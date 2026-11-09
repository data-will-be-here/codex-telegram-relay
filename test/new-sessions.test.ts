import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { State } from '../src/state.js';
import { allowedSessionDirectory, type Config } from '../src/config.js';
import { object, string, type Json } from '../src/types.js';
import { FakeCodex, FakeTelegram, message, temporary } from './helpers.js';

class Native extends FakeCodex {
  threads = new Map<string, Json>();
  starts = 0; names = 0; resumes: string[] = [];
  loseStart = false; rejectStart = false; loseName = false;
  async createThread(cwd: string, marker: string): Promise<Json> {
    this.starts++;
    if (this.rejectStart) throw new RpcError('Rejected', false);
    const id = `new-thread-${this.starts}`;
    const thread = { id, cwd, threadSource: marker, source: 'cli', ephemeral: false, name: '', status: { type: 'idle' } };
    this.threads.set(id, thread);
    this.sessions.push({ id, cwd, name: '', status: 'idle', threadSource: marker });
    if (this.loseStart) throw new RpcError('Response lost', true);
    return thread;
  }
  async setThreadName(threadId: string, name: string): Promise<void> {
    this.names++; this.threads.get(threadId)!.name = name;
    if (this.loseName) { this.loseName = false; throw new RpcError('Name response lost', true); }
  }
  override async read(id: string): Promise<Json> { return this.threads.get(id) ?? { ...await super.read(id), source: 'cli' }; }
  override async attach(id: string): Promise<Json> {
    this.resumes.push(id);
    if (!this.sessions.some(session => session.id === id)) {
      const thread = this.threads.get(id)!;
      this.sessions.push({ id, cwd: string(thread.cwd), name: string(thread.name), status: 'idle' });
    }
    return this.read(id);
  }
  async storedThreads(cwd: string): Promise<Json[]> { return [...this.threads.values()].filter(thread => thread.cwd === cwd && !thread.archived); }
  async nonArchivedThread(id: string): Promise<Json | undefined> { const thread = this.threads.get(id); return thread?.archived ? undefined : thread; }
  async findCreatedThread(cwd: string, marker: string): Promise<Json | undefined> {
    return [...this.threads.values()].find(thread => thread.cwd === cwd && thread.threadSource === marker);
  }
}

function setup(automatic = false, legacy = false) {
  const temp = temporary(); const project = join(temp.dir, 'project'); const scratch = join(temp.dir, 'conversations');
  mkdirSync(project); mkdirSync(scratch);
  const config: Config = { version: 1, ownerId: 42, roots: [project], codexBinary: process.execPath,
    ...(!automatic ? { newSessions: { projects: [project], scratchRoot: scratch } } : {}) };
  const state = new State(join(temp.dir, 'private')); const native = new Native(); const telegram = new FakeTelegram();
  const bridge = new Bridge(config, state, native, telegram);
  const outbox = new Outbox(state, telegram, config, 0);
  const drain = async () => { while (await outbox.flushOne()) { /* Deliver controls. */ } };
  const open = async (topic?: number) => {
    const update = message(100 + state.newSessions().length, topic ?? 999, '/new');
    if (topic === undefined) delete object(update.message).message_thread_id;
    await bridge.update(update); await drain();
    const op = state.newSessions().at(-1)!;
    if (legacy) state.changeNewSession(op.id, op.status, { topicFirst: false });
    return state.newSession(op.id)!;
  };
  const choose = async (index: number, updateId = 200) => {
    const op = state.newSessions().at(-1)!;
    const update: Json = { update_id: updateId, callback_query: { id: String(updateId), from: { id: 42, is_bot: false },
      data: `n:${op.token}:${index}`, message: { message_id: state.promptMessage(op.menuKey), chat: { id: 42, type: 'private' },
        ...(op.topicId === null ? {} : { message_thread_id: op.topicId }) } } };
    await bridge.update(update); return update;
  };
  return { ...temp, config, project, scratch, state, native, telegram, bridge, drain, open, choose,
    close: () => { bridge.close(); state.close(); temp.close(); } };
}

test('/new from topic-less owner chat creates a persistent empty scratch session; first task uses the new topic', async () => {
  const f = setup();
  try {
    const op = await f.open(); assert.equal(op.choices[0]!.kind, 'scratch');
    await f.choose(0); assert.equal(f.native.starts, 0); // Work is separate from Telegram dispatch.
    await f.bridge.workNewSession(); await f.drain();
    const completed = f.state.newSession(op.id)!;
    assert.equal(completed.status, 'ready'); assert.equal(f.native.starts, 1); assert.equal(f.native.names, 1);
    assert.equal(completed.cwd, join(f.scratch, op.id)); assert.ok(existsSync(completed.cwd!));
    const binding = f.state.binding(completed.threadId!)!;
    assert.equal(binding.lastTurn, '-'); assert.equal(binding.projectLabel, 'No project'); assert.match(binding.title, /^No project · /u);
    assert.equal(f.native.writes.length, 0);
    await f.bridge.update(message(300, binding.topicId, 'Research this'));
    assert.deepEqual(f.native.writes[0], { method: 'start', params: { threadId: completed.threadId, text: 'Research this' } });
    await f.bridge.notification('turn/completed', { threadId: completed.threadId, turn: { id: 'first', status: 'completed', items: [{ type: 'agentMessage', text: 'First answer' }] } });
    await f.drain();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('First answer') && string(item.text).startsWith('» No project')));
  } finally { f.close(); }
});

test('project selection preserves the originating binding and never copies history or dispatches a task', async () => {
  const f = setup();
  try {
    f.native.sessions.push({ id: 'original-thread', cwd: f.project, name: 'Old task', status: 'idle' });
    await f.bridge.discover(); const original = f.state.binding('original-thread')!;
    const op = await f.open(original.topicId); assert.match(op.choices[1]!.label, /This project/u);
    await f.choose(1); await f.bridge.workNewSession();
    assert.equal(f.state.binding('original-thread')!.topicId, original.topicId);
    assert.notEqual(f.state.binding(f.state.newSession(op.id)!.threadId!)!.topicId, original.topicId);
    assert.equal(f.native.writes.length, 0); assert.equal(f.state.newSession(op.id)!.cwd, f.project);
  } finally { f.close(); }
});

test('new requests create no native session when topic delivery fails or is unknown, including after reconnect', async () => {
  for (const code of [400, 0, 500]) {
    const f = setup(); let attempts = 0;
    try {
      const call = f.telegram.call.bind(f.telegram);
      f.telegram.call = async (method, params) => {
        if (method === 'createForumTopic') { attempts++; throw new TelegramError(code === 400 ? 'BOT_TOPIC_WRONG_HOME' : 'Lost response', code); }
        return call(method, params);
      };
      const op = await f.open(999); await f.choose(0); await f.bridge.workNewSession();
      assert.equal(f.native.starts, 0); assert.equal(f.state.newSession(op.id)!.threadId, undefined);
      assert.equal(f.state.newSession(op.id)!.topicState, 'uncertain');
      assert.ok(f.telegram.calls.some(item => item.method === 'editMessageText' && string(item.params.text).includes('No Codex session has been created')));
      f.state.changeNewSession(op.id, 'preparing', { retryAt: 0 }); await f.bridge.workNewSession();
      await f.bridge.update(message(700, 999, '/new'));
      const restarted = new Bridge(f.config, f.state, f.native, f.telegram);
      f.state.changeNewSession(op.id, 'preparing', { retryAt: 0 }); await restarted.workNewSession(); restarted.close();
      assert.equal(attempts, 1); assert.equal(f.native.starts, 0); assert.equal(f.state.newSessions().length, 1);
    } finally { f.close(); }
  }
});

test('an interrupted topic-first request stays unknown without native creation or a repeated Telegram request', async () => {
  const f = setup();
  try {
    const op = await f.open(); await f.choose(0);
    f.state.changeNewSession(op.id, 'preparing', { topicState: 'creating', topicAttempt: 1 });
    const restarted = new Bridge(f.config, f.state, f.native, f.telegram);
    await restarted.workNewSession(); restarted.close();
    assert.equal(f.state.newSession(op.id)!.topicState, 'uncertain'); assert.equal(f.native.starts, 0);
    assert.equal(f.telegram.calls.filter(item => item.method === 'createForumTopic').length, 0);
  } finally { f.close(); }
});

test('unstarted legacy operations also confirm a topic before creating any native session', async () => {
  const f = setup();
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'createForumTopic') throw new TelegramError('Rejected', 400); return call(method, params); };
    const menu = await f.open(999); f.state.changeNewSession(menu.id, 'selecting', { status: 'cancelled' });
    const legacy = { ...menu, id: 'legacy-preparing', status: 'preparing' as const, kind: 'scratch' as const, root: f.scratch, cwd: join(f.scratch, 'legacy-preparing'), choices: [] };
    delete legacy.topicFirst; f.state.createNewSession(legacy);
    await f.bridge.workNewSession();
    assert.equal(f.state.newSession(legacy.id)!.topicFirst, true); assert.equal(f.state.newSession(legacy.id)!.topicState, 'failed');
    assert.equal(f.native.starts, 0); assert.equal(f.state.newSession(legacy.id)!.threadId, undefined);
  } finally { f.close(); }
});

test('topic-first recovery binds an explicitly selected empty topic before the only native start', async () => {
  const f = setup(); let attempts = 0;
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'createForumTopic') { attempts++; throw new TelegramError('BOT_TOPIC_WRONG_HOME', 400); }
      return call(method, params);
    };
    const op = await f.open(999); await f.choose(0); await f.bridge.workNewSession();
    const saved = f.state.newSession(op.id)!;
    await f.bridge.update({ update_id: 709, callback_query: { id: 'missing-receipt', from: { id: 42, is_bot: false },
      data: `n:${op.token}:b${saved.topicAttempt}`, message: { chat: { id: 42, type: 'private' }, message_thread_id: 999 } } });
    await f.bridge.update(message(714, 556, '/bind')); assert.equal(f.state.newSession(op.id)!.targetTopic, undefined);
    const click: Json = { update_id: 710, callback_query: { id: 'use-topic', from: { id: 42, is_bot: false },
      data: `n:${op.token}:b${saved.topicAttempt}`, message: { message_id: f.state.promptMessage(op.menuKey), chat: { id: 42, type: 'private' }, message_thread_id: 888 } } };
    await f.bridge.update(click);
    await f.bridge.update(message(711, 555, '/bind')); assert.equal(f.state.newSession(op.id)!.targetTopic, undefined);
    object(object(click.callback_query).message).message_thread_id = 999; click.update_id = 712;
    await f.bridge.update(click); await f.drain(); assert.equal(f.native.starts, 0);
    await f.bridge.update(message(713, 555, '/bind')); await f.bridge.workNewSession();
    const ready = f.state.newSession(op.id)!;
    assert.equal(ready.status, 'ready'); assert.equal(f.state.binding(ready.threadId!)!.topicId, 555);
    assert.equal(f.native.starts, 1); assert.equal(attempts, 1); assert.equal(f.native.writes.length, 0);
  } finally { f.close(); }
});

test('explicit topic retry is fenced by its attempt and creates native state only after a positive topic receipt', async () => {
  const f = setup(); let attempts = 0;
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'createForumTopic') { attempts++; if (attempts < 3) throw new TelegramError('Rejected', 400); assert.equal(f.native.starts, 0); }
      return call(method, params);
    };
    const op = await f.open(999); await f.choose(0); await f.bridge.workNewSession();
    const click: Json = { update_id: 720, callback_query: { id: 'retry-topic', from: { id: 42, is_bot: false }, data: `n:${op.token}:r1`,
      message: { message_id: f.state.promptMessage(op.menuKey), chat: { id: 42, type: 'private' }, message_thread_id: 999 } } };
    await f.bridge.update(click); await f.bridge.workNewSession(); assert.equal(attempts, 2); assert.equal(f.native.starts, 0);
    click.update_id = 721; await f.bridge.update(click); f.state.changeNewSession(op.id, 'preparing', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(attempts, 2, 'a stale retry button cannot trigger a later attempt');
    object(click.callback_query).data = `n:${op.token}:r2`; click.update_id = 722;
    await f.bridge.update(click); await f.bridge.workNewSession();
    assert.equal(attempts, 3); assert.equal(f.native.starts, 1); assert.equal(f.state.newSession(op.id)!.status, 'ready');
  } finally { f.close(); }
});

test('an unbound topic reserved by an uncertain native start cannot be selected by another menu', async () => {
  const f = setup();
  try {
    f.native.loseStart = true;
    const first = await f.open(999); await f.choose(0); await f.bridge.workNewSession();
    const reserved = f.state.newSession(first.id)!.targetTopic!; assert.ok(reserved); assert.equal(f.native.starts, 1);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'createForumTopic') throw new TelegramError('Rejected', 400); return call(method, params); };
    const second = await f.open(888); await f.choose(0, 730); await f.bridge.workNewSession();
    await f.bridge.update({ update_id: 731, callback_query: { id: 'reserved', from: { id: 42, is_bot: false }, data: `n:${second.token}:b1`,
      message: { message_id: f.state.promptMessage(second.menuKey), chat: { id: 42, type: 'private' }, message_thread_id: 888 } } });
    await f.bridge.update(message(732, reserved, '/bind'));
    assert.equal(f.state.newSession(second.id)!.targetTopic, undefined); assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('duplicate updates, double clicks and reconnects cannot repeat a native start', async () => {
  const f = setup();
  try {
    const op = await f.open(); const click = await f.choose(0); await f.bridge.update(click); await f.choose(0, 201);
    await Promise.all([f.bridge.workNewSession(), f.bridge.workNewSession()]);
    await f.choose(0, 202); assert.equal(f.native.starts, 1);
    const reconnected = new Bridge(f.config, f.state, f.native, f.telegram);
    await reconnected.workNewSession(); await reconnected.discover(); reconnected.close();
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('an unconfirmed start is recovered by exact marker and cwd without repeating creation', async () => {
  const f = setup();
  try {
    f.native.loseStart = true; const op = await f.open(); await f.choose(0); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'uncertain');
    f.state.changeNewSession(op.id, 'uncertain', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('unknown start with no exact match remains uncertain; a new request cannot replace it', async () => {
  const f = setup();
  try {
    f.native.loseStart = true; const op = await f.open(); await f.choose(0); await f.bridge.workNewSession();
    f.native.threads.clear(); f.state.changeNewSession(op.id, 'uncertain', { retryAt: 0 });
    await f.bridge.workNewSession(); await f.bridge.update(message(400, 999, '/new')); // Different origin is a separate operation.
    await f.bridge.update({ update_id: 401, message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/new' } });
    assert.equal(f.state.newSessions().filter(item => item.topicId === null).length, 1);
    assert.equal(f.native.starts, 1); assert.equal(f.state.newSession(op.id)!.status, 'uncertain');
  } finally { f.close(); }
});

test('an uncertain name write reuses the known native ID and preserves its stored name', async () => {
  const f = setup();
  try {
    f.native.loseName = true; const op = await f.open(); await f.choose(1); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'known');
    f.native.threads.values().next().value!.name = 'User rename';
    f.state.changeNewSession(op.id, 'known', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.native.starts, 1); assert.equal(f.native.names, 1); assert.equal(f.state.newSession(op.id)!.status, 'ready');
    assert.equal(f.state.bindings()[0]!.sessionName, 'User rename');
  } finally { f.close(); }
});

test('Telegram uncertainty holds topic creation and uses existing bind recovery', async () => {
  const f = setup(false, true); // Operations already created by the previous native-first release.
  try {
    const call = f.telegram.call.bind(f.telegram); let creates = 0;
    f.telegram.call = async (method, params) => { if (method === 'createForumTopic') { creates++; throw new TelegramError('Lost', 0); } return call(method, params); };
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession();
    const known = f.state.newSession(op.id)!; assert.equal(known.status, 'topic');
    f.state.changeNewSession(op.id, 'topic', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(creates, 1); assert.equal(f.native.starts, 1);
    await f.bridge.update(message(500, 555, `/bind ${known.threadId}`));
    f.state.changeNewSession(op.id, 'topic', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.state.binding(known.threadId!)!.topicId, 555);
  } finally { f.close(); }
});

test('a rejected scratch topic replaces Creating session with recovery in the originating topic', async () => {
  const f = setup(false, true); let creates = 0;
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'createForumTopic') { creates++; throw new TelegramError('Telegram createForumTopic failed (400): Bad Request: BOT_TOPIC_WRONG_HOME', 400); }
      return call(method, params);
    };
    const op = await f.open(999); await f.choose(0); await f.bridge.workNewSession(); await f.drain();
    const saved = f.state.newSession(op.id)!; assert.equal(f.native.starts, 1); assert.ok(saved.threadId);
    assert.equal(f.state.topicOperation(saved.threadId!)!.status, 'uncertain', 'WRONG_HOME must not be treated as proof that no topic appeared');
    const edit = f.telegram.calls.filter(item => item.method === 'editMessageText').at(-1)!.params;
    assert.match(string(edit.text), /session.*created|created.*session/iu);
    assert.match(string(edit.text), /topic/iu); assert.match(string(edit.text), /BOT_TOPIC_WRONG_HOME/u);
    assert.ok(string(edit.text).includes(saved.threadId!)); assert.ok(object(edit.reply_markup).inline_keyboard);
    const before = f.telegram.calls.length;
    f.state.changeNewSession(op.id, 'topic', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.telegram.calls.length, before, 'background checks must not repeat the same recovery prompt');
    await f.bridge.update(message(900, 999, '/new')); await f.drain();
    assert.equal(f.native.starts, 1); assert.equal(creates, 1); assert.equal(f.state.newSessions().length, 1);
    const latest = f.telegram.calls.filter(item => item.method === 'editMessageText').at(-1)!.params;
    assert.doesNotMatch(string(latest.text), /already being created/u);
    const attempt = f.state.topicOperation(saved.threadId!)!;
    const retry: Json = { update_id: 901, callback_query: { id: 'retry', from: { id: 42, is_bot: false },
      data: `recover:${attempt.attempt.replaceAll('-', '')}:r`, message: { message_id: f.state.promptMessage(op.menuKey),
        chat: { id: 42, type: 'private' }, message_thread_id: 888 } } };
    await f.bridge.update(retry); assert.equal(creates, 1, 'the same message ID in another topic cannot recover');
    object(object(retry.callback_query).message).message_thread_id = 999;
    object(retry.callback_query).data = `recover:${attempt.attempt.replaceAll('-', '')}:b`;
    retry.update_id = 902; await f.bridge.update(retry); await f.drain();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('selection expires in 10 minutes') && item.message_thread_id === 999));
    f.telegram.call = call;
    object(retry.callback_query).data = `recover:${attempt.attempt.replaceAll('-', '')}:r`;
    retry.update_id = 903; await f.bridge.update(retry);
    assert.ok(f.state.binding(saved.threadId!), 'retry is available on the original creation menu');
    f.state.changeNewSession(op.id, 'topic', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('topic recovery restores the exact saved relay-owned session after its native connection closes', async () => {
  const f = setup(false, true);
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'createForumTopic') throw new TelegramError('BOT_TOPIC_WRONG_HOME', 400);
      return call(method, params);
    };
    const op = await f.open(999); await f.choose(0); await f.bridge.workNewSession();
    const saved = f.state.newSession(op.id)!; const topic = f.state.topicOperation(saved.threadId!)!;
    f.native.sessions = []; // Stored native history survives; the original connection no longer loads it.
    await f.bridge.update({ update_id: 910, callback_query: { id: 'bind-existing', from: { id: 42, is_bot: false },
      data: `recover:${topic.attempt.replaceAll('-', '')}:b`, message: { message_id: f.state.promptMessage(op.menuKey),
        chat: { id: 42, type: 'private' }, message_thread_id: 999 } } });
    await f.drain();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('selection expires in 10 minutes')));
    assert.deepEqual(f.native.resumes, [saved.threadId]);
    await f.bridge.update(message(911, 555, '/bind'));
    f.state.changeNewSession(op.id, 'topic', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.state.binding(saved.threadId!)!.topicId, 555);
    assert.equal(f.native.starts, 1); assert.equal(f.native.writes.length, 0);
  } finally { f.close(); }
});

test('owned recovery never resumes archived, substituted or newly disallowed native sessions', async () => {
  for (const invalid of ['archived', 'substituted', 'revoked']) {
    const f = setup(false, true);
    try {
      const call = f.telegram.call.bind(f.telegram);
      f.telegram.call = async (method, params) => {
        if (method === 'createForumTopic') throw new TelegramError('BOT_TOPIC_WRONG_HOME', 400);
        return call(method, params);
      };
      const op = await f.open(999); await f.choose(0); await f.bridge.workNewSession();
      const saved = f.state.newSession(op.id)!; const topic = f.state.topicOperation(saved.threadId!)!;
      f.native.sessions = [];
      const read = f.native.nonArchivedThread.bind(f.native);
      f.native.nonArchivedThread = async id => {
        const thread = await read(id);
        if (invalid === 'archived') return undefined;
        if (invalid === 'substituted') return { ...thread, id: 'another-native-session' };
        f.config.ignoredThreadIds = [id]; return thread;
      };
      await f.bridge.update({ update_id: 920, callback_query: { id: 'blocked', from: { id: 42, is_bot: false },
        data: `recover:${topic.attempt.replaceAll('-', '')}:b`, message: { message_id: f.state.promptMessage(op.menuKey),
          chat: { id: 42, type: 'private' }, message_thread_id: 999 } } });
      assert.deepEqual(f.native.resumes, [], invalid); assert.equal(f.native.starts, 1); assert.equal(f.native.writes.length, 0);
      assert.equal(f.state.binding(saved.threadId!), undefined);
    } finally { f.close(); }
  }
});

test('a proven unsent topic request retries after three seconds using the same native session', async () => {
  const f = setup(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  let creates = 0;
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'createForumTopic' && creates++ === 0) throw new TelegramError('Not connected', 0, undefined, true);
      return call(method, params);
    };
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.retryAt, now + 3000); assert.equal(f.native.starts, 0);
    now += 2999; await f.bridge.workNewSession(); assert.equal(creates, 1);
    now++; await f.bridge.workNewSession(); assert.equal(creates, 2);
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.native.starts, 1);
  } finally { Date.now = realNow; f.close(); }
});

test('selected scope accepts only owned scratch workspaces and refuses revoked roots', async () => {
  const f = setup();
  try {
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession(); const created = f.state.newSession(op.id)!;
    const other = join(f.scratch, 'foreign'); mkdirSync(other);
    assert.equal(allowedSessionDirectory(other, f.config, f.state.ownsScratch(other)), false);
    assert.equal(allowedSessionDirectory(created.cwd!, f.config, f.state.ownsScratch(created.cwd!)), true);
    delete f.config.newSessions!.scratchRoot;
    assert.equal(allowedSessionDirectory(created.cwd!, f.config, f.state.ownsScratch(created.cwd!)), false);
    await assert.rejects(f.bridge.update(message(510, f.state.binding(created.threadId!)!.topicId, 'Do not send')));
    assert.equal(f.native.writes.length, 0);
  } finally { f.close(); }
});

test('callback scope, expiry, cancel and authorization prevent allocation', async () => {
  const f = setup();
  try {
    await f.bridge.update(message(1, 999, '/new', 99)); assert.equal(f.state.newSessions().length, 0);
    const op = await f.open(999); const click = await f.choose(0);
    // A second fresh menu supplies a valid callback, but cannot be used in another topic.
    f.state.changeNewSession(op.id, 'preparing', { status: 'selecting' });
    object(object(click.callback_query).message).message_thread_id = 888; click.update_id = 220;
    await f.bridge.update(click); assert.equal(f.state.newSession(op.id)!.status, 'selecting');
    f.state.changeNewSession(op.id, 'selecting', { expires: 0 }); await f.choose(0, 221);
    await f.bridge.workNewSession(); assert.equal(f.native.starts, 0);
  } finally { f.close(); }
});

test('restart restores only exact owned non-archived sessions; ordinary sessions are never resumed by ownership', async () => {
  const f = setup();
  try {
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession(); const id = f.state.newSession(op.id)!.threadId!;
    f.native.sessions = []; f.native.resumes = [];
    const bridge = new Bridge(f.config, f.state, f.native, f.telegram); await bridge.discover(); bridge.close();
    assert.ok(f.native.resumes.includes(id)); assert.equal(f.native.starts, 1);
    f.native.sessions = []; f.native.resumes = []; f.native.threads.get(id)!.archived = true;
    const another = new Bridge(f.config, f.state, f.native, f.telegram); await another.discover(); another.close();
    assert.equal(f.native.resumes.length, 0);
  } finally { f.close(); }
});

test('working directory substitution is rejected before a native start', async t => {
  const f = setup();
  try {
    const op = await f.open(); await f.choose(0);
    try { symlinkSync(f.project, join(f.scratch, op.id), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch { t.skip('Symlink unavailable'); return; }
    await f.bridge.workNewSession(); assert.equal(f.native.starts, 0); assert.equal(f.state.newSession(op.id)!.status, 'failed');
  } finally { f.close(); }
});

test('persistent journal converts interrupted starts to uncertain and preserves the same workspace', async () => {
  const temp = temporary();
  try {
    const home = join(temp.dir, 'private'); const first = new State(home);
    first.createNewSession({ id: 'operation', status: 'starting', topicId: null, menuKey: 'notice/menu', token: 'token', expires: 123, choices: [], page: 0, cwd: 'unchanged' }); first.close();
    const second = new State(home);
    try { assert.equal(second.newSession('operation')!.status, 'uncertain'); assert.equal(second.newSession('operation')!.cwd, 'unchanged'); }
    finally { second.close(); }
  } finally { temp.close(); }
});

test('cancel retires a picker without creating a directory or native session', async () => {
  const f = setup();
  try {
    const op = await f.open();
    await f.bridge.update({ update_id: 700, callback_query: { id: 'cancel', from: { id: 42 }, data: `n:${op.token}:x`,
      message: { message_id: f.state.promptMessage(op.menuKey), chat: { id: 42, type: 'private' } } } });
    await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'cancelled'); assert.equal(f.native.starts, 0);
    assert.equal(existsSync(join(f.scratch, op.id)), false);
  } finally { f.close(); }
});

test('slow native creation cannot block instructions in an already attached topic', async () => {
  const f = setup();
  try {
    f.native.sessions.push({ id: 'original-thread', cwd: f.project, name: '', status: 'idle' });
    await f.bridge.discover(); const topic = f.state.binding('original-thread')!.topicId;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const original = f.native.createThread.bind(f.native);
    f.native.createThread = async (...args) => { await wait; return original(...args); };
    await f.open(); await f.choose(0); const work = f.bridge.workNewSession();
    await f.bridge.update(message(701, topic, 'Existing session keeps working'));
    assert.equal(f.native.writes[0]!.method, 'start'); release(); await work;
    assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('one missing owned history cannot disconnect unrelated sessions', async () => {
  const f = setup();
  try {
    await f.open(); await f.choose(0); await f.bridge.workNewSession(); f.native.sessions = [];
    f.native.nonArchivedThread = async () => { throw new Error('History was removed locally'); };
    f.native.sessions.push({ id: 'healthy-thread', cwd: f.project, name: '', status: 'idle' });
    const bridge = new Bridge(f.config, f.state, f.native, f.telegram);
    await bridge.discover();
    await bridge.update(message(702, f.state.binding('healthy-thread')!.topicId, 'Still connected'));
    assert.equal(f.native.writes.at(-1)!.params.threadId, 'healthy-thread'); bridge.close();
  } finally { f.close(); }
});

test('scratch ownership is tied to the native ID; disabling new creation keeps existing conversations usable', async () => {
  const f = setup();
  try {
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession(); const saved = f.state.newSession(op.id)!;
    f.native.sessions.push({ id: 'foreign-thread', cwd: saved.cwd!, name: 'Unowned', status: 'idle' });
    await f.bridge.discover(); assert.equal(f.state.binding('foreign-thread'), undefined);
    assert.equal(f.state.ownsScratch(saved.cwd!, 'foreign-thread'), false);
    f.config.newSessions!.enabled = false;
    const reconnected = new Bridge(f.config, f.state, f.native, f.telegram);
    await reconnected.discover();
    await reconnected.update(message(800, f.state.binding(saved.threadId!)!.topicId, 'Continue old conversation'));
    assert.equal(f.native.writes.at(-1)!.params.threadId, saved.threadId);
    await reconnected.update(message(801, 999, '/new'));
    assert.equal(f.state.newSessions().length, 1); reconnected.close();
  } finally { f.close(); }
});

test('/new controls can be delivered in an ignored or out-of-scope originating topic', async () => {
  const f = setup();
  try {
    f.state.bind('ignored-thread', 999, f.project, 'Ignored'); f.config.ignoredThreadIds = ['ignored-thread'];
    const op = await f.open(999);
    assert.ok(f.state.promptMessage(op.menuKey));
    await f.choose(0); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready');
    assert.equal(f.state.binding('ignored-thread')!.topicId, 999);
  } finally { f.close(); }
});

test('thread/started records an exact ID before a lost start response, without requiring a catalog scan', async () => {
  const f = setup();
  try {
    const original = f.native.createThread.bind(f.native);
    f.native.createThread = async (...args) => {
      const thread = await original(...args);
      await f.bridge.notification('thread/started', { thread });
      throw new RpcError('Response lost after notification', true);
    };
    f.native.findCreatedThread = async () => { throw new Error('An exact ID is already recorded'); };
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.threadId, 'new-thread-1');
    f.state.changeNewSession(op.id, 'uncertain', { retryAt: 0 }); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready'); assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('ordinary discovery uses one metadata scan when no owned session needs restoring', async () => {
  const f = setup();
  try {
    let scans = 0; const original = f.native.list.bind(f.native);
    f.native.list = async (...args) => { scans++; return original(...args); };
    await f.bridge.discover(); assert.equal(scans, 1);
  } finally { f.close(); }
});

test('/new works out of the box without new enable or a newSessions configuration section', async () => {
  const f = setup(true);
  try {
    const root = f.config.newSessions!.scratchRoot!;
    assert.equal(existsSync(root), false);
    await f.bridge.update(message(1, 999, '/new', 99));
    assert.equal(existsSync(root), false); assert.equal(f.state.newSessions().length, 0);
    const op = await f.open();
    assert.equal(existsSync(root), true); assert.equal(op.choices[0]!.kind, 'scratch');
    assert.ok(op.choices.some(choice => choice.cwd === f.project));
    await f.choose(0); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready');
    assert.equal(f.state.newSession(op.id)!.cwd, join(root, op.id));
    assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('automatic project choices follow known bindings and scope without listing scratch UUID directories', async () => {
  const f = setup(true);
  try {
    const other = join(f.dir, 'connected-project'); mkdirSync(other);
    f.state.bind('connected-thread', 777, other, 'Connected');
    const selected = await f.open(); assert.equal(selected.choices.some(choice => choice.cwd === other), false);
    f.config.sessionScope = 'all';
    const all = await f.open(777); assert.ok(all.choices.some(choice => choice.cwd === other && /This project/u.test(choice.label)));
    await f.choose(0); await f.bridge.workNewSession(); const scratch = f.state.newSession(all.id)!.cwd!;
    const next = await f.open(888); assert.equal(next.choices.some(choice => choice.cwd === scratch), false);
    assert.equal(next.choices[0]!.kind, 'scratch');
  } finally { f.close(); }
});

test('a known home-directory session cannot hide the general conversation option', async () => {
  const f = setup(true);
  try {
    f.config.sessionScope = 'all';
    // Like a native session opened at C:\Users\name: this candidate contains
    // private relay data and is rejected as a project, but also contains scratch.
    f.state.bind('home-directory-thread', 777, f.dir, 'Home');
    const op = await f.open();
    assert.equal(op.choices[0]!.kind, 'scratch');
    const keyboard = object(f.telegram.sent().at(-1)!.reply_markup).inline_keyboard as { text: string }[][];
    assert.match(keyboard[0]![0]!.text, /No project/u);
    assert.equal(op.choices.some(choice => choice.cwd === f.dir), false);
    await f.choose(0); await f.bridge.workNewSession();
    assert.equal(f.state.newSession(op.id)!.status, 'ready');
  } finally { f.close(); }
});

async function originalSession(f: ReturnType<typeof setup>) {
  f.native.sessions.push({ id: 'original', cwd: f.project, name: 'Previous task', status: 'idle' });
  f.native.histories.set('original', [{ id: 'old', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Previous history' }] }]);
  await f.bridge.discover(); await f.drain(); return f.state.binding('original')!;
}

test('/clear switches the same topic to one empty conversation and keeps the old native history', async () => {
  const f = setup();
  try {
    const old = await originalSession(f); f.state.setViewMode('widgets');
    const topics = f.telegram.calls.filter(call => call.method === 'createForumTopic').length;
    await f.bridge.update(message(10, old.topicId, '/clear'));
    await f.bridge.update(message(11, old.topicId, '/clear'));
    assert.equal(f.native.starts, 0); assert.equal(f.state.newSessions().length, 1);
    await f.bridge.update(message(12, old.topicId, 'Do not send during reset')).catch(() => undefined);
    assert.equal(f.native.writes.length, 0);
    await f.drain();
    await f.bridge.workNewSession(); await f.drain();
    const next = f.state.topic(old.topicId)!;
    assert.equal(next.threadId, 'new-thread-1'); assert.equal(next.cwd, old.cwd); assert.equal(next.lastTurn, '-');
    assert.equal(f.state.viewMode(), 'widgets'); assert.equal(f.state.retiredSession(old.threadId), true);
    assert.equal(f.state.historicalAnswerBinding(old), true);
    assert.equal(f.native.starts, 1); assert.equal(f.state.binding(old.threadId), undefined);
    assert.equal((await f.native.turns('original'))[0]!.id, 'old'); assert.deepEqual(await f.native.turns(next.threadId), []);
    await f.bridge.discover(); await f.drain();
    assert.equal(f.telegram.calls.filter(call => call.method === 'createForumTopic').length, topics);
    assert.equal(f.state.bindings().length, 1); assert.equal(f.native.starts, 1);
    await f.bridge.update(message(13, next.topicId, 'Fresh task'));
    assert.deepEqual(f.native.writes, [{ method: 'start', params: { threadId: next.threadId, text: 'Fresh task' } }]);
    await f.bridge.notification('turn/completed', { threadId: old.threadId, turn: { id: 'late-old', status: 'completed', items: [{ type: 'agentMessage', text: 'Must not leak' }] } });
    await f.drain(); assert.equal(f.telegram.sent().some(item => string(item.text).includes('Must not leak')), false);
  } finally { f.close(); }
});

test('/clear refuses active turns, pending approvals, delivery work and unavailable native sessions', async () => {
  for (const busy of ['active', 'turn', 'approval', 'delivery', 'read']) {
    const f = setup();
    try {
      const old = await originalSession(f);
      if (busy === 'active') f.native.sessions[0]!.status = 'active';
      if (busy === 'turn') f.native.histories.set(old.threadId, [{ id: 'running', status: 'inProgress' }]);
      if (busy === 'approval') {
        f.native.pending.add('pending');
        await f.bridge.request({ id: 'pending', method: 'item/commandExecution/requestApproval', params: { threadId: old.threadId, turnId: 'old', itemId: 'command', command: 'echo ok' } });
        await f.drain();
      }
      if (busy === 'delivery') f.state.enqueue('final/original/queued', old.topicId, 'Pending final');
      if (busy === 'read') f.native.read = async () => { throw new RpcError('Offline', true); };
      await f.bridge.update(message(10, old.topicId, '/clear')); await f.bridge.workNewSession();
      assert.equal(f.native.starts, 0, busy); assert.equal(f.state.topic(old.topicId)!.threadId, old.threadId);
      assert.equal(f.state.resettingTopic(old.topicId), false); assert.equal(f.native.writes.length, 0);
    } finally { f.close(); }
  }
});

test('/clear requires the paired owner and an existing eligible topic; invalid arguments never create', async () => {
  const f = setup();
  try {
    const old = await originalSession(f);
    await f.bridge.update(message(10, old.topicId, '/clear', 99));
    await f.bridge.update(message(11, 999, '/clear'));
    await f.bridge.update(message(12, old.topicId, '/clear extra'));
    const root = message(13, old.topicId, '/clear'); delete object(root.message).message_thread_id; await f.bridge.update(root);
    f.config.ignoredThreadIds = [old.threadId]; await f.bridge.update(message(14, old.topicId, '/clear'));
    await f.bridge.workNewSession(); assert.equal(f.native.starts, 0);
    assert.equal(f.state.topic(old.topicId)!.threadId, old.threadId);
  } finally { f.close(); }
});

test('unknown /clear creation recovers the same marked thread after reconnect without a repeated start', async () => {
  const f = setup();
  try {
    const old = await originalSession(f); f.native.loseStart = true;
    await f.bridge.update(message(10, old.topicId, '/clear')); await f.bridge.workNewSession();
    const op = f.state.newSessions().at(-1)!;
    assert.equal(op.status, 'uncertain'); assert.equal(f.state.topic(old.topicId)!.threadId, old.threadId);
    f.bridge.close(); const next = new Bridge(f.config, f.state, f.native, f.telegram);
    await next.discover(); f.state.changeNewSession(op.id, 'uncertain', { retryAt: 0 });
    await next.workNewSession(); await f.drain();
    assert.equal(f.native.starts, 1); assert.equal(f.state.topic(old.topicId)!.threadId, 'new-thread-1');
    assert.equal(f.state.newSession(op.id)!.status, 'ready');
    next.close();
  } finally { f.close(); }
});

test('a busy old session after creation pauses the handoff and never creates another thread', async () => {
  const f = setup();
  try {
    const old = await originalSession(f); const create = f.native.createThread.bind(f.native);
    f.native.createThread = async (...args) => { const result = await create(...args); f.native.sessions[0]!.status = 'active'; return result; };
    await f.bridge.update(message(10, old.topicId, '/clear')); await f.bridge.workNewSession(); await f.drain();
    const op = f.state.newSessions().at(-1)!; assert.equal(op.status, 'topic');
    assert.equal(f.state.topic(old.topicId)!.threadId, old.threadId); assert.equal(f.native.starts, 1);
    f.native.sessions[0]!.status = 'idle'; f.state.changeNewSession(op.id, 'topic', { retryAt: 0 });
    await f.bridge.workNewSession(); assert.equal(f.state.topic(old.topicId)!.threadId, 'new-thread-1');
    assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('/clear retains scratch ownership and does not create another directory or Telegram topic', async () => {
  const f = setup();
  try {
    const op = await f.open(); await f.choose(0); await f.bridge.workNewSession(); await f.drain();
    const old = f.state.binding(f.state.newSession(op.id)!.threadId!)!;
    await f.bridge.update(message(300, old.topicId, '/clear')); await f.bridge.workNewSession(); await f.drain();
    const next = f.state.topic(old.topicId)!;
    assert.equal(next.threadId, 'new-thread-2'); assert.equal(next.cwd, old.cwd); assert.equal(next.projectLabel, 'No project');
    assert.equal(f.state.ownsScratch(next.cwd, next.threadId), true);
    await f.bridge.discover(); assert.equal(f.telegram.calls.filter(call => call.method === 'createForumTopic').length, 1);
  } finally { f.close(); }
});

test('a definite /clear creation rejection unlocks the original topic without repeated creation', async () => {
  const f = setup();
  try {
    const old = await originalSession(f); f.native.rejectStart = true;
    await f.bridge.update(message(10, old.topicId, '/clear')); await f.bridge.workNewSession(); await f.drain();
    assert.equal(f.state.newSessions().at(-1)!.status, 'failed'); assert.equal(f.state.resettingTopic(old.topicId), false);
    await f.bridge.workNewSession(); assert.equal(f.native.starts, 1);
    await f.bridge.update(message(11, old.topicId, 'Continue original'));
    assert.equal(f.native.writes[0]!.params.threadId, old.threadId);
  } finally { f.close(); }
});

test('revoked scope during pre-creation metadata reads cannot create a /clear replacement', async () => {
  for (const revoke of ['scope', 'disabled', 'ignored']) {
    const f = setup();
    try {
      const old = await originalSession(f);
      await f.bridge.update(message(10, old.topicId, '/clear'));
      const list = f.native.list.bind(f.native);
      f.native.list = async (...args) => {
        const result = await list(...args);
        if (revoke === 'scope') f.config.roots = [];
        if (revoke === 'disabled') f.config.newSessions!.enabled = false;
        if (revoke === 'ignored') f.config.ignoredThreadIds = [old.threadId];
        return result;
      };
      await f.bridge.workNewSession(); await f.bridge.workNewSession();
      assert.equal(f.native.starts, 0, revoke); assert.equal(f.state.topic(old.topicId)!.threadId, old.threadId);
    } finally { f.close(); }
  }
});

test('the creation worker cannot start while /clear preflight is awaiting native state', async () => {
  const f = setup(); let release: (() => void) | undefined;
  try {
    const old = await originalSession(f); const read = f.native.read.bind(f.native);
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; }); let first = true;
    f.native.read = async id => { if (id === old.threadId && first) { first = false; entered(); await waiting; } return read(id); };
    const pending = f.bridge.update(message(10, old.topicId, '/clear')); await started;
    assert.equal(f.state.newSessions().at(-1)!.status, 'checking');
    await f.bridge.workNewSession(); assert.equal(f.native.starts, 0);
    release!(); await pending; await f.bridge.workNewSession();
    assert.equal(f.native.starts, 1); assert.equal(f.state.topic(old.topicId)!.threadId, 'new-thread-1');
  } finally { release?.(); f.close(); }
});

test('historical Full answer remains readable after /clear but old permission controls cannot change sessions', async () => {
  const f = setup();
  try {
    const old = await originalSession(f);
    await f.bridge.update(message(10, old.topicId, '/permissions')); await f.drain();
    const menu = f.telegram.sent().at(-1)!; const menuId = f.telegram.message;
    const controls = object(menu.reply_markup).inline_keyboard as Json[][];
    const permission = controls.flat().find(item => string(item.text).includes('Read Only'))!;
    f.state.setViewMode('widgets');
    await f.bridge.notification('turn/started', { threadId: old.threadId, turn: { id: 'result', status: 'inProgress' } });
    f.native.histories.get(old.threadId)!.unshift({ id: 'result', status: 'completed' });
    await f.bridge.notification('turn/completed', { threadId: old.threadId, turn: { id: 'result', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Historical full reply' }] } });
    await f.drain();
    const widget = f.telegram.calls.filter(call => call.method === 'sendWidget').at(-1)!.params;
    const answer = (object(widget.reply_markup).inline_keyboard as Json[][])[0]![0]!;
    const receipt = f.state.widgetAnswer(string(answer.callback_data).slice(2))!;
    await f.bridge.update(message(11, old.topicId, '/clear')); await f.bridge.workNewSession(); await f.drain();
    const click = (id: number, data: unknown, messageId: number) => ({ update_id: id, callback_query: { id: String(id), from: { id: 42 }, data,
      message: { message_id: messageId, chat: { id: 42, type: 'private' }, message_thread_id: old.topicId } } });
    await f.bridge.update(click(12, permission.callback_data, menuId)); assert.equal(f.native.writes.length, 0);
    f.native.read = async () => { throw new Error('A cached answer must not require native state'); };
    await f.bridge.update(click(13, answer.callback_data, receipt.messageId!)); await f.drain();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Historical full reply')));
    assert.equal(f.native.writes.length, 0);
  } finally { f.close(); }
});

test('an interrupted preflight unlocks on disk recovery and a committed clear binding survives restart', () => {
  const temp = temporary(); let state: State | undefined;
  try {
    const home = join(temp.dir, 'private'); state = new State(home);
    state.bind('old', 101, temp.dir, 'Old'); const old = state.binding('old')!;
    const op = { id: 'clear-op', status: 'checking' as const, topicId: 101, reset: old, menuKey: 'notice/clear/clear-op', token: '', expires: 1, choices: [], page: 0 };
    state.createNewSession(op); state.close(); state = new State(home);
    assert.equal(state.newSession(op.id)!.status, 'failed'); assert.equal(state.resettingTopic(101), false);
    const ready = state.changeNewSession(op.id, 'failed', { status: 'topic', threadId: 'next' })!;
    state.resetTopic(ready); state.close(); state = new State(home);
    assert.equal(state.topic(101)!.threadId, 'next'); assert.equal(state.retiredSession('old'), true);
    assert.equal(state.historicalAnswerBinding(old), true);
    state.installTopic('next', 555, temp.dir, 'Moved'); assert.equal(state.historicalAnswerBinding(old), false);
  } finally { state?.close(); temp.close(); }
});

test('/clear delivers a missed completed reply before replacing its original session', async () => {
  const f = setup();
  try {
    const old = await originalSession(f);
    f.native.histories.get(old.threadId)!.unshift({ id: 'missed', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Completed before clear' }] });
    await f.bridge.update(message(10, old.topicId, '/clear')); await f.bridge.workNewSession(); await f.drain();
    assert.equal(f.native.starts, 0, 'a missed reply must be queued before the old binding can be retired');
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Completed before clear')));
    await f.bridge.update(message(11, old.topicId, '/clear')); await f.bridge.workNewSession();
    assert.equal(f.native.starts, 1);
  } finally { f.close(); }
});

test('/clear recovery uses its validated history snapshot without importing another response', async () => {
  const f = setup();
  try {
    const old = await originalSession(f); let reads = 0;
    f.native.turns = async () => ++reads === 1 ? [
      { id: 'missed', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Validated missed reply' }] },
      { id: 'old', status: 'completed' },
    ] : [{ id: 'unrelated', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Unrelated old history' }] }];
    await f.bridge.update(message(10, old.topicId, '/clear')); await f.drain();
    assert.equal(reads, 1); assert.equal(f.state.binding(old.threadId)!.lastTurn, 'missed');
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Validated missed reply')));
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('Unrelated old history')), false);
    assert.equal(f.native.starts, 0);
  } finally { f.close(); }
});

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
    this.sessions.push({ id, cwd, name: '', status: 'idle' });
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

function setup() {
  const temp = temporary(); const project = join(temp.dir, 'project'); const scratch = join(temp.dir, 'conversations');
  mkdirSync(project); mkdirSync(scratch);
  const config: Config = { version: 1, ownerId: 42, roots: [project], codexBinary: process.execPath,
    newSessions: { projects: [project], scratchRoot: scratch } };
  const state = new State(join(temp.dir, 'private')); const native = new Native(); const telegram = new FakeTelegram();
  const bridge = new Bridge(config, state, native, telegram);
  const outbox = new Outbox(state, telegram, config, 0);
  const drain = async () => { while (await outbox.flushOne()) { /* Deliver controls. */ } };
  const open = async (topic?: number) => {
    const update = message(100 + state.newSessions().length, topic ?? 999, '/new');
    if (topic === undefined) delete object(update.message).message_thread_id;
    await bridge.update(update); await drain(); return state.newSessions().at(-1)!;
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
    assert.equal(binding.lastTurn, '-'); assert.equal(binding.projectLabel, 'Без проекта'); assert.match(binding.title, /^Без проекта · /u);
    assert.equal(f.native.writes.length, 0);
    await f.bridge.update(message(300, binding.topicId, 'Research this'));
    assert.deepEqual(f.native.writes[0], { method: 'start', params: { threadId: completed.threadId, text: 'Research this' } });
    await f.bridge.notification('turn/completed', { threadId: completed.threadId, turn: { id: 'first', status: 'completed', items: [{ type: 'agentMessage', text: 'First answer' }] } });
    await f.drain();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('First answer') && string(item.text).startsWith('» Без проекта')));
  } finally { f.close(); }
});

test('project selection preserves the originating binding and never copies history or dispatches a task', async () => {
  const f = setup();
  try {
    f.native.sessions.push({ id: 'original-thread', cwd: f.project, name: 'Old task', status: 'idle' });
    await f.bridge.discover(); const original = f.state.binding('original-thread')!;
    const op = await f.open(original.topicId); assert.match(op.choices[1]!.label, /Этот проект/u);
    await f.choose(1); await f.bridge.workNewSession();
    assert.equal(f.state.binding('original-thread')!.topicId, original.topicId);
    assert.notEqual(f.state.binding(f.state.newSession(op.id)!.threadId!)!.topicId, original.topicId);
    assert.equal(f.native.writes.length, 0); assert.equal(f.state.newSession(op.id)!.cwd, f.project);
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
  const f = setup();
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

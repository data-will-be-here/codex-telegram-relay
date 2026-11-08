import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { State } from '../src/state.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { array, object, string, type RpcRequest } from '../src/types.js';
import { fixture, click, messageBody, approvalBody, temporary, FakeCodex, FakeTelegram } from './helpers.js';

const request: RpcRequest = { id: 'pending-approval', method: 'item/commandExecution/requestApproval', params: {
  threadId: 'thread-a', turnId: 'turn-a', itemId: 'command-a', command: 'echo waiting-for-owner', availableDecisions: ['accept', 'cancel'],
} };
function control(markup: unknown): string {
  return string(object(array(array(object(markup).inline_keyboard)[0])[0]).callback_data);
}

async function persistentFixture() {
  const temp = temporary(); const project = join(temp.dir, 'project'); mkdirSync(project);
  const config = { version: 1 as const, ownerId: 42, roots: [project], codexBinary: process.execPath };
  let codex = new FakeCodex(); const telegram = new FakeTelegram();
  codex.sessions = [{ id: 'thread-a', cwd: project, name: 'Project', status: 'idle' }];
  codex.pending.add(request.id);
  let state = new State(join(temp.dir, 'state'));
  let bridge = new Bridge(config, state, codex, telegram);
  await bridge.discover();
  return {
    telegram, get codex() { return codex; },
    get state() { return state; }, get bridge() { return bridge; },
    reconnect: async (reopen = false, replaceClient = false) => {
      if (reopen) { state.close(); state = new State(join(temp.dir, 'state')); }
      if (replaceClient) {
        const previous = codex; codex = new FakeCodex(); codex.sessions = previous.sessions;
        for (const id of previous.pending) codex.pending.add(id);
        previous.pending.clear();
      }
      bridge = new Bridge(config, state, codex, telegram); await bridge.discover();
    },
    drain: async () => { const outbox = new Outbox(state, telegram, config, 0); while (await outbox.flushOne()) {} },
    close: () => { state.close(); temp.close(); },
  };
}

test('replaying an unanswered approval keeps one card with fresh controls bound to the current request', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add(request.id);
    await f.bridge.request(request); await f.drain();
    const card = f.telegram.sent().find(s => messageBody(s).includes('waiting-for-owner'))!;
    const oldControl = control(card.reply_markup);
    let bridge = f.bridge;
    for (let reconnect = 0; reconnect < 3; reconnect++) {
      bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
      await bridge.discover(); await bridge.request(request); await f.drain();
    }
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
    const edits = f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup');
    assert.equal(edits.length, 3, 'Each connection refreshes the existing card instead of posting another');
    assert.ok(edits.every(edit => edit.params.message_id === 1001));
    const refreshed = control(edits.at(-1)!.params.reply_markup);
    assert.notEqual(refreshed, oldControl);
    await bridge.update(click(1, oldControl));
    await bridge.update(click(2, refreshed, 102));
    await bridge.update(click(3, refreshed, 101, 99));
    assert.equal(f.codex.writes.length, 0);
    await bridge.update(click(4, refreshed));
    await bridge.update(click(5, refreshed));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: request.id, result: { decision: 'accept' } } }]);
  } finally { f.close(); }
});

test('an unsent approval survives process restart but stays held until the native request is replayed', async () => {
  const f = await persistentFixture();
  try {
    await f.bridge.request(request);
    await f.reconnect(true); await f.drain();
    assert.equal(f.telegram.sent().length, 0, 'Old controls must not be sent before a live replay');
    await f.bridge.request(request); await f.drain();
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
    const original = control(f.telegram.sent()[0]!.reply_markup);
    await f.reconnect(true); await f.bridge.request(request); await f.drain();
    assert.equal(f.telegram.sent().length, 1, 'A confirmed receipt also survives process restart');
    const edit = f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').at(-1)!;
    assert.notEqual(control(edit.params.reply_markup), original);
  } finally { f.close(); }
});

test('a lost Telegram send acknowledgement stays uncertain across reconnect and process restart without another submission', async () => {
  const f = await persistentFixture();
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'sendMessage' && params.reply_markup) throw new TelegramError('Synthetic lost send acknowledgement', 0);
      return result;
    };
    await f.bridge.request(request); await assert.rejects(f.drain(), /lost send acknowledgement/u);
    for (const reopen of [false, true, true]) {
      await f.reconnect(reopen); await f.bridge.request(request); await f.drain();
    }
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
    assert.equal(f.state.uncertainCount(), 1);
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('an uncertain native approval decision cannot be rearmed by reconnecting to the same pending request', async () => {
  const f = await persistentFixture();
  try {
    let responses = 0;
    f.codex.respond = async () => { responses++; throw new RpcError('Synthetic native response outcome unknown', true); };
    await f.bridge.request(request); await f.drain();
    const original = control(f.telegram.sent()[0]!.reply_markup);
    await assert.rejects(f.bridge.update(click(1, original)), /native response outcome unknown/u);
    const before = f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').length;
    await f.reconnect(true); await f.bridge.request(request); await f.drain();
    const newControls = f.telegram.calls.slice().filter(c => c.method === 'editMessageReplyMarkup').slice(before)
      .filter(c => array(object(c.params.reply_markup).inline_keyboard).length);
    assert.equal(newControls.length, 0, 'A consumed decision must remain consumed across process restart');
    await f.bridge.update(click(2, original));
    assert.equal(responses, 1);
  } finally { f.close(); }
});

test('an approval still waiting after a week retains its receipt and does not publish another card', async () => {
  const f = await persistentFixture();
  const now = Date.now;
  try {
    await f.bridge.request(request); await f.drain();
    const future = now() + 8 * 24 * 60 * 60 * 1000;
    Date.now = () => future;
    await f.reconnect(true); await f.bridge.request(request); await f.drain();
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
  } finally { Date.now = now; f.close(); }
});

test('a temporary keyboard edit failure is retried on the known card without another post or native reconnect', async () => {
  const f = await persistentFixture();
  const now = Date.now;
  try {
    await f.bridge.request(request); await f.drain();
    const oldControl = control(f.telegram.sent()[0]!.reply_markup);
    const call = f.telegram.call.bind(f.telegram); let edits = 0;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'editMessageReplyMarkup' && ++edits === 1) throw new TelegramError('Synthetic edit timeout', 0);
      return call(method, params);
    };
    await f.reconnect();
    await f.bridge.request(request);
    const future = now() + 31_000; Date.now = () => future;
    await f.bridge.discover(); await f.drain();
    const refreshed = f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').at(-1)!;
    assert.ok(refreshed);
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
    assert.equal(edits, 2);
    await f.bridge.update(click(1, oldControl));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(click(2, control(refreshed.params.reply_markup)));
    assert.equal(f.codex.writes.filter(w => w.method === 'respond').length, 1);
  } finally { Date.now = now; f.close(); }
});

test('recovering a topic cannot rearm a native decision whose delivery is uncertain', async () => {
  const f = await persistentFixture();
  try {
    f.codex.respond = async () => { throw new RpcError('Synthetic native response outcome unknown', true); };
    await f.bridge.request(request); await f.drain();
    await assert.rejects(f.bridge.update(click(1, control(f.telegram.sent()[0]!.reply_markup))), /native response outcome unknown/u);
    f.state.missingTopic(f.state.binding('thread-a')!);
    await f.bridge.discover(); await f.bridge.request(request); await f.drain();
    assert.notEqual(f.state.binding('thread-a')!.topicId, 101);
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1,
      'The native decision belongs to the request, independently of its destination topic');
  } finally { f.close(); }
});

test('reconnect during a card send refreshes the eventual receipt without submitting a second card', async () => {
  const f = await persistentFixture();
  let release!: () => void; let started!: () => void;
  const sendingStarted = new Promise<void>(done => { started = done; });
  const heldSend = new Promise<void>(done => { release = done; });
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'sendMessage' && params.reply_markup) { started(); await heldSend; }
      return result;
    };
    await f.bridge.request(request);
    const sending = f.drain(); await sendingStarted;
    const oldControl = control(f.telegram.sent()[0]!.reply_markup);
    await f.reconnect(); await f.bridge.request(request);
    release(); await sending;
    await f.bridge.flushApproval();
    assert.equal(f.telegram.sent().length, 1);
    const refreshed = f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').at(-1)!;
    assert.ok(refreshed);
    await f.bridge.update(click(1, oldControl));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(click(2, control(refreshed.params.reply_markup)));
    assert.equal(f.codex.writes.filter(w => w.method === 'respond').length, 1);
  } finally { release(); f.close(); }
});

test('multipart approval replay edits only the final control message and preserves all review text', async () => {
  const f = await persistentFixture();
  try {
    const command = 'echo literal-command-content';
    const long = { ...request, params: { ...request.params, command, reason: 'Complete review context. '.repeat(300) } };
    await f.bridge.request(long); await f.drain();
    const parts = f.telegram.sent().length; const lastMessage = f.telegram.message;
    assert.ok(parts > 1);
    assert.ok(f.telegram.sent().map(approvalBody).join('').includes(command));
    assert.ok(f.telegram.sent().slice(0, -1).every(part => !part.reply_markup));
    await f.reconnect(); await f.bridge.request(long); await f.drain();
    assert.equal(f.telegram.sent().length, parts);
    assert.equal(f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').at(-1)!.params.message_id, lastMessage);
  } finally { f.close(); }
});

test('a changed native proposal invalidates its previous controls instead of hiding new permission context', async () => {
  const f = await persistentFixture();
  try {
    await f.bridge.request(request); await f.drain();
    const oldControl = control(f.telegram.sent()[0]!.reply_markup);
    const changed = { ...request, params: { ...request.params, additionalPermissions: { fileSystem: { write: ['/synthetic/new-target'] } } } };
    await f.bridge.request(changed); await f.drain();
    const cards = f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner'));
    assert.equal(cards.length, 2);
    assert.match(messageBody(cards[1]!), /new-target/u);
    await f.bridge.update(click(1, oldControl));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(click(2, control(cards[1]!.reply_markup)));
    assert.equal(f.codex.writes.filter(w => w.method === 'respond').length, 1);
  } finally { f.close(); }
});

test('different native request IDs keep independent approvals even when their visible proposals match', async () => {
  const f = await persistentFixture();
  try {
    for (const id of [1, '1']) {
      f.codex.pending.add(id);
      await f.bridge.request({ ...request, id }); await f.drain();
    }
    const cards = f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner'));
    assert.equal(cards.length, 2);
    await f.bridge.update(click(1, control(cards[0]!.reply_markup)));
    await f.bridge.update(click(2, control(cards[1]!.reply_markup)));
    assert.deepEqual(f.codex.writes.filter(w => w.method === 'respond').map(w => w.params.id), [1, '1']);
  } finally { f.close(); }
});

test('held approvals wait for queue admission after restart and resume when space is available', async () => {
  const f = await persistentFixture();
  try {
    await f.bridge.request(request); await f.reconnect(true);
    for (let index = 0; index < 1000; index++) f.state.enqueue(`backlog/${index}`, 101, 'Synthetic queued message');
    await f.bridge.request(request);
    for (let index = 0; index < 1000; index++) {
      const delivery = f.state.next()!;
      assert.equal(delivery.key, `backlog/${index}`, 'The held card must not bypass the full admission queue');
      f.state.delivered(delivery.id, 2000 + index);
    }
    assert.equal(f.state.next(), undefined);
    await f.bridge.flushApproval(); await f.drain();
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
  } finally { f.close(); }
});

test('a native resolution before replay cancels a held card and allows its normal retention cleanup', async () => {
  const f = await persistentFixture();
  const now = Date.now;
  try {
    await f.bridge.request(request);
    const key = f.state.next()!.key;
    await f.reconnect(true);
    f.codex.pending.delete(request.id);
    await f.bridge.notification('serverRequest/resolved', { threadId: 'thread-a', requestId: request.id });
    assert.equal(f.state.approvalReceipt(key)?.status, 'cancelled');
    const future = now() + 8 * 24 * 60 * 60 * 1000; Date.now = () => future;
    f.state.prune();
    assert.equal(f.state.approvalReceipt(key), undefined);
    await f.drain(); assert.equal(f.telegram.sent().length, 0);
  } finally { Date.now = now; f.close(); }
});

for (const consumeBeforeLateEdit of [false, true]) test(`a late keyboard edit from a disconnected Bridge preserves ${consumeBeforeLateEdit ? 'closed' : 'current'} controls`, async () => {
  const f = await persistentFixture(); const now = Date.now;
  let release!: () => void; let started!: () => void; let oldRefresh: Promise<void> | undefined;
  const editStarted = new Promise<void>(done => { started = done; });
  const holdEdit = new Promise<void>(done => { release = done; });
  let visibleMarkup: unknown;
  try {
    await f.bridge.request(request); await f.drain();
    const call = f.telegram.call.bind(f.telegram); let delayed = false;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'editMessageReplyMarkup') {
        if (!delayed) { delayed = true; started(); await holdEdit; }
        visibleMarkup = params.reply_markup;
      }
      return call(method, params);
    };
    await f.reconnect(); oldRefresh = f.bridge.request(request); await editStarted;
    await f.reconnect(false, true); await f.bridge.request(request);
    const currentControl = control(visibleMarkup);
    assert.ok(currentControl);
    if (consumeBeforeLateEdit) await f.bridge.update(click(1, currentControl));
    release(); await oldRefresh;
    const future = now() + 2000; Date.now = () => future;
    await f.bridge.flushApproval();
    assert.equal(control(visibleMarkup), consumeBeforeLateEdit ? '' : currentControl, 'Late old work must be reconciled to the current request state');
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('waiting-for-owner')).length, 1);
    if (!consumeBeforeLateEdit) await f.bridge.update(click(1, currentControl));
    assert.equal(f.codex.writes.filter(w => w.method === 'respond').length, 1);
  } finally { release(); await oldRefresh?.catch(() => undefined); Date.now = now; f.close(); }
});

test('a late missing-topic error from an old card cannot replace a healthy recovered topic', async () => {
  const f = await persistentFixture();
  let release!: () => void; let started!: () => void; let oldRefresh: Promise<void> | undefined;
  const editStarted = new Promise<void>(done => { started = done; });
  const holdEdit = new Promise<void>(done => { release = done; });
  try {
    await f.bridge.request(request); await f.drain();
    const call = f.telegram.call.bind(f.telegram); let delayed = false;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'editMessageReplyMarkup' && !delayed) {
        delayed = true; started(); await holdEdit;
        throw new TelegramError('Bad Request: message thread not found', 400);
      }
      return call(method, params);
    };
    await f.reconnect(); oldRefresh = f.bridge.request(request); await editStarted;
    f.state.missingTopic(f.state.binding('thread-a')!);
    await f.bridge.discover(); await f.bridge.request(request); await f.drain();
    const topic = f.state.binding('thread-a')!.topicId;
    assert.notEqual(topic, 101);
    release(); await oldRefresh;
    assert.equal(f.state.topicOperation('thread-a'), undefined);
    await f.bridge.discover();
    assert.equal(f.state.binding('thread-a')!.topicId, topic);
  } finally { release(); await oldRefresh?.catch(() => undefined); f.close(); }
});

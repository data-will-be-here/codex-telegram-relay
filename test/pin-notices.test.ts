import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { object, type Json } from '../src/types.js';
import { fixture, temporary, FakeTelegram } from './helpers.js';

async function setup() {
  const f = await fixture();
  const binding = f.state.binding('thread-a')!;
  f.state.saveWidget({ id: 'owned-card', token: 'token', generation: f.bridge.widgetDelivery().generation, binding,
    turnId: 'turn', view: 'widgets', revision: 1, createdAt: Date.now(),
    snapshot: { status: 'working', startedAt: null, finishedAt: null, updatedAt: Date.now(), plan: null, activities: [] } });
  f.state.widgetDelivered('owned-card', 1, 1001, Date.now()); f.state.widgetPinResult('owned-card', 'pinned');
  return f;
}
function service(updateId = 1, serviceId = 1067): Json {
  return { update_id: updateId, message: { message_id: serviceId, from: { id: 900, is_bot: true },
    chat: { id: 42, type: 'private' }, message_thread_id: 101,
    pinned_message: { message_id: 1001, from: { id: 900, is_bot: true }, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } };
}

test('only the service notice is deleted, once, without changing the pin or sending a native instruction', async () => {
  const f = await setup();
  try {
    await f.bridge.update(service()); await f.bridge.update(service(2)); await f.drain();
    assert.deepEqual(f.telegram.calls.filter(c => c.method === 'deleteMessage').map(c => c.params), [{ chat_id: 42, message_id: 1067 }]);
    assert.equal(f.telegram.calls.some(c => /pinChatMessage/u.test(c.method)), false);
    assert.equal(f.state.widgetCard('thread-a', 'turn')!.messageId, 1001); assert.deepEqual(f.codex.writes, []);
    assert.equal(f.telegram.sent().length, 0); assert.equal(f.state.offset(), 3);
  } finally { f.close(); }
});

test('a service event in the root or another service topic still uses the recorded pinned subject', async () => {
  for (const outerTopic of [undefined, 999]) {
    const f = await setup();
    try {
      const update = service(); const message = object(update.message);
      if (outerTopic === undefined) delete message.message_thread_id; else message.message_thread_id = outerTopic;
      await f.bridge.update(update); await f.drain();
      assert.equal(f.telegram.calls.filter(c => c.method === 'deleteMessage').length, 1); assert.deepEqual(f.codex.writes, []);
    } finally { f.close(); }
  }
});

test('manual pins, foreign chats, unknown subjects, forwarded text and invalid IDs are preserved', async () => {
  const f = await setup();
  try {
    const mutations: ((message: Json) => void)[] = [
      message => { message.from = { id: 42, is_bot: false }; },
      message => { object(message.chat).id = 99; },
      message => { object(message.chat).type = 'group'; },
      message => { object(message.pinned_message).message_id = 2222; },
      message => { object(object(message.pinned_message).chat).id = 99; },
      message => { object(object(message.pinned_message).from).id = 901; },
      message => { object(message.pinned_message).message_thread_id = 102; },
      message => { message.forward_origin = { type: 'user' }; },
      message => { message.text = 'A regular message with a copied pin description'; },
      message => { message.message_id = 1001; },
      message => { message.message_id = 0; },
    ];
    for (const [index, mutate] of mutations.entries()) { const update = service(index + 1); mutate(object(update.message)); await f.bridge.update(update); }
    await f.drain(); assert.equal(f.telegram.calls.some(c => c.method === 'deleteMessage'), false); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('an uncertain deletion retries the same service ID and already-deleted is treated as success', async () => {
  const f = await setup(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const call = f.telegram.call.bind(f.telegram); let deletes = 0;
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'deleteMessage') { deletes++; throw new TelegramError(deletes === 1 ? 'Lost deletion receipt' : 'message to delete not found', deletes === 1 ? 0 : 400); }
      return result;
    };
    await f.bridge.update(service()); await f.drain(); assert.equal(deletes, 1);
    now += 2999; await f.drain(); assert.equal(deletes, 1);
    now++; await f.drain(); assert.equal(deletes, 2); assert.equal(f.state.uncertainCount(), 0);
    assert.equal(f.state.deliveryExists('notice/widget-pin-cleanup/42/1067'), true); assert.deepEqual(f.codex.writes, []);
  } finally { Date.now = realNow; f.close(); }
});

test('a known deletion receipt retries local persistence without repeating the API request', async () => {
  const f = await setup(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const delivered = f.state.delivered.bind(f.state); let fail = true;
    f.state.delivered = (...args) => { if (fail) { fail = false; throw new Error('Synthetic local write failure'); } return delivered(...args); };
    await f.bridge.update(service()); await f.drain(); now += 1000; await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'deleteMessage').length, 1); assert.equal(f.state.uncertainCount(), 0);
  } finally { Date.now = realNow; f.close(); }
});

test('narrowed project scope cancels queued cleanup', async () => {
  const f = await setup();
  try {
    await f.bridge.update(service()); f.bridge.config.roots = []; await f.drain();
    assert.equal(f.telegram.calls.some(c => c.method === 'deleteMessage'), false); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a crash during cleanup safely resumes deletion of the exact known service message after SQLite reopen', async () => {
  const temp = temporary(); const project = join(temp.dir, 'project'); mkdirSync(project);
  const config = { version: 1 as const, ownerId: 42, roots: [project], codexBinary: process.execPath };
  const telegram = new FakeTelegram(); let state = new State(join(temp.dir, 'private'));
  try {
    state.installTopic('thread-a', 101, project, 'Project');
    state.enqueueScreen('notice/widget-pin-cleanup/42/1067', 101, '', null, [{ method: 'deleteMessage', params: { chat_id: 42, message_id: 1067 } }]);
    state.sending(state.next()!.id); state.close(); state = new State(join(temp.dir, 'private'));
    const outbox = new Outbox(state, telegram, config, 0); assert.equal(await outbox.flushOne(), true);
    assert.deepEqual(telegram.calls, [{ method: 'deleteMessage', params: { chat_id: 42, message_id: 1067 } }]);
    assert.equal(state.uncertainCount(), 0);
  } finally { state.close(); temp.close(); }
});

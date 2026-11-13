import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { State, type RichDeliveryPart } from '../src/state.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { fixture, temporary, FakeTelegram } from './helpers.js';
import { type Json } from '../src/types.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = 'final/thread-a/finished';
const pinCalls = (f: Fixture) => f.telegram.calls.filter(c => c.method === 'pinChatMessage');
function answer(f: Fixture, method: RichDeliveryPart['method'] = 'sendWidget', count = 3): void {
  const parts: RichDeliveryPart[] = Array.from({ length: count }, (_, index) => ({ method,
    params: method === 'sendMessage' ? { text: `Synthetic part ${index + 1}` } : method === 'sendRichMessage' ? { rich_message: { blocks: [] } } : { html: '<html><body>Synthetic part</body></html>', chat_data: '{}' },
    ...(method === 'sendDocument' ? { document: { name: 'synthetic-table.html', html: '<html><body>Table</body></html>' } } : {}),
    fallback: `Synthetic part ${index + 1}`, fallbackText: { text: `Synthetic part ${index + 1}`, entities: [] } }));
  f.state.enqueueWidgetAnswer(key, f.state.binding('thread-a')!, 'Complete synthetic answer', 'a'.repeat(32), parts);
}
function service(messageId: number): Json {
  return { update_id: 100, message: { message_id: 2000, from: { id: 900, is_bot: true }, chat: { id: 42, type: 'private' },
    pinned_message: { message_id: messageId, from: { id: 900, is_bot: true }, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } };
}

for (const method of ['sendWidget', 'sendMessage', 'sendRichMessage', 'sendDocument'] as const)
  test(`a multipart ${method} final quietly pins its first receipt and removes only its service notice`, async () => {
    const f = await fixture();
    try {
      if (method === 'sendDocument') Object.assign(f.telegram, { upload: async (_method: string, params: Json) => {
        f.telegram.calls.push({ method: 'sendDocument', params }); return { message_id: ++f.telegram.message };
      } });
      answer(f, method); await f.drain();
      assert.equal(f.telegram.calls.filter(c => c.method === method).length, 3);
      assert.deepEqual(pinCalls(f).map(c => c.params), [{ chat_id: 42, message_id: 1001, disable_notification: true }]);
      await f.bridge.update(service(1001)); await f.drain();
      assert.deepEqual(f.telegram.calls.filter(c => c.method === 'deleteMessage').map(c => c.params), [{ chat_id: 42, message_id: 2000 }]);
      assert.equal(f.telegram.calls.some(c => /unpin/u.test(c.method)), false); assert.deepEqual(f.codex.writes, []);
    } finally { f.close(); }
  });

test('a normal Classic final is pinned, but status snapshots and text copies are not', async () => {
  const f = await fixture();
  try {
    f.state.enqueue(key, 101, 'Completed Classic answer.'); await f.drain();
    assert.deepEqual(pinCalls(f).map(c => c.params.message_id), [1001]);
    f.state.enqueueWidgetAnswer('attention/widget-step/snapshot', f.state.binding('thread-a')!, 'Status snapshot', 'b'.repeat(32),
      { method: 'sendWidget', params: { html: '<html><body>Snapshot</body></html>' } });
    f.state.enqueue('attention/widget-answer/copy', 101, 'Text version'); await f.drain();
    assert.equal(pinCalls(f).length, 1); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

for (const firstConfirmed of [false, true]) test(`uncertain result delivery pins the first confirmed ${firstConfirmed ? 'original part' : 'text backup'}`, async () => {
  const f = await fixture();
  try {
    const call = f.telegram.call.bind(f.telegram); let sends = 0;
    f.telegram.call = async (method, params = {}) => { const result = await call(method, params);
      if (method === 'sendWidget' && ++sends === (firstConfirmed ? 2 : 1)) throw new TelegramError('Lost result receipt', 0); return result; };
    answer(f, 'sendWidget', 2); await f.drain();
    assert.deepEqual(pinCalls(f).map(c => c.params.message_id), [firstConfirmed ? 1001 : 1002]);
    assert.equal(pinCalls(f).length, 1);
  } finally { f.close(); }
});

test('unknown final pin outcomes do not repeat, affect answer delivery or count as uncertain replies', async () => {
  const f = await fixture();
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => { const result = await call(method, params); if (method === 'pinChatMessage') throw new TelegramError('Lost pin receipt', 0); return result; };
    answer(f, 'sendWidget', 1); await f.drain();
    await new Outbox(f.state, f.telegram, f.bridge.config, 0).flushOne();
    assert.equal(pinCalls(f).length, 1); assert.equal(f.state.uncertainCount(), 0);
    assert.ok(f.state.pinnedRelayMessage(1001, 42)); assert.equal(f.state.pinnedRelayMessage(1001, 99), undefined);
    await f.bridge.update(service(1001)); await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'deleteMessage').length, 1);
  } finally { f.close(); }
});

test('rate-limited final pin retries only its known first message', async () => {
  const f = await fixture(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const call = f.telegram.call.bind(f.telegram); let tries = 0;
    f.telegram.call = async (method, params = {}) => { const result = await call(method, params);
      if (method === 'pinChatMessage' && tries++ === 0) throw new TelegramError('Retry later', 429, 4); return result; };
    answer(f, 'sendWidget', 2); await f.drain(); assert.equal(tries, 1);
    now += 4000; await f.drain(); assert.equal(tries, 2);
    assert.deepEqual(pinCalls(f).map(c => c.params.message_id), [1001, 1001]);
    assert.equal(f.telegram.calls.filter(c => c.method === 'sendWidget').length, 2);
  } finally { Date.now = realNow; f.close(); }
});

test('delayed plain-backup pin persistence retains the first ID after later chunks change the last receipt', async () => {
  const f = await fixture(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const remember = f.state.rememberFinalPin.bind(f.state); let fail = true;
    f.state.rememberFinalPin = (...args) => { if (fail) { fail = false; throw new Error('Local write failed'); } return remember(...args); };
    f.state.enqueue('attention/final-widget-fallback/' + key, 101, 'Complete synthetic text backup. '.repeat(250));
    await f.drain(); assert.ok(f.telegram.sent().length > 1); now += 1000; await f.drain();
    assert.deepEqual(pinCalls(f).map(c => c.params.message_id), [1001]);
  } finally { Date.now = realNow; f.close(); }
});

test('atomic first-part receipt retries locally without another send or pinning a later part', async () => {
  const f = await fixture(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const remember = f.state.rememberFinalPin.bind(f.state); let fail = true;
    f.state.rememberFinalPin = (...args) => { if (fail) { fail = false; throw new Error('Local write failed'); } return remember(...args); };
    answer(f); await f.drain(); now += 1000; await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'sendWidget').length, 3);
    assert.deepEqual(pinCalls(f).map(c => c.params.message_id), [1001]);
  } finally { Date.now = realNow; f.close(); }
});

test('a queued final pin is cancelled when its session topic is rebound', async () => {
  const f = await fixture();
  try {
    answer(f, 'sendWidget', 1); const outbox = new Outbox(f.state, f.telegram, f.bridge.config, 0);
    await outbox.flushOne(); f.state.installTopic('thread-a', 505, f.projectA, 'Moved'); f.state.installTopic('thread-b', 101, f.projectB, 'Another session'); await f.drain();
    assert.equal(pinCalls(f).length, 0);
  } finally { f.close(); }
});

test('SQLite reopen never replays an in-flight final pin and still recognizes its service subject', async () => {
  const temp = temporary(); const project = join(temp.dir, 'project'); mkdirSync(project); let state = new State(join(temp.dir, 'private'));
  const config = { version: 1 as const, ownerId: 42, roots: [project], codexBinary: process.execPath }; const telegram = new FakeTelegram();
  try {
    state.installTopic('thread-a', 101, project, 'Project'); state.enqueue(key, 101, 'Completed answer.');
    await new Outbox(state, telegram, config, 0).flushOne(); const job = state.next()!; assert.match(job.key, /^notice\/final-pin\//u); state.sending(job.id);
    state.close(); state = new State(join(temp.dir, 'private'));
    const outbox = new Outbox(state, telegram, config, 0); while (await outbox.flushOne()) { /* No pin replay. */ }
    assert.equal(telegram.calls.some(c => c.method === 'pinChatMessage'), false);
    assert.ok(state.pinnedRelayMessage(1001, 42)); assert.equal(state.uncertainCount(), 0);
  } finally { state.close(); temp.close(); }
});

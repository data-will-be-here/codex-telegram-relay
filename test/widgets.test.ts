import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { Outbox, TelegramClient, TelegramError } from '../src/telegram.js';
import { State } from '../src/state.js';
import { WIDGET_HTML, widgetData } from '../src/widget-template.js';
import { Widgets } from '../src/widgets.js';
import { object, string, type Json } from '../src/types.js';
import { fixture, message, temporary } from './helpers.js';

async function setup() {
  const f = await fixture(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const outbox = new Outbox(f.state, f.telegram, f.bridge.config, 0);
  return { ...f, outbox, advance: (ms = 3000) => { now += ms; },
    start: async (id = 'live') => f.bridge.notification('turn/started', { threadId: 'thread-a', turn: { id, status: 'inProgress', startedAt: now / 1000 } }),
    flush: () => outbox.flushWidget(f.bridge.widgetDelivery()),
    close: () => { Date.now = realNow; f.close(); } };
}

test('/view is per-session, defaults to classic, latches each turn and never writes native settings/input', async () => {
  const f = await setup();
  try {
    await f.start('old'); await f.bridge.update(message(1, 101, '/view widgets')); await f.drain();
    assert.equal(f.state.viewMode('thread-a'), 'widgets'); assert.equal(f.state.viewMode('thread-b'), 'classic');
    f.advance(); assert.equal(await f.flush(), false, 'current classic turn keeps its view');
    await f.start(); f.advance(); assert.equal(await f.flush(), true);
    await f.bridge.update(message(2, 101, '/view classic')); await f.drain();
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'Do work', status: 'inProgress' }] });
    f.advance(); await f.flush();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.equal(f.telegram.calls.filter(call => call.method === 'editMessageWidgetData').length, 1, 'current widget turn keeps its view');
    await f.start('next'); f.advance(); await f.flush();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('one themed card shows actual bounded activity/plan and keeps final replies in the normal archive', async () => {
  const f = await setup();
  try {
    await f.bridge.update(message(1, 101, '/view widgets')); await f.drain(); await f.start();
    const event = { threadId: 'thread-a', turnId: 'live', item: { id: 'tool', type: 'commandExecution', command: 'SECRET_COMMAND', aggregatedOutput: 'SECRET_OUTPUT' } };
    await f.bridge.notification('item/started', event); await f.bridge.notification('item/started', event);
    await f.bridge.notification('item/started', { ...event, item: { id: 'reason', type: 'reasoning', text: 'SECRET_REASONING' } });
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'First', status: 'completed' }, { step: 'Second', status: 'inProgress' }] });
    f.advance(); await f.flush();
    const sent = f.telegram.calls.find(call => call.method === 'sendWidget')!.params;
    assert.equal(sent.message_thread_id, 101); assert.equal(sent.is_shared, false); assert.equal(sent.allow_queries, false); assert.equal(sent.public_data, undefined);
    const data = JSON.parse(string(sent.chat_data)); assert.deepEqual(data.n, [1, 2]); assert.deepEqual(data.a, [['running', 'Run command']]);
    assert.doesNotMatch(string(sent.chat_data), /SECRET_/u);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', text: 'Итоговый ответ', phase: 'final_answer' }] } });
    await f.drain(); f.advance(); await f.flush();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Итоговый ответ')));
    assert.equal(JSON.parse(string(f.telegram.calls.filter(call => call.method === 'editMessageWidgetData').at(-1)!.params.chat_data)).s, 'done');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('fast turns create no empty widget; failed tool calls do not fail the whole turn or invent a plan', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start('fast');
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'fast', status: 'completed' } });
    f.advance(); assert.equal(await f.flush(), false);
    await f.start();
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'bad', type: 'commandExecution' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'bad', type: 'commandExecution', exitCode: 1 } });
    f.advance(); await f.flush();
    const data = JSON.parse(string(f.telegram.calls.find(call => call.method === 'sendWidget')!.params.chat_data));
    assert.equal(data.s, 'working'); assert.equal(data.n, null); assert.deepEqual(data.a, [['failed', 'Run command']]);
  } finally { f.close(); }
});

test('widget progress stays in the card instead of repeating assistant steps as permanent text', async () => {
  const f = await setup();
  try {
    f.state.setMessageMode('all'); f.state.setViewMode('thread-a', 'widgets'); await f.start();
    const item = { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking the relay update queue' };
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item });
    assert.equal(await f.bridge.flushDraft(), false, 'commentary previews must stay inside the card too');
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item });
    f.advance(); await f.flush(); await f.drain();
    const sent = f.telegram.calls.find(call => call.method === 'sendWidget')!.params;
    assert.equal(sent.caption, undefined, 'the card must not add an explanatory text block below itself');
    assert.ok(string(sent.chat_data).includes(item.text), 'the live card must explain the current work');
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(item.text)), false, 'widget progress must not be repeated below the card');
  } finally { f.close(); }
});

test('a lost completion notification is reconciled on the existing card without reconnecting', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start();
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'tool', type: 'commandExecution' } });
    f.advance(); await f.flush(); const messageId = f.state.widgetCard('thread-a', 'live')!.messageId;
    const turn = { id: 'live', status: 'completed', items: [{ id: 'tool', type: 'commandExecution', status: 'completed', exitCode: 0 }, { type: 'agentMessage', phase: 'final_answer', text: 'Recovered final reply' }] };
    f.codex.histories.set('thread-a', [turn]);
    f.advance(30_000); await f.bridge.discover(); await f.flush();
    await f.drain();
    assert.equal(f.state.widgetCard('thread-a', 'live')!.snapshot.status, 'done');
    assert.equal(f.state.widgetCard('thread-a', 'live')!.messageId, messageId);
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.ok(f.telegram.sent().some(message => string(message.text).includes('Recovered final reply')));
    assert.equal(f.state.binding('thread-a')!.lastTurn, 'live');
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Recovered final reply')).length, 1);
  } finally { f.close(); }
});

test('unknown send outcomes are durable and never replayed, while ordinary output remains usable', async () => {
  const f = await setup(); let sends = 0;
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    const original = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') { sends++; throw new TelegramError('Connection lost', 0); } return original(method, params); };
    await f.flush(); f.advance(); await f.flush();
    assert.equal(sends, 1); assert.equal(f.state.widgetCards('thread-a')[0]!.delivery, 'uncertain');
    await f.drain(); await f.bridge.update(message(1, 101, '/status')); await f.drain();
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Connected sessions')));
    f.bridge.close(); const next = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    f.codex.histories.set('thread-a', [{ id: 'live', status: 'inProgress' }]); await next.discover();
    f.advance(); await f.outbox.flushWidget(next.widgetDelivery()); next.close(); assert.equal(sends, 1);
  } finally { f.close(); }
});

test('proven pre-connect failures retry widget delivery after three seconds without an uncertain admission', async () => {
  const f = await setup(); let attempts = 0;
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    const api = new TelegramClient('123456:synthetic_token', async () => {
      if (attempts++ === 0) throw new TypeError('fetch failed', { cause: Object.assign(new Error('credential-bearing URL must not be retained'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }));
    });
    const original = f.telegram.call.bind(f.telegram);
    f.telegram.call = (method, params) => method === 'sendWidget' ? api.call(method, params) : original(method, params);
    await f.flush(); assert.equal(f.state.widgetCard('thread-a', 'live')!.delivery, 'new');
    assert.equal(f.state.uncertainCount(), 0); f.advance(2999); assert.equal(await f.flush(), false);
    f.advance(1); await f.flush(); assert.equal(attempts, 2);
    assert.equal(f.state.widgetCard('thread-a', 'live')!.messageId, 9001);
  } finally { f.close(); }
});

test('safe tool details distinguish actions without exposing command arguments or tool payloads', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start();
    for (const item of [
      { id: 'read', type: 'commandExecution', command: 'SECRET_COMMAND', commandActions: [{ type: 'read', path: 'C:\\work\\src\\state.ts', command: 'SECRET_ARGUMENT' }] },
      { id: 'test', type: 'commandExecution', command: 'npm test --token SECRET_TOKEN' },
      { id: 'tool', type: 'mcpToolCall', server: 'private-server', tool: 'read_status', arguments: { token: 'SECRET_PAYLOAD' } },
    ]) await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item });
    f.advance(); await f.flush();
    const data = string(f.telegram.calls.find(call => call.method === 'sendWidget')!.params.chat_data);
    assert.match(data, /state\.ts/u); assert.match(data, /npm/u); assert.match(data, /read_status/u);
    assert.doesNotMatch(data, /SECRET_|C:\\|private-server/u);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed' } });
    assert.ok(f.state.widgetCard('thread-a', 'live')!.snapshot.activities.every(activity => activity.status !== 'running'));
  } finally { f.close(); }
});

test('an unknown initial send releases the latest suppressed progress once as a classic fallback', async () => {
  const f = await setup();
  try {
    f.state.setMessageMode('all'); f.state.setViewMode('thread-a', 'widgets'); await f.start();
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking the update delivery queue' } });
    await f.drain(); assert.equal(f.telegram.sent().some(message => string(message.text).includes('Checking the update delivery queue')), false);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') throw new TelegramError('Unknown outcome', 0); return call(method, params); };
    f.advance(); await f.flush(); await f.drain(); f.advance(); await f.flush(); await f.drain();
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Checking the update delivery queue')).length, 1);
    assert.equal(f.state.viewMode('thread-a'), 'classic');
  } finally { f.close(); }
});

test('a quiet running tool gets native status checks without a lost-event replay or stale completion overwrite', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance(); await f.flush();
    f.codex.histories.set('thread-a', [{ id: 'live', status: 'inProgress' }]);
    const before = f.state.widgetCard('thread-a', 'live')!.snapshot.updatedAt;
    f.advance(16_000); await f.bridge.discover();
    assert.ok(f.state.widgetCard('thread-a', 'live')!.snapshot.updatedAt > before);
    const read = f.codex.turns.bind(f.codex); let polling = false;
    f.codex.turns = async (id, timeoutMs?: number) => {
      if (timeoutMs === 3000 && !polling) {
        polling = true;
        await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Finished during poll' }] } });
      }
      return read(id);
    };
    f.advance(16_000); await f.bridge.discover();
    assert.equal(f.state.widgetCard('thread-a', 'live')!.snapshot.status, 'done');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('recovering an older missed completion preserves the newer final baseline', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start('older'); f.advance(); await f.flush();
    await f.start('newer');
    const newer = { id: 'newer', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Newer final' }] };
    const older = { id: 'older', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Older recovered final' }] };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: newer }); await f.drain();
    f.codex.histories.set('thread-a', [newer, older]);
    f.advance(16_000); await f.bridge.discover(); await f.drain();
    assert.equal(f.state.binding('thread-a')!.lastTurn, 'newer');
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Older recovered final')).length, 1);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: older }); await f.drain();
    assert.equal(f.state.binding('thread-a')!.lastTurn, 'newer');
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Older recovered final')).length, 1);
  } finally { f.close(); }
});

test('a received widget message is retained when local receipt persistence fails temporarily', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    const delivered = f.state.widgetDelivered.bind(f.state); let fail = true;
    f.state.widgetDelivered = (...args) => { if (fail) { fail = false; throw new Error('Database busy'); } delivered(...args); };
    await f.flush(); f.advance(); await f.flush();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.equal(f.state.widgetCard('thread-a', 'live')!.delivery, 'active');
    assert.ok(f.state.widgetCard('thread-a', 'live')!.messageId);
  } finally { f.close(); }
});

test('widget retry outcomes survive a temporary local state write failure', async () => {
  const f = await setup(); let attempts = 0;
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    const result = f.state.widgetResult.bind(f.state); let fail = true;
    f.state.widgetResult = (...args) => { if (fail) { fail = false; throw new Error('Database busy'); } result(...args); };
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'sendWidget' && attempts++ === 0) throw new TelegramError('No connection', 0, undefined, true);
      return call(method, params);
    };
    await f.flush(); assert.equal(f.state.widgetCard('thread-a', 'live')!.delivery, 'sending');
    f.advance(3000); await f.flush(); assert.equal(attempts, 1);
    assert.equal(f.state.widgetCard('thread-a', 'live')!.delivery, 'new');
    await f.flush(); assert.equal(attempts, 2); assert.equal(f.state.widgetCard('thread-a', 'live')!.delivery, 'active');
  } finally { f.close(); }
});

test('a definite widget rejection selects classic and does not disconnect or change native permissions', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    const original = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') throw new TelegramError('Unknown method', 404); return original(method, params); };
    await f.flush(); await f.drain(); assert.equal(f.state.viewMode('thread-a'), 'classic');
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Widgets are unavailable')));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('429 delays only widget work; editing an existing message can safely retry a full snapshot', async () => {
  const f = await setup(); let attempts = 0;
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    const original = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget' && !attempts++) throw new TelegramError('Rate limited', 429, 5); return original(method, params); };
    await f.flush(); f.advance(1000); assert.equal(await f.flush(), false); f.advance(5000); await f.flush();
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'One', status: 'completed' }] });
    f.telegram.call = async (method, params) => { if (method === 'editMessageWidgetData') throw new TelegramError('Lost edit receipt', 0); return original(method, params); };
    f.advance(); await f.flush(); assert.equal(f.state.widgetCards('thread-a')[0]!.delivery, 'active');
    f.telegram.call = original; f.advance(5000); await f.flush();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.equal(f.state.widgetCards('thread-a')[0]!.sentRevision, f.state.widgetCards('thread-a')[0]!.revision);
  } finally { f.close(); }
});

test('no older edit can overtake a final snapshot through the local sender', async () => {
  const f = await setup(); let release!: (value: unknown) => void;
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance(); await f.flush();
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'One', status: 'inProgress' }] }); f.advance();
    const original = f.telegram.call.bind(f.telegram); let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise(resolve => { release = resolve; });
    f.telegram.call = async (method, params) => { const result = await original(method, params); if (method === 'editMessageWidgetData') { entered(); return held; } return result; };
    const first = f.flush(); await waiting;
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed' } });
    assert.equal(await f.flush(), false); release(true); await first;
    f.telegram.call = original; f.advance(); await f.flush();
    const edits = f.telegram.calls.filter(call => call.method === 'editMessageWidgetData').map(call => JSON.parse(string(call.params.chat_data)));
    assert.deepEqual(edits.map(data => data.s), ['working', 'done']); assert.ok(edits[1].r > edits[0].r);
  } finally { release?.(true); f.close(); }
});

test('reconnect reuses a confirmed message, does not import old turns and preserves view preferences on disk', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance(); await f.flush();
    const messageId = f.state.widgetCards('thread-a')[0]!.messageId;
    f.bridge.close(); f.codex.histories.set('thread-a', [{ id: 'live', status: 'inProgress' }, { id: 'historical', status: 'completed' }]);
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram); await bridge.discover();
    f.advance(); await f.outbox.flushWidget(bridge.widgetDelivery()); bridge.close();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.equal(f.state.widgetCards('thread-a').find(card => card.turnId === 'live')!.messageId, messageId);
    assert.equal(f.state.widgetCards('thread-a').some(card => card.turnId === 'historical'), false);
  } finally { f.close(); }
});

test('disk recovery selects classic for interrupted sends once and preserves explicit later choices', async () => {
  const f = await setup(); const temp = temporary(); let state: State | undefined;
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start();
    state = new State(join(temp.dir, 'private')); state.setViewMode('thread-a', 'widgets');
    const card = f.state.widgetCards('thread-a')[0]!; state.saveWidget(card); assert.equal(state.claimWidget(card.id, false), true);
    state.close(); state = new State(join(temp.dir, 'private'));
    assert.equal(state.viewMode('thread-a'), 'classic'); assert.equal(state.widgetCards()[0]!.delivery, 'uncertain');
    assert.equal(state.widgetCards()[0]!.failure, 'restart-outcome-unknown');
    state.setViewMode('thread-a', 'widgets'); state.close(); state = new State(join(temp.dir, 'private'));
    assert.equal(state.viewMode('thread-a'), 'widgets'); assert.equal(state.widgetCards()[0]!.delivery, 'uncertain');
  } finally { state?.close(); temp.close(); f.close(); }
});

test('widget view is independent of text previews and permanent-message verbosity', async () => {
  const f = await setup();
  try {
    f.state.setStreaming(false); f.state.setMessageMode('compact');
    await f.bridge.update(message(1, 101, '/view widgets')); await f.start(); f.advance(); await f.flush();
    assert.equal(f.state.streamingEnabled(), false); assert.equal(f.state.messageMode(), 'compact');
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    assert.equal(f.telegram.calls.some(call => call.method.endsWith('Draft')), false);
  } finally { f.close(); }
});

test('pending approvals and questions change status without being answered by widget rendering', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start();
    f.codex.pending.add('approval');
    await f.bridge.request({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'live', itemId: 'command', command: 'echo ok', cwd: f.projectA,
    } });
    f.bridge.widgetDelivery(); assert.equal(f.state.widgetCards('thread-a')[0]!.snapshot.status, 'approval');
    f.codex.pending.delete('approval'); await f.bridge.notification('serverRequest/resolved', { threadId: 'thread-a', requestId: 'approval' });
    f.codex.pending.add('question');
    await f.bridge.request({ id: 'question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-a', turnId: 'live', questions: [{ id: 'q', question: 'Which option?', options: [{ label: 'One', description: 'First' }] }],
    } });
    f.bridge.widgetDelivery(); assert.equal(f.state.widgetCards('thread-a')[0]!.snapshot.status, 'answer');
    f.advance(); await f.flush(); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('view controls require the original owner/private chat/topic/message and a current binding', async () => {
  const f = await setup();
  try {
    await f.bridge.update(message(1, 101, '/view widgets', 99)); assert.equal(f.state.viewMode('thread-a'), 'classic');
    await f.bridge.update(message(2, 101, '/view')); await f.drain();
    const sent = f.telegram.sent().at(-1)!; const data = string(object((object(sent.reply_markup).inline_keyboard as Json[][])[0]![1]).callback_data);
    const click = (id: number, topic = 101, owner = 42, messageId = f.telegram.message) => ({ update_id: id, callback_query: { id: String(id), from: { id: owner }, data,
      message: { message_id: messageId, chat: { id: owner, type: 'private' }, message_thread_id: topic } } });
    await f.bridge.update(click(3, 102)); await f.bridge.update(click(4, 101, 99)); await f.bridge.update(click(5, 101, 42, 1));
    assert.equal(f.state.viewMode('thread-a'), 'classic');
    await f.bridge.update(click(6)); await f.bridge.update(click(7)); assert.equal(f.state.viewMode('thread-a'), 'widgets');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('rebound or excluded sessions cannot leak queued widget data or use old fallback buttons', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
    f.state.installTopic('thread-a', 555, f.projectA, 'Moved');
    assert.equal(await f.flush(), false); assert.equal(f.telegram.calls.some(call => call.method === 'sendWidget'), false);
  } finally { f.close(); }
});

test('template and Unicode snapshots fit server byte limits and use Telegram theme/text/safe-area tokens', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start();
    const card = f.state.widgetCards('thread-a')[0]!;
    card.binding.sessionName = '😀Русский заголовок<script>bad()</script>'.repeat(100);
    card.snapshot.activities = Array.from({ length: 3 }, (_, i) => ({ id: String(i), label: '😀'.repeat(100), status: 'done' }));
    const data = widgetData(card); assert.ok(Buffer.byteLength(data) <= 900); assert.ok(!data.includes('\ufffd'));
    card.binding.sessionName = '"\\'.repeat(100); card.binding.projectLabel = '"\\'.repeat(100);
    card.snapshot.plan = { done: 2, total: 4, current: '"\\'.repeat(100) };
    card.snapshot.activities = Array.from({ length: 3 }, (_, i) => ({ id: String(i), label: '"\\'.repeat(100), status: 'done' }));
    assert.ok(Buffer.byteLength(widgetData(card)) <= 900, 'JSON escaping must fit the byte budget too');
    assert.ok(Buffer.byteLength(WIDGET_HTML) <= 32768); assert.ok(deflateSync(WIDGET_HTML, { level: 9 }).length < 3800);
    assert.match(WIDGET_HTML, /--tg-theme-text-color/u); assert.match(WIDGET_HTML, /--tg-text-font-size/u); assert.match(WIDGET_HTML, /safe-area-inset-bottom/u);
    assert.match(WIDGET_HTML, /textContent/u); assert.doesNotMatch(WIDGET_HTML, /innerHTML|fetch\(|WebSocket|#[0-9a-f]{3,8}\b/iu);
  } finally { f.close(); }
});

test('history pruning never evicts a live receipt or an uncertain admission identity', async () => {
  for (const uncertain of [false, true]) {
    const f = await setup();
    try {
      f.state.setViewMode('thread-a', 'widgets'); await f.start(); f.advance();
      if (uncertain) {
        const card = f.state.widgetCard('thread-a', 'live')!;
        f.state.claimWidget(card.id, false); f.state.widgetResult(card.id, 'uncertain');
      } else await f.flush();
      const original = f.state.widgetCard('thread-a', 'live')!;
      const widgets = new Widgets(f.state, f.bridge.widgetDelivery().generation); const binding = f.state.binding('thread-b')!;
      for (let index = 0; index < 520; index++) {
        widgets.observe(binding, 'turn/started', { turn: { id: `other-${index}` } });
        widgets.observe(binding, 'turn/completed', { turn: { id: `other-${index}`, status: 'completed' } });
      }
      await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'late', type: 'commandExecution' } });
      const retained = f.state.widgetCard('thread-a', 'live')!;
      assert.equal(retained.id, original.id); assert.equal(retained.messageId, original.messageId);
      assert.equal(retained.delivery, original.delivery); assert.ok(f.state.widgetCards().length <= 512);
      f.advance(); await f.flush(); assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, uncertain ? 0 : 1);
      if (uncertain) {
        f.state.widgetResult(retained.id, 'retired'); f.advance(8 * 86400_000);
        widgets.observe(binding, 'turn/started', { turn: { id: 'after-retention' } });
        assert.equal(f.state.widgetCard('thread-a', 'live')!.id, original.id, 'retiring a route must retain an uncertain tombstone');
      }
    } finally { f.close(); }
  }
});

test('bounded storage pauses new widget admission instead of evicting unresolved sends', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start(); const base = f.state.widgetCard('thread-a', 'live')!;
    for (let index = 0; index < 511; index++) {
      const card = { ...base, id: `unresolved-${index}`, turnId: `unresolved-${index}` };
      assert.equal(f.state.saveWidget(card), true); f.state.widgetResult(card.id, 'uncertain');
    }
    await f.start('over-capacity'); assert.equal(f.state.widgetCard('thread-a', 'over-capacity'), undefined);
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'over-capacity', item: { id: 'late', type: 'commandExecution' } });
    assert.equal(f.state.widgetCard('thread-a', 'over-capacity'), undefined); assert.equal(f.state.widgetCards().length, 512);
    await f.drain(); assert.ok(f.telegram.sent().some(item => string(item.text).includes('unresolved deliveries')));
  } finally { f.close(); }
});

test('recovery retains terminal history and reconciles missed tool completions on an existing card', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('thread-a', 'widgets'); await f.start('done'); f.advance(); await f.flush();
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'done', status: 'completed' } });
    f.advance(); await f.flush(); const terminal = f.state.widgetCard('thread-a', 'done')!;
    await f.start();
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'tool', type: 'commandExecution' } });
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'Unknown after restart', status: 'inProgress' }] });
    f.advance(); await f.flush(); const active = f.state.widgetCard('thread-a', 'live')!;
    f.bridge.close();
    f.codex.histories.set('thread-a', [{ id: 'live', status: 'inProgress', items: [{ id: 'tool', type: 'commandExecution', status: 'completed', exitCode: 0 }] }]);
    const next = new Bridge(f.bridge.config, f.state, f.codex, f.telegram); await next.discover();
    const restoredTerminal = f.state.widgetCard('thread-a', 'done')!;
    assert.equal(restoredTerminal.snapshot.status, 'done'); assert.equal(restoredTerminal.revision, terminal.revision);
    assert.equal(restoredTerminal.messageId, terminal.messageId);
    const restored = f.state.widgetCard('thread-a', 'live')!;
    assert.equal(restored.messageId, active.messageId); assert.equal(restored.snapshot.activities[0]!.status, 'done');
    assert.equal(restored.snapshot.plan, null, 'missing structured plan events cannot be inferred from history');
    f.advance(); await f.outbox.flushWidget(next.widgetDelivery()); next.close();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 2);
  } finally { f.close(); }
});

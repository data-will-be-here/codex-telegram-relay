import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Bridge } from '../src/bridge.js';
import { Outbox, TelegramClient, TelegramError } from '../src/telegram.js';
import { State } from '../src/state.js';
import { WIDGET_HTML, widgetData } from '../src/widget-template.js';
import { Widgets } from '../src/widgets.js';
import { resultParts } from '../src/widget-result.js';
import { object, string, type Json } from '../src/types.js';
import { fixture, message, temporary } from './helpers.js';

async function setup() {
  const f = await fixture(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const outbox = new Outbox(f.state, f.telegram, f.bridge.config, 0);
  return { ...f, outbox, advance: (ms = 3000) => { now += ms; },
    readAnswer: async (needle: string, id = 900) => {
      const result = f.telegram.calls.filter(call => call.method === 'sendWidget' && string(call.params.chat_data).includes(needle)).at(-1)!;
      const data = string(object((object(result.params.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data);
      const answer = f.state.widgetAnswer(data.slice(2))!;
      await f.bridge.update({ update_id: id, callback_query: { id: String(id), from: { id: 42 }, data,
        message: { message_id: answer.messageId, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } });
      await f.drain();
    },
    start: async (id = 'live') => f.bridge.notification('turn/started', { threadId: 'thread-a', turn: { id, status: 'inProgress', startedAt: now / 1000 } }),
    flush: () => outbox.flushWidget(f.bridge.widgetDelivery()),
    close: () => { Date.now = realNow; f.close(); } };
}

test('a confirmed Working card is quietly pinned once and stays pinned after completion', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance(); await f.flush();
    const card = f.state.widgetCard('thread-a', 'live')!;
    const pins = () => f.telegram.calls.filter(call => call.method === 'pinChatMessage');
    assert.deepEqual(pins().map(call => call.params), [{ chat_id: 42, message_id: card.messageId, disable_notification: true }]);
    assert.ok(f.telegram.calls.findIndex(call => call.method === 'sendWidget') < f.telegram.calls.findIndex(call => call.method === 'pinChatMessage'));
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'tool', type: 'commandExecution', command: 'echo synthetic' } });
    f.advance(); await f.flush();
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed' } });
    f.advance(); await f.flush();
    assert.equal(pins().length, 1); assert.equal(f.telegram.calls.some(call => /unpin/iu.test(call.method)), false);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

for (const failure of ['rejected', 'unknown', 'missing-receipt'] as const) test(`pin ${failure} does not disable Widgets or repeat a pin on later updates`, async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'pinChatMessage') {
        if (failure === 'missing-receipt') return false;
        throw new TelegramError('Synthetic pin failure', failure === 'rejected' ? 400 : 0);
      }
      return result;
    };
    await f.start(); f.advance(); await f.flush();
    assert.equal(f.state.viewMode(), 'widgets'); assert.equal(f.state.widgetCard('thread-a', 'live')!.delivery, 'active');
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'next', type: 'commandExecution', command: 'echo synthetic' } });
    f.advance(6000); await new Outbox(f.state, f.telegram, f.bridge.config, 0).flushWidget(f.bridge.widgetDelivery());
    assert.equal(f.telegram.calls.filter(c => c.method === 'pinChatMessage').length, 1);
    assert.ok(f.telegram.calls.some(c => c.method === 'editMessageWidgetData'));
    assert.equal(f.state.nextWidgetPin(f.bridge.widgetDelivery().generation, Date.now()), undefined);
  } finally { f.close(); }
});

for (const rateLimit of [false, true]) test(`a proven unsent pin retries after ${rateLimit ? 'retry_after' : 'three seconds'} without another card`, async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); const call = f.telegram.call.bind(f.telegram); let tries = 0;
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'pinChatMessage' && tries++ === 0) throw new TelegramError('Synthetic deferred pin', rateLimit ? 429 : 0, rateLimit ? 5 : undefined, !rateLimit);
      return result;
    };
    await f.start(); f.advance(); await f.flush(); f.advance(2000); await f.flush(); assert.equal(tries, 1);
    f.advance(rateLimit ? 3000 : 1000); await f.flush(); assert.equal(tries, 2);
    assert.equal(f.telegram.calls.filter(c => c.method === 'sendWidget').length, 1); assert.equal(f.state.viewMode(), 'widgets');
  } finally { f.close(); }
});

test('an unconfirmed activity-card send cannot trigger a pin', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => { const result = await call(method, params); if (method === 'sendWidget') throw new TelegramError('Lost card receipt', 0); return result; };
    await f.start(); f.advance(); await f.flush();
    assert.equal(f.telegram.calls.some(c => c.method === 'pinChatMessage'), false);
  } finally { f.close(); }
});

test('pin authorization rechecks the original topic after its native await', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance(); const guard = f.bridge.widgetDelivery(); let checks = 0;
    guard.allowed = async () => { if (++checks === 2) f.state.installTopic('thread-a', 999, f.projectA, 'Moved'); return true; };
    await f.outbox.flushWidget(guard);
    assert.equal(f.telegram.calls.filter(c => c.method === 'sendWidget').length, 1);
    assert.equal(f.telegram.calls.some(c => c.method === 'pinChatMessage'), false);
  } finally { f.close(); }
});

test('a crash during pinning stays uncertain after SQLite reopen and payload updates do not rearm it', () => {
  const temp = temporary(); const project = join(temp.dir, 'project'); mkdirSync(project); let state = new State(join(temp.dir, 'private'));
  try {
    const card = { id: 'pin-card', token: 'token', generation: 'generation', binding: { threadId: 'thread', topicId: 101, cwd: project, title: 'Project', lastTurn: null },
      turnId: 'turn', view: 'widgets' as const, revision: 1, createdAt: Date.now(), snapshot: { status: 'working' as const, startedAt: null, finishedAt: null, updatedAt: Date.now(), plan: null, activities: [] } };
    state.saveWidget(card); state.widgetDelivered(card.id, 1, 123, Date.now()); assert.equal(state.claimWidgetPin(card.id, 123), true);
    state.close(); state = new State(join(temp.dir, 'private')); state.saveWidget({ ...card, revision: 2 });
    assert.equal(state.nextWidgetPin('generation', Date.now()), undefined); assert.equal(state.viewMode(), 'widgets');
  } finally { state.close(); temp.close(); }
});

test('/view applies to all sessions, preserves classic running turns and never writes native settings/input', async () => {
  const f = await setup();
  try {
    await f.start('old'); await f.bridge.update(message(1, 101, '/view widgets')); await f.drain();
    assert.equal(f.state.viewMode(), 'widgets');
    f.advance(); assert.equal(await f.flush(), false, 'current classic turn keeps its view');
    await f.start(); f.advance(); assert.equal(await f.flush(), true);
    await f.bridge.update(message(2, 101, '/view classic')); await f.drain();
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'Do work', status: 'inProgress' }] });
    f.advance(); await f.flush();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget' && call.params.html === WIDGET_HTML).length, 1);
    assert.equal(f.telegram.calls.filter(call => call.method === 'editMessageWidgetData').length, 1, 'current widget turn keeps its view');
    await f.start('next'); f.advance(); await f.flush();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget' && call.params.html === WIDGET_HTML).length, 1);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('global /view menus and direct commands work without a topic or session, with exact callback authority', async () => {
  for (const topicId of [null, 909]) {
    const f = await setup();
    try {
      f.codex.turns = async () => { throw new Error('Native session temporarily unavailable'); };
      const command = (id: number, text: string): Json => {
        const update = message(id, topicId ?? 909, text);
        if (topicId === null) delete object(update.message).message_thread_id;
        return update;
      };
      await f.bridge.update(command(1, '/view')); await f.drain();
      const menu = f.telegram.sent().at(-1)!;
      assert.ok(string(menu.text).includes('View for all topics: Classic'));
      const data = string(object((object(menu.reply_markup).inline_keyboard as Json[][])[0]![1]).callback_data);
      const click = (id: number, topic = topicId, owner = 42, messageId = f.telegram.message): Json => ({ update_id: id,
        callback_query: { id: String(id), data, from: { id: owner }, message: { message_id: messageId,
          chat: { id: owner, type: 'private' }, ...(topic !== null ? { message_thread_id: topic } : {}) } } });
      await f.bridge.update(click(2, 101)); await f.bridge.update(click(3, topicId, 99)); await f.bridge.update(click(4, topicId, 42, 1));
      assert.equal(f.state.viewMode(), 'classic');
      await f.bridge.update(click(5)); assert.equal(f.state.viewMode(), 'widgets');
      await f.bridge.update(command(6, '/status')); await f.drain();
      assert.ok(f.telegram.calls.some(call => call.method === 'sendWidget' && string(call.params.html).includes('View for all topics: Widgets')));
      await f.bridge.update(command(7, '/view classic')); assert.equal(f.state.viewMode(), 'classic');
      await f.bridge.update(click(8)); assert.equal(f.state.viewMode(), 'classic', 'an already consumed menu cannot change the global setting again');
      assert.deepEqual(f.codex.writes, []);
    } finally { f.close(); }
  }
});

test('global view selection latches running turns across projects before applying to future turns', async () => {
  const f = await setup();
  try {
    await f.start('old-a');
    f.codex.histories.set('thread-b', [{ id: 'old-b', status: 'inProgress' }]);
    await f.bridge.update(message(1, 101, '/view widgets'));
    assert.equal(f.state.widgetCard('thread-a', 'old-a')!.view, 'classic');
    assert.equal(f.state.widgetCard('thread-b', 'old-b')!.view, 'classic');
    await f.bridge.notification('turn/started', { threadId: 'thread-b', turn: { id: 'new-b', status: 'inProgress' } });
    assert.equal(f.state.widgetCard('thread-b', 'new-b')!.view, 'widgets');
    await f.bridge.update(message(2, 102, '/view classic'));
    assert.equal(f.state.widgetCard('thread-b', 'new-b')!.view, 'widgets');
    await f.start('next-a');
    assert.equal(f.state.widgetCard('thread-a', 'next-a')!.view, 'classic');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('legacy per-session view choices migrate once into the persisted global preference', () => {
  const temp = temporary(); const home = join(temp.dir, 'view-migration'); let state: State | undefined;
  try {
    state = new State(home); state.setMessageMode('compact'); state.setStreaming(false); state.close(); state = undefined;
    const db = new DatabaseSync(join(home, 'state.sqlite'));
    try { db.exec("DELETE FROM settings WHERE key='view'; INSERT INTO settings VALUES('view/thread-a','widgets'),('view/thread-b','classic')"); }
    finally { db.close(); }
    state = new State(home); assert.equal(state.viewMode(), 'widgets');
    assert.equal(state.messageMode(), 'compact'); assert.equal(state.streamingEnabled(), false);
    state.setViewMode('classic'); state.close(); state = new State(home);
    assert.equal(state.viewMode(), 'classic', 'the old opt-in must not override a later global choice after restart');
  } finally { state?.close(); temp.close(); }
});

test('global view preparation cannot recover a stale binding after an awaited native read', async () => {
  const f = await setup();
  try {
    const turns = f.codex.turns.bind(f.codex);
    f.codex.turns = async threadId => {
      if (threadId !== 'thread-b') return turns(threadId);
      f.state.installTopic('thread-b', 555, f.projectB, 'Moved');
      return [{ id: 'old-route-turn', status: 'inProgress' }];
    };
    await f.bridge.update(message(1, 101, '/view widgets'));
    assert.equal(f.state.viewMode(), 'widgets');
    assert.equal(f.state.widgetCard('thread-b', 'old-route-turn'), undefined);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a current activity card Classic control selects the shared view while keeping the running turn latched', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance(); await f.flush();
    const card = f.state.widgetCard('thread-a', 'live')!;
    await f.bridge.update({ update_id: 1, callback_query: { id: 'global-classic', from: { id: 42 }, data: `v:${card.token}:c`,
      message: { message_id: card.messageId, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } });
    assert.equal(f.state.viewMode(), 'classic'); assert.equal(f.state.widgetCard('thread-a', 'live')!.view, 'widgets');
    await f.bridge.notification('turn/started', { threadId: 'thread-b', turn: { id: 'next-b', status: 'inProgress' } });
    assert.equal(f.state.widgetCard('thread-b', 'next-b')!.view, 'classic');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a quiet activity card finishes and a separate result notifies without an automatic text duplicate', async () => {
  const f = await setup();
  try {
    await f.bridge.update(message(1, 101, '/view widgets')); await f.drain(); await f.start();
    const event = { threadId: 'thread-a', turnId: 'live', item: { id: 'tool', type: 'commandExecution', command: 'SECRET_COMMAND', aggregatedOutput: 'SECRET_OUTPUT' } };
    await f.bridge.notification('item/started', event); await f.bridge.notification('item/started', event);
    await f.bridge.notification('item/started', { ...event, item: { id: 'reason', type: 'reasoning', text: 'SECRET_REASONING' } });
    await f.bridge.notification('turn/plan/updated', { threadId: 'thread-a', turnId: 'live', plan: [{ step: 'First', status: 'completed' }, { step: 'Second', status: 'inProgress' }] });
    f.advance(); await f.flush();
    const sent = f.telegram.calls.find(call => call.method === 'sendWidget' && call.params.html === WIDGET_HTML)!.params;
    assert.equal(sent.message_thread_id, 101); assert.equal(sent.is_shared, false); assert.equal(sent.allow_queries, false); assert.equal(sent.public_data, undefined);
    const data = JSON.parse(string(sent.chat_data)); assert.deepEqual(data.n, [1, 2]); assert.deepEqual(data.a, [['running', 'Run command']]);
    assert.doesNotMatch(string(sent.chat_data), /SECRET_/u);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', text: 'Итоговый ответ', phase: 'final_answer' }] } });
    await f.drain(); f.advance(); await f.flush();
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('Итоговый ответ')), false);
    const result = f.telegram.calls.filter(call => call.method === 'sendWidget').at(-1)!.params;
    assert.equal(result.disable_notification, false); assert.equal(JSON.parse(string(result.chat_data)).k, 'result');
    await f.readAnswer('Итоговый ответ'); assert.ok(f.telegram.sent().some(item => string(item.text).includes('Итоговый ответ')));
    assert.equal(JSON.parse(string(f.telegram.calls.filter(call => call.method === 'editMessageWidgetData').at(-1)!.params.chat_data)).s, 'done');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('fast turns create no empty widget; failed tool calls do not fail the whole turn or invent a plan', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start('fast');
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
    f.state.setMessageMode('all'); f.state.setViewMode('widgets'); await f.start();
    const item = { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking the relay update queue' };
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item });
    assert.equal(await f.bridge.flushDraft(), false, 'commentary previews must stay inside the card too');
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item });
    f.advance(); await f.flush(); await f.drain();
    const sent = f.telegram.calls.find(call => call.method === 'sendWidget')!.params;
    assert.equal(sent.caption, 'Working · project-a');
    assert.ok(string(sent.caption).length <= 180, 'caption is a short archive/notification label');
    assert.equal(string(sent.caption).includes(item.text), false, 'progress must not be duplicated in the caption');
    assert.ok(string(sent.chat_data).includes(item.text), 'the live card must explain the current work');
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(item.text)), false, 'widget progress must not be repeated below the card');
  } finally { f.close(); }
});

test('Working previews parse Markdown before budgeting while preserving literal code and the original status text', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = '**Checking the queue** with *care*, ~~old retries~~, `count **=** 2` and [documentation](https://example.com/guide).';
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text } });
    f.advance(); await f.flush();
    const params = f.telegram.calls.find(call => call.method === 'sendWidget')!.params;
    const data = JSON.parse(string(params.chat_data));
    assert.equal(data.q, 'Checking the queue with care, old retries, count **=** 2 and documentation.');
    assert.ok(data.f.some((span: number[]) => span[0] === 0 && data.q.slice(span[1], span[1]! + span[2]!) === 'Checking the queue'));
    assert.ok(data.f.some((span: number[]) => span[0] === 3 && data.q.slice(span[1], span[1]! + span[2]!) === 'count **=** 2'));
    assert.ok(Buffer.byteLength(string(params.chat_data)) <= 900);
    assert.equal(f.state.widgetCard('thread-a', 'live')!.snapshot.progressText, text, 'The formatted Current status reader keeps the original Markdown');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('Russian progress uses available data space instead of stopping halfway through a sentence', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = 'Тесты воспроизвели отмену «В эфир» и для гнили, и для луж. Исправление сохраняет состояние игры и позволяет продолжить ход.';
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text } });
    f.advance(); await f.flush();
    const data = JSON.parse(string(f.telegram.calls.find(call => call.method === 'sendWidget')!.params.chat_data));
    assert.equal(data.q, text, 'this complete progress paragraph fits the Telegram data budget');
  } finally { f.close(); }
});

test('styled progress keeps Unicode offsets after whitespace normalization and budgets formatting together with text', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const card = f.state.widgetCard('thread-a', 'live')!;
    card.snapshot.progressText = ' \n**🧪 First** \n\n *Second*\tand `a**b` ';
    let data = JSON.parse(widgetData(card));
    assert.equal(data.q, '🧪 First Second and a**b');
    assert.equal(data.q.slice(data.f[0][1], data.f[0][1] + data.f[0][2]), '🧪 First');
    assert.ok(data.f.some((span: number[]) => span[0] === 1 && data.q.slice(span[1], span[1]! + span[2]!) === 'Second'));
    card.snapshot.progressText = Array.from({ length: 300 }, (_, index) => `**Value ${index}** *checking* \`x_${index}\`.`).join('\n');
    const encoded = widgetData(card); data = JSON.parse(encoded);
    assert.ok(Buffer.byteLength(encoded) <= 900);
    assert.ok(data.q.endsWith('…')); assert.ok(data.f.length <= 24);
    assert.ok(data.f.every((span: number[]) => span[1]! >= 0 && span[2]! > 0 && span[1]! + span[2]! <= data.q.length));
    assert.ok(!data.q.includes('\ufffd'));
  } finally { f.close(); }
});

test('Current status opens a complete immutable progress widget only on an authorized card click', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = ('Проверяю полный текст текущего шага и сохранение состояния игры после отмены. '.repeat(25)).trim();
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text } });
    f.advance(); await f.flush(); await f.drain();
    const card = f.state.widgetCard('thread-a', 'live')!;
    const data = JSON.parse(string(f.telegram.calls.find(call => call.method === 'sendWidget')!.params.chat_data));
    assert.ok(Buffer.byteLength(string(f.telegram.calls.find(call => call.method === 'sendWidget')!.params.chat_data)) <= 900);
    assert.ok(data.q.endsWith('…')); assert.ok(data.q.length < text.length);
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(text)), false);
    const click = (id: number, topic = 101, owner = 42, messageId = card.messageId) => ({ update_id: id, callback_query: { id: String(id), from: { id: owner }, data: `v:${card.token}:d`,
      message: { message_id: messageId, chat: { id: owner, type: 'private' }, message_thread_id: topic } } });
    await f.bridge.update(click(801, 102)); await f.bridge.update(click(802, 101, 99)); await f.bridge.update(click(803, 101, 42, 1)); await f.drain();
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(text)), false);
    await f.bridge.update(click(804)); await f.drain();
    const readers = f.telegram.calls.filter(call => call.method === 'sendWidget' && string(call.params.html).includes('Current status'));
    assert.equal(readers.length, 1);
    assert.ok(string(readers[0]!.params.html).includes(text));
    assert.match(string(readers[0]!.params.html), /id="nav"/u);
    assert.match(string(readers[0]!.params.html), /class="badge status">●/u);
    assert.doesNotMatch(string(readers[0]!.params.html), /class="badge done"|"status":"(?:Answer ready|Ready)"|"status":"Turn interrupted"/u);
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(text)), false);
    const copy = string(object((object(readers[0]!.params.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data);
    const answer = f.state.widgetAnswer(copy.slice(2))!; assert.ok(answer.text.includes(text));
    await f.bridge.update(click(805)); await f.drain();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget' && string(call.params.html).includes('Current status')).length, 1, 'Repeated clicks on the same revision reuse the saved snapshot');
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'next-progress', type: 'agentMessage', phase: 'commentary', text: 'Newer explanation' } });
    assert.ok(f.state.widgetAnswer(copy.slice(2))!.text.includes(text), 'An existing status reader must not change when live progress changes');
    await f.bridge.update(click(806)); await f.drain();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget' && string(call.params.html).includes('Current status')).length, 2);
    assert.ok(f.telegram.calls.some(call => call.method === 'sendWidget' && string(call.params.html).includes('Newer explanation')));
    await f.bridge.update({ update_id: 807, callback_query: { id: 'status-text-copy', from: { id: 42 }, data: copy,
      message: { message_id: answer.messageId, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } }); await f.drain();
    assert.ok(f.telegram.sent().some(message => string(message.text).includes(text)), 'The explicit text copy retains the original snapshot');
    assert.equal(f.state.viewMode(), 'widgets'); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('an unknown Current status widget send uses one complete text backup without replaying the widget', async () => {
  const f = await setup(); let attempts = 0;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = '**Checking delivery.** ' + 'The saved explanation remains available. '.repeat(35);
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text } });
    f.advance(); await f.flush(); await f.drain();
    const card = f.state.widgetCard('thread-a', 'live')!;
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'sendWidget' && string(params?.html).includes('Current status')) { attempts++; throw new TelegramError('Unknown delivery', 0); }
      return call(method, params);
    };
    const click = (id: number) => ({ update_id: id, callback_query: { id: String(id), from: { id: 42 }, data: `v:${card.token}:d`,
      message: { message_id: card.messageId, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } });
    await f.bridge.update(click(810)); await f.drain(); f.advance(); await f.drain();
    await f.bridge.update(click(811)); await f.drain();
    assert.equal(attempts, 1);
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Current status') && string(message.text).includes('The saved explanation remains available.')).length, 1);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a fast widget turn sends complete result parts with one notification and retains its text copy', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'The full final answer' } });
    assert.equal(await f.bridge.flushDraft(), false);
    const text = ('The complete final answer with code and explanation. '.repeat(45)).trim();
    const turn = { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
    const cards = f.telegram.calls.filter(call => call.method === 'sendWidget');
    assert.equal(cards.length, 1); assert.equal(cards.filter(card => card.params.disable_notification === false).length, 1);
    const result = cards.at(-1)!.params;
    assert.equal(JSON.parse(string(result.chat_data)).k, 'result');
    const data = string(object((object(result.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data);
    const answer = f.state.widgetAnswer(data.slice(2))!; assert.ok(answer.text.includes(text));
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(text)), false);
    const click = (id: number, topic = 101, owner = 42, messageId = answer.messageId) => ({ update_id: id, callback_query: { id: String(id), from: { id: owner }, data,
      message: { message_id: messageId, chat: { id: owner, type: 'private' }, message_thread_id: topic } } });
    await f.bridge.update(click(820, 102)); await f.bridge.update(click(821, 101, 99)); await f.bridge.update(click(822, 101, 42, 1)); await f.drain();
    assert.equal(f.telegram.sent().some(message => string(message.text).includes(text)), false);
    f.advance(8 * 86400_000); f.state.prune(); f.codex.sessions = []; await f.bridge.discover();
    assert.ok(f.state.widgetAnswer(data.slice(2))!.text.includes(text));
    await f.bridge.update(click(823)); await f.drain(); assert.ok(f.telegram.sent().some(message => string(message.text).includes(text)));
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, cards.length);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a failed result widget falls back to the complete text without replaying the card', async () => {
  for (const status of [400, 0, 500]) {
    const f = await setup(); let sends = 0;
    try {
      f.state.setViewMode('widgets'); await f.start();
      const call = f.telegram.call.bind(f.telegram);
      f.telegram.call = async (method, params) => { if (method === 'sendWidget') { sends++; throw new TelegramError('Widget failed', status); } return call(method, params); };
      const turn = { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Complete fallback reply' }] };
      await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
      assert.ok(f.telegram.sent().some(message => string(message.text).includes('Complete fallback reply')));
      await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
      assert.equal(sends, 1); assert.equal(f.state.viewMode(), 'classic');
    } finally { f.close(); }
  }
});

test('a large single result document falls back to bounded formatted text messages after rejection', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') throw new TelegramError('Widget unsupported', 400); return call(method, params); };
    const text = '**A complete formatted section with useful details 🧪.**\n\n'.repeat(180) + 'FALLBACK_FINAL_TAIL';
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] } });
    await f.drain();
    const messages = f.telegram.sent();
    assert.ok(messages.length > 1);
    assert.ok(messages.every(message => string(message.text).length <= 4096), 'a paged widget must not become an oversized Telegram text message');
    assert.ok(messages.some(message => string(message.text).includes('FALLBACK_FINAL_TAIL')));
    assert.ok(messages.some(message => Array.isArray(message.entities) && (message.entities as Json[]).some(entity => object(entity).type === 'bold')));
    assert.equal(f.state.viewMode(), 'classic');
  } finally { f.close(); }
});

test('a proven unsent result widget waits three seconds and then sends once', async () => {
  const f = await setup(); let sends = 0;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget' && sends++ === 0) throw new TelegramError('Connect timeout', 0, undefined, true); return call(method, params); };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Final result' }] } });
    await f.drain(); assert.equal(sends, 1); f.advance(2999); await f.drain(); assert.equal(sends, 1);
    f.advance(1); await f.drain(); assert.equal(sends, 2); assert.equal(f.telegram.sent().some(message => string(message.text).includes('Final result')), false);
  } finally { f.close(); }
});

test('final widgets embed the formatted complete answer and number all parts instead of shortening it', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = '# Result\n\n**Formatted explanation.**\n\n- First item\n- Second item\n\n```js\nconst value = 42;\n```\n\n' + 'A complete paragraph with details. '.repeat(70) + 'END_OF_WIDGET_ANSWER';
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] } });
    await f.drain();
    const cards = f.telegram.calls.filter(call => call.method === 'sendWidget');
    assert.equal(cards.length, 1, 'a fitting full answer must use one locally paged result card');
    assert.ok(cards.some(card => string(card.params.html).includes('END_OF_WIDGET_ANSWER')), 'the tail must live in a widget, not only in a server cache');
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('Formatted explanation')), false);
  } finally { f.close(); }
});

const mixedTableSource = 'BEFORE_TABLE\n\n| Item | Value |\n|---|---|\n| Example | **42** |\n\nAFTER_TABLE';
const wideResultTable = (): string => {
  const cells = Array.from({ length: 21 }, (_, index) => `column-${index}`);
  return `| ${cells.join(' | ')} |\n| ${cells.map(() => '---').join(' | ')} |\n| ${cells.map((_, index) => `value-${index}`).join(' | ')} |`;
};

test('widget finals automatically deliver text, a native table and text with one notification and one cached result', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: mixedTableSource }] } });
    await f.drain();
    const parts = f.telegram.calls.filter(call => ['sendWidget', 'sendRichMessage'].includes(call.method));
    assert.deepEqual(parts.map(part => part.method), ['sendWidget', 'sendRichMessage', 'sendWidget']);
    assert.ok(parts.every(part => part.params.message_thread_id === 101));
    assert.equal(parts.filter(part => part.params.disable_notification === false).length, 1);
    assert.ok(JSON.stringify(parts[1]!.params.rich_message).includes('"type":"table"'));
    const token = string(object((object(parts[2]!.params.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data).slice(2);
    const answer = f.state.widgetAnswer(token)!; assert.ok(answer.messageId! > 0); assert.ok(answer.text.includes(mixedTableSource));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('table-only finals save a usable last receipt and keep the explicit Text version control', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '| A | B |\n|---|---|\n| One | Two |' }] } });
    await f.drain();
    const result = f.telegram.calls.find(call => call.method === 'sendRichMessage')!.params;
    assert.ok(JSON.stringify(result.rich_message).includes('✅ Answer ready'));
    const data = string(object((object(result.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data);
    const answer = f.state.widgetAnswer(data.slice(2))!; assert.ok(answer.messageId! > 0);
    await f.bridge.update({ update_id: 990, callback_query: { id: 'table-copy', data, from: { id: 42 }, message: {
      message_id: answer.messageId, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } }); await f.drain();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendRichMessage').length, 2);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a rejected native table changes only that part to HTML and retries a failed receipt locally', async () => {
  const f = await setup(); const uploads: { params: Json; html: string }[] = []; let fail = true;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendRichMessage') { f.telegram.calls.push({ method, params: params ?? {} }); throw new TelegramError('Unsupported rich table', 400); } return call(method, params); };
    Object.assign(f.telegram, { upload: async (_method: string, params: Json, file: { bytes: Buffer }) => { uploads.push({ params, html: file.bytes.toString('utf8') }); return { message_id: ++f.telegram.message }; } });
    const accept = f.state.acceptRichPart.bind(f.state);
    f.state.acceptRichPart = (...args) => { if (args[1] === 1 && fail) { fail = false; throw new Error('Local receipt write failed'); } return accept(...args); };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: mixedTableSource }] } });
    await f.drain(); assert.equal(uploads.length, 1); f.advance(1000); await f.drain();
    assert.equal(uploads.length, 1); assert.match(uploads[0]!.html, /<table>/u);
    assert.equal(string(uploads[0]!.params.caption), 'Attachment 1 · Table');
    assert.doesNotMatch(string(uploads[0]!.params.caption), /» |Part \d+\/\d+/u);
    assert.equal(uploads[0]!.params.message_thread_id, 101); assert.equal(f.state.viewMode(), 'widgets');
    assert.equal(f.telegram.calls.filter(item => item.method === 'sendWidget').length, 2);
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('AFTER_TABLE')), false);
  } finally { f.close(); }
});

test('an unknown native table POST is never repeated or reformatted as another native send in the backup', async () => {
  const f = await setup(); let attempts = 0;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendRichMessage') { attempts++; throw new TelegramError('Unknown outcome', 0); } return call(method, params); };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: mixedTableSource }] } });
    await f.drain(); f.advance(); await f.drain();
    assert.equal(attempts, 1); assert.equal(f.telegram.calls.filter(item => item.method === 'sendWidget').length, 1);
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('BEFORE_TABLE') && string(item.text).includes('AFTER_TABLE')));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a rejected widget preserves native tables, the completion heading and sequence numbers in text fallback', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') throw new TelegramError('Widget unsupported', 400); return call(method, params); };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: mixedTableSource }] } }); await f.drain();
    const texts = f.telegram.sent();
    assert.ok(texts.some(item => string(item.text).includes('✅ Answer ready') && string(item.text).includes('Part 1/3') && string(item.text).includes('BEFORE_TABLE')));
    assert.ok(texts.some(item => string(item.text).includes('Part 3/3') && string(item.text).includes('AFTER_TABLE')));
    assert.equal(texts.filter(item => string(item.text).includes('Answer ready')).length, 1);
    assert.ok(f.telegram.calls.some(item => item.method === 'sendRichMessage' && JSON.stringify(item.params.rich_message).includes('"type":"table"')));
  } finally { f.close(); }
});

test('unknown or malformed generated table upload receipts never authorize another file POST', async () => {
  for (const malformed of [false, true]) {
    const f = await setup(); let uploads = 0;
    try {
      f.state.setViewMode('widgets'); await f.start();
      Object.assign(f.telegram, { upload: async () => { uploads++; if (malformed) return {}; throw new TelegramError('Upload outcome unknown', 0); } });
      await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: wideResultTable() }] } });
      await f.drain(); f.advance(); await f.drain();
      assert.equal(uploads, 1); assert.ok(f.telegram.sent().some(item => string(item.text).includes('value-20')));
      assert.equal(f.telegram.calls.some(item => item.method === 'sendRichMessage'), false);
      assert.deepEqual(f.codex.writes, []);
    } finally { f.close(); }
  }
});

test('a confirmed middle document receipt resumes only the last widget after restart', async () => {
  const f = await setup(); const temp = temporary(); let state: State | undefined;
  try {
    const binding = f.state.binding('thread-a')!; const token = 'f'.repeat(32);
    const source = `Before.\n\n${wideResultTable()}\n\nAfter.`;
    const parts = resultParts({ id: 'result', token, generation: 'test', kind: 'result', view: 'widgets', binding, turnId: 'test', revision: 1, createdAt: 1,
      snapshot: { status: 'done', startedAt: 1, finishedAt: 2, updatedAt: 2, plan: null, activities: [] } }, source, token);
    assert.deepEqual(parts.map(part => part.method), ['sendWidget', 'sendDocument', 'sendWidget']);
    const home = join(temp.dir, 'mixed-receipt'); state = new State(home); state.installTopic(binding.threadId, binding.topicId, binding.cwd, binding.title);
    state.enqueueWidgetAnswer('final/thread-a/mixed-receipt', binding, source, token, parts);
    const delivery = state.next()!; state.sending(delivery.id); state.acceptRichPart(delivery.id, 0, 2001);
    state.retryDelivery(delivery.id, 0); state.sending(delivery.id); state.acceptRichPart(delivery.id, 1, 2002);
    state.close(); state = new State(home);
    let uploads = 0; Object.assign(f.telegram, { upload: async () => { uploads++; return { message_id: 2003 }; } });
    const before = f.telegram.calls.length; const outbox = new Outbox(state, f.telegram, f.bridge.config, 0);
    while (await outbox.flushOne()) { /* Only the definitely-unsent last part can send. */ }
    assert.equal(uploads, 0); assert.equal(f.telegram.calls.slice(before).filter(item => item.method === 'sendWidget').length, 1);
    assert.ok(state.widgetAnswer(token)!.messageId! > 0);
  } finally { state?.close(); temp.close(); f.close(); }
});

test('scope revocation cancels an unsent generated table document before upload', async () => {
  const f = await setup(); let uploads = 0;
  try {
    f.state.setViewMode('widgets'); await f.start(); Object.assign(f.telegram, { upload: async () => { uploads++; return { message_id: 2001 }; } });
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: wideResultTable() }] } });
    f.bridge.config.ignoredThreadIds = ['thread-a']; await f.drain();
    assert.equal(uploads, 0);
  } finally { f.close(); }
});

test('native rejection is persisted as a document before restart can send the file', async () => {
  const f = await setup(); const temp = temporary(); let state: State | undefined; let uploads = 0;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const base = f.state.widgetCard('thread-a', 'live')!; const binding = base.binding; const token = 'f'.repeat(32);
    const parts = resultParts({ ...base, kind: 'result', snapshot: { ...base.snapshot, status: 'done' } }, mixedTableSource, token);
    const home = join(temp.dir, 'converted-table'); state = new State(home); state.installTopic(binding.threadId, binding.topicId, binding.cwd, binding.title);
    state.enqueueWidgetAnswer('final/thread-a/converted-table', binding, mixedTableSource, token, parts);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendRichMessage') throw new TelegramError('Table unsupported', 400); return call(method, params); };
    Object.assign(f.telegram, { upload: async () => { uploads++; return { message_id: ++f.telegram.message }; } });
    const outbox = new Outbox(state, f.telegram, f.bridge.config, 0);
    await outbox.flushOne(); await outbox.flushOne();
    assert.equal(uploads, 0); assert.equal(state.next()!.richPlan![1]!.method, 'sendDocument');
    state.close(); state = new State(home); const restarted = new Outbox(state, f.telegram, f.bridge.config, 0);
    while (await restarted.flushOne()) { /* Persisted conversion sends exactly one file, then the final widget. */ }
    assert.equal(uploads, 1); assert.ok(state.widgetAnswer(token)!.messageId! > 0);
    assert.equal(f.telegram.calls.filter(item => item.method === 'sendWidget').length, 2);
  } finally { state?.close(); temp.close(); f.close(); }
});

test('a multipart result retries only the unsent card and persists a middle receipt without another POST', async () => {
  const f = await setup(); let attempts = 0; let failWrite = true;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = 'A complete section with useful details. '.repeat(1000) + 'MULTIPART_TAIL';
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] } });
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget' && ++attempts === 2) throw new TelegramError('Pre-connect failure', 0, undefined, true); return call(method, params); };
    const accept = f.state.acceptRichPart.bind(f.state);
    f.state.acceptRichPart = (...args) => { if (args[1] === 1 && failWrite) { failWrite = false; throw new Error('Temporary receipt persistence failure'); } return accept(...args); };
    assert.equal(await f.outbox.flushOne(), true); assert.equal(await f.outbox.flushOne(), true);
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    f.advance(2999); assert.equal(await f.outbox.flushOne(), false);
    f.advance(1); await f.outbox.flushOne();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 2);
    f.advance(1000); while (await f.outbox.flushOne()) { /* Retry receipt locally, then send the unsent suffix. */ }
    const cards = f.telegram.calls.filter(call => call.method === 'sendWidget');
    assert.equal(new Set(cards.map(card => card.params.html)).size, cards.length);
    assert.ok(cards.some(card => string(card.params.html).includes('MULTIPART_TAIL')));
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('A complete section')), false);
  } finally { f.close(); }
});

test('restart resumes an acknowledged result suffix but never replays an in-flight unknown card', async () => {
  const f = await setup(); const temp = temporary(); let state: State | undefined;
  try {
    f.state.setViewMode('widgets'); await f.start();
    const saved = f.state.widgetCard('thread-a', 'live')!;
    const text = 'Preserved complete result section. '.repeat(1000) + 'RECOVERY_TAIL';
    const parts = resultParts({ ...saved, kind: 'result', snapshot: { ...saved.snapshot, status: 'done' } }, text, 'f'.repeat(32));
    assert.ok(parts.length > 2);
    for (const phase of ['acknowledged', 'unknown', 'legacy']) {
      const inFlight = phase !== 'acknowledged';
      const home = join(temp.dir, phase); state = new State(home);
      const binding = saved.binding; state.installTopic(binding.threadId, binding.topicId, binding.cwd, binding.title);
      state.enqueueWidgetAnswer('final/thread-a/live', binding, text, 'f'.repeat(32), parts);
      const delivery = state.next()!; state.sending(delivery.id); state.acceptRichPart(delivery.id, 0, 1234);
      if (phase === 'unknown') { state.retryDelivery(delivery.id, 0); const next = state.next()!; state.sending(next.id); }
      state.close();
      if (phase === 'legacy') {
        const db = new DatabaseSync(join(home, 'state.sqlite'));
        try { db.exec('UPDATE widget_answers SET multipartSafe=0'); } finally { db.close(); }
      }
      state = new State(home); const before = f.telegram.calls.length;
      const outbox = new Outbox(state, f.telegram, f.bridge.config, 0);
      while (await outbox.flushOne()) { /* Only parts with definitely no POST are resumed. */ }
      const calls = f.telegram.calls.slice(before); const widgets = calls.filter(call => call.method === 'sendWidget');
      assert.equal(widgets.length, inFlight ? 0 : parts.length - 1);
      assert.equal(widgets.some(call => call.params.html === parts[0]!.params.html), false);
      assert.equal(calls.some(call => call.method === 'sendMessage' && string(call.params.text).includes('RECOVERY_TAIL')), inFlight);
      state.close(); state = undefined;
    }
  } finally { state?.close(); temp.close(); f.close(); }
});

test('text fallback cannot mark a result delivered without a positive receipt or replay that part', async () => {
  for (const malformed of [{}, { message_id: 0 }, { message_id: -1 }]) {
    const f = await setup(); let unconfirmed = 0;
    try {
      f.state.setViewMode('widgets'); await f.start();
      await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Receipt example' }] } });
      const delivery = f.state.next()!;
      const markup = object(delivery.richPlan!.at(-1)!.params.reply_markup);
      const token = string(object((markup.inline_keyboard as Json[][])[0]![0]).callback_data).slice(2);
      const call = f.telegram.call.bind(f.telegram);
      f.telegram.call = async (method, params) => {
        if (method === 'sendWidget') throw new TelegramError('Unsupported widget', 400);
        if (method === 'sendMessage' && !string(params?.text).includes('could not be confirmed')) {
          unconfirmed++; return malformed;
        }
        return call(method, params);
      };
      await f.outbox.flushOne(); await f.outbox.flushOne();
      assert.ok(f.state.uncertainCount() > 0); assert.equal(f.state.widgetAnswer(token)!.messageId, null);
      while (await f.outbox.flushOne()) { /* The separate complete-reply backup may deliver, never the uncertain part again. */ }
      assert.equal(unconfirmed, 1); assert.ok(f.telegram.sent().some(item => string(item.text).includes('Receipt example')));
    } finally { f.close(); }
  }
});

test('a new native question is delivered before continuing a long result series', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Long result paragraph. '.repeat(1500) }] } });
    await f.outbox.flushOne(); assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
    f.codex.pending.add('question');
    await f.bridge.request({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', turnId: 'next',
      questions: [{ id: 'q', question: 'Important pending question?', options: [{ label: 'One', description: 'First' }] }] } });
    await f.outbox.flushOne();
    const sent = f.telegram.calls.filter(call => call.method === 'sendWidget');
    assert.ok(string(sent.at(-1)!.params.html).includes('Important pending question'));
    assert.equal(sent.length, 2);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a result receipt survives temporary local write failures without another Telegram send', async () => {
  for (const method of ['acceptRichPart', 'delivered'] as const) {
    const f = await setup();
    try {
      f.state.setViewMode('widgets'); await f.start();
      await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Known result receipt' }] } });
      let failures = 1;
      const failOnce = (): void => { if (failures-- > 0) throw new Error('Temporary local write failure'); };
      if (method === 'acceptRichPart') {
        const original = f.state.acceptRichPart.bind(f.state);
        f.state.acceptRichPart = (...args) => { failOnce(); return original(...args); };
      } else {
        const original = f.state.delivered.bind(f.state);
        f.state.delivered = (...args) => { failOnce(); return original(...args); };
      }
      while (await f.outbox.flushOne()) { /* Drain except the deferred local write. */ }
      assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
      f.advance(1000); while (await f.outbox.flushOne()) { /* Settle the known receipt locally. */ }
      const result = f.telegram.calls.find(call => call.method === 'sendWidget')!.params;
      const data = string(object((object(result.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data);
      assert.ok(f.state.widgetAnswer(data.slice(2))!.messageId! > 0);
      assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 1);
      await f.readAnswer('Known result receipt'); assert.ok(f.telegram.sent().some(item => string(item.text).includes('Known result receipt')));
    } finally { f.close(); }
  }
});

test('long cached answers preserve their tail and deduplicate late completion after queue pruning', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    const text = 'A full explanation. '.repeat(2500) + 'END_OF_FULL_ANSWER';
    const turn = { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
    const cards = f.telegram.calls.filter(call => call.method === 'sendWidget').length;
    f.advance(8 * 86400_000); f.state.prune();
    // Use a different baseline so the late notification reaches durable deduplication.
    f.state.baseline('thread-a', 'other');
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, cards);
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('A full explanation')), false);
    await f.readAnswer('A full explanation');
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('END_OF_FULL_ANSWER')));
    assert.equal(f.telegram.sent().some(item => string(item.text).includes('Message shortened')), false);
  } finally { f.close(); }
});

test('restart settles known result receipts and falls back once for interrupted unknown sends', async () => {
  const f = await setup(); const temp = temporary(); let state: State | undefined;
  try {
    for (const known of [false, true]) {
      const home = join(temp.dir, known ? 'known' : 'unknown'); state = new State(home);
      const binding = f.state.binding('thread-a')!;
      state.installTopic(binding.threadId, binding.topicId, binding.cwd, binding.title);
      const key = 'final/thread-a/live'; const token = 'f'.repeat(32);
      state.enqueueWidgetAnswer(key, binding, 'Recovered full answer', token, { method: 'sendWidget', params: {}, fallback: 'Recovered full answer' });
      const delivery = state.next()!; state.sending(delivery.id);
      if (known) state.acceptRichPart(delivery.id, 0, 1234);
      state.close(); state = new State(home);
      const outbox = new Outbox(state, f.telegram, f.bridge.config, 0);
      const before = f.telegram.sent().length;
      while (await outbox.flushOne()) { /* Only unknown sends may produce a text fallback. */ }
      assert.equal(f.telegram.sent().length - before, known ? 0 : 1);
      assert.equal(state.widgetAnswer(token)!.messageId, known ? 1234 : null);
      // Even after the fallback text is pruned, a restart cannot send it again or undo a later view choice.
      f.advance(8 * 86400_000); state.prune(); state.setViewMode('widgets');
      state.close(); state = new State(home);
      const again = new Outbox(state, f.telegram, f.bridge.config, 0);
      while (await again.flushOne()) { /* A second restart must not duplicate the fallback. */ }
      assert.equal(f.telegram.sent().length - before, known ? 0 : 1);
      assert.equal(state.viewMode(), 'widgets');
      state.close(); state = undefined;
    }
    assert.equal(f.telegram.calls.some(call => call.method === 'sendWidget'), false);
  } finally { state?.close(); temp.close(); f.close(); }
});

test('a failed callback acknowledgement does not drop an authorized cached answer', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Read without acknowledgement' }] } });
    await f.drain(); const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'answerCallbackQuery') throw new TelegramError('Query expired', 400); return call(method, params); };
    await f.readAnswer('Read without acknowledgement');
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Read without acknowledgement')));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('negative result transitions survive local failures while preserving POST certainty', async () => {
  for (const notSent of [false, true]) {
    const f = await setup(); let attempts = 0;
    try {
      f.state.setViewMode('widgets'); await f.start();
      await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'live', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Persisted fallback result' }] } });
      const call = f.telegram.call.bind(f.telegram);
      f.telegram.call = async (method, params) => { if (method === 'sendWidget' && attempts++ === 0) throw new TelegramError('Send failed', 0, undefined, notSent); return call(method, params); };
      let fail = true;
      if (notSent) {
        const retry = f.state.retryDelivery.bind(f.state);
        f.state.retryDelivery = (...args) => { if (fail) { fail = false; throw new Error('Local retry write failed'); } return retry(...args); };
      } else {
        const view = f.state.setViewMode.bind(f.state);
        f.state.setViewMode = (...args) => { if (fail) { fail = false; throw new Error('Local fallback write failed'); } return view(...args); };
      }
      while (await f.outbox.flushOne()) { /* Persist send outcome without replaying. */ }
      assert.equal(attempts, 1); f.advance(3000);
      while (await f.outbox.flushOne()) { /* Retry only local state, then safe pending work. */ }
      assert.equal(attempts, notSent ? 2 : 1);
      assert.equal(f.telegram.sent().some(item => string(item.text).includes('Persisted fallback result')), !notSent);
    } finally { f.close(); }
  }
});

test('a lost completion notification is reconciled on the existing card without reconnecting', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('item/started', { threadId: 'thread-a', turnId: 'live', item: { id: 'tool', type: 'commandExecution' } });
    f.advance(); await f.flush(); const messageId = f.state.widgetCard('thread-a', 'live')!.messageId;
    const turn = { id: 'live', status: 'completed', items: [{ id: 'tool', type: 'commandExecution', status: 'completed', exitCode: 0 }, { type: 'agentMessage', phase: 'final_answer', text: 'Recovered final reply' }] };
    f.codex.histories.set('thread-a', [turn]);
    f.advance(30_000); await f.bridge.discover(); await f.flush();
    await f.drain();
    assert.equal(f.state.widgetCard('thread-a', 'live')!.snapshot.status, 'done');
    assert.equal(f.state.widgetCard('thread-a', 'live')!.messageId, messageId);
    assert.equal(f.telegram.calls.filter(call => call.method === 'sendWidget').length, 2);
    await f.readAnswer('Recovered final reply'); assert.ok(f.telegram.sent().some(message => string(message.text).includes('Recovered final reply')));
    assert.equal(f.state.binding('thread-a')!.lastTurn, 'live');
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn }); await f.drain();
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Recovered final reply')).length, 1);
  } finally { f.close(); }
});

test('unknown send outcomes are durable and never replayed, while ordinary output remains usable', async () => {
  const f = await setup(); let sends = 0;
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance();
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
    f.state.setViewMode('widgets'); await f.start(); f.advance();
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
    f.state.setViewMode('widgets'); await f.start();
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
    f.state.setMessageMode('all'); f.state.setViewMode('widgets'); await f.start();
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'live', item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Checking the update delivery queue' } });
    await f.drain(); assert.equal(f.telegram.sent().some(message => string(message.text).includes('Checking the update delivery queue')), false);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') throw new TelegramError('Unknown outcome', 0); return call(method, params); };
    f.advance(); await f.flush(); await f.drain(); f.advance(); await f.flush(); await f.drain();
    assert.equal(f.telegram.sent().filter(message => string(message.text).includes('Checking the update delivery queue')).length, 1);
    assert.equal(f.state.viewMode(), 'classic');
  } finally { f.close(); }
});

test('a quiet running tool gets native status checks without a lost-event replay or stale completion overwrite', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance(); await f.flush();
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
    f.state.setViewMode('widgets'); await f.start('older'); f.advance(); await f.flush();
    await f.start('newer');
    const newer = { id: 'newer', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Newer final' }] };
    const older = { id: 'older', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Older recovered final' }] };
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: newer }); await f.drain();
    f.codex.histories.set('thread-a', [newer, older]);
    f.advance(16_000); await f.bridge.discover(); await f.drain();
    await f.readAnswer('Older recovered final');
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
    f.state.setViewMode('widgets'); await f.start(); f.advance();
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
    f.state.setViewMode('widgets'); await f.start(); f.advance();
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
    f.state.setViewMode('widgets'); await f.start(); f.advance();
    const original = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'sendWidget') throw new TelegramError('Unknown method', 404); return original(method, params); };
    await f.flush(); await f.drain(); assert.equal(f.state.viewMode(), 'classic');
    assert.ok(f.telegram.sent().some(item => string(item.text).includes('Widgets are unavailable')));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('429 delays only widget work; editing an existing message can safely retry a full snapshot', async () => {
  const f = await setup(); let attempts = 0;
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance();
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
    f.state.setViewMode('widgets'); await f.start(); f.advance(); await f.flush();
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
    f.state.setViewMode('widgets'); await f.start(); f.advance(); await f.flush();
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
    f.state.setViewMode('widgets'); await f.start();
    state = new State(join(temp.dir, 'private')); state.setViewMode('widgets');
    const card = f.state.widgetCards('thread-a')[0]!; state.saveWidget(card); assert.equal(state.claimWidget(card.id, false), true);
    state.close(); state = new State(join(temp.dir, 'private'));
    assert.equal(state.viewMode(), 'classic'); assert.equal(state.widgetCards()[0]!.delivery, 'uncertain');
    assert.equal(state.widgetCards()[0]!.failure, 'restart-outcome-unknown');
    state.setViewMode('widgets'); state.close(); state = new State(join(temp.dir, 'private'));
    assert.equal(state.viewMode(), 'widgets'); assert.equal(state.widgetCards()[0]!.delivery, 'uncertain');
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
    f.state.setViewMode('widgets'); await f.start();
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

test('global view menus require the original owner/private chat/topic/message and an unused selection', async () => {
  const f = await setup();
  try {
    await f.bridge.update(message(1, 101, '/view widgets', 99)); assert.equal(f.state.viewMode(), 'classic');
    await f.bridge.update(message(2, 101, '/view')); await f.drain();
    const sent = f.telegram.sent().at(-1)!; const data = string(object((object(sent.reply_markup).inline_keyboard as Json[][])[0]![1]).callback_data);
    const click = (id: number, topic = 101, owner = 42, messageId = f.telegram.message) => ({ update_id: id, callback_query: { id: String(id), from: { id: owner }, data,
      message: { message_id: messageId, chat: { id: owner, type: 'private' }, message_thread_id: topic } } });
    await f.bridge.update(click(3, 102)); await f.bridge.update(click(4, 101, 99)); await f.bridge.update(click(5, 101, 42, 1));
    assert.equal(f.state.viewMode(), 'classic');
    await f.bridge.update(click(6)); await f.bridge.update(click(7)); assert.equal(f.state.viewMode(), 'widgets');
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('rebound or excluded sessions cannot leak queued widget data or use old fallback buttons', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start(); f.advance();
    f.state.installTopic('thread-a', 555, f.projectA, 'Moved');
    assert.equal(await f.flush(), false); assert.equal(f.telegram.calls.some(call => call.method === 'sendWidget'), false);
  } finally { f.close(); }
});

test('template and Unicode snapshots fit server byte limits and use Telegram theme/text/safe-area tokens', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets'); await f.start();
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
      f.state.setViewMode('widgets'); await f.start(); f.advance();
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
    f.state.setViewMode('widgets'); await f.start(); const base = f.state.widgetCard('thread-a', 'live')!;
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
    f.state.setViewMode('widgets'); await f.start('done'); f.advance(); await f.flush();
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

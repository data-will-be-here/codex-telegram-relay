import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, message, click, messageBody } from './helpers.js';
import { Bridge } from '../src/bridge.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { RpcError } from '../src/codex.js';
import { array, object, string } from '../src/types.js';

test('automatic discovery picks up a later session in a new project and routes its messages while preserving ignored sessions', async () => {
  const f = await fixture();
  try {
    const newProject = join(f.dir, 'new-project'); mkdirSync(newProject);
    f.codex.sessions.push({ id: 'new-session', cwd: newProject, name: '', status: 'idle' }, { id: 'ignored-session', cwd: newProject, name: '', status: 'idle' });
    await f.bridge.discover();
    assert.equal(f.state.binding('new-session'), undefined);
    const config = { ...f.bridge.config, sessionScope: 'all' as const, ignoredThreadIds: ['ignored-session'] };
    const automatic = new Bridge(config, f.state, f.codex, f.telegram);
    await automatic.discover();
    const topic = f.state.binding('new-session')?.topicId;
    assert.ok(topic, 'A session in a newly opened project must receive a topic automatically.');
    assert.equal(f.state.binding('ignored-session'), undefined);
    await automatic.update(message(990, topic, 'Continue in the new project'));
    assert.deepEqual(f.codex.writes, [{ method: 'start', params: { threadId: 'new-session', text: 'Continue in the new project' } }]);
    await automatic.notification('item/completed', { threadId: 'new-session', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', phase: 'commentary', text: 'Working in the new project' } });
    await automatic.notification('item/completed', { threadId: 'ignored-session', turnId: 'turn', item: { id: 'ignored-reply', type: 'agentMessage', phase: 'commentary', text: 'Do not relay this' } });
    await f.drain();
    assert.deepEqual(f.telegram.sent().map(messageBody), ['Working in the new project']);
    assert.equal(f.telegram.sent()[0]!.message_thread_id, topic);
    await automatic.discover();
    assert.equal(f.state.bindings().length, 3);
  } finally { f.close(); }
});

test('known host questions remain answerable after a later turn and reconnect without importing unrelated old questions', async () => {
  const f = await fixture();
  const askedAtMs = Date.parse('2026-11-02T10:00:01Z'); let later = false;
  try {
    Object.assign(f.codex, { asyncQuestions: async (_threadId: string, since?: number) => !later || (since !== undefined && since <= askedAtMs)
      ? [{ callId: 'kept', turnId: 'old-turn', askedAtMs, questions: [{ title: 'Still waiting?', options: ['Yes'] }] }] : [] });
    await f.bridge.discover(); await f.drain(); later = true;
    const restarted = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await restarted.discover(); await f.drain();
    const cards = f.telegram.sent().filter(s => s.message_thread_id === 101 && string(s.text).includes('Still waiting?'));
    assert.equal(cards.length, 2);
    const data = string(object(array(array(object(cards.at(-1)!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await restarted.update(click(900, data));
    assert.equal(f.codex.writes.length, 1);
  } finally { f.close(); }
});

test('a host answer rejected by an unready session stays available and can be retried exactly once when ready', async () => {
  const f = await fixture();
  try {
    Object.assign(f.codex, { asyncQuestions: async () => [{ callId: 'retry', turnId: 'turn', questions: [{ title: 'Choose', options: ['A'] }] }] });
    await f.bridge.discover(); await f.drain();
    const card = f.telegram.sent().find(s => s.message_thread_id === 101)!;
    const data = string(object(array(array(object(card.reply_markup).inline_keyboard)[0])[0]).callback_data);
    f.codex.sessions[0]!.status = 'systemError';
    await f.bridge.update(click(901, data));
    assert.equal(f.codex.writes.length, 0);
    assert.equal(f.state.asyncAnswered('thread-a', 'retry'), false);
    f.codex.sessions[0]!.status = 'idle';
    await f.bridge.update(click(902, data)); await f.bridge.update(click(903, data));
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.state.asyncAnswered('thread-a', 'retry'), true);
  } finally { f.close(); }
});

test('an uncertain host answer stays consumed after reconnect and is never automatically sent again', async () => {
  const f = await fixture();
  try {
    Object.assign(f.codex, { asyncQuestions: async () => [{ callId: 'uncertain', turnId: 'turn', questions: [{ title: 'Choose', options: ['A'] }] }] });
    f.codex.start = async (threadId, text) => { f.codex.writes.push({ method: 'start', params: { threadId, text } }); throw new RpcError('Uncertain delivery', true); };
    await f.bridge.discover(); await f.drain();
    const card = f.telegram.sent().find(s => s.message_thread_id === 101)!;
    const data = string(object(array(array(object(card.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await assert.rejects(f.bridge.update(click(906, data)), /Uncertain delivery/u);
    await new Bridge(f.bridge.config, f.state, f.codex, f.telegram).discover();
    await f.bridge.update(click(907, data));
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.state.asyncAnswered('thread-a', 'uncertain'), true);
  } finally { f.close(); }
});

test('partial native question answers survive reconnect with a new RPC id and fresh controls', async () => {
  const f = await fixture();
  try {
    const params = { threadId: 'thread-a', turnId: 'turn', itemId: 'item', questions: [{ id: 'one', question: 'First?', options: [{ label: 'A' }] }, { id: 'two', question: 'Second?', options: [{ label: 'B' }] }] };
    f.codex.pending.add('old'); await f.bridge.request({ id: 'old', method: 'item/tool/requestUserInput', params }); await f.drain();
    const first = string(object(array(array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.update(click(904, first));
    f.codex.pending.delete('old'); f.codex.pending.add('new');
    const restarted = new Bridge(f.bridge.config, f.state, f.codex, f.telegram); await restarted.discover();
    await restarted.request({ id: 'new', method: 'item/tool/requestUserInput', params }); await f.drain();
    assert.ok(string(f.telegram.sent().at(-1)!.text).includes('Second?'));
    await restarted.update(message(905, 101, 'B'));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'new', result: { answers: { one: { answers: ['A'] }, two: { answers: ['B'] } } } } }]);
  } finally { f.close(); }
});

test('host async questions have owner-scoped buttons and text answers, persist after completion, and never fake an RPC response', async () => {
  const f = await fixture();
  try {
    Object.assign(f.codex, { asyncQuestions: async () => [{ callId: 'host-q', turnId: 'turn', questions: [{ title: 'Choose a processor', options: ['Local', 'External'] }] }] });
    await f.bridge.discover(); await f.bridge.discover(); await f.drain();
    const questions = f.telegram.sent().filter(s => s.message_thread_id === 101 && string(s.text).includes('Choose a processor'));
    assert.equal(questions.length, 1);
    const data = string(object(array(array(object(questions[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Waiting for you' }] } });
    await f.bridge.update(click(1, data, 101, 99));
    await f.bridge.update(click(2, data, 102));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(message(3, 101, 'Local, please'));
    await f.bridge.update(click(4, data));
    assert.deepEqual(f.codex.writes, [{ method: 'start', params: { threadId: 'thread-a', text: 'Question: Choose a processor\nAnswer: Local, please' } }]);
    assert.equal(f.state.asyncAnswered('thread-a', 'host-q'), true);
    await new Bridge(f.bridge.config, f.state, f.codex, f.telegram).discover(); await f.drain();
    assert.equal(f.telegram.sent().filter(s => s.message_thread_id === 101 && string(s.text).includes('Choose a processor')).length, 1);
  } finally { f.close(); }
});

test('host questions answered in the native UI invalidate Telegram buttons before the next discovery', async () => {
  const f = await fixture(); let resolved = false;
  try {
    Object.assign(f.codex, { asyncQuestions: async () => resolved ? [] : [{ callId: 'host-q', turnId: 'turn', questions: [{ title: 'Pick', options: ['A', 'B'] }] }] });
    await f.bridge.discover(); await f.drain();
    const sent = f.telegram.sent().find(s => s.message_thread_id === 101)!;
    const data = string(object(array(array(object(sent.reply_markup).inline_keyboard)[0])[0]).callback_data);
    resolved = true;
    await f.bridge.update(click(1, data));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('approval buttons stop working when the session moves outside the selected project roots', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('moved');
    await f.bridge.request({ id: 'moved', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'example' } });
    await f.drain();
    const data = string(object(array(array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    f.codex.sessions[0]!.cwd = f.dir;
    await f.bridge.update(click(1, data));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('all mode forwards informative partial answers without forwarding reasoning', async () => {
  const f = await fixture('all');
  try {
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn', item: { id: 'p', type: 'agentMessage', phase: 'partial_answer', text: 'Visible progress' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn', item: { id: 'r', type: 'reasoning', text: 'Hidden' } });
    await f.drain();
    assert.deepEqual(f.telegram.sent().map(messageBody), ['Visible progress']);
  } finally { f.close(); }
});

test('two projects get distinct persistent topics; idle messages target the matching native thread', async () => {
  const f = await fixture();
  try {
    assert.equal(f.state.bindings().length, 2);
    await f.bridge.discover();
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 2);
    await f.bridge.update(message(1, 102, 'Fix project B'));
    await f.bridge.update(message(2, 101, 'Fix project A'));
    assert.deepEqual(f.codex.writes, [
      { method: 'start', params: { threadId: 'thread-b', text: 'Fix project B' } },
      { method: 'start', params: { threadId: 'thread-a', text: 'Fix project A' } },
    ]);
  } finally { f.close(); }
});

test('unknown users and group chats cannot journal, allocate topics, or invoke Codex', async () => {
  const f = await fixture();
  try {
    const count = f.telegram.calls.length;
    await f.bridge.update(message(1, 101, 'Do something', 99));
    const group = message(2); object(object(group.message).chat).type = 'supergroup';
    await f.bridge.update(group);
    assert.equal(f.codex.writes.length, 0);
    assert.equal(f.telegram.calls.length, count);
    // If an unknown update had been journaled, admission of the same ID would fail.
    assert.equal(f.state.admit(1, 101), true);
    assert.equal(f.state.offset(), 3);
  } finally { f.close(); }
});

test('duplicate Telegram updates never submit the instruction twice', async () => {
  const f = await fixture();
  try { await f.bridge.update(message(1)); await f.bridge.update(message(1)); assert.equal(f.codex.writes.length, 1); }
  finally { f.close(); }
});

test('Telegram input receives the actual first assistant reply once, without a canned acknowledgement', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(1, 101, 'Start work'));
    await f.bridge.update(message(1, 101, 'Start work'));
    await f.drain();
    assert.equal(f.telegram.sent().length, 0);
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'new-turn', item: { type: 'agentMessage', phase: 'commentary', text: '**Понял**, проверю причину.' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'new-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Reading files' } });
    await f.drain();
    assert.equal(f.telegram.sent().length, 1);
    assert.equal(f.telegram.sent()[0]!.message_thread_id, 101);
    assert.equal(messageBody(f.telegram.sent()[0]!), 'Понял, проверю причину.');
    assert.ok(f.telegram.sent()[0]!.entities);
    f.codex.sessions[1]!.status = 'active';
    f.codex.histories.set('thread-b', [{ id: 'busy-turn', status: 'inProgress' }]);
    await f.bridge.update(message(2, 102, 'Change direction'));
    await f.bridge.notification('item/completed', { threadId: 'thread-b', turnId: 'other-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Unrelated turn' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-b', turnId: 'busy-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Учту изменение.' } });
    await f.drain();
    assert.equal(f.telegram.sent().length, 2);
    assert.equal(f.telegram.sent()[1]!.message_thread_id, 102);
    assert.equal(messageBody(f.telegram.sent()[1]!), 'Учту изменение.');
    f.codex.failSteer = true;
    await assert.rejects(f.bridge.update(message(3, 102, 'Another direction')));
    await f.drain();
    assert.ok(f.telegram.sent().every(s => !string(s.text).includes('accepted by Codex')));
  } finally { f.close(); }
});

test('a first reply arriving before the native RPC result is preserved, then only the final answer follows', async () => {
  const f = await fixture();
  try {
    f.codex.start = async () => {
      await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'fast-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Проверю это.' } });
      return { turn: { id: 'fast-turn' } };
    };
    await f.bridge.update(message(1));
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'fast-turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Reading file' } });
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'fast-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Готово.' }] } });
    await f.drain();
    assert.equal(f.telegram.sent().length, 2);
    assert.equal(messageBody(f.telegram.sent()[0]!), 'Проверю это.');
    assert.match(string(f.telegram.sent()[1]!.text), /Готово/u);
    assert.equal(f.state.reply('thread-a'), undefined);
  } finally { f.close(); }
});

test('reconnecting before the first reply retains the wait but does not replay commentary afterwards', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(1));
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await bridge.discover();
    const reply = { threadId: 'thread-a', turnId: 'turn', item: { type: 'agentMessage', phase: 'commentary', text: 'Первый ответ.' } };
    await bridge.notification('item/completed', reply);
    await bridge.notification('item/completed', reply);
    await f.drain();
    assert.equal(f.telegram.sent().length, 1);
    assert.equal(messageBody(f.telegram.sent()[0]!), 'Первый ответ.');
  } finally { f.close(); }
});

test('busy input steers the expected active turn; uncertain steering never creates a fallback turn', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'turn-active', status: 'inProgress' }]);
    f.codex.failSteer = true;
    await assert.rejects(f.bridge.update(message(1, 101, 'Change direction')));
    assert.deepEqual(f.codex.writes, [{ method: 'steer', params: { threadId: 'thread-a', turnId: 'turn-active', text: 'Change direction' } }]);
    assert.equal(f.state.uncertainCount(), 1);
    await f.bridge.update(message(1, 101, 'Change direction'));
    assert.equal(f.codex.writes.length, 1);
  } finally { f.close(); }
});

test('commentary is suppressed and final delivery is deduplicated across native event/catch-up', async () => {
  const f = await fixture();
  try {
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'commentary', text: 'Reading files' } });
    await f.drain(); assert.equal(f.telegram.sent().length, 0);
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Tests passed' } });
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn-1', status: 'completed' } });
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn-1', status: 'completed' } });
    await f.drain();
    assert.equal(f.telegram.sent().length, 1);
    assert.match(string(f.telegram.sent()[0]!.text), /Tests passed/u);
    assert.equal(f.telegram.sent()[0]!.message_thread_id, 101);
  } finally { f.close(); }
});

test('all mode relays every assistant message once while excluding tools and system events', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(500, 101, '/mode all'));
    await f.drain(); f.telegram.calls.length = 0;
    const first = { threadId: 'thread-a', turnId: 'turn-all', item: { id: 'a1', type: 'agentMessage', phase: 'commentary', text: '**Начинаю** проверку.' } };
    await f.bridge.notification('item/completed', first);
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-all', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'Ran Get-Content' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-all', item: { id: 'file', type: 'fileChange', text: 'Added file' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-all', item: { id: 'reasoning', type: 'reasoning', text: 'Synthetic internal item' } });
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-all', item: { id: 'a2', type: 'agentMessage', phase: 'commentary', text: 'Нашёл причину, исправляю.' } });
    const final = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Готово.' };
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn-all', item: final });
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn-all', status: 'completed', items: [final] } });
    const reconnect = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await reconnect.discover();
    await reconnect.notification('item/completed', first);
    await f.drain();
    assert.equal(f.telegram.sent().length, 3);
    assert.equal(messageBody(f.telegram.sent()[0]!), 'Начинаю проверку.');
    assert.ok(f.telegram.sent()[0]!.entities);
    assert.equal(messageBody(f.telegram.sent()[1]!), 'Нашёл причину, исправляю.');
    assert.match(string(f.telegram.sent()[2]!.text), /Готово/u);
    assert.ok(f.telegram.sent().every(s => s.message_thread_id === 101));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('only the owner can switch message modes; changes apply immediately without starting a Codex turn', async () => {
  const f = await fixture('all');
  try {
    await f.bridge.update(message(1, 101, '/mode compact', 99));
    assert.equal(f.state.messageMode(), 'all');
    await f.bridge.update(message(2, 101, '/mode compact'));
    assert.equal(f.state.messageMode(), 'compact');
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn', item: { id: 'hidden', type: 'agentMessage', phase: 'commentary', text: 'Hidden in compact' } });
    await f.bridge.update(message(3, 101, '/mode all'));
    assert.equal(f.state.messageMode(), 'all');
    await f.bridge.notification('item/completed', { threadId: 'thread-a', turnId: 'turn', item: { id: 'visible', type: 'agentMessage', phase: 'commentary', text: 'Visible in all' } });
    await f.bridge.update(message(4, 101, '/mode invalid'));
    assert.equal(f.state.messageMode(), 'all');
    await f.drain();
    assert.ok(f.telegram.sent().some(s => messageBody(s) === 'Visible in all'));
    assert.ok(f.telegram.sent().every(s => messageBody(s) !== 'Hidden in compact'));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('topic names stay project/id when the native status changes, including reconnects', async () => {
  const f = await fixture();
  try {
    const original = f.state.binding('thread-a')!;
    f.codex.sessions[0]!.status = 'active';
    await f.bridge.discover();
    await new Bridge(f.bridge.config, f.state, f.codex, f.telegram).discover();
    assert.equal(f.state.binding('thread-a')?.title, original.title);
    assert.equal(f.state.binding('thread-a')?.topicId, original.topicId);
    assert.equal(f.telegram.calls.filter(c => c.method === 'editForumTopic').length, 0);
  } finally { f.close(); }
});

test('native approval needs an owner click in its own topic, then becomes one-shot', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('r1');
    await f.bridge.request({ id: 'r1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'echo harmless', availableDecisions: ['accept', 'decline'] } });
    assert.equal(f.codex.writes.length, 0);
    await f.drain();
    const rows = array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard);
    const data = string(object(array(rows[0])[0]).callback_data);
    await f.bridge.update(click(1, data, 102));
    await f.bridge.update(click(2, data, 101, 99));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(click(3, data));
    await f.bridge.update(click(4, data));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'r1', result: { decision: 'accept' } } }]);
    await f.drain();
    const confirmations = f.telegram.sent().filter(s => string(s.text).includes('Decision sent to Codex'));
    assert.equal(confirmations.length, 0);
  } finally { f.close(); }
});

test('resolved native requests invalidate outstanding Telegram buttons', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('r1');
    await f.bridge.request({ id: 'r1', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a', reason: 'test', changes: [{ path: 'example.txt', diff: '+synthetic' }] } });
    await f.drain();
    const data = string(object(array(array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    f.codex.pending.delete('r1');
    await f.bridge.notification('serverRequest/resolved', { threadId: 'thread-a', requestId: 'r1' });
    await f.bridge.update(click(1, data));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('multi-question replies preserve native IDs and old buttons cannot answer the next question', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('q1');
    await f.bridge.request({ id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [
      { id: 'color', question: 'Color?', options: [{ label: 'Blue' }] },
      { id: 'size', question: 'Size?', options: [{ label: 'Large' }] },
    ] } });
    await f.drain();
    const oldData = string(object(array(array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.update(click(1, oldData));
    await f.bridge.update(click(2, oldData));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(message(3, 101, 'Medium'));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'q1', result: { answers: { color: { answers: ['Blue'] }, size: { answers: ['Medium'] } } } } }]);
    await f.drain();
    assert.equal(f.telegram.sent().filter(s => string(s.text).includes('Answer sent to Codex')).length, 0);
  } finally { f.close(); }
});

test('question cards list numbered choices with descriptions, concise buttons and a free-text alternative', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('q-card');
    await f.bridge.request({ id: 'q-card', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [
      { id: 'delivery', header: 'Delivery', question: 'How should it work?', options: [
        { label: 'Local bot', description: 'Runs on your computer; no server required.' },
        { label: 'Hosted bot', description: 'Requires a server that remains online.' },
      ] },
      { id: 'detail', question: 'Any additional requirements?' },
    ] } });
    await f.drain();
    const first = f.telegram.sent()[0]!;
    assert.match(string(first.text), /1\/2/u);
    assert.match(string(first.text), /1\. Local bot\nRuns on your computer/u);
    assert.match(string(first.text), /2\. Hosted bot\nRequires a server/u);
    const buttons = array(object(first.reply_markup).inline_keyboard).flatMap(array).map(object);
    assert.deepEqual(buttons.map(b => b.text), ['1 · Local bot', '2 · Hosted bot', 'Type an answer']);
    const data = string(buttons[0]!.callback_data);
    assert.ok(Buffer.byteLength(data) <= 64);
    await f.bridge.update(click(1, data, 102));
    await f.bridge.update(click(2, data, 101, 99));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(click(3, data));
    await f.drain();
    assert.ok(f.telegram.sent().some(s => string(s.text).includes('2/2')));
    await f.bridge.update(message(4, 101, 'Support my own bot'));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'q-card', result: { answers: {
      delivery: { answers: ['Local bot'] }, detail: { answers: ['Support my own bot'] },
    } } } }]);
  } finally { f.close(); }
});

test('questions that cannot be displayed completely stay in the terminal without partial answer buttons', async () => {
  const f = await fixture();
  try {
    for (const [index, question] of [
      { id: 'many', question: 'Pick', options: Array.from({ length: 11 }, (_, i) => ({ label: String(i) })) },
      { id: 'large', question: 'x'.repeat(19_000) },
      { id: 'secret', question: 'Secret?', isSecret: true },
    ].entries()) {
      await f.bridge.request({ id: 'unsupported-' + index, method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [question] } });
    }
    await f.drain();
    assert.ok(f.telegram.sent().every(s => !s.reply_markup));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('remote settings commands are not forwarded to Codex', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(1, 101, '/sandbox danger-full-access'));
    await f.bridge.update(message(2, 101, '/approval never'));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('moved native cwd outside approved roots cannot receive an instruction', async () => {
  const f = await fixture();
  try {
    const outside = join(f.dir, 'other-project'); mkdirSync(outside);
    f.codex.sessions[0]!.cwd = outside;
    await f.bridge.update(message(1));
    assert.equal(f.codex.writes.length, 0);
    assert.equal(f.state.uncertainCount(), 0);
    await f.drain();
    assert.ok(f.telegram.sent().some(s => string(s.text).includes('outside configured roots')));
  } finally { f.close(); }
});

test('unsupported and oversized approvals do not offer a blind acceptance button', async () => {
  const f = await fixture();
  try {
    await f.bridge.request({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-a' } });
    await f.bridge.request({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'x'.repeat(19_000) } });
    await f.drain();
    assert.equal(f.codex.writes.length, 0);
    assert.ok(f.telegram.sent().every(x => !x.reply_markup));
  } finally { f.close(); }
});

test('native cancel-only rejection is offered without inventing a decline decision', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('r1');
    await f.bridge.request({ id: 'r1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'echo safe', availableDecisions: ['accept', 'cancel'] } });
    await f.drain();
    const buttons = array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard).flatMap(array).map(object);
    assert.deepEqual(buttons.map(b => b.text), ['Allow once', 'Cancel turn']);
    await f.bridge.update(click(1, string(buttons[1]!.callback_data)));
    assert.deepEqual(f.codex.writes[0]!.params.result, { decision: 'cancel' });
  } finally { f.close(); }
});

test('file approval without its proposed diff stays in the terminal', async () => {
  const f = await fixture();
  try {
    await f.bridge.request({ id: 'r1', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a', itemId: 'change1' } });
    await f.drain();
    assert.ok(f.telegram.sent().every(x => !x.reply_markup));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('moving a native session outside selected projects stops outgoing content too', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.cwd = f.dir;
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'outside-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'OUTSIDE_PRIVATE_TEXT' }] } });
    await f.drain();
    assert.ok(f.telegram.sent().every(x => !string(x.text).includes('OUTSIDE_PRIVATE_TEXT')));
  } finally { f.close(); }
});

test('native question IDs are data, including prototype-like names', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('q');
    await f.bridge.request({ id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [{ id: '__proto__', question: 'Pick a value' }] } });
    await f.bridge.update(message(1, 101, 'Synthetic answer'));
    const answers = object(f.codex.writes[0]!.params.result).answers;
    assert.deepEqual(Object.keys(object(answers)), ['__proto__']);
    assert.equal(object(object(answers).__proto__).answers instanceof Array, true);
  } finally { f.close(); }
});

test('reconnection does not spam an unchanged background approval', async () => {
  const f = await fixture();
  try {
    const read = f.codex.read.bind(f.codex);
    f.codex.read = async id => ({ ...await read(id), status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    for (let reconnect = 0; reconnect < 4; reconnect++) {
      const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
      await bridge.discover();
      await bridge.request({ id: 'transport-' + reconnect, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a', turnId: 'same-turn', itemId: 'same-file-change', reason: 'Unchanged pending approval' } });
      await f.drain();
    }
    const warnings = f.telegram.sent().filter(m => m.message_thread_id === 101);
    assert.equal(warnings.length, 1, 'the same background request must produce one attention notice across reconnects');
  } finally { f.close(); }
});

test('ignored sessions preserve their topics but never attach, receive input or deliver queued output', async () => {
  const f = await fixture();
  try {
    const config = { ...f.bridge.config, ignoredThreadIds: ['thread-a'] };
    const attach = f.codex.attach.bind(f.codex); const attached: string[] = [];
    f.codex.attach = async id => { attached.push(id); return attach(id); };
    const bridge = new Bridge(config, f.state, f.codex, f.telegram);
    await bridge.discover();
    assert.deepEqual(attached, ['thread-b']);
    assert.equal(f.state.bindings().length, 2);
    f.state.enqueue('final/thread-a/queued', 101, 'Old queued answer');
    await bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'ignored', status: 'completed' } });
    await bridge.update(message(1, 101, 'Do not forward'));
    await bridge.update(message(2, 102, 'Still forward B'));
    await bridge.notification('item/completed', { threadId: 'thread-b', turnId: 'active-b', item: { type: 'agentMessage', phase: 'commentary', text: 'Working on B' } });
    assert.deepEqual(f.codex.writes, [{ method: 'start', params: { threadId: 'thread-b', text: 'Still forward B' } }]);
    const outbox = new Outbox(f.state, f.telegram, 42, 0, config.ignoredThreadIds);
    while (await outbox.flushOne()) { /* Cancel ignored deliveries; send other topics. */ }
    assert.ok(f.telegram.sent().every(s => s.message_thread_id !== 101));
    assert.ok(f.telegram.sent().some(s => s.message_thread_id === 102));
    assert.equal(f.state.uncertainCount(), 0);
  } finally { f.close(); }
});

test('ambiguous topic creation is not repeated; the owner can bind the already created topic', async () => {
  const f = await fixture();
  try {
    f.codex.sessions.push({ id: 'thread-new', cwd: f.projectA, name: 'New', status: 'idle' });
    const call = f.telegram.call.bind(f.telegram); let loseResponse = true;
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'createForumTopic' && loseResponse) { loseResponse = false; throw new TelegramError('Created, response lost', 0); }
      return result;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await new Bridge(f.bridge.config, f.state, f.codex, f.telegram).discover(); } catch { /* Old behaviour throws; regression asserts no duplicate. */ }
    }
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 3);
    assert.equal(f.state.binding('thread-new'), undefined);
    await f.bridge.update(message(1, 103, '/bind thread-new', 99));
    assert.equal(f.state.binding('thread-new'), undefined);
    await f.bridge.update(message(2, 103, '/bind thread-new'));
    assert.equal(f.state.binding('thread-new')?.topicId, 103);
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 3);
  } finally { f.close(); }
});

test('a missing Telegram topic is recreated and its undelivered answer moves to the replacement topic', async () => {
  const f = await fixture();
  try {
    f.state.enqueue('final/thread-a/deleted', 101, 'Saved answer');
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendMessage' && params.message_thread_id === 101) throw new TelegramError('Bad Request: message thread not found', 400);
      return call(method, params);
    };
    const outbox = new Outbox(f.state, f.telegram, 42, 0);
    try { await outbox.flushOne(); } catch { /* Old behaviour marks it uncertain and never repairs. */ }
    await f.bridge.discover(); await f.drain();
    assert.equal(f.state.binding('thread-a')?.topicId, 103);
    assert.ok(f.telegram.sent().some(s => s.message_thread_id === 103 && messageBody(s) === 'Saved answer'));
    assert.equal(f.state.uncertainCount(), 0);
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('a local attach error does not disconnect healthy sessions, but transport failure still reconnects', async () => {
  const f = await fixture();
  try {
    const attach = f.codex.attach.bind(f.codex);
    f.codex.attach = async id => { if (id === 'thread-a') throw new RpcError('Cannot resume this thread', false); return attach(id); };
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await bridge.discover();
    await bridge.update(message(1, 102, 'Still available'));
    assert.equal(f.codex.writes.length, 1);
    f.codex.attach = async () => { throw new RpcError('Connection lost', true); };
    await assert.rejects(new Bridge(f.bridge.config, f.state, f.codex, f.telegram).discover(), /Connection lost/u);
  } finally { f.close(); }
});

test('ambiguous replacement pauses output until binding; other topics continue and old approval buttons stay inert', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('approval');
    const request = { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'echo synthetic', availableDecisions: ['accept', 'decline'] } };
    await f.bridge.request(request); await f.drain();
    const oldData = string(object(array(array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    f.telegram.calls.length = 0;
    f.state.enqueue('final/a/restore', 101, 'Saved A');
    const call = f.telegram.call.bind(f.telegram); let loseResponse = true;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendMessage' && params.message_thread_id === 101) throw new TelegramError('Bad Request: message thread not found', 400);
      const result = await call(method, params);
      if (method === 'createForumTopic' && loseResponse) { loseResponse = false; throw new TelegramError('Replacement response lost', 0); }
      return result;
    };
    const outbox = new Outbox(f.state, f.telegram, 42, 0);
    await outbox.flushOne();
    await f.bridge.discover(); await f.bridge.discover();
    f.state.enqueue('assistant/a/new', 101, 'New A');
    f.state.enqueue('final/b/healthy', 102, 'Healthy B');
    await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 1);
    assert.ok(f.telegram.sent().some(s => messageBody(s) === 'Healthy B'));
    assert.ok(f.telegram.sent().every(s => messageBody(s) !== 'Saved A' && messageBody(s) !== 'New A'));
    await f.bridge.update(message(20, 103, '/bind thread-a'));
    await f.bridge.update(click(21, oldData, 101));
    assert.equal(f.codex.writes.length, 0);
    const attach = f.codex.attach.bind(f.codex);
    f.codex.attach = async id => { if (id === 'thread-a') await f.bridge.request(request); return attach(id); };
    await f.bridge.discover(); await f.drain();
    assert.ok(f.telegram.sent().some(s => s.message_thread_id === 103 && messageBody(s) === 'Saved A'));
    assert.ok(f.telegram.sent().some(s => s.message_thread_id === 103 && messageBody(s) === 'New A'));
    const restoredApproval = f.telegram.sent().find(s => s.message_thread_id === 103 && s.reply_markup);
    assert.ok(restoredApproval);
    const newData = string(object(array(array(object(restoredApproval.reply_markup).inline_keyboard)[0])[0]).callback_data);
    assert.notEqual(newData, oldData);
    await f.bridge.update(click(22, oldData, 103));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(click(23, newData, 103));
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.codex.writes[0]!.method, 'respond');
  } finally { f.close(); }
});

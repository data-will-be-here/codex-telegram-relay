import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, message, click } from './helpers.js';
import { Bridge } from '../src/bridge.js';
import { Outbox } from '../src/telegram.js';
import { array, object, string } from '../src/types.js';

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

test('accepted Telegram instructions get one immediate acknowledgement in their own topic', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(1, 101, 'Start work'));
    await f.bridge.update(message(1, 101, 'Start work'));
    await f.drain();
    assert.equal(f.telegram.sent().length, 1);
    assert.equal(f.telegram.sent()[0]!.message_thread_id, 101);
    assert.match(string(f.telegram.sent()[0]!.text), /accepted by Codex/u);
    f.codex.sessions[1]!.status = 'active';
    f.codex.histories.set('thread-b', [{ id: 'busy-turn', status: 'inProgress' }]);
    await f.bridge.update(message(2, 102, 'Change direction'));
    await f.drain();
    assert.equal(f.telegram.sent().length, 2);
    assert.equal(f.telegram.sent()[1]!.message_thread_id, 102);
    assert.match(string(f.telegram.sent()[1]!.text), /accepted by Codex/u);
    f.codex.failSteer = true;
    await assert.rejects(f.bridge.update(message(3, 102, 'Another direction')));
    await f.drain();
    assert.equal(f.telegram.sent().filter(s => string(s.text).includes('accepted by Codex')).length, 2);
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
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0]!.message_thread_id, 101);
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
    assert.equal(f.telegram.sent().filter(s => string(s.text).includes('Answer sent to Codex')).length, 1);
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
    await assert.rejects(f.bridge.update(message(1)), /outside configured roots/u);
    assert.equal(f.codex.writes.length, 0);
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
    assert.deepEqual(f.codex.writes, [{ method: 'start', params: { threadId: 'thread-b', text: 'Still forward B' } }]);
    const outbox = new Outbox(f.state, f.telegram, 42, 0, config.ignoredThreadIds);
    while (await outbox.flushOne()) { /* Cancel ignored deliveries; send other topics. */ }
    assert.ok(f.telegram.sent().every(s => s.message_thread_id !== 101));
    assert.ok(f.telegram.sent().some(s => s.message_thread_id === 102));
    assert.equal(f.state.uncertainCount(), 0);
  } finally { f.close(); }
});

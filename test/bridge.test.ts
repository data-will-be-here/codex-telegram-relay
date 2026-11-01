import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, message, click } from './helpers.js';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncQuestionReader } from '../src/async-questions.js';
import { temporary } from './helpers.js';

test('reads only current-turn async questions, survives split records, and removes externally answered questions', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    const event = (payload: unknown, timestamp = '2026-11-02T10:00:01Z') => JSON.stringify({ timestamp, type: 'response_item', payload }) + '\n';
    const call = { type: 'function_call', name: 'request_user_input_async', call_id: 'call-q', arguments: JSON.stringify({ questions: [{ title: 'Pick?', options: ['A', 'B'] }] }) };
    writeFileSync(path, event({ ...call, call_id: 'old' }, '2026-11-01T10:00:00Z') + event({ type: 'function_call', name: 'exec_command', arguments: 'private command' }));
    const reader = new AsyncQuestionReader();
    const record = event(call);
    appendFileSync(path, record.slice(0, 90));
    assert.deepEqual(await reader.read(path, 'turn', Date.parse('2026-11-02T10:00:00Z')), []);
    appendFileSync(path, record.slice(90));
    const result = await reader.read(path, 'turn', Date.parse('2026-11-02T10:00:00Z'));
    assert.equal(result.length, 1);
    assert.equal(result[0]!.callId, 'call-q');
    assert.deepEqual(result[0]!.questions, [{ id: '0', title: 'Pick?', options: ['A', 'B'] }]);
    const reply = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'call-q', 0]), answer: 'A' }]) + '\n</send_user_message_question_reply>';
    appendFileSync(path, event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] }));
    assert.deepEqual(await reader.read(path, 'turn', Date.parse('2026-11-02T10:00:00Z')), []);
    assert.deepEqual(await reader.read(path, 'next-turn', Date.now()), []);
  } finally { f.close(); }
});

test('a large journal stays quiet after restart and a subsequent turn when no questions were missed', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ timestamp: '2026-11-01T10:00:00Z', type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(9 * 1024 * 1024) } }) + '\n');
    const started = Date.parse('2026-11-02T10:00:00Z');
    assert.deepEqual(await new AsyncQuestionReader().read(path, 'turn-1', started), []);
    const restarted = new AsyncQuestionReader();
    assert.deepEqual(await restarted.read(path, 'turn-1', started), []);
    appendFileSync(path, JSON.stringify({ timestamp: '2026-11-02T10:01:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] } }) + '\n');
    assert.deepEqual(await restarted.read(path, 'turn-2', started + 60_000), []);
  } finally { f.close(); }
});

test('recovers a current question before a large tool result instead of warning that history may be missing', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    const timestamp = '2026-11-02T10:00:01Z';
    const question = { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'q-before-output', arguments: JSON.stringify({ questions: [{ title: 'Proceed?', options: ['Yes', 'No'] }] }) } };
    writeFileSync(path, JSON.stringify(question) + '\n' + JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(9 * 1024 * 1024) } }) + '\n');
    const reader = new AsyncQuestionReader();
    const result = await reader.read(path, 'turn', Date.parse('2026-11-02T10:00:00Z'));
    assert.deepEqual(result.map(q => q.callId), ['q-before-output']);
    assert.deepEqual((await reader.read(path, 'turn', Date.parse('2026-11-02T10:00:00Z'))).map(q => q.callId), ['q-before-output']);
  } finally { f.close(); }
});

test('finishes the journal snapshot before publishing a question answered beyond the first read chunk', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    const event = (payload: unknown) => JSON.stringify({ timestamp: '2026-11-02T10:00:01Z', type: 'response_item', payload }) + '\n';
    const reply = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'resolved', 0]), answer: 'Done' }]) + '\n</send_user_message_question_reply>';
    writeFileSync(path, event({ type: 'function_call', name: 'request_user_input_async', call_id: 'resolved', arguments: JSON.stringify({ questions: [{ title: 'Proceed?' }] }) }) +
      event({ type: 'function_call_output', output: 'x'.repeat(9 * 1024 * 1024) }) +
      event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] }));
    assert.deepEqual(await new AsyncQuestionReader().read(path, 'turn', Date.parse('2026-11-02T10:00:00Z')), []);
  } finally { f.close(); }
});

test('sensitive or malformed host questions produce a terminal-only marker without exposing their contents', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'secret', arguments: JSON.stringify({ questions: [{ title: 'Private secret', isSecret: true }] }) } }) + '\n');
    const result = await new AsyncQuestionReader().read(path, 'turn', 0);
    assert.equal(result[0]?.needsTerminal, true);
    assert.ok(!JSON.stringify(result).includes('Private secret'));
  } finally { f.close(); }
});

test('an oversized host question produces a terminal notice without exposing its payload or treating tool output as a question', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    const event = (payload: unknown) => JSON.stringify({ timestamp: '2026-11-02T10:00:01Z', type: 'response_item', payload }) + '\n';
    writeFileSync(path, event({ type: 'function_call', name: 'request_user_input_async', call_id: 'large', arguments: JSON.stringify({ questions: [{ title: 'private'.repeat(50_000) }] }) }) +
      event({ type: 'function_call_output', output: 'request_user_input_async'.repeat(30_000) }));
    const result = await new AsyncQuestionReader().read(path, 'turn', 0);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.needsTerminal, true);
    assert.ok(!JSON.stringify(result).includes('private'));
  } finally { f.close(); }
});

test('question capacity overflow is visible and an external answer retires its notice', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    const event = (payload: unknown) => JSON.stringify({ timestamp: '2026-11-02T10:00:01Z', type: 'response_item', payload }) + '\n';
    writeFileSync(path, Array.from({ length: 33 }, (_, index) => event({ type: 'function_call', name: 'request_user_input_async', call_id: `q-${index}`, arguments: JSON.stringify({ questions: [{ title: 'Question' }] }) })).join(''));
    const reader = new AsyncQuestionReader();
    const questions = await reader.read(path, 'turn', 0);
    assert.equal(questions.filter(q => !q.needsTerminal).length, 32);
    assert.equal(questions.find(q => q.callId === 'q-32')?.needsTerminal, true);
    const reply = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'q-32', 0]), answer: 'Done' }]) + '\n</send_user_message_question_reply>';
    appendFileSync(path, event({ type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] }));
    assert.equal((await reader.read(path, 'turn', 0)).some(q => q.callId === 'q-32'), false);
  } finally { f.close(); }
});

test('an unanswered question survives a new turn until an explicit native answer arrives', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    const event = (type: string, payload: unknown, timestamp = '2026-11-02T10:00:01Z') => JSON.stringify({ timestamp, type, payload }) + '\n';
    writeFileSync(path, event('event_msg', { type: 'task_started', turn_id: 'turn-1' }) + event('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'waiting', arguments: JSON.stringify({ questions: [{ title: 'Pick' }] }) }));
    const since = Date.parse('2026-11-02T10:00:00Z');
    const reader = new AsyncQuestionReader();
    assert.equal((await reader.read(path, 'turn-1', since))[0]?.callId, 'waiting');
    appendFileSync(path, event('event_msg', { type: 'task_started', turn_id: 'turn-2' }, '2026-11-02T10:01:01Z'));
    const next = await reader.read(path, 'turn-2', since + 60_000);
    assert.equal(next[0]?.callId, 'waiting');
    assert.equal(next[0]?.turnId, 'turn-1');
    assert.equal((await new AsyncQuestionReader().read(path, 'turn-2', since))[0]?.turnId, 'turn-1');
  } finally { f.close(); }
});

test('questions already answered through Telegram do not consume journal question capacity', async () => {
  const f = temporary();
  try {
    const path = join(f.dir, 'session.jsonl');
    writeFileSync(path, Array.from({ length: 33 }, (_, i) => JSON.stringify({ timestamp: '2026-11-02T10:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: `q-${i}`, arguments: JSON.stringify({ questions: [{ title: 'Question' }] }) } }) + '\n').join(''));
    const reader = new AsyncQuestionReader();
    await reader.read(path, 'turn', 0);
    const result = await reader.read(path, 'turn', 0, Array.from({ length: 32 }, (_, i) => `q-${i}`));
    assert.deepEqual(result.map(q => q.callId), ['q-32']);
    assert.equal(result[0]?.needsTerminal, undefined);
  } finally { f.close(); }
});

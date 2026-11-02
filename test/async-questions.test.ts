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

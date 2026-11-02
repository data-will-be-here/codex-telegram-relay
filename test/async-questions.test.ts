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

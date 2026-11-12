import { test } from 'node:test';
import assert from 'node:assert/strict';
import { State } from '../src/state.js';
import { Bridge } from '../src/bridge.js';
import { Outbox } from '../src/telegram.js';
import { fixture, message, messageBody } from './helpers.js';
import { type Json } from '../src/types.js';
import { join } from 'node:path';

const completed = (id: string, text: string): Json => ({ id, status: 'completed', items: [{ id: `${id}-answer`, type: 'agentMessage', phase: 'final_answer', text }] });

test('a final received at queue capacity survives a later completion and restart without native replay', async () => {
  const f = await fixture(); let state = new State(join(f.dir, 'recovery'));
  state.setViewMode('classic');
  try {
    const original = new Bridge(f.bridge.config, state, f.codex, f.telegram);
    await original.discover();
    const topicId = state.binding('thread-a')!.topicId;
    for (let index = 0; index < 1000; index++) state.enqueue(`filler/${index}`, topicId, 'Queued commentary');
    const first = completed('first', 'FIRST IMPORTANT ANSWER');
    await original.notification('turn/completed', { threadId: 'thread-a', turn: first });
    // Another completed turn must not make the first answer unrecoverable.
    const second = completed('second', 'SECOND IMPORTANT ANSWER');
    f.codex.histories.set('thread-a', [second, first]);
    await original.notification('turn/completed', { threadId: 'thread-a', turn: second });
    assert.equal(state.pendingFinalCount(), 2);
    await original.update(message(8000, topicId, '/status'));
    const home = state.home; state.close(); state = new State(home);
    const bridge = new Bridge(f.bridge.config, state, f.codex, f.telegram);
    await bridge.discover();
    const outbox = new Outbox(state, f.telegram, f.bridge.config, 0);
    while (await outbox.flushOne()) { /* Exercise the real durable sender after restart. */ }
    const answers = f.telegram.sent().map(messageBody);
    assert.equal(answers.filter(text => text.includes('FIRST IMPORTANT ANSWER')).length, 1);
    assert.equal(answers.filter(text => text.includes('SECOND IMPORTANT ANSWER')).length, 1);
    assert.ok(answers.findIndex(text => text.includes('FIRST IMPORTANT ANSWER')) < answers.findIndex(text => text.includes('SECOND IMPORTANT ANSWER')));
    assert.ok(answers.some(text => text.includes('Pending final answers: 2')));
    assert.equal(state.pendingFinalCount(), 0);
    assert.deepEqual(f.codex.writes, []);
  } finally { state.close(); f.close(); }
});

test('narrowing project scope cancels old finals, controls and project notices before sending', async () => {
  const f = await fixture();
  try {
    f.state.enqueue('final/thread-b/old', 102, 'EXCLUDED FINAL');
    f.state.enqueue('prompt/old/approval', 102, 'EXCLUDED CONTROL', { inline_keyboard: [[{ text: 'Allow', callback_data: 'old' }]] });
    f.state.enqueue('notice/project-b', null, 'EXCLUDED PROJECT NOTICE', null, f.projectB);
    f.state.enqueue('final/thread-a/healthy', 101, 'ALLOWED FINAL');
    f.state.missingTopic(f.state.binding('thread-b')!);
    const config = { ...f.bridge.config, roots: [f.projectA], sessionScope: 'selected' as const };
    const bridge = new Bridge(config, f.state, f.codex, f.telegram);
    await bridge.discover();
    const outbox = new Outbox(f.state, f.telegram, config, 0);
    while (await outbox.flushOne()) { /* Same sender seam as a fresh narrowed installation. */ }
    assert.equal(f.telegram.sent().some(message => String(message.text).includes('EXCLUDED')), false);
    assert.equal(f.telegram.sent().filter(message => String(message.text).includes('ALLOWED FINAL')).length, 1);
    assert.equal(f.state.pendingFinalCount(), 0, 'Excluded blocked finals must also be cancelled.');
    config.roots.push(f.projectB);
    while (await outbox.flushOne()) { /* Re-enabling does not resurrect cancelled deliveries. */ }
    assert.equal(f.telegram.sent().some(message => String(message.text).includes('EXCLUDED')), false);
  } finally { f.close(); }
});

test('project revocation stops the remaining parts of an ordinary or rich answer', async () => {
  for (const rich of [false, true]) {
    const f = await fixture();
    try {
      const config = { ...f.bridge.config, roots: [f.projectA, f.projectB] };
      const text = rich ? '| Item | Description |\n| --- | --- |\n' + Array.from({ length: 100 }, (_, index) => `| ${index} | ${'description '.repeat(25)} |`).join('\n') : 'ordinary text '.repeat(800);
      f.state.enqueue('final/thread-b/multipart', 102, text);
      const call = f.telegram.call.bind(f.telegram);
      f.telegram.call = async (method, params) => {
        const result = await call(method, params);
        if (method === 'sendMessage' || method === 'sendRichMessage') config.roots = [f.projectA];
        return result;
      };
      const sender = new Outbox(f.state, f.telegram, config, 0);
      await sender.flushOne();
      assert.equal(f.telegram.calls.filter(call => call.method === (rich ? 'sendRichMessage' : 'sendMessage')).length, 1);
      assert.equal(f.state.pendingFinalCount(), 0); assert.equal(f.state.uncertainCount(), 0);
      assert.deepEqual(f.codex.writes, []);
    } finally { f.close(); }
  }
});

test('status diagnostics are delivered before queued commentary', async () => {
  const f = await fixture();
  try {
    f.state.enqueue('assistant/thread-a/earlier', 101, 'Earlier commentary');
    await f.bridge.update(message(8500, 101, '/status'));
    await f.drain();
    assert.match(messageBody(f.telegram.sent()[0]!), /Pending final answers: 0/u);
    assert.equal(messageBody(f.telegram.sent()[1]!), 'Earlier commentary');
  } finally { f.close(); }
});

test('ignoring one session cancels only its topicless notices when projects are shared', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[1]!.cwd = f.projectA;
    f.codex.attach = async () => { throw new Error('Synthetic session unavailable'); };
    await new Bridge(f.bridge.config, f.state, f.codex, f.telegram).discover();
    const config = { ...f.bridge.config, ignoredThreadIds: ['thread-a'] };
    const sender = new Outbox(f.state, f.telegram, config, 0);
    while (await sender.flushOne()) { /* Both notices have the same project and no topic. */ }
    const texts = f.telegram.sent().map(messageBody);
    assert.equal(texts.some(text => text.includes('Codex session thread-a')), false);
    assert.equal(texts.some(text => text.includes('Codex session thread-b')), true);
  } finally { f.close(); }
});

test('owner diagnostics work in an unbound topic without permitting orphan project output', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(8600, 999, '/help'));
    await f.bridge.update(message(8601, 999, '/bind invalid'));
    f.state.enqueue('final/orphan/old', 999, 'ORPHAN ANSWER');
    f.state.enqueue('prompt/orphan', 999, 'ORPHAN CONTROL', { inline_keyboard: [[{ text: 'Allow', callback_data: 'old' }]] });
    await f.drain();
    const texts = f.telegram.sent().map(messageBody);
    assert.ok(texts.some(text => text.includes('Codex Telegram Relay')));
    assert.ok(texts.some(text => text.includes('Session prefix')));
    assert.equal(texts.some(text => text.includes('ORPHAN')), false);
  } finally { f.close(); }
});

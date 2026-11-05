import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { CodexClient } from '../src/codex.js';
import { State } from '../src/state.js';
import { Outbox } from '../src/telegram.js';
import { type Json } from '../src/types.js';
import { FakeTelegram, message, messageBody, temporary } from './helpers.js';

const waitingId = 'waiting-session';
const healthyId = 'healthy-session';

async function nativeFixture() {
  const temp = temporary();
  const project = join(temp.dir, 'project'); mkdirSync(project);
  const state = new State(join(temp.dir, 'private'));
  const codex = new CodexClient();
  const telegram = new FakeTelegram();
  const config = { version: 1 as const, ownerId: 42, roots: [project], codexBinary: process.execPath };
  const bridge = new Bridge(config, state, codex, telegram);
  const outbox = new Outbox(state, telegram, config, 0);
  const close = (): void => { codex.close(); state.close(); temp.close(); };
  try {
    await codex.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    await codex.call('test/discovery', { threads: [waitingId, healthyId].map(id => ({
      id, source: 'vscode', cwd: project, path: join(project, `${id}.jsonl`), status: { type: 'idle' }, createdAt: Math.floor(Date.now() / 1000) - 3600,
    })) });
    await codex.call('test/waiting', { threadId: waitingId });
  } catch (error) { close(); throw error; }
  return {
    state, codex, telegram, bridge, config, project, close,
    drain: async () => { while (await outbox.flushOne()) { /* Synthetic Telegram only. */ } },
    records: async () => await codex.call('test/records', {}) as { method: string; params: Json }[],
  };
}

test('waiting for first local input creates no topic or warning across reconnects, then connects automatically', async () => {
  const f = await nativeFixture();
  try {
    await f.bridge.discover(); await f.drain();
    assert.equal(f.state.binding(waitingId), undefined, 'The reserved rollout path must not create an unusable topic');
    assert.ok(f.state.binding(healthyId), 'An empty session must not prevent other sessions from connecting');
    await f.bridge.discover();
    const reconnected = new Bridge(f.config, f.state, f.codex, f.telegram);
    await reconnected.discover(); await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 1);
    assert.equal(f.telegram.sent().some(s => messageBody(s).includes('temporarily unavailable')), false);
    assert.equal((await f.records()).some(c => c.method === 'thread/resume' && c.params.threadId === waitingId), false);

    await f.codex.call('test/materialize', { threadId: waitingId });
    await reconnected.discover();
    const binding = f.state.binding(waitingId)!;
    assert.ok(binding);
    await reconnected.update(message(1, binding.topicId, 'Instruction after the first local message'));
    const inputs = (await f.records()).filter(c => c.method === 'turn/start');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.params.threadId, waitingId);
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 2);
  } finally { f.close(); }
});

test('a saved empty-session topic explains first local input and reconnects without replacing or replaying it', async () => {
  const f = await nativeFixture();
  try {
    f.state.bind(waitingId, 444, f.project, 'project · waiting-');
    f.state.baseline(waitingId, '-'); // A binding left behind by an older relay.
    await f.bridge.discover();
    for (const [index, text] of ['Instruction before readiness', `/bind ${waitingId}`, `/repair ${waitingId}`].entries()) {
      await f.bridge.update(message(index + 1, 444, text));
    }
    await f.drain();
    const replies = f.telegram.sent().filter(s => s.message_thread_id === 444).map(messageBody);
    assert.equal(replies.length, 3);
    for (const reply of replies) assert.match(reply, /first message.*locally/u);
    assert.equal((await f.records()).some(c => c.method === 'turn/start'), false);
    assert.equal(f.state.binding(waitingId)?.topicId, 444);

    await f.codex.call('test/materialize', { threadId: waitingId });
    await f.bridge.update(message(4, 444, `/bind ${waitingId}`));
    assert.equal((await f.records()).some(c => c.method === 'turn/start'), false, 'Rejected instructions must not be replayed');
    await f.bridge.update(message(5, 444, 'A fresh instruction'));
    assert.equal((await f.records()).filter(c => c.method === 'turn/start').length, 1);
    assert.equal(f.state.binding(waitingId)?.topicId, 444);
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 1, 'Only the other session needs a topic');
  } finally { f.close(); }
});

test('the first answer after observed waiting is delivered even when the session predates this connection', async () => {
  const f = await nativeFixture();
  try {
    await f.bridge.discover();
    await f.codex.call('test/materialize', { threadId: waitingId, turns: [{
      id: 'first-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'The first completed answer' }],
    }] });
    await f.bridge.discover(); await f.drain();
    const binding = f.state.binding(waitingId)!;
    assert.ok(f.telegram.sent().some(s => s.message_thread_id === binding.topicId && messageBody(s).includes('The first completed answer')));
    await f.bridge.discover(); await f.drain();
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('The first completed answer')).length, 1);
  } finally { f.close(); }
});

test('manual recovery cannot create or rebind a waiting session before its first local message', async () => {
  const f = await nativeFixture();
  try {
    f.state.bind(waitingId, 444, f.project, 'project · waiting-');
    f.state.missingTopic(f.state.binding(waitingId)!);
    await f.bridge.discover();
    const healthyTopic = f.state.binding(healthyId)!.topicId;
    await f.bridge.update(message(1, healthyTopic, `/repair ${waitingId}`));
    await f.bridge.update(message(2, 555, `/bind ${waitingId}`));
    await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 1, 'Recovery must wait before a new Telegram topic is created');
    assert.equal(f.state.binding(waitingId)?.topicId, 444);
    assert.equal(f.state.topicOperation(waitingId)?.status, 'missing');
    assert.equal(f.telegram.sent().filter(s => /first message.*locally/u.test(messageBody(s))).length, 2);
    assert.equal((await f.records()).some(c => c.method === 'turn/start'), false);
  } finally { f.close(); }
});

test('a waiting saved topic explains local initialization before accepting media', async () => {
  const f = await nativeFixture();
  try {
    f.state.bind(waitingId, 444, f.project, 'project · waiting-');
    await f.bridge.discover();
    const update = message(1, 444, '');
    (update.message as Json).document = { file_id: 'synthetic-file', file_name: 'example.txt', file_size: 10 };
    await f.bridge.update(update); await f.drain();
    assert.match(messageBody(f.telegram.sent().at(-1)!), /first message.*locally/u);
    assert.equal(f.telegram.calls.some(c => c.method === 'getFile'), false);
    assert.equal((await f.records()).some(c => c.method === 'turn/start'), false);
  } finally { f.close(); }
});

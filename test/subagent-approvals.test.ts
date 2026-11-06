import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Bridge } from '../src/bridge.js';
import { CodexClient } from '../src/codex.js';
import { type Config } from '../src/config.js';
import { State } from '../src/state.js';
import { Outbox } from '../src/telegram.js';
import { array, object, string, type Json, type RpcRequest } from '../src/types.js';
import { FakeTelegram, click, messageBody, temporary } from './helpers.js';

function approval(id = 'child-approval', threadId = 'child-agent'): RpcRequest {
  return { id, method: 'item/commandExecution/requestApproval', params: {
    threadId, turnId: 'child-turn', itemId: 'child-command', command: 'echo synthetic-child-approval', availableDecisions: ['accept', 'cancel'],
  } };
}
function control(card: Json, index = 0): string {
  return string(object(array(array(object(card.reply_markup).inline_keyboard)[0])[index]).callback_data);
}

async function nativeFixture() {
  const temp = temporary();
  const project = join(temp.dir, 'project'); mkdirSync(project);
  const state = new State(join(temp.dir, 'private'));
  let codex = new CodexClient();
  const telegram = new FakeTelegram();
  const config: Config = { version: 1, ownerId: 42, roots: [project], codexBinary: process.execPath };
  let bridge = new Bridge(config, state, codex, telegram);
  let events = Promise.resolve();
  const listen = (): void => {
    codex.on('request', (request: RpcRequest) => { events = events.then(() => bridge.request(request)); });
    codex.on('notification', (method: string, params: Json) => { events = events.then(() => bridge.notification(method, params)); });
  };
  listen();
  const outbox = new Outbox(state, telegram, config, 0);
  const base = { source: 'vscode', cwd: project, status: { type: 'idle' }, path: join(project, 'history.jsonl'), ephemeral: false };
  const threads: Json[] = [
    { ...base, id: 'root-session' }, { ...base, id: 'other-root' },
    { ...base, id: 'child-agent', parentThreadId: 'root-session', canAcceptDirectInput: false,
      source: { subAgent: { thread_spawn: { parent_thread_id: 'root-session', agent_path: '/root/performance', agent_nickname: 'Euclid' } } } },
  ];
  const close = (): void => { codex.close(); state.close(); temp.close(); };
  const settle = async (): Promise<void> => { await new Promise<void>(done => setImmediate(done)); await events; };
  try {
    await codex.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    await codex.call('test/discovery', { threads });
    await bridge.discover(); await settle();
  } catch (error) { close(); throw error; }
  return {
    state, telegram, config, project, threads, close, settle,
    get codex() { return codex; },
    get bridge() { return bridge; },
    reconnect: async (pending: RpcRequest[] = []) => {
      await settle(); codex.close();
      codex = new CodexClient(); bridge = new Bridge(config, state, codex, telegram); listen();
      await codex.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
      await codex.call('test/discovery', { threads });
      // Reconstruct the synthetic daemon's still-pending work on the new transport.
      for (const request of pending) await codex.call('test/request', { request, emit: false });
      return bridge;
    },
    publish: async (request: RpcRequest) => { await codex.call('test/request', { request }); await settle(); },
    notify: async (method: string, params: Json) => { await codex.call('test/notification', { method, params }); await settle(); },
    metadata: async () => { await codex.call('test/discovery', { threads }); },
    drain: async () => { await settle(); while (await outbox.flushOne()) {} },
    records: async () => await codex.call('test/records', {}) as Json[],
  };
}

test('a child approval reaches only the parent topic, identifies its origin and answers the original request once', async () => {
  const f = await nativeFixture();
  try {
    await f.publish(approval()); await f.drain();
    const parent = f.state.binding('root-session')!;
    const other = f.state.binding('other-root')!;
    const card = f.telegram.sent().find(s => s.message_thread_id === parent.topicId && messageBody(s).includes('synthetic-child-approval'));
    assert.ok(card, 'The parent topic must receive its child approval');
    assert.match(messageBody(card), /child-agent/u);
    assert.match(messageBody(card), /performance/u);
    assert.equal(f.state.binding('child-agent'), undefined);
    await f.bridge.update(click(1, control(card), other.topicId));
    await f.bridge.update(click(2, control(card), parent.topicId, 99));
    assert.equal((await f.records()).some(r => 'result' in r), false);
    await f.bridge.update(click(3, control(card), parent.topicId));
    await f.bridge.update(click(4, control(card), parent.topicId));
    const records = await f.records();
    assert.deepEqual(records.filter(r => 'result' in r), [{ id: 'child-approval', result: { decision: 'accept' } }]);
    assert.equal(records.some(r => ['thread/start', 'turn/start', 'turn/steer'].includes(string(r.method))), false);
    assert.equal(f.state.reply('root-session'), undefined, 'Child approval must not register a child turn as a root reply');
    assert.equal(f.state.bindings().length, 2);
  } finally { f.close(); }
});

test('parent completion leaves child approvals open; native child resolution and completion retire only their controls', async () => {
  const f = await nativeFixture();
  try {
    await f.publish(approval()); await f.drain();
    const topic = f.state.binding('root-session')!.topicId;
    const first = f.telegram.sent().find(s => messageBody(s).includes('synthetic-child-approval'))!;
    await f.notify('turn/completed', { threadId: 'root-session', turn: { id: 'parent-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Parent finished' }] } });
    assert.equal(f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').length, 0, 'A parent turn must not close the child approval');
    await f.notify('serverRequest/resolved', { threadId: 'child-agent', requestId: 'child-approval' });
    assert.equal(f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').length, 1);
    await f.bridge.update(click(1, control(first), topic));
    assert.equal((await f.records()).some(r => 'result' in r), false);

    await f.publish(approval('next-child-approval')); await f.drain();
    const second = f.telegram.sent().filter(s => messageBody(s).includes('synthetic-child-approval')).at(-1)!;
    await f.notify('turn/completed', { threadId: 'child-agent', turn: { id: 'unrelated-child-turn', status: 'completed' } });
    assert.equal(f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').length, 1);
    await f.notify('turn/completed', { threadId: 'child-agent', turn: { id: 'child-turn', status: 'completed' } });
    assert.equal(f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').length, 2);
    await f.bridge.update(click(2, control(second), topic));
    assert.equal((await f.records()).some(r => 'result' in r), false);
  } finally { f.close(); }
});

test('reconnecting subscribes to existing children and replays pending approvals with fresh controls', async () => {
  const f = await nativeFixture();
  try {
    await f.publish(approval()); await f.drain();
    const first = f.telegram.sent().find(s => messageBody(s).includes('synthetic-child-approval'));
    assert.ok(first);
    const topic = f.state.binding('root-session')!.topicId;
    const previousClient = f.codex;
    await f.reconnect([approval()]);
    assert.equal(previousClient.hasRequest('child-approval'), false, 'Disconnected native pending state must be cleared');
    await f.bridge.discover(); await f.drain();
    const cards = f.telegram.sent().filter(s => messageBody(s).includes('synthetic-child-approval'));
    assert.equal(cards.length, 1, 'Native replay must refresh the existing child card');
    assert.equal(f.codex.hasRequest('child-approval'), true);
    const refreshed = f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').at(-1)!;
    assert.equal(refreshed.params.message_id, 1001);
    const newControl = control(refreshed.params);
    assert.notEqual(control(first), newControl);
    await f.bridge.update(click(1, control(first), topic));
    assert.equal((await f.records()).some(r => 'result' in r), false);
    await f.bridge.update(click(2, newControl, topic));
    await f.bridge.update(click(3, newControl, topic));
    assert.deepEqual((await f.records()).filter(r => 'result' in r), [{ id: 'child-approval', result: { decision: 'accept' } }]);
    await f.reconnect(); await f.bridge.discover(); await f.drain();
    assert.equal(f.telegram.sent().filter(s => messageBody(s).includes('synthetic-child-approval')).length, 1);
    assert.equal(f.state.bindings().length, 2);
  } finally { f.close(); }
});

test('recovering the parent topic replays its pending child approval into the replacement topic', async () => {
  const f = await nativeFixture();
  try {
    await f.publish(approval()); await f.drain();
    const previous = f.state.binding('root-session')!;
    const first = f.telegram.sent().find(s => messageBody(s).includes('synthetic-child-approval'))!;
    f.state.missingTopic(previous);
    await f.bridge.discover(); await f.drain();
    const replacement = f.state.binding('root-session')!;
    assert.notEqual(replacement.topicId, previous.topicId);
    const cards = f.telegram.sent().filter(s => messageBody(s).includes('synthetic-child-approval'));
    assert.equal(cards.length, 2, 'The pending child request must be replayed after the destination changes');
    assert.equal(cards[1]!.message_thread_id, replacement.topicId);
    assert.notEqual(control(cards[1]!), control(first));
    await f.bridge.update(click(1, control(first), previous.topicId));
    assert.equal((await f.records()).some(r => 'result' in r), false);
    await f.bridge.update(click(2, control(cards[1]!), replacement.topicId));
    assert.deepEqual((await f.records()).filter(r => 'result' in r), [{ id: 'child-approval', result: { decision: 'accept' } }]);
  } finally { f.close(); }
});

test('file approvals use the child diff without confusing an identical parent item ID', async () => {
  const f = await nativeFixture();
  try {
    await f.notify('item/started', { threadId: 'root-session', item: { id: 'shared-item', type: 'fileChange', changes: [{ path: 'parent.txt', diff: '+PARENT_CHANGE' }] } });
    await f.notify('item/started', { threadId: 'child-agent', item: { id: 'shared-item', type: 'fileChange', changes: [{ path: 'child.txt', diff: '+CHILD_CHANGE' }] } });
    await f.publish({ id: 'child-file', method: 'item/fileChange/requestApproval', params: { threadId: 'child-agent', turnId: 'child-turn', itemId: 'shared-item' } });
    await f.drain();
    const child = f.telegram.sent().find(s => messageBody(s).includes('CHILD_CHANGE'));
    assert.ok(child, 'The complete child diff must be available in its approval card');
    assert.equal(messageBody(child).includes('PARENT_CHANGE'), false);
    assert.match(messageBody(child), /child-agent/u);
    await f.publish({ id: 'root-file', method: 'item/fileChange/requestApproval', params: { threadId: 'root-session', turnId: 'root-turn', itemId: 'shared-item' } });
    await f.drain();
    assert.ok(f.telegram.sent().some(s => messageBody(s).includes('PARENT_CHANGE') && !messageBody(s).includes('CHILD_CHANGE')));
    await f.publish({ id: 'missing-file', method: 'item/fileChange/requestApproval', params: { threadId: 'child-agent', turnId: 'child-turn', itemId: 'unknown-item' } });
    await f.drain();
    assert.match(messageBody(f.telegram.sent().at(-1)!), /complete proposed diff is not available/u);
    assert.equal(f.telegram.sent().at(-1)!.reply_markup, undefined);
  } finally { f.close(); }
});

test('nested agents route to their root while foreign, cyclic, ignored and out-of-scope ancestry cannot publish approvals', async () => {
  const f = await nativeFixture();
  try {
    const child = structuredClone(f.threads[2]!);
    f.threads.push({ ...child, id: 'nested-agent', parentThreadId: 'child-agent',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'child-agent', agent_path: '/root/performance/nested' } } } });
    await f.metadata(); await f.bridge.discover();
    await f.publish(approval('nested-approval', 'nested-agent')); await f.drain();
    const nested = f.telegram.sent().find(s => messageBody(s).includes('nested-agent'))!;
    assert.equal(nested.message_thread_id, f.state.binding('root-session')!.topicId);
    assert.equal(f.state.bindings().length, 2);
    await f.notify('serverRequest/resolved', { threadId: 'nested-agent', requestId: 'nested-approval' });
    const before = f.telegram.sent().filter(s => s.reply_markup).length;
    const cases: Json[] = [
      { parentThreadId: 'unrelated-root' },
      { parentThreadId: 'child-agent', source: { subAgent: { thread_spawn: { parent_thread_id: 'child-agent' } } } },
      { source: 'vscode', canAcceptDirectInput: true },
      { cwd: join(f.project, '..') },
      { status: { type: 'notLoaded' } },
      { ephemeral: true },
    ];
    for (const [index, patch] of cases.entries()) {
      f.threads[2] = { ...child, ...patch };
      await f.metadata(); await f.publish(approval(`invalid-${index}`));
    }
    f.threads[2] = child;
    f.config.ignoredThreadIds = ['root-session'];
    await f.metadata(); await f.publish(approval('ignored-root'));
    f.config.ignoredThreadIds = ['child-agent'];
    await f.publish(approval('ignored-child'));
    await f.drain();
    assert.equal(f.telegram.sent().filter(s => s.reply_markup).length, before);
    assert.equal((await f.records()).some(r => 'result' in r), false);
  } finally { f.close(); }
});

test('approval clicks revalidate current ancestry, scope and topic binding', async () => {
  const f = await nativeFixture();
  try {
    const original = structuredClone(f.threads[2]!);
    const topic = f.state.binding('root-session')!.topicId;
    const mutations = [
      () => { f.threads[2] = { ...original, cwd: join(f.project, '..') }; },
      () => { f.threads[2] = { ...original, parentThreadId: 'other-root', source: { subAgent: { thread_spawn: { parent_thread_id: 'other-root' } } } }; },
      () => { f.config.ignoredThreadIds = ['root-session']; },
      () => { f.state.installTopic('root-session', 444, f.project, 'replacement'); },
    ];
    for (const [index, mutate] of mutations.entries()) {
      f.threads[2] = structuredClone(original); f.config.ignoredThreadIds = [];
      await f.metadata(); await f.publish(approval(`changing-${index}`)); await f.drain();
      const card = f.telegram.sent().filter(s => messageBody(s).includes('synthetic-child-approval')).at(-1)!;
      mutate(); await f.metadata();
      await f.bridge.update(click(index + 1, control(card), topic));
    }
    assert.equal((await f.records()).some(r => 'result' in r), false);
  } finally { f.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CodexClient, FirstMessageRequiredError, RpcError } from '../src/codex.js';
import { allowedDirectory, validateBinary } from '../src/config.js';
import { type Json } from '../src/types.js';
import { temporary } from './helpers.js';

test('native proxy HTTP upgrade works; discovery excludes subagents and writes omit all policy overrides', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const sessions = await c.list(); assert.deepEqual(sessions.map(s => s.id), ['a', 'b']);
    await c.attach('a'); await c.start('a', 'hello'); await c.steer('a', 'turn-1', 'change');
    const records = await c.call('test/records', {}) as { method: string; params: Json }[];
    const capabilities = records.find(x => x.method === 'initialize')!.params.capabilities as Json;
    assert.deepEqual(capabilities.optOutNotificationMethods, ['item/commandExecution/outputDelta', 'item/reasoning/textDelta']);
    assert.deepEqual(records.find(x => x.method === 'thread/resume')!.params, { threadId: 'a', excludeTurns: true });
    assert.deepEqual(records.find(x => x.method === 'turn/start')!.params, { threadId: 'a', input: [{ type: 'text', text: 'hello' }] });
    assert.deepEqual(records.find(x => x.method === 'turn/steer')!.params, { threadId: 'a', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'change' }] });
    const input = [{ type: 'text' as const, text: 'Look at this' }, { type: 'localImage' as const, path: join('private', 'image.png') }];
    await c.start('a', input); await c.steer('a', 'turn-1', input);
    const mediaRecords = await c.call('test/records', {}) as { method: string; params: Json }[];
    assert.deepEqual(mediaRecords.filter(x => x.method === 'turn/start').at(-1)!.params, { threadId: 'a', input });
    assert.deepEqual(mediaRecords.filter(x => x.method === 'turn/steer').at(-1)!.params, { threadId: 'a', expectedTurnId: 'turn-1', input });
  } finally { c.close(); }
});

test('unmaterialized history remains distinct from a readable empty history even with a reserved path', async () => {
  const client = new CodexClient();
  try {
    await client.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    await client.call('test/discovery', { threads: [{ id: 'empty', source: 'vscode', cwd: process.cwd(), path: '/reserved/not-created.jsonl', status: { type: 'idle' } }] });
    assert.equal((await client.list())[0]?.id, 'empty');
    assert.deepEqual(await client.turns('a'), [], 'A readable empty history is a valid result');
    await assert.rejects(client.turns('empty'), /first message.*locally/u);
  } finally { client.close(); }
});

test('other history failures are not mislabeled as waiting for the first message', async () => {
  const client = new CodexClient();
  try {
    await client.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    for (const message of [
      'no rollout found for thread id a',
      'thread another-session is not materialized yet; thread/turns/list is unavailable before first user message',
      'failed to read stored history: permission denied',
    ]) {
      await client.call('test/historyError', { threadId: 'a', message });
      await assert.rejects(client.turns('a'), error => error instanceof RpcError && !(error instanceof FirstMessageRequiredError) &&
        error.message === `Codex rejected the request: ${message}` && !error.uncertain);
    }
  } finally { client.close(); }
});

test('native assistant streaming preserves started, delta and completed event identities over the actual proxy transport', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const events: { method: string; params: Json }[] = [];
    c.on('notification', (method: string, params: Json) => events.push({ method, params }));
    await c.call('test/stream', {});
    assert.deepEqual(events.map(e => e.method), ['item/started', 'item/agentMessage/delta', 'item/completed']);
    assert.deepEqual(events[1]!.params, { threadId: 'a', turnId: 'turn-1', itemId: 'answer', delta: 'Streamed answer' });
  } finally { c.close(); }
});

test('native request IDs expire on resolved notification and cannot be reused', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const event = once(c, 'request'); await c.call('test/request', {}); await event;
    assert.equal(c.hasRequest('approval-1'), true);
    await c.call('test/resolved', {});
    assert.equal(c.hasRequest('approval-1'), false);
    await assert.rejects(c.respond('approval-1', { decision: 'accept' }));
  } finally { c.close(); }
});

test('native RPC timeout is explicitly uncertain', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    await assert.rejects(c.call('test/timeout', {}, 20), error => error instanceof RpcError && error.uncertain);
  } finally { c.close(); }
});

test('large tool history does not disconnect the shared-daemon connection', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const turns = await c.turns('large');
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.status, 'completed');
    assert.equal((await c.list()).length, 2, 'the native connection must remain usable after history discovery');
  } finally { c.close(); }
});

test('oversized protocol data reports the payload problem, not an absent daemon', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    await assert.rejects(c.call('test/oversized', {}), /exceeded the 16 MiB transport limit/u);
  } finally { c.close(); }
});

test('project roots use path containment rather than a shared string prefix', () => {
  const t = temporary();
  try {
    const root = join(t.dir, 'app'); const sibling = join(t.dir, 'app-other');
    mkdirSync(root); mkdirSync(sibling); mkdirSync(join(root, 'child'));
    assert.equal(allowedDirectory(join(root, 'child'), [root]), true);
    assert.equal(allowedDirectory(sibling, [root]), false);
    assert.throws(() => validateBinary('codex.cmd'));
  } finally { t.close(); }
});

test('a session disappearing during discovery does not hide healthy sessions', async () => {
  const c = new CodexClient();
  c.call = async () => ({ data: ['gone', 'healthy'] });
  c.read = async id => {
    if (id === 'gone') throw new RpcError('Thread no longer loaded', false);
    return { id, source: 'cli', cwd: process.cwd(), path: '/synthetic', status: { type: 'idle' } };
  };
  assert.deepEqual((await c.list()).map(s => s.id), ['healthy']);
  c.read = async () => { throw new RpcError('Transport disconnected', true); };
  await assert.rejects(c.list(), /Transport disconnected/u);
});

test('many loaded subagents do not hide later interactive sessions', async () => {
  const client = new CodexClient();
  try {
    await client.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const base = { source: 'cli', cwd: process.cwd(), path: '/synthetic', status: { type: 'idle' } };
    const agents = Array.from({ length: 80 }, (_, index) => ({ ...base, id: `agent-${index}`, parentThreadId: 'root' }));
    await client.call('test/discovery', { threads: [...agents, { ...base, id: 'project-a' }, { ...base, id: 'project-b' }] });
    assert.deepEqual((await client.list()).map(session => session.id), ['project-a', 'project-b']);
  } finally { client.close(); }
});

test('discovery applies project selection before its session cap and warns on true overflow', async () => {
  const client = new CodexClient();
  try {
    await client.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const threads = Array.from({ length: 80 }, (_, index) => ({ id: `thread-${index}`, source: 'cli', cwd: process.cwd(), path: '/synthetic', status: { type: 'idle' } }));
    await client.call('test/discovery', { threads });
    const warnings: number[] = []; client.on('discoveryLimit', (limit: number) => warnings.push(limit));
    assert.deepEqual((await client.list(session => ['thread-78', 'thread-79'].includes(session.id))).map(session => session.id), ['thread-78', 'thread-79']);
    assert.deepEqual(warnings, []);
    assert.equal((await client.list()).length, 64);
    assert.deepEqual(warnings, [64]);
  } finally { client.close(); }
});

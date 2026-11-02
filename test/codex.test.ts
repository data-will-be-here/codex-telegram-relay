import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CodexClient, RpcError } from '../src/codex.js';
import { allowedDirectory, validateBinary } from '../src/config.js';
import { type Json } from '../src/types.js';
import { temporary } from './helpers.js';

test('native proxy HTTP upgrade works; discovery excludes subagents and writes omit all policy overrides', async () => {
  const c = new CodexClient();
  try {
    await c.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const sessions = await c.list(); assert.deepEqual(sessions.map(s => s.id), ['a', 'b']);
    assert.deepEqual(await c.turns('empty'), []);
    await c.attach('a'); await c.start('a', 'hello'); await c.steer('a', 'turn-1', 'change');
    const records = await c.call('test/records', {}) as { method: string; params: Json }[];
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

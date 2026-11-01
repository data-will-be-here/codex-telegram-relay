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

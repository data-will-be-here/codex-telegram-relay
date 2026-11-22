import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestCodexVersion } from '../src/codex-release.js';

test('explicit release lookup reads only official public package metadata and accepts stable version strings', async () => {
  const result = await latestCodexVersion(async (url, init) => {
    assert.equal(url, 'https://registry.npmjs.org/@openai/codex/latest');
    assert.ok(init?.signal);
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify({ name: '@openai/codex', version: '0.171.0' }));
  });
  assert.equal(result, '0.171.0');
});

test('invalid or unavailable release metadata stays optional and never becomes a candidate', async () => {
  for (const data of [{ name: 'other', version: '0.171.0' }, { name: '@openai/codex', version: '0.172.0-alpha.1' },
    { name: '@openai/codex', version: '--unsafe' }, null]) {
    assert.equal(await latestCodexVersion(async () => new Response(JSON.stringify(data))), null);
  }
  assert.equal(await latestCodexVersion(async () => new Response('', { status: 503 })), null);
  assert.equal(await latestCodexVersion(async () => { throw new Error('Offline'); }), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message } from './helpers.js';

test('requested status distinguishes proxy and daemon without exposing paths or adding automatic messages', async () => {
  const f = await fixture();
  try {
    Object.assign(f.codex, { runtimeInfo: () => ({ relayVersion: '0.1.23', proxyVersion: '0.167.0', daemonVersion: '0.171.0', compatibility: 'verified' }) });
    await f.drain(); f.telegram.calls.length = 0;
    await f.bridge.update(message(1, 101, '/status')); await f.drain();
    const body = JSON.stringify(f.telegram.calls);
    assert.match(body, /Proxy: 0\.167\.0/u);
    assert.match(body, /Daemon: 0\.171\.0/u);
    assert.match(body, /API: verified/u);
    assert.doesNotMatch(body, /codex\.exe|AppData|CODEX_HOME/u);
    const count = f.telegram.calls.length;
    await f.bridge.discover(); await f.drain();
    assert.equal(f.telegram.calls.length, count);
  } finally { f.close(); }
});

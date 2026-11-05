import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporary } from './helpers.js';

interface StartupFailure { method: 'getMe' | 'getWebhookInfo'; statuses: number[]; retryAfter?: number; }
async function runPolling(fatalCode?: number, startup?: StartupFailure): Promise<{ exit: number | null; starts: number; output: string; checks: number[] }> {
  const temp = temporary();
  try {
    const home = join(temp.dir, 'private'); mkdirSync(home, { mode: 0o700 });
    const trace = join(temp.dir, 'proxy-starts.txt');
    const startupTrace = join(temp.dir, 'startup-checks.jsonl');
    writeFileSync(join(temp.dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(temp.dir, 'app-server'), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(trace)}, 'started\\n');
await import(${JSON.stringify(pathToFileURL(resolve('test/fake-proxy.mjs')).href)});
`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, ownerId: 42, roots: [temp.dir], codexBinary: process.execPath }), { mode: 0o600 });
    writeFileSync(join(home, 'bot.token'), '123456789:synthetic-test-token-no-external-access', { mode: 0o600 });
    const preload = join(temp.dir, 'telegram-fixture.mjs');
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
let polls = 0; let topic = 100; let startupChecks = 0;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected external request');
  const method = url.pathname.split('/').at(-1);
  const startup = ${JSON.stringify(startup ?? null)};
  if (startup && method === startup.method) {
    appendFileSync(${JSON.stringify(startupTrace)}, JSON.stringify(Date.now()) + '\\n');
    const status = startup.statuses[startupChecks++];
    if (status === 0) throw new TypeError('Synthetic startup connection interruption');
    if (status) return new Response(JSON.stringify({ ok: false, error_code: status, description: 'Synthetic startup rejection', parameters: { retry_after: startup.retryAfter } }), { status });
  }
  let result = true;
  if (method === 'getMe') result = { is_bot: true, has_topics_enabled: true, username: 'synthetic_relay' };
  if (method === 'getWebhookInfo') result = { url: '' };
  if (method === 'getMyCommands') result = [];
  if (method === 'createForumTopic') result = { message_thread_id: ++topic };
  if (method === 'sendMessage') result = { message_id: 1001 };
  if (method === 'getUpdates') {
    polls++;
    const fatal = ${JSON.stringify(fatalCode ?? 0)};
    if (fatal) return new Response(JSON.stringify({ ok: false, error_code: fatal, description: 'Synthetic fatal polling rejection' }), { status: fatal });
    if (!startup && polls === 1) throw new TypeError('Synthetic network interruption');
    if (!startup && polls === 2) return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Synthetic rate limit', parameters: { retry_after: 1 } }), { status: 429 });
    process.emit('SIGINT'); result = [];
  }
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
};
`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, resolve('dist/src/cli.js'), 'start'], {
      cwd: temp.dir, windowsHide: true, env: { ...process.env, CODEX_TELEGRAM_RELAY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    const exit = await new Promise<number | null>((done, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Synthetic relay did not finish: ' + output)); }, 30_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); done(code); });
    });
    return { exit, starts: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').length : 0, output,
      checks: existsSync(startupTrace) ? readFileSync(startupTrace, 'utf8').trim().split('\n').map(line => Number(JSON.parse(line))) : [] };
  } finally { temp.close(); }
}

test('Telegram polling failures and rate limits recover without restarting the native connection', async () => {
  const result = await runPolling();
  assert.equal(result.exit, 0, result.output);
  assert.equal(result.starts, 1, result.output);
});

for (const status of [401, 409]) test(`Telegram polling ${status} remains fatal instead of retrying authorization or a competing consumer`, async () => {
  const result = await runPolling(status);
  assert.equal(result.exit, 1, result.output);
  assert.equal(result.starts, 1, result.output);
  assert.doesNotMatch(result.output, /Reconnecting in/u);
});

test('startup retries a failed getMe every three seconds until Telegram recovers', async () => {
  const result = await runPolling(undefined, { method: 'getMe', statuses: [0, 503] });
  assert.equal(result.exit, 0, result.output);
  assert.equal(result.starts, 1, result.output);
  assert.equal(result.checks.length, 3);
  for (let index = 1; index < result.checks.length; index++) assert.ok(result.checks[index]! - result.checks[index - 1]! >= 2900, 'Retry must wait three seconds');
});

test('startup also retries a transient webhook check failure without creating a native client early', async () => {
  const result = await runPolling(undefined, { method: 'getWebhookInfo', statuses: [503] });
  assert.equal(result.exit, 0, result.output);
  assert.equal(result.starts, 1, result.output);
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks[1]! - result.checks[0]! >= 2900);
});

test('startup respects a Telegram retry interval longer than three seconds', async () => {
  const result = await runPolling(undefined, { method: 'getMe', statuses: [429], retryAfter: 4 });
  assert.equal(result.exit, 0, result.output);
  assert.equal(result.starts, 1, result.output);
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks[1]! - result.checks[0]! >= 3900);
});

test('startup rejects invalid bot credentials without retrying or starting Codex', async () => {
  const result = await runPolling(undefined, { method: 'getMe', statuses: [401] });
  assert.equal(result.exit, 1, result.output);
  assert.equal(result.starts, 0);
  assert.equal(result.checks.length, 1);
  assert.doesNotMatch(result.output, /retrying in/u);
});

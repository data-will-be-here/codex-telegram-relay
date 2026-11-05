import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporary } from './helpers.js';

async function runPolling(fatalCode?: number): Promise<{ exit: number | null; starts: number; output: string }> {
  const temp = temporary();
  try {
    const home = join(temp.dir, 'private'); mkdirSync(home, { mode: 0o700 });
    const trace = join(temp.dir, 'proxy-starts.txt');
    writeFileSync(join(temp.dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(temp.dir, 'app-server'), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(trace)}, 'started\\n');
await import(${JSON.stringify(pathToFileURL(resolve('test/fake-proxy.mjs')).href)});
`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, ownerId: 42, roots: [temp.dir], codexBinary: process.execPath }), { mode: 0o600 });
    writeFileSync(join(home, 'bot.token'), '123456789:synthetic-test-token-no-external-access', { mode: 0o600 });
    const preload = join(temp.dir, 'telegram-fixture.mjs');
    writeFileSync(preload, `let polls = 0; let topic = 100;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected external request');
  const method = url.pathname.split('/').at(-1);
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
    if (polls === 1) throw new TypeError('Synthetic network interruption');
    if (polls === 2) return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Synthetic rate limit', parameters: { retry_after: 1 } }), { status: 429 });
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
    return { exit, starts: readFileSync(trace, 'utf8').trim().split('\n').length, output };
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

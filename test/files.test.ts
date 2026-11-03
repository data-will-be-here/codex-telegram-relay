import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { linkSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Files, MAX_EXPORT_BYTES } from '../src/files.js';
import { readConfig, type Config } from '../src/config.js';
import { TelegramClient, TelegramError } from '../src/telegram.js';
import { fixture } from './helpers.js';
import { type Json, type Telegram } from '../src/types.js';

async function setup() {
  const f = await fixture();
  const home = f.state.home;
  const config: Config = { version: 1, ownerId: 42, roots: [f.projectA, f.projectB], codexBinary: process.execPath, outgoingFiles: true };
  const save = (): void => writeFileSync(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  save();
  const files = new Files(home); files.startWorker(42);
  const path = join(f.projectA, 'demo.txt'); writeFileSync(path, 'synthetic demo');
  const calls: { method: string; params: Json; name: string; bytes: Buffer }[] = [];
  const telegram: Telegram = {
    call: (...args) => f.telegram.call(...args),
    upload: async (method, params, file) => {
      calls.push({ method, params, ...file });
      return { message_id: 900, chat: { id: params.chat_id }, message_thread_id: params.message_thread_id };
    },
  };
  const flush = (adapter = telegram, signal = new AbortController().signal) => files.flushOne(adapter, binding => f.bridge.allowsFile(binding), signal);
  return { ...f, home, config, save, files, path, calls, messages: f.telegram, telegram, flush, close: () => { files.close(); f.close(); } };
}

test('export producer runs in another process alongside singleton State, without a bot token', async () => {
  const f = await setup();
  try {
    const run = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'send-file', f.path, '--session', 'thread-a', '--no-wait'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_TELEGRAM_RELAY_HOME: f.home, CODEX_THREAD_ID: 'thread-b' },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'pending'); assert.equal(result.session, 'thread-a');
    assert.equal(await f.flush(), true);
    assert.equal(f.files.status(result.id).status, 'sent');
    assert.equal(f.calls[0]!.params.chat_id, 42); assert.equal(f.calls[0]!.params.message_thread_id, 101);
    assert.equal(f.calls[0]!.bytes.toString(), 'synthetic demo');
    assert.match(String(f.calls[0]!.params.caption), /project-a/u);
    assert.deepEqual(readdirSync(join(f.home, 'outgoing')), []);
  } finally { f.close(); }
});

test('exports default off and local preferences need no credential or Codex executable', async () => {
  const f = await setup();
  try {
    delete f.config.outgoingFiles; f.save();
    assert.equal(readConfig(f.home).outgoingFiles, undefined);
    assert.throws(() => f.files.enqueue({ path: f.path }, f.projectA, ''), /disabled/u);
    const run = spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'files', 'enable'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_TELEGRAM_RELAY_HOME: f.home } });
    assert.equal(run.status, 0, run.stderr); assert.equal(readConfig(f.home).outgoingFiles, true);
    assert.equal(f.files.enqueue({ path: f.path }, f.projectA, '').status, 'pending');
  } finally { f.close(); }
});

test('concurrent producer processes and cleanup preserve every reserved snapshot', async () => {
  const f = await setup(); let running = true;
  const pump = (async () => { while (running) { await f.flush(); await new Promise(done => setTimeout(done, 5)); } })();
  try {
    const code = `import { Files } from './dist/src/files.js';
      const files = new Files(process.argv[1]);
      const results = [];
      try { for (let i=0;i<3;i++) results.push(files.enqueue({path:process.argv[2],session:'thread-a',requestId:process.argv[3]+'-'+i})); }
      finally { files.close(); }
      console.log(JSON.stringify(results));`;
    const batches = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<{ id: string }[]>((done, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.home, f.path, `parallel-${index}`], { windowsHide: true });
      let output = ''; let errors = '';
      child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { errors += String(data); });
      child.once('error', reject);
      child.once('close', status => { if (status === 0) done(JSON.parse(output)); else reject(new Error(errors)); });
    })));
    running = false; await pump;
    while (await f.flush()) { /* Complete any remaining requests. */ }
    for (const result of batches.flat()) assert.equal(f.files.status(result.id).status, 'sent');
    assert.equal(f.calls.length, 12); assert.deepEqual(readdirSync(join(f.home, 'outgoing')), []);
  } finally { running = false; await pump; f.close(); }
});

test('changing the installation owner before queueing requires a new relay generation', async () => {
  const f = await setup();
  try {
    f.config.ownerId = 43; f.save();
    assert.throws(() => f.files.enqueue({ path: f.path, session: 'thread-a' }), /Restart/u);
    assert.equal(await f.flush(), false); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('an unexpected upload receipt remains uncertain, visible in status, without replay', async () => {
  const f = await setup();
  try {
    const result = f.files.enqueue({ path: f.path, session: 'thread-a' });
    await f.flush({ ...f.telegram, upload: async () => ({ message_id: 99, chat: { id: 7 }, message_thread_id: 101 }) });
    assert.equal(f.files.status(result.id).status, 'uncertain'); assert.equal(f.state.uncertainCount(), 1);
    assert.equal(await f.flush(), false);
  } finally { f.close(); }
});

test('session selection fails closed for ambiguous projects and honors explicit session over environment', async () => {
  const f = await setup();
  try {
    f.state.bind('thread-another', 103, f.projectA, 'Another');
    assert.throws(() => f.files.enqueue({ path: f.path }, f.projectA, ''), /exactly one/u);
    assert.throws(() => f.files.enqueue({ path: f.path, session: 'thread-' }, f.projectA, ''), /exactly one/u);
    const result = f.files.enqueue({ path: f.path, session: 'thread-a' }, f.projectA, 'thread-b');
    assert.equal(result.session, 'thread-a');
  } finally { f.close(); }
});

test('reject outside-project paths, relay private files, hard links, oversize and empty files', async () => {
  const f = await setup();
  try {
    const outside = join(f.projectB, 'other.txt'); writeFileSync(outside, 'synthetic');
    assert.throws(() => f.files.enqueue({ path: outside, session: 'thread-a' }), /inside this session/u);
    const hard = join(f.projectA, 'hard.txt'); linkSync(f.path, hard);
    assert.throws(() => f.files.enqueue({ path: hard, session: 'thread-a' }), /without links/u);
    const huge = join(f.projectA, 'large.bin'); writeFileSync(huge, ''); truncateSync(huge, MAX_EXPORT_BYTES + 1);
    assert.throws(() => f.files.enqueue({ path: huge, session: 'thread-a' }), /49,000,000/u);
    const empty = join(f.projectA, 'empty.bin'); writeFileSync(empty, '');
    assert.throws(() => f.files.enqueue({ path: empty, session: 'thread-a' }), /nonempty/u);
    f.state.bind('thread-home', 104, f.dir, 'Parent');
    f.config.roots.push(f.dir); f.save();
    assert.throws(() => f.files.enqueue({ path: join(f.home, 'config.json'), session: 'thread-home' }), /outside relay private/u);
    assert.throws(() => f.files.enqueue({ path: f.path + '\x00', session: 'thread-a' }), /Invalid export path/u);
    if (process.platform === 'win32') assert.throws(() => f.files.enqueue({ path: f.path + ':stream', session: 'thread-a' }), /alternate streams/u);
  } finally { f.close(); }
});

test('directory junctions and symlinks cannot export another project', async () => {
  const f = await setup();
  try {
    const outside = join(f.projectB, 'other.txt'); writeFileSync(outside, 'synthetic');
    const link = join(f.projectA, 'link'); symlinkSync(f.projectB, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.files.enqueue({ path: join(link, 'other.txt'), session: 'thread-a' }), /links/u);
  } finally { f.close(); }
});

test('queued bytes remain stable after source mutation and repeated requests deduplicate', async () => {
  const f = await setup();
  try {
    const request = { path: f.path, session: 'thread-a', requestId: 'stable-request' };
    const first = f.files.enqueue(request);
    assert.equal(f.files.enqueue(request).id, first.id);
    writeFileSync(f.path, 'changed source');
    assert.throws(() => f.files.enqueue(request), /different content/u);
    await f.flush();
    assert.equal(f.calls[0]!.bytes.toString(), 'synthetic demo');
    assert.equal(await f.flush(), false); assert.equal(f.calls.length, 1);
    writeFileSync(f.path, 'synthetic demo');
    assert.equal(f.files.enqueue(request).status, 'sent');
  } finally { f.close(); }
});

test('tampered snapshots fail without network effects', async () => {
  const f = await setup();
  try {
    const result = f.files.enqueue({ path: f.path, session: 'thread-a' });
    const name = readdirSync(join(f.home, 'outgoing'))[0]!;
    writeFileSync(join(f.home, 'outgoing', name), 'tampered');
    await f.flush();
    assert.equal(f.files.status(result.id).status, 'rejected'); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('revoked opt-in, owner changes, ignored, closed and moved sessions cannot upload', async () => {
  for (const change of ['disabled', 'owner', 'ignored', 'closed', 'moved'] as const) {
    const f = await setup();
    try {
      const result = f.files.enqueue({ path: f.path, session: 'thread-a' });
      if (change === 'disabled') f.config.outgoingFiles = false;
      if (change === 'owner') f.config.ownerId = 43;
      if (change === 'ignored') f.config.ignoredThreadIds = ['thread-a'];
      if (change === 'closed') f.codex.sessions = f.codex.sessions.filter(session => session.id !== 'thread-a');
      if (change === 'moved') f.codex.sessions[0]!.cwd = f.projectB;
      f.save(); await f.flush();
      assert.equal(f.calls.length, 0, change);
      if (change !== 'owner') assert.equal(f.files.status(result.id).status, 'rejected');
      else assert.throws(() => f.files.status(result.id), /Unknown/u);
    } finally { f.close(); }
  }
});

test('a slow file upload leaves the ordinary outbox and questions usable', async () => {
  const f = await setup();
  try {
    f.files.enqueue({ path: f.path, session: 'thread-a' });
    let release!: () => void;
    const hold = new Promise<void>(done => { release = done; });
    const uploading = f.flush({ ...f.telegram, upload: async (...args) => { await hold; return f.telegram.upload!(...args); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.flush(), false, 'Only one active upload');
    f.state.enqueue('test/file-upload', 101, 'Question while uploading?', { inline_keyboard: [[{ text: 'Continue', callback_data: 'test' }]] });
    await f.drain();
    assert.equal(f.calls.length, 0);
    // Native callbacks/text use the independent sender; this message reached it before the file completed.
    assert.equal(f.state.next(), undefined);
    assert.ok(f.messages.sent().some(message => String(message.text).includes('Question while uploading?')));
    release(); await uploading; assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('unknown outcomes and shutdown aborts stay uncertain and never replay', async () => {
  for (const abort of [false, true]) {
    const f = await setup();
    try {
      const result = f.files.enqueue({ path: f.path, session: 'thread-a' });
      const controller = new AbortController(); let attempts = 0;
      const uploading = f.flush({ ...f.telegram, upload: async (_method, _params, _file, signal) => {
        attempts++;
        if (abort) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        throw new TelegramError('unknown', 0);
      } }, controller.signal);
      if (abort) { await new Promise(resolve => setImmediate(resolve)); controller.abort(); }
      await uploading;
      assert.equal(f.files.status(result.id).status, 'uncertain');
      assert.equal(f.files.enqueue({ path: f.path, session: 'thread-a' }).status, 'uncertain');
      assert.equal(await f.flush(), false); assert.equal(attempts, 1);
    } finally { f.close(); }
  }
});

test('crash recovery marks sending uncertain, expires old pending and preserves unsent requests', async () => {
  const f = await setup();
  try {
    const sent = f.files.enqueue({ path: f.path, session: 'thread-a', requestId: 'crash-job' });
    const expired = f.files.enqueue({ path: f.path, session: 'thread-a', requestId: 'expired-job' });
    const pending = f.files.enqueue({ path: f.path, session: 'thread-a', requestId: 'pending-job' });
    const db = new DatabaseSync(join(f.home, 'state.sqlite'));
    db.prepare("UPDATE file_jobs SET status='sending' WHERE id=?").run(sent.id);
    db.prepare('UPDATE file_jobs SET at=? WHERE id=?').run(Date.now() - 11 * 60_000, expired.id); db.close();
    f.files.startWorker(42);
    assert.equal(f.files.status(sent.id).status, 'uncertain'); assert.equal(f.files.status(expired.id).status, 'rejected');
    await f.flush(); assert.equal(f.files.status(pending.id).status, 'sent'); assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('429 retains an unsent snapshot with a cooldown; 400 rejects and never falls back blindly', async () => {
  const f = await setup();
  try {
    const result = f.files.enqueue({ path: f.path, session: 'thread-a' });
    await f.flush({ ...f.telegram, upload: async () => { throw new TelegramError('rate', 429, 60); } });
    assert.equal(f.files.status(result.id).status, 'pending'); assert.equal(await f.flush(), false);
    const db = new DatabaseSync(join(f.home, 'state.sqlite')); db.exec('UPDATE file_jobs SET retryAt=0'); db.close();
    await f.flush({ ...f.telegram, upload: async () => { throw new TelegramError('bad file', 400); } });
    assert.equal(f.files.status(result.id).status, 'rejected'); assert.equal(await f.flush(), false);
  } finally { f.close(); }
});

test('queue admission is bounded and a legacy relay cannot silently accept exports', async () => {
  const f = await setup();
  try {
    for (let n = 0; n < 16; n++) f.files.enqueue({ path: f.path, session: 'thread-a', requestId: `request-${n}` });
    assert.throws(() => f.files.enqueue({ path: f.path, session: 'thread-a', requestId: 'request-overflow' }), /full/u);
    const db = new DatabaseSync(join(f.home, 'state.sqlite')); db.exec('DELETE FROM file_runtime'); db.close();
    assert.throws(() => f.files.enqueue({ path: f.path, session: 'thread-a' }), /Restart/u);
  } finally { f.close(); }
});

test('MP4 routes as video, other media remain lossless documents, and captions stay literal', async () => {
  const f = await setup();
  try {
    const mp4 = join(f.projectA, 'demo.mp4'); writeFileSync(mp4, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]));
    f.files.enqueue({ path: mp4, session: 'thread-a', caption: '<b>literal & caption</b>' }); await f.flush();
    assert.equal(f.calls[0]!.method, 'sendVideo'); assert.match(String(f.calls[0]!.params.caption), /<b>literal & caption<\/b>/u);
    assert.equal(f.calls[0]!.params.parse_mode, undefined);
    f.files.enqueue({ path: mp4, session: 'thread-a', as: 'document' }); await f.flush();
    assert.equal(f.calls[1]!.method, 'sendDocument');
    assert.throws(() => f.files.enqueue({ path: f.path, session: 'thread-a', as: 'video' }), /MP4/u);
  } finally { f.close(); }
});

test('multipart upload pins the official endpoint, routes owner/topic and redacts transport errors', async () => {
  const token = '12345:synthetic-not-a-secret'; let called = 0;
  const telegram = new TelegramClient(token, async (url, init) => {
    called++; assert.equal(url, `https://api.telegram.org/bot${token}/sendDocument`); assert.equal(init!.redirect, 'error');
    assert.ok(init!.body instanceof FormData);
    const form = init!.body;
    assert.equal(form.get('chat_id'), '42'); assert.equal(form.get('message_thread_id'), '101');
    const file = form.get('document') as File; assert.equal(file.name, 'demo.txt'); assert.equal(await file.text(), 'demo');
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5, chat: { id: 42 }, message_thread_id: 101 } }));
  });
  await telegram.upload('sendDocument', { chat_id: 42, message_thread_id: 101 }, { name: 'demo.txt', bytes: Buffer.from('demo') }, new AbortController().signal);
  assert.equal(called, 1);
  const broken = new TelegramClient(token, async () => { throw new Error(`failure https://api.telegram.org/bot${token}/sendDocument`); });
  await assert.rejects(broken.upload('sendDocument', {}, { name: 'test', bytes: Buffer.from('test') }, new AbortController().signal), error => !String(error).includes(token) && !Object.hasOwn(error as object, 'cause'));
});

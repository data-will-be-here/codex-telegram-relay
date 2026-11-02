import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Attachments, AttachmentError, MAX_ATTACHMENT_BYTES } from '../src/attachments.js';
import { TelegramClient } from '../src/telegram.js';
import { fixture, temporary, message, messageBody } from './helpers.js';
import { array, object, string } from '../src/types.js';

test('download uses the official file endpoint, rejects traversal/redirects and redacts all credential-bearing errors', async () => {
  const token = 'test-private-token';
  let path = 'photos/file_1.jpg'; let requests = 0;
  const fake: typeof fetch = async (input, init) => {
    requests++;
    assert.equal(init?.redirect, 'error');
    if (String(input).endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: path } });
    assert.equal(String(input), `https://api.telegram.org/file/bot${token}/photos/file_1.jpg`);
    return new Response(Buffer.from('image-data'));
  };
  const client = new TelegramClient(token, fake);
  assert.equal((await client.download('f')).toString(), 'image-data');
  for (path of ['../bot.token', '/etc/passwd', 'photos/../../secret', 'https://evil.invalid/file', 'photos/f%2fsecret', 'photos/a?token=x', 'photos/a#x', 'photos\\x']) {
    const before = requests;
    await assert.rejects(client.download('f'), e => e instanceof AttachmentError && !e.message.includes(token));
    assert.equal(requests, before + 1);
  }
  const failing = new TelegramClient(token, async () => { throw new Error(`https://api.telegram.org/bot${token}`); });
  await assert.rejects(failing.download('f'), e => e instanceof AttachmentError && !e.message.includes(token) && !('cause' in e));
});

test('download caps the actual stream when Telegram omits or understates its size', async () => {
  let cancelled = false;
  const client = new TelegramClient('private', async input => String(input).endsWith('/getFile')
    ? Response.json({ ok: true, result: { file_path: 'documents/file.bin', file_size: 1 } })
    : new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } })));
  await assert.rejects(client.download('f'), AttachmentError);
  assert.equal(cancelled, true);
});

test('attachments use private random names, detect images by bytes, bound text, and never execute uploaded files', async () => {
  const f = temporary();
  try {
    const jpg = Buffer.from([255, 216, 255, 0, 1, 2]);
    let content = jpg;
    const store = new Attachments(f.dir, { call: async () => undefined, download: async () => content });
    const image = await store.prepare({ document: { file_id: 'img', file_name: '..\\..\\evil.exe', file_size: jpg.length } });
    assert.equal(image[1]?.type, 'localImage');
    if (image[1]?.type !== 'localImage') assert.fail();
    assert.equal(dirname(image[1].path), join(f.dir, 'attachments'));
    assert.ok(image[1].path.endsWith('.jpg'));
    assert.deepEqual(readFileSync(image[1].path), jpg);
    content = Buffer.from('File text\n'.repeat(5000));
    const text = await store.prepare({ document: { file_id: 'txt', file_name: 'readme.txt' } });
    assert.equal(text.length, 1);
    assert.ok(JSON.stringify(text).length < 30_000);
    await assert.rejects(store.prepare({ document: { file_id: 'big', file_size: MAX_ATTACHMENT_BYTES + 1 } }), AttachmentError);
    assert.equal(readdirSync(join(f.dir, 'attachments')).length, 2);
  } finally { f.close(); }
});

test('only an authorized attached in-root session can download media; captions are input, not commands', async () => {
  const f = await fixture(); let downloads = 0;
  Object.assign(f.telegram, { download: async () => { downloads++; return Buffer.from([255, 216, 255, 1]); } });
  const media = (id: number, topic = 101, owner = 42) => {
    const update = message(id, topic, '', owner);
    Object.assign(object(update.message), { caption: '/mode compact', photo: [{ file_id: 'small' }, { file_id: 'largest', file_size: 4 }] });
    return update;
  };
  try {
    await f.bridge.update(media(1, 101, 99));
    await f.bridge.update(media(2, 555));
    assert.equal(downloads, 0);
    await f.bridge.update(media(3));
    assert.equal(downloads, 1);
    const inputs = array(f.codex.writes[0]?.params.text).map(object);
    assert.equal(inputs[0]?.text, '/mode compact');
    assert.equal(inputs[2]?.type, 'localImage');
    assert.equal(f.codex.writes[0]?.method, 'start');
    f.codex.sessions[0]!.cwd = f.dir;
    await f.bridge.update(media(4));
    assert.equal(downloads, 1);
    assert.equal(f.codex.writes.length, 1);
  } finally { f.close(); }
});

test('failed attachment preparation is a definite rejection with no ambiguous-delivery warning or native write', async () => {
  const f = await fixture();
  try {
    Object.assign(f.telegram, { download: async () => { throw new AttachmentError('Download failed. No instruction was sent.'); } });
    const update = message(1, 101, ''); object(update.message).document = { file_id: 'f' };
    await f.bridge.update(update); await f.drain();
    assert.equal(f.codex.writes.length, 0);
    assert.equal(f.state.uncertainCount(), 0);
    assert.equal(f.telegram.sent().map(messageBody).filter(s => s.includes('Download failed')).length, 1);
    assert.ok(!existsSync(join(f.dir, 'private', 'bot.token')));
  } finally { f.close(); }
});

test('attachment answers to a native question include its caption and local context without starting a separate turn', async () => {
  const f = await fixture();
  try {
    Object.assign(f.telegram, { download: async () => Buffer.from('The requested evidence') });
    f.codex.pending.add('q');
    await f.bridge.request({ id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', questions: [{ id: 'q1', question: 'Which evidence?', options: [] }] } });
    const update = message(1, 101, ''); Object.assign(object(update.message), { caption: 'This one', document: { file_id: 'f', file_name: 'evidence.txt' } });
    await f.bridge.update(update);
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.codex.writes[0]?.method, 'respond');
    const result = JSON.stringify(f.codex.writes[0]);
    assert.ok(result.includes('This one'));
    assert.ok(result.includes('The requested evidence'));
    assert.ok(!result.includes('api.telegram.org'));
    assert.equal(string(object(f.codex.writes[0]?.params.result).id), '');
  } finally { f.close(); }
});

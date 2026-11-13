import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkForUpdates, type UpdateCache, type UpdateStore } from '../src/updates.js';
import { State } from '../src/state.js';
import { object, type Json } from '../src/types.js';
import { temporary } from './helpers.js';

const published = (tag: string, extra: Json = {}): Json => ({ tag_name: tag, draft: false, prerelease: true, published_at: '2026-01-01T00:00:00Z', ...extra });
class Store implements UpdateStore {
  cache: unknown;
  notices: { version: string; text: string; markup: Json }[] = [];
  updateCheck(): unknown { return this.cache; }
  saveUpdateCheck(cache: UpdateCache): void { this.cache = cache; }
  enqueueUpdateNotice(version: string, text: string, markup: Json): void { this.notices.push({ version, text, markup }); }
}
const response = (data: unknown): Response => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('published previews are compared numerically and only canonical repository links reach the owner notice', async () => {
  const store = new Store(); const logs: string[] = []; let calls = 0;
  const update = await checkForUpdates(store, '0.1.9', { log: text => logs.push(text), fetch: async (url, init) => {
    calls++; assert.equal(String(url), 'https://api.github.com/repos/data-will-be-here/codex-telegram-relay/releases?per_page=20');
    assert.equal(new Headers(init?.headers).get('Authorization'), null); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return response([published('v0.1.10', { html_url: 'https://untrusted.invalid/update' }), published('v0.1.8'),
      published('v9.0.0', { draft: true }), published('v8.0.0', { published_at: null }), published('v7.0.0-bad'), published('v06.0.0')]);
  } });
  assert.equal(update?.version, '0.1.10'); assert.equal(calls, 1); assert.equal(logs.length, 1);
  assert.equal(store.notices.length, 1); assert.match(store.notices[0]!.text, /Installed: v0.1.9\nAvailable: v0.1.10/u);
  assert.ok(JSON.stringify(store.notices[0]!.markup).includes('/releases/tag/v0.1.10'));
  assert.ok(JSON.stringify(store.notices[0]!.markup).includes('#upgrade-an-existing-installation'));
  assert.doesNotMatch(JSON.stringify(store.notices), /untrusted/u);
});

test('equal, older and malformed installed versions produce no update proposal', async () => {
  for (const installed of ['0.1.21', '0.1.22', 'development', '0.01.1']) {
    const store = new Store(); let calls = 0;
    assert.equal(await checkForUpdates(store, installed, { log: () => assert.fail('Unexpected log'), fetch: async () => {
      calls++; return response([published('v0.1.21')]);
    } }), undefined);
    assert.equal(store.notices.length, 0); assert.equal(calls, installed === 'development' || installed === '0.01.1' ? 0 : 1);
  }
});

test('fresh positive and negative checks are cached for fifteen minutes across startups', async () => {
  for (const tag of ['v0.1.21', 'v0.1.22']) {
    const store = new Store(); let calls = 0; let now = 1000;
    const options = { now: () => now, log: () => {}, fetch: async () => { calls++; return response([published(tag)]); } };
    await checkForUpdates(store, '0.1.21', options); now += 899_999;
    await checkForUpdates(store, '0.1.21', options); assert.equal(calls, 1);
    now++; await checkForUpdates(store, '0.1.21', options); assert.equal(calls, 2);
  }
});

test('unavailable, rate-limited and malformed metadata is best-effort and backed off without notices', async () => {
  for (const make of [() => { throw new Error('offline'); }, () => new Response('limited', { status: 429 }),
    () => new Response('forbidden', { status: 403 }), () => new Response('error', { status: 500 }),
    () => new Response('{bad JSON'), () => response({ tag_name: 'v2.0.0' })]) {
    const store = new Store(); let calls = 0;
    const options = { now: () => 1000, log: () => assert.fail('Unexpected log'), fetch: async () => { calls++; return make(); } };
    assert.equal(await checkForUpdates(store, '0.1.21', options), undefined);
    await checkForUpdates(store, '0.1.21', options); assert.equal(calls, 1); assert.equal(store.notices.length, 0);
  }
});

test('oversized advertised or streamed bodies are cancelled without offering a release', async () => {
  for (const advertised of [true, false]) {
    const store = new Store(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel() { cancelled = true; } });
    await checkForUpdates(store, '0.1.21', { log: () => assert.fail('Unexpected log'), fetch: async () => new Response(body,
      advertised ? { headers: { 'content-length': String(512 * 1024 + 1) } } : {}) });
    assert.equal(cancelled, true); assert.equal(store.notices.length, 0);
  }
});

test('shutdown cancels an in-flight check before state or notification writes', async () => {
  const store = new Store(); const stop = new AbortController(); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const checking = checkForUpdates(store, '0.1.21', { signal: stop.signal, log: () => assert.fail('Unexpected log'), fetch: async (_url, init) => {
    assert.ok(init?.signal); await waiting; return response([published('v0.1.22')]);
  } });
  stop.abort(); release(); assert.equal(await checking, undefined);
  assert.equal(store.cache, undefined); assert.equal(store.notices.length, 0);
  await checkForUpdates(store, '0.1.21', { signal: stop.signal, fetch: async () => assert.fail('Already stopped') });
});

test('invalid cached tags and future timestamps are rechecked rather than used as notification links', async () => {
  const store = new Store(); let calls = 0;
  for (const cache of [{ checkedAt: 2000, release: { tag: 'v0.1.22', version: '0.1.22' } },
    { checkedAt: 1000, release: { tag: 'https://untrusted.invalid', version: '2.0.0' } }]) {
    store.cache = cache;
    await checkForUpdates(store, '0.1.21', { now: () => 1000, fetch: async () => { calls++; return response([]); } });
  }
  assert.equal(calls, 2); assert.equal(store.notices.length, 0);
});

test('the cache and one-per-version owner notice persist across reopen and outbox retention', async () => {
  const temp = temporary(); const home = join(temp.dir, 'updates'); let state = new State(home); let now = 1000; let calls = 0;
  const options = { now: () => now, log: () => {}, fetch: async () => { calls++; return response([published('v0.1.22')]); } };
  try {
    await checkForUpdates(state, '0.1.21', options);
    const notice = state.next()!; assert.equal(notice.key, 'notice/release/0.1.22'); assert.equal(notice.topicId, null);
    assert.equal(notice.ownerNotice, true); assert.equal(notice.sourceThreadId, null); assert.equal(notice.projectCwd, null);
    state.sending(notice.id); state.delivered(notice.id, 100); state.close(); state = new State(home);
    await checkForUpdates(state, '0.1.21', options); assert.equal(calls, 1); assert.equal(state.next(), undefined);
    const realNow = Date.now; Date.now = () => realNow() + 8 * 86400_000;
    try { state.prune(); } finally { Date.now = realNow; }
    now += 16 * 60_000; await checkForUpdates(state, '0.1.21', options);
    assert.equal(calls, 2); assert.equal(state.next(), undefined, 'retention must not repeat the same bot notification');
    assert.equal(object(object(state.updateCheck()).release).version, '0.1.22');
  } finally { state.close(); temp.close(); }
});

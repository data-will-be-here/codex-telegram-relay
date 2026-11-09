import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, messageBody } from './helpers.js';
import { array, object } from '../src/types.js';
import { formatLimits } from '../src/limits.js';
import { CodexClient, RpcError } from '../src/codex.js';
import { resolve } from 'node:path';

test('/limits reads fresh account usage in the owner chat without an attached topic or a model turn', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    Object.assign(f.codex, { rateLimits: async () => {
      reads++;
      return { rateLimits: { primary: { usedPercent: reads === 1 ? 25 : 40, windowDurationMins: 10080, resetsAt: 1900000000 } } };
    } });
    const root = message(901, 101, '/limits');
    delete object(root.message).message_thread_id;
    await f.bridge.update(root); await f.drain();
    assert.match(messageBody(f.telegram.sent().at(-1)!), /Weekly limit: remaining 75%/u);
    assert.equal(f.telegram.sent().at(-1)!.message_thread_id, undefined);
    await f.bridge.update(message(902, 101, '/limits')); await f.drain();
    assert.match(messageBody(f.telegram.sent().at(-1)!), /Weekly limit: remaining 60%/u);
    assert.equal(f.telegram.sent().at(-1)!.message_thread_id, 101);
    assert.equal(reads, 2);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('limits use the native read-only RPC and a rejected read leaves the transport usable', async () => {
  const codex = new CodexClient();
  try {
    await codex.connect(process.execPath, [resolve('test/fake-proxy.mjs')]);
    const response = { rateLimits: { primary: null, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: null } } };
    await codex.call('test/rateLimits', { response });
    assert.deepEqual(await codex.rateLimits(), response);
    await codex.call('test/rateLimits', { error: 'Synthetic account read unavailable' });
    await assert.rejects(codex.rateLimits(), error => error instanceof RpcError && !error.uncertain);
    assert.ok((await codex.loaded()).length > 0);
    const calls = array(await codex.call('test/records', {})).map(object);
    assert.deepEqual(calls.filter(c => c.method === 'account/rateLimits/read').map(c => c.params), [{}, {}]);
    assert.equal(calls.some(c => ['thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'thread/settings/update', 'account/rateLimitResetCredit/consume'].includes(String(c.method))), false);
  } finally { codex.close(); }
});

test('/limits authorizes before reading, deduplicates updates and contains sensitive read errors locally', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    Object.assign(f.codex, { rateLimits: async () => { reads++; throw new RpcError('SENSITIVE_SYNTHETIC_ERROR', true); } });
    const group = message(912, 101, '/limits');
    object(object(group.message).chat).type = 'group';
    await f.bridge.update(message(910, 101, '/limits', 99));
    await f.bridge.update(group); await f.drain();
    assert.equal(reads, 0);
    assert.equal(f.telegram.sent().length, 0);
    await f.bridge.update(message(913, 101, '/limits unexpected')); await f.drain();
    assert.equal(reads, 0);
    assert.match(messageBody(f.telegram.sent().at(-1)!), /without arguments/u);
    const input = message(914, 101, '/limits');
    await assert.doesNotReject(f.bridge.update(input)); await f.drain();
    await f.bridge.update(input); await f.drain();
    assert.equal(reads, 1);
    assert.match(messageBody(f.telegram.sent().at(-1)!), /Could not load Codex limits/u);
    assert.doesNotMatch(messageBody(f.telegram.sent().at(-1)!), /SENSITIVE_SYNTHETIC_ERROR|Delivery could not be confirmed/u);
    await f.bridge.update(message(915, 101, '/status')); await f.drain();
    assert.match(messageBody(f.telegram.sent().at(-1)!), /Connected sessions: 2/u);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('/limits leaves an existing native question pending and never submits an answer', async () => {
  const f = await fixture();
  try {
    f.codex.pending.add('limits-question');
    await f.bridge.request({ id: 'limits-question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-a', turnId: 'question-turn', questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?',
        options: [{ label: 'One', description: 'First option' }, { label: 'Two', description: 'Second option' }] }],
    } });
    await f.drain();
    await f.bridge.update(message(920, 101, '/limits')); await f.drain();
    assert.match(messageBody(f.telegram.sent().at(-1)!), /Codex account limits/u);
    assert.equal(f.codex.hasRequest('limits-question'), true);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('missing, invalid and expired quota data is not presented as recovered or unlimited, and large replies are explicit', () => {
  const now = Date.parse('2026-11-08T09:00:00Z');
  const text = formatLimits({ rateLimits: {
    primary: { usedPercent: 100, resetsAt: now / 1000 - 60 },
    secondary: { usedPercent: -5, windowDurationMins: 15, resetsAt: 'invalid' },
  } }, now, 'UTC');
  assert.match(text, /Primary limit: remaining 0%/u);
  assert.match(text, /quota recovery is not yet confirmed/u);
  assert.match(text, /Limit for 15 min: remaining quota unavailable/u);
  assert.match(text, /Reset: time unavailable/u);
  assert.doesNotMatch(text, /unlimited|5 h|100%/u);
  assert.match(formatLimits({}, now, 'UTC'), /Quota data unavailable/u);
  const large = formatLimits({ rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [String(index), {
    limitName: '**synthetic**'.repeat(50), primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: now / 1000 + 3600 },
  }])) }, now, 'UTC');
  assert.ok(large.length < 30_000);
  assert.match(large, /The limits list was shortened/u);
  assert.match(large, /Checked:.*GMT/u);
});

test('account snapshots show distinct quota groups, backend restrictions, credits and host-zone reset times', () => {
  const now = Date.parse('2026-11-08T09:00:00Z');
  const reset = Date.parse('2026-11-08T11:30:00Z') / 1000;
  const text = formatLimits({
    ordinaryUsageAllowed: false,
    rateLimits: { limitName: 'Legacy duplicate', primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { limitName: 'Codex', planType: 'pro',
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: reset },
        secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: reset },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        spendControlReached: true,
        individualLimit: { remainingPercent: 12, used: '88', limit: '100', resetsAt: reset },
      },
      review: { limitName: 'Code review', primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: reset } },
    },
  }, now, 'Europe/Moscow');
  for (const expected of ['Included usage is currently restricted', 'Codex', 'Code review', 'Plan: pro',
    'Limit for 5 h: remaining 80%', 'Weekly limit: remaining 55%', 'Limit for 1 h: remaining 95%',
    'Credits: 12.50', 'Spending limit: remaining 12%', 'Used: 88 of 100',
    'Spending limit reached', '14:30 GMT+3', 'In 2 h 30 min']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /Legacy duplicate|undefined|null/u);
});

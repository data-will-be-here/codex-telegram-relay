import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drafts } from '../src/drafts.js';
import { Bridge } from '../src/bridge.js';
import { TelegramError } from '../src/telegram.js';
import { type Binding, type Json, string } from '../src/types.js';
import { FakeTelegram, fixture, message } from './helpers.js';

const binding = (id = 'a', topicId = 101): Binding => ({ threadId: id, topicId, cwd: '/projects/demo', title: id, lastTurn: '-' });
const allowed = async (): Promise<boolean> => true;
const start = (threadId = 'thread-a', phase = 'final_answer', itemId = 'answer'): Json =>
  ({ threadId, turnId: 'turn', item: { id: itemId, type: 'agentMessage', phase, text: '' } });
const delta = (text: string, threadId = 'thread-a', itemId = 'answer'): Json =>
  ({ threadId, turnId: 'turn', itemId, delta: text });

test('token bursts coalesce into rich snapshots, share one chat budget and fairly update independent topics', async () => {
  const telegram = new FakeTelegram(); let now = 1000;
  const drafts = new Drafts(telegram, 42, () => now);
  drafts.begin(binding(), 'turn', 'answer', 'final_answer');
  drafts.begin(binding('b', 102), 'turn', 'answer', 'final_answer');
  for (let i = 0; i < 2000; i++) drafts.append('a', 'turn', 'answer', 'x');
  drafts.append('b', 'turn', 'answer', 'Other topic');
  assert.equal(telegram.calls.length, 0);
  assert.equal(await drafts.flushOne(allowed), true);
  assert.equal(await drafts.flushOne(allowed), false);
  drafts.append('a', 'turn', 'answer', ' more'); now += 1000;
  await drafts.flushOne(allowed); now += 1000; await drafts.flushOne(allowed);
  assert.deepEqual(telegram.calls.map(c => c.method), Array(3).fill('sendRichMessageDraft'));
  assert.deepEqual(telegram.calls.map(c => c.params.message_thread_id), [101, 102, 101]);
  assert.equal(telegram.calls[0]!.params.draft_id, telegram.calls[2]!.params.draft_id);
  assert.notEqual(telegram.calls[0]!.params.draft_id, telegram.calls[1]!.params.draft_id);
  assert.ok(telegram.calls.every(c => c.params.chat_id === 42 && Number.isSafeInteger(c.params.draft_id)));
  assert.ok(JSON.stringify(telegram.calls[2]!.params.rich_message).includes('x'.repeat(2000) + ' more'));
  assert.equal(await drafts.flushOne(allowed), false);
});

test('plain prefixes grow into native tables using valid allowlisted rich snapshots without activating HTML/media', async () => {
  const telegram = new FakeTelegram(); let now = 1000;
  const drafts = new Drafts(telegram, 42, () => now);
  drafts.begin(binding(), 'turn', 'answer', 'final_answer');
  drafts.append('a', 'turn', 'answer', 'Results\n\n| Name | Status |');
  await drafts.flushOne(allowed);
  drafts.append('a', 'turn', 'answer', '\n| --- | --- |\n| Worker | **Ready** |\n\n<img src="https://example.com/private.png">');
  now += 1000; await drafts.flushOne(allowed);
  const first = JSON.stringify(telegram.calls[0]!.params.rich_message);
  const last = JSON.stringify(telegram.calls[1]!.params.rich_message);
  assert.ok(first.includes('paragraph'));
  assert.ok(last.includes('"type":"table"'));
  assert.ok(last.includes('"type":"bold","text":"Ready"'));
  assert.ok(last.includes('<img src='));
  assert.ok(!last.includes('"type":"photo"'));
  assert.ok(!('markdown' in (telegram.calls[1]!.params.rich_message as Json)));
});

test('unsupported rich previews fall back to ordinary drafts without changing the draft identity', async () => {
  const telegram = new FakeTelegram(); let now = 1000;
  const call = telegram.call.bind(telegram);
  telegram.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'sendRichMessageDraft') throw new TelegramError('Unknown method', 404);
    return result;
  };
  const drafts = new Drafts(telegram, 42, () => now);
  drafts.begin(binding(), 'turn', 'answer', 'final_answer'); drafts.append('a', 'turn', 'answer', '**Visible**');
  await drafts.flushOne(allowed); now += 1000; await drafts.flushOne(allowed);
  assert.deepEqual(telegram.calls.map(c => c.method), ['sendRichMessageDraft', 'sendMessageDraft']);
  assert.equal(telegram.calls[0]!.params.draft_id, telegram.calls[1]!.params.draft_id);
  assert.equal(telegram.calls[1]!.params.text, '» demo\n\nVisible');
  assert.ok(Array.isArray(telegram.calls[1]!.params.entities));
});

test('a Telegram cooldown applies to all topics, does not sleep, and survives clearing previews on reconnect', async () => {
  const telegram = new FakeTelegram(); let now = 1000; let reject = true;
  const call = telegram.call.bind(telegram);
  telegram.call = async (method, params) => {
    const result = await call(method, params);
    if (reject) { reject = false; throw new TelegramError('Too many requests', 429, 8); }
    return result;
  };
  const drafts = new Drafts(telegram, 42, () => now);
  drafts.begin(binding(), 'turn', 'answer', 'final_answer'); drafts.append('a', 'turn', 'answer', 'First');
  await drafts.flushOne(allowed); drafts.clear();
  drafts.begin(binding('b', 102), 'turn', 'answer', 'final_answer'); drafts.append('b', 'turn', 'answer', 'Second');
  now = 8999; assert.equal(await drafts.flushOne(allowed), false);
  now = 9000; assert.equal(await drafts.flushOne(allowed), true);
  assert.equal(telegram.calls.length, 2);
});

test('idle drafts refresh before their TTL, but completion and stale item deltas cannot resurrect them', async () => {
  const telegram = new FakeTelegram(); let now = 1000;
  const drafts = new Drafts(telegram, 42, () => now);
  drafts.begin(binding(), 'turn', 'answer', 'final_answer'); drafts.append('a', 'turn', 'answer', 'Generating');
  await drafts.flushOne(allowed);
  now += 14_999; assert.equal(await drafts.flushOne(allowed), false);
  now++; assert.equal(await drafts.flushOne(allowed), true);
  drafts.finish('a', 'turn', 'answer'); drafts.append('a', 'turn', 'answer', ' late');
  now += 30_000; assert.equal(await drafts.flushOne(allowed), false);
});

test('completion during an asynchronous scope check cancels the preview before any Telegram write', async () => {
  const telegram = new FakeTelegram(); const drafts = new Drafts(telegram, 42);
  drafts.begin(binding(), 'turn', 'answer', 'final_answer'); drafts.append('a', 'turn', 'answer', 'Old');
  let resolve!: (value: boolean) => void;
  const pending = drafts.flushOne(() => new Promise<boolean>(r => { resolve = r; }));
  drafts.finish('a', 'turn'); resolve(true);
  assert.equal(await pending, false); assert.equal(telegram.calls.length, 0);
});

test('Unicode preview tails stay bounded and stale deltas from replaced items or turns cannot contaminate them', async () => {
  const telegram = new FakeTelegram(); const drafts = new Drafts(telegram, 42);
  drafts.begin(binding(), 'old-turn', 'old-answer', 'final_answer');
  drafts.append('a', 'old-turn', 'old-answer', 'Old content');
  drafts.begin(binding(), 'turn', 'answer', 'final_answer');
  drafts.append('a', 'old-turn', 'old-answer', 'Do not mix');
  drafts.append('a', 'turn', 'answer', '🎁'.repeat(40_000) + 'FINAL-TAIL');
  await drafts.flushOne(allowed);
  const preview = JSON.stringify(telegram.calls[0]!.params.rich_message);
  assert.ok(Buffer.byteLength(preview) <= 24_000);
  assert.ok(preview.includes('FINAL-TAIL'));
  assert.ok(!preview.includes('Old content') && !preview.includes('Do not mix'));
  assert.ok(!/\\u[dD][89aAbB][0-9a-fA-F]{2}|\\u[dD][c-fC-F][0-9a-fA-F]{2}/u.test(preview));
});

test('stream settings are owner-only and immediate, and disabled streaming does not suppress final answers', async () => {
  const f = await fixture();
  try {
    assert.equal(f.state.streamingEnabled(), true);
    await f.bridge.update(message(1, 101, '/stream off', 99));
    assert.equal(f.state.streamingEnabled(), true);
    await f.bridge.update(message(2, 101, '/stream off'));
    assert.equal(f.state.streamingEnabled(), false);
    await f.bridge.notification('item/started', start());
    f.bridge.streamEvent('item/agentMessage/delta', delta('Do not preview'));
    assert.equal(await f.bridge.flushDraft(), false);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Full final' }] } });
    await f.drain();
    assert.ok(f.telegram.sent().some(m => string(m.text).includes('Full final')));
    assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(message(3, 101, '/stream wrong'));
    assert.equal(f.state.streamingEnabled(), false);
    await f.bridge.update(message(4, 101, '/stream on'));
    assert.equal(f.state.streamingEnabled(), true);
  } finally { f.close(); }
});

test('compact mode streams only the first Telegram reply and finals; tools, reasoning and unknown items never stream', async () => {
  const f = await fixture();
  let now = 1000;
  const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram, new Drafts(f.telegram, 42, () => now));
  try {
    await bridge.discover();
    await bridge.notification('item/started', start('thread-a', 'commentary'));
    bridge.streamEvent('item/agentMessage/delta', delta('Unrequested commentary'));
    assert.equal(await bridge.flushDraft(), false);
    await bridge.update(message(1));
    await bridge.notification('item/started', start('thread-a', 'commentary', 'first'));
    bridge.streamEvent('item/agentMessage/delta', delta('First reply', 'thread-a', 'first'));
    assert.equal(await bridge.flushDraft(), true);
    await bridge.notification('item/completed', { ...start('thread-a', 'commentary', 'first'), item: { id: 'first', type: 'agentMessage', phase: 'commentary', text: 'First reply' } });
    await bridge.notification('item/started', start('thread-a', 'commentary', 'second'));
    bridge.streamEvent('item/agentMessage/delta', delta('Further commentary', 'thread-a', 'second'));
    now += 1000; assert.equal(await bridge.flushDraft(), false);
    await bridge.notification('item/started', start('thread-a', 'final_answer', 'final'));
    bridge.streamEvent('item/agentMessage/delta', delta('Terminal answer', 'thread-a', 'final'));
    assert.equal(await bridge.flushDraft(), true);
    await bridge.notification('item/completed', { ...start(), item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Terminal answer' } });
    await bridge.update(message(2, 101, '/mode all'));
    await bridge.notification('item/started', { ...start(), item: { id: 'tool', type: 'commandExecution' } });
    bridge.streamEvent('item/agentMessage/delta', delta('Must not be attached to the tool', 'thread-a', 'tool'));
    await bridge.notification('item/started', { ...start(), item: { id: 'reason', type: 'reasoning' } });
    bridge.streamEvent('item/agentMessage/delta', delta('Private reasoning', 'thread-a', 'reason'));
    now += 1000; assert.equal(await bridge.flushDraft(), false);
    const previews = f.telegram.calls.filter(c => c.method.endsWith('MessageDraft'));
    assert.equal(previews.length, 2);
    assert.ok(JSON.stringify(previews).includes('First reply'));
    assert.ok(JSON.stringify(previews).includes('Terminal answer'));
    assert.ok(!JSON.stringify(previews).includes('Further commentary'));
    assert.ok(!JSON.stringify(previews).includes('Private reasoning'));
  } finally { f.close(); }
});

test('a slow in-flight preview settles before the single writer sends a final table and cannot be sent again', async () => {
  const f = await fixture('all');
  try {
    let settle!: () => void;
    const call = f.telegram.call.bind(f.telegram);
    const sent: string[] = [];
    f.telegram.call = async (method, params) => {
      if (method.endsWith('MessageDraft')) await new Promise<void>(resolve => { settle = resolve; });
      sent.push(method);
      return call(method, params);
    };
    await f.bridge.notification('item/started', start());
    f.bridge.streamEvent('item/agentMessage/delta', delta('Partial'));
    const inFlight = f.bridge.flushDraft();
    // Let the live native directory check finish so the draft POST is in flight.
    await Promise.resolve(); await Promise.resolve();
    assert.ok(settle);
    const text = '| Task | State |\n| --- | --- |\n| Complete | Ready |';
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] } });
    f.bridge.streamEvent('item/agentMessage/delta', delta('Late token'));
    settle(); await inFlight;
    // Same serialization contract as the CLI output loop: await preview, then drain permanent work.
    await f.drain();
    assert.deepEqual(sent, ['sendRichMessageDraft', 'sendRichMessage']);
    assert.equal(await f.bridge.flushDraft(), false);
  } finally { f.close(); }
});

test('a native session moved outside selected projects cannot stream data, including a previously buffered prefix', async () => {
  const f = await fixture('all');
  try {
    await f.bridge.notification('item/started', start());
    f.bridge.streamEvent('item/agentMessage/delta', delta('Private moved output'));
    f.codex.sessions[0]!.cwd = f.dir;
    assert.equal(await f.bridge.flushDraft(), false);
    assert.equal(f.telegram.calls.filter(c => c.method.endsWith('MessageDraft')).length, 0);
  } finally { f.close(); }
});

test('detaching a session or changing its topic discards buffered previews rather than routing them to an old topic', async () => {
  const f = await fixture('all');
  try {
    await f.bridge.notification('item/started', start());
    f.bridge.streamEvent('item/agentMessage/delta', delta('Buffered for old topic'));
    f.state.installTopic('thread-a', 103, f.projectA, 'New topic');
    assert.equal(await f.bridge.flushDraft(), false);
    await f.bridge.discover();
    await f.bridge.notification('item/started', start('thread-b'));
    f.bridge.streamEvent('item/agentMessage/delta', delta('Buffered for detached session', 'thread-b'));
    f.codex.sessions = f.codex.sessions.filter(s => s.id !== 'thread-b');
    await f.bridge.discover();
    assert.equal(await f.bridge.flushDraft(), false);
    assert.equal(f.telegram.calls.filter(c => c.method.endsWith('MessageDraft')).length, 0);
  } finally { f.close(); }
});

test('a bounded rich preview never truncates the durable final table, even after a preview transport failure', async () => {
  const f = await fixture('all');
  try {
    const rows = Array.from({ length: 180 }, (_, i) => `| row-${i.toString().padStart(3, '0')} | ${'🟢 Full cell '.repeat(9)} |`);
    const text = '# Results\n\n| Item | Result |\n| --- | --- |\n' + rows.join('\n') + '\n\nEND-OF-COMPLETE-ANSWER';
    assert.ok(text.length > 12_000 && text.length < 39_000);
    await f.bridge.notification('item/started', start());
    f.bridge.streamEvent('item/agentMessage/delta', delta(text));
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      const result = await call(method, params);
      if (method.endsWith('MessageDraft')) throw new TelegramError('Network timeout', 0);
      return result;
    };
    assert.equal(await f.bridge.flushDraft(), true);
    await f.bridge.notification('item/completed', { ...start(), item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } });
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn', status: 'completed', items: [] } });
    await f.drain();
    const finals = f.telegram.calls.filter(c => c.method === 'sendRichMessage');
    assert.ok(finals.length > 1);
    const content = JSON.stringify(finals);
    for (let i = 0; i < rows.length; i++) assert.ok(content.includes(`row-${i.toString().padStart(3, '0')}`));
    assert.ok(content.includes('END-OF-COMPLETE-ANSWER'));
    assert.ok(content.includes('"type":"table"'));
    assert.equal(f.state.uncertainCount(), 0);
    assert.equal(await f.bridge.flushDraft(), false);
  } finally { f.close(); }
});

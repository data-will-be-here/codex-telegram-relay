import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Outbox, TelegramClient, TelegramError, splitMessage } from '../src/telegram.js';
import { FakeTelegram, temporary, messageBody } from './helpers.js';
import { projectHeader } from '../src/format.js';
import { DatabaseSync } from 'node:sqlite';
import { string, array, object } from '../src/types.js';

test('interrupted host-answer reservations, question drafts and recovery timestamps survive a real database reopen', () => {
  const f = temporary(); let state = new State(join(f.dir, 'home'));
  try {
    assert.equal(state.beginAsyncAnswer('thread', 'call'), true);
    state.saveQuestionAnswers('native/thread/turn/item', 'signature', { one: { answers: ['A'] } });
    state.trackHostQuestions('thread', [{ callId: 'waiting', turnId: 'turn', askedAtMs: 1234, questions: [{ title: 'Pick' }] }]);
    state.close(); state = new State(join(f.dir, 'home'));
    assert.equal(state.beginAsyncAnswer('thread', 'call'), false);
    state.finishAsyncAnswer('thread', 'call', 'rejected');
    assert.equal(state.asyncAnswered('thread', 'call'), true, 'An interrupted write cannot be reclassified as definitely rejected.');
    assert.deepEqual(state.questionAnswers('native/thread/turn/item', 'signature'), { one: { answers: ['A'] } });
    assert.deepEqual(state.questionAnswers('native/thread/turn/item', 'changed'), {});
    assert.equal(state.hostSince('thread'), 1234);
  } finally { state.close(); f.close(); }
});

test('restart preserves bindings and marks dispatched inputs/sends uncertain without replay', () => {
  const temp = temporary(); const home = join(temp.dir, 'home');
  let state = new State(home);
  try {
    state.bind('a', 1, temp.dir, 'Project'); state.baseline('a', 'turn-previous');
    state.admit(9, 1); state.advance(9);
    state.enqueue('final/a/t', 1, 'Finished'); state.sending(state.next()!.id);
    state.awaitReply('a', 9, 'next-turn');
    state.close(); state = new State(home);
    assert.equal(state.bindings()[0]!.lastTurn, 'turn-previous');
    assert.equal(state.offset(), 10); assert.equal(state.uncertainCount(), 2);
    assert.equal(state.next(), undefined); assert.equal(state.admit(9, 1), false);
    assert.deepEqual({ ...state.reply('a') }, { inputId: 9, turnId: 'next-turn' });
    state.clearReply('a', 8);
    assert.ok(state.reply('a'));
    state.clearReply('a', 9);
    assert.equal(state.reply('a'), undefined);
  } finally { state.close(); temp.close(); }
});

test('singleton lock refuses a second local poller', () => {
  const temp = temporary(); const home = join(temp.dir, 'home'); const state = new State(home);
  try { assert.throws(() => new State(home), /already be running/u); }
  finally { state.close(); temp.close(); }
});

test('message mode defaults to all and persists across restarts', () => {
  const temp = temporary(); const home = join(temp.dir, 'home'); let state = new State(home);
  try {
    assert.equal(state.messageMode(), 'all');
    state.setMessageMode('compact'); state.close(); state = new State(home);
    assert.equal(state.messageMode(), 'compact');
    state.setMessageMode('all');
    assert.equal(state.messageMode(), 'all');
  } finally { state.close(); temp.close(); }
});

test('streaming defaults to enabled and its owner preference survives restarts independently of message mode', () => {
  const temp = temporary(); const home = join(temp.dir, 'home'); let state = new State(home);
  try {
    assert.equal(state.streamingEnabled(), true);
    state.setStreaming(false); state.setMessageMode('compact'); state.close(); state = new State(home);
    assert.equal(state.streamingEnabled(), false); assert.equal(state.messageMode(), 'compact');
    state.setStreaming(true); state.close(); state = new State(home);
    assert.equal(state.streamingEnabled(), true); assert.equal(state.messageMode(), 'compact');
  } finally { state.close(); temp.close(); }
});

test('a crash during topic creation leaves an uncertain operation that cannot create a duplicate after restart', () => {
  const temp = temporary(); const home = join(temp.dir, 'home'); let state = new State(home);
  try {
    const attempt = state.beginTopic('thread-a', temp.dir, 'Project')!;
    assert.equal(attempt.status, 'creating');
    state.close(); state = new State(home);
    assert.equal(state.topicOperation('thread-a')?.status, 'uncertain');
    assert.equal(state.beginTopic('thread-a', temp.dir, 'Project'), undefined);
    state.installTopic('thread-a', 101, temp.dir, 'Project');
    assert.equal(state.topicOperation('thread-a'), undefined);
    assert.equal(state.binding('thread-a')?.topicId, 101);
  } finally { state.close(); temp.close(); }
});

test('missing-topic recovery blocks new output, cancels old approval buttons and preserves other topics', () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home'));
  try {
    state.bind('a', 101, temp.dir, 'A'); state.bind('b', 102, temp.dir, 'B');
    state.baseline('a', 'previous-turn');
    state.enqueue('final/a/1', 101, 'First saved answer');
    state.sending(state.next()!.id);
    state.enqueue('prompt/old/approval', 101, 'Old approval', { inline_keyboard: [[{ text: 'Allow', callback_data: 'old' }]] });
    state.enqueue('final/b/1', 102, 'Unrelated answer');
    state.missingTopic(state.binding('a')!);
    const attempt = state.beginTopic('a', temp.dir, 'A')!;
    state.enqueue('assistant/a/2', 101, 'Arrived while creating replacement');
    state.missingTopic(state.binding('a')!);
    assert.equal(state.topicOperation('a')?.attempt, attempt.attempt);
    assert.equal(state.topicOperation('a')?.status, 'creating');
    assert.equal(state.next()?.topicId, 102);
    state.delivered(state.next()!.id, 1);
    assert.equal(state.next(), undefined);
    state.installTopic('a', 103, temp.dir, 'A');
    assert.equal(state.binding('a')?.lastTurn, 'previous-turn');
    const recovered: string[] = [];
    for (let row = state.next(); row; row = state.next()) {
      assert.equal(row.topicId, 103); assert.equal(row.markup, null);
      recovered.push(row.text); state.delivered(row.id, 1);
    }
    assert.deepEqual(recovered, ['First saved answer', 'Arrived while creating replacement']);
  } finally { state.close(); temp.close(); }
});

test('Telegram errors unrelated to formatting are not retried as plain text', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); let attempts = 0;
  try {
    state.enqueue('final/a/missing-topic', 1, '**Answer**');
    const telegram = { call: async () => { attempts++; throw new TelegramError('Bad Request: message thread not found', 400); } };
    await assert.rejects(new Outbox(state, telegram, 42, 0).flushOne());
    assert.equal(attempts, 1);
    assert.equal(state.uncertainCount(), 1);
  } finally { state.close(); temp.close(); }
});

test('format fallback on a later chunk never replays accepted chunks and keeps buttons on the last part', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); const t = new FakeTelegram();
  try {
    state.enqueue('final/a/multipart-fallback', 1, '**' + 'x'.repeat(4000) + '**', { inline_keyboard: [[{ text: 'OK', callback_data: 'test' }]] });
    const call = t.call.bind(t); let attempts = 0;
    t.call = async (method, params = {}) => {
      if (method === 'sendMessage' && ++attempts === 2) { t.calls.push({ method, params }); throw new TelegramError("Bad Request: can't parse entities", 400); }
      return call(method, params);
    };
    await new Outbox(state, t, 42, 0).flushOne();
    const messages = t.sent();
    assert.equal(messages.length, 3);
    const limit = 3500 - projectHeader().length - 2;
    assert.equal(messageBody(messages[0]!), 'x'.repeat(limit));
    assert.equal(messageBody(messages[2]!), 'x'.repeat(4000 - limit));
    assert.equal(messages[2]!.entities, undefined);
    assert.ok(messages[2]!.reply_markup);
    assert.equal(state.uncertainCount(), 0);
  } finally { state.close(); temp.close(); }
});

test('HTTP errors cannot leak the bot token or its URL', async () => {
  const token = 'synthetic-token-used-only-by-mocked-fetch';
  const t = new TelegramClient(token, (async () => { throw new Error('https://api.telegram.org/bot' + token + '/sendMessage'); }) as typeof fetch);
  await assert.rejects(t.call('sendMessage'), error => !String(error).includes(token) && !String(error).includes('https://'));
  const rejected = new TelegramClient(token, (async () => new Response(JSON.stringify({ ok: false, description: 'reflected ' + token }), { status: 400 })) as typeof fetch);
  await assert.rejects(rejected.call('sendMessage'), error => !String(error).includes(token));
});

test('an uncertain Telegram POST is not automatically replayed', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home'));
  try {
    state.enqueue('one', 1, 'Hello');
    const failing = { call: async (): Promise<unknown> => { throw new Error('Connection lost after send'); } };
    const outbox = new Outbox(state, failing, 42, 0);
    await assert.rejects(outbox.flushOne());
    assert.equal(await outbox.flushOne(), false); assert.equal(state.uncertainCount(), 1);
  } finally { state.close(); temp.close(); }
});

test('a definite Telegram entity rejection falls back to readable text with link targets', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); const t = new FakeTelegram();
  try {
    state.enqueue('final/a/rejected-markup', 1, '**Result**: [docs](https://example.com/docs).');
    const call = t.call.bind(t); let first = true;
    t.call = async (method, params = {}) => {
      if (method === 'sendMessage' && first) { first = false; t.calls.push({ method, params }); throw new TelegramError("Bad Request: can't parse entities", 400); }
      return call(method, params);
    };
    await new Outbox(state, t, 42, 0).flushOne();
    assert.equal(t.sent().length, 2);
    assert.ok(t.sent()[0]!.entities);
    assert.equal(t.sent()[1]!.entities, undefined);
    assert.equal(messageBody(t.sent()[1]!), 'Result: docs (https://example.com/docs).');
    assert.equal(state.uncertainCount(), 0);
  } finally { state.close(); temp.close(); }
});

test('final answers send Telegram formatting entities instead of raw Markdown', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); const t = new FakeTelegram();
  try {
    state.enqueue('final/a/formatted', 1, '🎁 **Готово**: [документация](https://example.com/docs) и `npm test`.');
    await new Outbox(state, t, 42, 0).flushOne();
    const sent = t.sent()[0]!;
    assert.equal(messageBody(sent), '🎁 Готово: документация и npm test.');
    const header = projectHeader();
    assert.deepEqual(sent.entities, [
      { type: 'italic', offset: 0, length: header.length },
      ...[
      { type: 'bold', offset: 3, length: 6 },
      { type: 'text_link', offset: 11, length: 12, url: 'https://example.com/docs' },
      { type: 'code', offset: 26, length: 8 },
      ].map(e => ({ ...e, offset: e.offset + header.length + 2 })),
    ]);
    assert.equal(sent.parse_mode, undefined);
  } finally { state.close(); temp.close(); }
});

test('long Unicode output is split intact and buttons appear only on its last message', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); const t = new FakeTelegram();
  try {
    const text = '🎁'.repeat(4000);
    assert.equal(splitMessage(text).join(''), text);
    assert.ok(splitMessage(text).every(x => x.length <= 3500));
    state.enqueue('long', 1, text, { inline_keyboard: [[{ text: 'OK', callback_data: 'x' }]] });
    await new Outbox(state, t, 42, 0).flushOne();
    assert.equal(t.sent().length, 3);
    assert.equal(t.sent()[0]!.reply_markup, undefined);
    assert.ok(t.sent().at(-1)!.reply_markup);
  } finally { state.close(); temp.close(); }
});

test('each long message part includes its italic project signature and keeps formatting within limits', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); const t = new FakeTelegram();
  try {
    state.bind('a', 101, join(temp.dir, 'project-a'), 'A');
    const text = '🎁'.repeat(4000);
    state.enqueue('final/a/header', 101, text);
    await new Outbox(state, t, 42, 0).flushOne();
    const sent = t.sent();
    assert.equal(sent.map(messageBody).join(''), text);
    for (const message of sent) {
      assert.ok(string(message.text).startsWith('» project-a\n\n'));
      assert.ok(string(message.text).length <= 3500);
      const header = object(array(message.entities)[0]);
      assert.equal(header.type, 'italic'); assert.equal(header.offset, 0); assert.equal(header.length, '» project-a'.length);
    }
    state.enqueue('topic-problem/synthetic', null, 'Needs attention', null, join(temp.dir, 'project-a'));
    await new Outbox(state, t, 42, 0).flushOne();
    assert.equal(t.sent().at(-1)!.text, '» project-a\n\nNeeds attention');
  } finally { state.close(); temp.close(); }
});

test('older outbox schemas migrate without losing queued answers or their project identity', async () => {
  const temp = temporary(); const db = new DatabaseSync(join(temp.dir, 'state.sqlite'));
  db.exec("CREATE TABLE outbox(id INTEGER PRIMARY KEY,key TEXT UNIQUE,topicId INTEGER,text TEXT,markup TEXT,status TEXT DEFAULT 'pending',messageId INTEGER,at INTEGER); INSERT INTO outbox(key,topicId,text,at) VALUES('final/a/legacy',101,'Legacy answer',0)");
  db.close();
  const state = new State(temp.dir); const t = new FakeTelegram();
  try {
    state.bind('a', 101, join(temp.dir, 'legacy-project'), 'Legacy');
    await new Outbox(state, t, 42, 0).flushOne();
    assert.equal(t.sent()[0]!.text, '» legacy-project\n\nLegacy answer');
  } finally { state.close(); temp.close(); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Outbox, TelegramClient, TelegramError, splitMessage } from '../src/telegram.js';
import { FakeTelegram, temporary } from './helpers.js';

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
    assert.equal(messages[0]!.text, 'x'.repeat(3500));
    assert.equal(messages[2]!.text, 'x'.repeat(500));
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
    assert.equal(t.sent()[1]!.text, 'Result: docs (https://example.com/docs).');
    assert.equal(state.uncertainCount(), 0);
  } finally { state.close(); temp.close(); }
});

test('final answers send Telegram formatting entities instead of raw Markdown', async () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'home')); const t = new FakeTelegram();
  try {
    state.enqueue('final/a/formatted', 1, '🎁 **Готово**: [документация](https://example.com/docs) и `npm test`.');
    await new Outbox(state, t, 42, 0).flushOne();
    const sent = t.sent()[0]!;
    assert.equal(sent.text, '🎁 Готово: документация и npm test.');
    assert.deepEqual(sent.entities, [
      { type: 'bold', offset: 3, length: 6 },
      { type: 'text_link', offset: 11, length: 12, url: 'https://example.com/docs' },
      { type: 'code', offset: 26, length: 8 },
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Outbox, TelegramClient, splitMessage } from '../src/telegram.js';
import { FakeTelegram, temporary } from './helpers.js';

test('restart preserves bindings and marks dispatched inputs/sends uncertain without replay', () => {
  const temp = temporary(); const home = join(temp.dir, 'home');
  let state = new State(home);
  try {
    state.bind('a', 1, temp.dir, 'Project'); state.baseline('a', 'turn-previous');
    state.admit(9, 1); state.advance(9);
    state.enqueue('final/a/t', 1, 'Finished'); state.sending(state.next()!.id);
    state.close(); state = new State(home);
    assert.equal(state.bindings()[0]!.lastTurn, 'turn-previous');
    assert.equal(state.offset(), 10); assert.equal(state.uncertainCount(), 2);
    assert.equal(state.next(), undefined); assert.equal(state.admit(9, 1), false);
  } finally { state.close(); temp.close(); }
});

test('singleton lock refuses a second local poller', () => {
  const temp = temporary(); const home = join(temp.dir, 'home'); const state = new State(home);
  try { assert.throws(() => new State(home), /already be running/u); }
  finally { state.close(); temp.close(); }
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

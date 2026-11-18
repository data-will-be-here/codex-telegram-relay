import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { State } from '../src/state.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { join } from 'node:path';
import { click, fixture, message } from './helpers.js';
import { array, object, string, type Json } from '../src/types.js';

async function open(f: Awaited<ReturnType<typeof fixture>>, id = 1, topic = 101) {
  await f.bridge.update(message(id, topic, '/rename')); await f.drain();
  const sent = f.telegram.sent().filter(p => string(p.text).includes('Current topic:')).at(-1)!;
  const controls = array(array(object(sent.reply_markup).inline_keyboard)[0]).map(object);
  return { id: f.telegram.message, cancel: string(controls[0]!.callback_data), reset: string(controls[1]!.callback_data) };
}
function reply(id: number, promptId: number, text: string, topic = 101): Json {
  const update = message(id, topic, text);
  object(update.message).reply_to_message = { message_id: promptId };
  return update;
}
function control(id: number, data: string, promptId: number, topic = 101): Json {
  const update = click(id, data, topic);
  object(object(update.callback_query).message).message_id = promptId;
  return update;
}

test('/rename changes only the topic, in Classic and Widgets, without a native session attachment', async () => {
  for (const view of ['classic', 'widgets'] as const) {
    const f = await fixture();
    try {
      f.state.setViewMode(view);
      f.codex.sessions = []; await f.bridge.discover();
      const original = f.state.binding('thread-a')!;
      await f.bridge.update(message(1, 101, '/rename Новый диалог 🎁')); await f.drain();
      assert.equal(f.state.binding('thread-a')?.title, 'Новый диалог 🎁');
      assert.equal(f.state.binding('thread-a')?.topicId, original.topicId);
      assert.equal(f.state.binding('thread-a')?.sessionName, original.sessionName);
      assert.equal(f.state.binding('thread-a')?.taskName, original.taskName);
      assert.deepEqual(f.codex.writes, []);
      assert.ok(f.telegram.sent().some(p => string(p.text).includes('Topic renamed: Новый диалог 🎁')));
      assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 2);
    } finally { f.close(); }
  }
});

test('only replies to the rename prompt are names; cancellation, old menus and expiry never send instructions', async () => {
  const f = await fixture();
  try {
    const first = await open(f);
    await f.bridge.update(message(2, 101, 'Ordinary instruction'));
    assert.equal(f.codex.writes.length, 1);
    const second = await open(f, 3);
    await f.bridge.update(reply(4, first.id, 'Stale name'));
    await f.bridge.update(control(5, second.cancel, second.id));
    await f.bridge.update(reply(6, second.id, 'Cancelled name'));
    assert.equal(f.state.binding('thread-a')?.customTitle, null);
    assert.equal(f.codex.writes.length, 1);
    const expired = await open(f, 7);
    const realNow = Date.now; Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
    try { f.state.prune(); await f.bridge.update(reply(8, expired.id, 'Expired name')); }
    finally { Date.now = realNow; }
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.state.binding('thread-a')?.customTitle, null);
  } finally { f.close(); }
});

test('rename prompts and their reply routing survive a relay restart; reset returns the generated name', async () => {
  const f = await fixture();
  try {
    const defaultTitle = f.state.binding('thread-a')!.title;
    const prompt = await open(f);
    f.bridge.close(); f.state.close();
    const state = new State(join(f.dir, 'private'));
    const bridge = new Bridge(f.bridge.config, state, f.codex, f.telegram);
    const outbox = new Outbox(state, f.telegram, bridge.config, 0);
    const drain = async () => { while (await outbox.flushOne()) { /* Deliver persisted controls. */ } };
    try {
      await bridge.update(reply(2, prompt.id, 'My conversation')); await drain();
      assert.equal(state.binding('thread-a')?.title, 'My conversation');
      await bridge.update(message(3, 101, '/rename')); await drain();
      const sent = f.telegram.sent().at(-1)!;
      const controls = array(array(object(sent.reply_markup).inline_keyboard)[0]).map(object);
      await bridge.update(control(4, string(controls[1]!.callback_data), f.telegram.message));
      assert.equal(state.binding('thread-a')?.title, defaultTitle);
      assert.equal(state.binding('thread-a')?.customTitle, null);
    } finally { bridge.close(); state.close(); }
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('rename controls validate owner, chat, topic, message and current binding after acknowledgement', async () => {
  const f = await fixture();
  try {
    const prompt = await open(f);
    await f.bridge.update(message(2, 101, '/rename Stranger', 99));
    const root = message(3, 101, '/rename Root'); delete object(root.message).message_thread_id;
    await f.bridge.update(root);
    await f.bridge.update(control(4, prompt.reset, prompt.id, 102));
    await f.bridge.update(control(5, prompt.reset, prompt.id + 99));
    assert.equal(f.telegram.calls.filter(c => c.method === 'editForumTopic').length, 0);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'answerCallbackQuery') f.bridge.config.ignoredThreadIds = ['thread-a'];
      return call(method, params);
    };
    await f.bridge.update(control(6, prompt.reset, prompt.id));
    assert.equal(f.telegram.calls.filter(c => c.method === 'editForumTopic').length, 0);
    await f.bridge.update(reply(7, prompt.id, 'Revoked name'));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('invalid rename replies stay in the prompt and media is never forwarded', async () => {
  const f = await fixture();
  try {
    const prompt = await open(f);
    await f.bridge.update(reply(2, prompt.id, 'a'.repeat(129)));
    await f.bridge.update(reply(3, prompt.id, 'Two\nlines'));
    const photo = reply(4, prompt.id, ''); object(photo.message).photo = [{ file_id: 'never-download' }];
    await f.bridge.update(photo);
    assert.equal(f.state.binding('thread-a')?.customTitle, null);
    await f.bridge.update(reply(5, prompt.id, 'Valid name'));
    assert.equal(f.state.binding('thread-a')?.title, 'Valid name');
    assert.deepEqual(f.codex.writes, []);
    assert.equal(f.telegram.calls.some(c => c.method === 'getFile'), false);
  } finally { f.close(); }
});

test('an uncertain rename of an unloaded session is retried without loading or starting Codex', async () => {
  const f = await fixture();
  try {
    f.codex.sessions = []; await f.bridge.discover();
    const call = f.telegram.call.bind(f.telegram); let lose = true;
    f.telegram.call = async (method, params) => {
      if (method === 'editForumTopic' && lose) throw new TelegramError('Response lost', 0);
      return call(method, params);
    };
    await f.bridge.update(message(1, 101, '/rename Offline research'));
    assert.equal(f.state.binding('thread-a')?.titlePending, 1);
    assert.equal(f.state.binding('thread-a')?.customTitle, 'Offline research');
    f.state.deferTopicTitle('thread-a', 0); lose = false;
    await f.bridge.discover();
    assert.equal(f.state.binding('thread-a')?.title, 'Offline research');
    assert.equal(f.state.binding('thread-a')?.titlePending, 0);
    assert.deepEqual(f.codex.writes, []);
    assert.equal(f.codex.sessions.length, 0);
  } finally { f.close(); }
});

test('closing a relay generation during acknowledgement prevents a rename callback write', async () => {
  const f = await fixture();
  try {
    const prompt = await open(f);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => {
      if (method === 'answerCallbackQuery') f.bridge.close();
      return call(method, params);
    };
    await f.bridge.update(control(2, prompt.reset, prompt.id));
    assert.equal(f.telegram.calls.some(c => c.method === 'editForumTopic'), false);
  } finally { f.close(); }
});

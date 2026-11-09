import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandHelp, syncCommandMenu } from '../src/commands.js';
import { array, object, string, type Json } from '../src/types.js';
import { FakeTelegram, fixture, message } from './helpers.js';
import { TelegramError } from '../src/telegram.js';

class MenuTelegram extends FakeTelegram {
  menus = new Map<string, unknown[]>();
  override async call(method: string, params: Json = {}): Promise<unknown> {
    await super.call(method, params);
    const language = string(params.language_code);
    if (method === 'getMyCommands') return this.menus.get(language) ?? [];
    if (method === 'setMyCommands') this.menus.set(language, array(params.commands));
    return true;
  }
}

test('command menus use the owner chat and English descriptions in both default and legacy Russian scopes', async () => {
  const telegram = new MenuTelegram();
  const ownerId = 710007;
  assert.equal(await syncCommandMenu(telegram, ownerId), true);
  const sets = telegram.calls.filter(c => c.method === 'setMyCommands');
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map(c => c.params.language_code), ['', 'ru']);
  for (const call of telegram.calls) assert.deepEqual(call.params.scope, { type: 'chat', chat_id: ownerId });
  const expected = ['help', 'status', 'limits', 'sessions', 'new', 'model', 'permissions', 'view', 'mode', 'stream', 'questions'];
  for (const set of sets) {
    const items = array(set.params.commands).map(object);
    assert.deepEqual(items.map(c => c.command), expected);
    for (const item of items) {
      assert.match(string(item.command), /^[a-z0-9_]{1,32}$/u);
      assert.ok(Array.from(string(item.description)).length > 0 && Array.from(string(item.description)).length <= 256);
      assert.ok(commandHelp().includes('/' + string(item.command)));
    }
  }
  assert.deepEqual(sets[0]!.params.commands, sets[1]!.params.commands);
  assert.equal(telegram.calls.some(c => c.method === 'deleteMyCommands' || c.method === 'sendMessage'), false);
});

test('unchanged menus are not rewritten, but legacy Russian descriptions are replaced independently', async () => {
  const telegram = new MenuTelegram();
  await syncCommandMenu(telegram, 42); telegram.calls.length = 0;
  assert.equal(await syncCommandMenu(telegram, 42), true);
  assert.deepEqual(telegram.calls.map(c => c.method), ['getMyCommands', 'getMyCommands']);
  telegram.menus.set('ru', telegram.menus.get('')!.map(command => ({ ...object(command), description: 'Старое русское описание' }))); telegram.calls.length = 0;
  assert.equal(await syncCommandMenu(telegram, 42), true);
  const sets = telegram.calls.filter(c => c.method === 'setMyCommands');
  assert.equal(sets.length, 1); assert.equal(sets[0]!.params.language_code, 'ru');
  assert.ok(array(sets[0]!.params.commands).some(c => object(c).command === 'stream'));
  assert.deepEqual(sets[0]!.params.commands, telegram.menus.get(''));
});

test('a failed language update cannot stop the other language or normal relay messages, and next startup repairs it', async () => {
  const telegram = new MenuTelegram(); const original = telegram.call.bind(telegram); let fail = true;
  telegram.call = async (method, params = {}) => {
    if (method === 'getMyCommands' && params.language_code === '' && fail) { fail = false; throw new TelegramError('Network unavailable', 0); }
    return original(method, params);
  };
  assert.equal(await syncCommandMenu(telegram, 42), false);
  assert.equal(telegram.menus.has(''), false); assert.ok(telegram.menus.has('ru'));
  assert.equal(await syncCommandMenu(telegram, 42), true);
  assert.ok(telegram.menus.has(''));
  const f = await fixture();
  try {
    f.telegram.call = async (method, params) => {
      if (method.endsWith('MyCommands')) throw new TelegramError('Too many requests', 429, 60);
      return FakeTelegram.prototype.call.call(f.telegram, method, params);
    };
    assert.equal(await syncCommandMenu(f.telegram, 42), false);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Messaging still works' }] } });
    await f.drain();
    assert.ok(f.telegram.sent().some(c => string(c.text).includes('Messaging still works')));
    assert.equal(f.state.uncertainCount(), 0);
  } finally { f.close(); }
});

test('an uncertain settings response is resolved by reading the saved menu rather than blindly repeating the write', async () => {
  const telegram = new MenuTelegram(); const original = telegram.call.bind(telegram); let fail = true;
  telegram.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'setMyCommands' && fail) { fail = false; throw new TelegramError('Response lost', 0); }
    return result;
  };
  assert.equal(await syncCommandMenu(telegram, 42), false);
  telegram.calls.length = 0;
  assert.equal(await syncCommandMenu(telegram, 42), true);
  assert.deepEqual(telegram.calls.map(c => c.method), ['getMyCommands', 'getMyCommands']);
});

test('invalid owner IDs never fall back to a globally visible command scope', async () => {
  const telegram = new MenuTelegram();
  for (const id of [0, -42, 1.5, NaN, Infinity]) assert.equal(await syncCommandMenu(telegram, id), false);
  assert.equal(telegram.calls.length, 0);
});

test('each command advertised in the menu is handled when tapped without arguments and never becomes a Codex instruction', async () => {
  const f = await fixture(); const menu = new MenuTelegram();
  try {
    await syncCommandMenu(menu, 42);
    const items = menu.menus.get('')!;
    for (const [index, command] of items.entries()) await f.bridge.update(message(index + 1, 101, '/' + string(object(command).command)));
    await f.drain();
    assert.equal(f.codex.writes.length, 0);
    assert.ok(f.telegram.sent().length >= items.length);
    assert.ok(!f.telegram.sent().some(c => string(c.text).includes('Unknown command')));
    assert.ok(!commandHelp().includes('/say'));
    assert.ok(f.telegram.sent().some(c => string(c.text).includes(commandHelp())));
  } finally { f.close(); }
});

test('strangers cannot invoke any advertised command, change preferences or receive session data even with valid arguments', async () => {
  const f = await fixture('all'); const menu = new MenuTelegram();
  try {
    await syncCommandMenu(menu, 42);
    const inputs = [
      '/start', ...menu.menus.get('')!.map(c => '/' + string(object(c).command)),
      '/mode compact', '/stream off', '/say Run an unauthorized instruction', '/bind thread-b', '/repair thread-a',
    ];
    const bindings = f.state.bindings();
    f.telegram.calls.length = 0;
    let updateId = 1000;
    for (const input of inputs) {
      // A stranger's actual private chat with the bot.
      await f.bridge.update(message(updateId++, 101, input, 99));
      // Owner commands from a group are also outside the authorized private chat.
      const group = message(updateId++, 101, input);
      object(object(group.message).chat).id = -100;
      object(object(group.message).chat).type = 'group';
      await f.bridge.update(group);
      // A mismatched sender/chat pair cannot pass authorization either.
      const mismatched = message(updateId++, 101, input, 99);
      object(object(mismatched.message).chat).id = 42;
      await f.bridge.update(mismatched);
    }
    await f.drain();
    assert.equal(f.telegram.calls.length, 0, 'No reply or session information may be sent to unauthorized users.');
    assert.equal(f.codex.writes.length, 0);
    assert.equal(f.state.messageMode(), 'all'); assert.equal(f.state.streamingEnabled(), true);
    assert.deepEqual(f.state.bindings(), bindings);
    assert.equal(f.state.next(), undefined);
  } finally { f.close(); }
});

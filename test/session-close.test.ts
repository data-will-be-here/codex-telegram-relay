import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcError } from '../src/codex.js';
import { SessionClose } from '../src/session-close.js';
import { array, object, string, type Json } from '../src/types.js';
import { click, fixture, message } from './helpers.js';

function buttons(menu: Json): Json[] {
  return array(object(menu.reply_markup).inline_keyboard).flat().map(object);
}

function button(menu: Json, pattern: string): string {
  const match = buttons(menu).find(item => string(item.text).includes(pattern));
  assert.ok(match, `Missing button ${pattern}`);
  return string(match.callback_data);
}

test('/close keeps the menu open for consecutive closures and never retargets a removed button', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.drain();
  for (const session of f.codex.sessions) Object.assign(session, { source: 'appServer' });
  const archived = new Set<string>();
  const rpcCalls: string[] = [];
  Object.assign(f.codex, {
    loaded: async () => f.codex.sessions.map(session => session.id).filter(id => !archived.has(id)),
    nonArchivedThread: async (id: string) => archived.has(id) ? undefined : f.codex.read(id),
    archive: async (id: string) => {
      rpcCalls.push(id);
      archived.add(id);
      f.codex.sessions = f.codex.sessions.filter(session => session.id !== id);
    },
  });
  f.codex.sessions[1]!.status = 'active';
  await f.bridge.update(message(1, 101, '/close'));
  await f.drain();
  const menu = f.telegram.sent().at(-1)!;
  const messageId = f.telegram.message;
  const press = async (update: number, data: string, topic = 101) => {
    const event = click(update, data, topic);
    object(object(event.callback_query).message).message_id = messageId;
    await f.bridge.update(event);
  };

  const first = button(menu, ' · thread-a · ');
  const second = button(menu, ' · thread-b · ');
  await press(2, second);
  assert.deepEqual(rpcCalls, []);
  const busy = f.telegram.calls.at(-1)!.params;
  assert.match(string(busy.text), /still active/u);
  assert.deepEqual(buttons(busy), buttons(menu));

  f.codex.sessions[1]!.status = 'idle';
  await press(3, second, 102);
  assert.deepEqual(rpcCalls, []);
  await press(4, second);
  const updated = f.telegram.calls.at(-1)!;
  assert.equal(updated.method, 'editMessageText');
  assert.equal(updated.params.message_id, messageId);
  assert.equal(button(updated.params, ' · thread-a · '), first);
  assert.ok(!buttons(updated.params).some(item => item.callback_data === second));
  await press(5, second);
  assert.deepEqual(rpcCalls, ['thread-b']);
  assert.equal(f.state.binding('thread-b')?.topicId, 102);
  assert.equal(f.state.archivedSession('thread-b'), true);
  assert.deepEqual(await f.codex.loaded!(), ['thread-a']);

  await press(6, first);
  assert.deepEqual(rpcCalls, ['thread-b', 'thread-a']);
  assert.deepEqual(buttons(f.telegram.calls.at(-1)!.params), []);
  assert.equal(f.telegram.message, messageId);

  await f.bridge.update(message(7, 102, 'A new instruction'));
  await f.drain();
  assert.match(string(f.telegram.sent().at(-1)?.text), /closed and its history is archived/u);
  assert.deepEqual(f.codex.writes, []);
});

test('/close orders sessions by creation time and moves back when closing the last item on a page', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.drain();
  const choices = Array.from({ length: 9 }, (_, index) => ({
    threadId: `0000000${9 - index}-0000-7000-8000-000000000000`,
    topicId: 200 + index,
    cwd: f.projectA,
    title: `Project ${9 - index}`,
    lastTurn: null,
  }));
  const picker = new SessionClose(f.state, f.telegram, 42, async () => choices.slice(),
    async () => ({ status: 'closed', text: 'Session closed.' }));
  await picker.open(null);
  await f.drain();
  const menu = f.telegram.sent().at(-1)!;
  const messageId = f.telegram.message;
  const press = (data: string) => picker.callback({ id: data, data }, { message_id: messageId }, null);
  const oldest = button(menu, 'Project 1 ·');
  assert.equal(buttons(menu)[0]?.callback_data, oldest);
  assert.equal(buttons(menu)[7]?.text, 'Close Project 8 · 00000008 · #201');

  await press(button(menu, '→'));
  const lastPage = f.telegram.calls.at(-1)!.params;
  await press(button(lastPage, 'Project 9 ·'));
  const updated = f.telegram.calls.at(-1)!.params;
  assert.equal(updated.message_id, messageId);
  assert.equal(buttons(updated).length, 9);
  assert.equal(buttons(updated)[0]?.callback_data, oldest);
  assert.equal(buttons(updated).at(-1)?.text, 'Cancel');
});

test('/close skips missing and archived sessions but retains saved unloaded sessions and unverified bindings', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.drain();
  const missing = new Set(['missing']);
  const unavailable = (id: string) => new RpcError(`Codex rejected the request: thread not loaded: ${id}`, false);
  f.state.bind('missing', 201, f.projectA, 'Missing session');
  f.state.bind('archived', 202, f.projectA, 'Archived session');
  f.state.bind('saved', 203, f.projectA, 'Saved unloaded session');
  f.state.bind('unverified', 204, f.projectA, 'Try again later');
  const archiveCalls: string[] = [];
  Object.assign(f.codex, {
    loaded: async () => f.codex.sessions.map(session => session.id),
    nonArchivedThread: async (id: string) => {
      if (missing.has(id)) throw unavailable(id);
      if (id === 'archived') return undefined;
      if (id === 'unverified') throw new RpcError('Temporary read failure', true);
      if (id === 'saved') return { id, cwd: f.projectA, status: { type: 'notLoaded' } };
      return f.codex.read(id);
    },
    archive: async (id: string) => { archiveCalls.push(id); },
  });

  await f.bridge.update(message(1, 101, '/close'));
  await f.drain();
  const menu = f.telegram.sent().at(-1)!;
  assert.ok(!buttons(menu).some(item => string(item.text).includes(' · missing · ') || string(item.text).includes(' · archived · ')));
  const saved = button(menu, ' · saved · ');
  assert.ok(button(menu, ' · unverifi · '));
  assert.equal(f.state.topic(201)?.threadId, 'missing');

  missing.add('saved');
  const event = click(2, saved);
  object(object(event.callback_query).message).message_id = f.telegram.message;
  await f.bridge.update(event);
  const updated = f.telegram.calls.at(-1)!.params;
  assert.match(string(updated.text), /no longer exists in Codex/u);
  assert.ok(!buttons(updated).some(item => item.callback_data === saved));
  assert.equal(f.state.topic(203)?.threadId, 'saved');
  assert.deepEqual(archiveCalls, []);
});

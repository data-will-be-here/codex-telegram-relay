import assert from 'node:assert/strict';
import { test } from 'node:test';
import { array, object, string } from '../src/types.js';
import { click, fixture, message } from './helpers.js';

test('/close targets the exact saved session, protects active work and consumes its own button', async t => {
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
  const open = async (update: number, id: string) => {
    await f.bridge.update(message(update, 101, '/close'));
    await f.drain();
    const menu = f.telegram.sent().at(-1)!;
    const button = array(object(menu.reply_markup).inline_keyboard).flat().map(object)
      .find(button => string(button.text).includes(` · ${id} · `));
    assert.ok(button);
    return { messageId: f.telegram.message, data: string(button.callback_data) };
  };
  const press = async (update: number, selection: Awaited<ReturnType<typeof open>>, topic = 101) => {
    const event = click(update, selection.data, topic);
    object(object(event.callback_query).message).message_id = selection.messageId;
    await f.bridge.update(event);
  };
  f.codex.sessions[1]!.status = 'active';
  const busy = await open(1, 'thread-b');
  await press(2, busy);
  assert.deepEqual(rpcCalls, []);
  assert.match(string(f.telegram.calls.at(-1)?.params.text), /still active/u);

  f.codex.sessions[1]!.status = 'idle';
  const idle = await open(3, 'thread-b');
  await press(4, idle, 102);
  assert.deepEqual(rpcCalls, []);
  await press(5, idle);
  await press(6, idle);
  assert.deepEqual(rpcCalls, ['thread-b']);
  assert.equal(f.state.binding('thread-b')?.topicId, 102);
  assert.equal(f.state.archivedSession('thread-b'), true);
  assert.deepEqual(await f.codex.loaded!(), ['thread-a']);

  await f.bridge.update(message(7, 102, 'A new instruction'));
  await f.drain();
  assert.match(string(f.telegram.sent().at(-1)?.text), /closed and its history is archived/u);
  assert.deepEqual(f.codex.writes, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message } from './helpers.js';
import { type ClearSettingsSnapshot } from '../src/clear-settings.js';
import { type Json } from '../src/types.js';

async function childFixture(status: 'idle' | 'active') {
  const f = await fixture(); let starts = 0; const released: string[] = [];
  const read = f.codex.read.bind(f.codex);
  const child: Json = { id: 'child-agent', cwd: f.projectA, status: { type: status }, parentThreadId: 'thread-a', canAcceptDirectInput: false,
    source: { subAgent: { thread_spawn: { parent_thread_id: 'thread-a', agent_path: '/root/check' } } } };
  Object.assign(f.codex, {
    read: async (id: string) => id === 'child-agent' ? structuredClone(child) : { ...await read(id), source: 'cli' },
    loaded: async () => [...f.codex.sessions.map(session => session.id), 'child-agent'],
    createThread: async (cwd: string, marker: string, _source?: 'clear', settings?: ClearSettingsSnapshot) => {
      starts++; const id = 'replacement';
      f.codex.sessions.push({ id, cwd, name: '', status: 'idle', threadSource: marker });
      if (settings) f.codex.permissionStates.set(id, structuredClone(settings.settings));
      return { id, cwd, source: 'cli', ephemeral: false, threadSource: marker, status: { type: 'idle' } };
    },
    setThreadName: async () => {},
    nonArchivedThread: async (id: string) => f.codex.read(id),
    findCreatedThread: async () => undefined,
    unsubscribe: async (id: string) => { released.push(id); },
  });
  await f.bridge.discover(); await f.drain();
  return { ...f, child, released, starts: () => starts };
}

test('/clear refuses a known subscribed active child without stopping it or creating a replacement', async () => {
  const f = await childFixture('active');
  try {
    await f.bridge.update(message(1, 101, '/clear')); await f.bridge.workNewSession(); await f.drain();
    assert.equal(f.starts(), 0);
    assert.equal(f.state.topic(101)?.threadId, 'thread-a');
    assert.deepEqual(f.codex.writes, []);
    assert.deepEqual(f.released, []);
  } finally { f.close(); }
});

test('/clear durably releases known idle child subscriptions as well as the retired root', async () => {
  const f = await childFixture('idle');
  try {
    await f.bridge.update(message(1, 101, '/clear'));
    for (let i = 0; i < 3; i++) await f.bridge.workNewSession();
    assert.equal(f.state.topic(101)?.threadId, 'replacement');
    assert.deepEqual(f.released.sort(), ['child-agent', 'thread-a']);
    assert.equal(f.state.pendingUnsubscribes().length, 0);
  } finally { f.close(); }
});

test('/clear does not revive a host question retired by a confirmed /stop', async () => {
  const f = await childFixture('idle');
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'stopped-turn', status: 'inProgress', items: [] }]);
    Object.assign(f.codex, {
      interrupt: async () => ({}),
      asyncQuestions: async (id: string) => id === 'thread-a' ? [{ callId: 'closed-host-question', turnId: 'stopped-turn', questions: [{ title: 'Choose', options: ['A'] }] }] : [],
    });
    await f.bridge.discover(); await f.drain();
    await f.bridge.update(message(1, 101, '/stop'));
    f.codex.sessions[0]!.status = 'idle';
    f.codex.histories.set('thread-a', [{ id: 'stopped-turn', status: 'interrupted', items: [] }]);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'stopped-turn', status: 'interrupted', items: [] } });
    await f.drain();
    await f.bridge.update(message(2, 101, '/clear')); await f.bridge.workNewSession();
    assert.equal(f.starts(), 1);
    assert.equal(f.state.topic(101)?.threadId, 'replacement');
  } finally { f.close(); }
});

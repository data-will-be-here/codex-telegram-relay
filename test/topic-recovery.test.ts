import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, messageBody } from './helpers.js';

test('saved but unloaded session is distinguished from a healthy attached topic', async () => {
  const f = await fixture();
  try {
    f.codex.sessions = f.codex.sessions.filter(s => s.id !== 'thread-a');
    await f.bridge.discover();
    await f.bridge.update(message(901, 101, '/repair thread-a'));
    await f.bridge.update(message(902, 101, '/bind thread-a'));
    await f.bridge.update(message(903, 101, '322'));
    await f.drain();
    const replies = f.telegram.sent().map(messageBody);
    assert.equal(replies.some(text => /healthy topic/u.test(text)), false);
    assert.equal(replies.filter(text => /not loaded/iu.test(text)).length, 3);
    assert.equal(f.state.binding('thread-a')?.topicId, 101);
    assert.equal(f.codex.writes.length, 0);
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 2);
  } finally { f.close(); }
});

test('bind in the saved topic reconnects a session after a transient attach failure', async () => {
  const f = await fixture();
  try {
    const sessions = f.codex.sessions;
    f.codex.sessions = sessions.filter(s => s.id !== 'thread-a');
    await f.bridge.discover();
    f.codex.sessions = sessions;
    await f.bridge.update(message(904, 101, '/bind thread-a'));
    await f.bridge.update(message(905, 101, 'Continue'));
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.codex.writes[0]?.params.threadId, 'thread-a');
    assert.equal(f.state.binding('thread-a')?.topicId, 101);
  } finally { f.close(); }
});

test('bind from another topic identifies the saved destination without moving either session', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(906, 102, '/bind thread-a'));
    await f.drain();
    assert.match(f.telegram.sent().map(messageBody).at(-1)!, /saved binding to topic #101/u);
    assert.equal(f.state.binding('thread-a')?.topicId, 101);
    assert.equal(f.state.binding('thread-b')?.topicId, 102);
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('repair distinguishes a loaded session with an attachment failure from an unloaded session', async () => {
  const f = await fixture();
  try {
    const sessions = f.codex.sessions;
    f.codex.sessions = sessions.filter(s => s.id !== 'thread-a');
    await f.bridge.discover();
    f.codex.sessions = sessions;
    const attach = f.codex.attach.bind(f.codex);
    f.codex.attach = async id => { if (id === 'thread-a') throw new Error('Synthetic attach failure'); return attach(id); };
    await f.bridge.update(message(907, 101, '/repair thread-a'));
    await f.drain();
    assert.match(f.telegram.sent().map(messageBody).at(-1)!, /loaded but relay attachment has not succeeded/u);
    assert.equal(f.state.binding('thread-a')?.topicId, 101);
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('sessions reports both saved topic numbers and actual relay attachment', async () => {
  const f = await fixture();
  try {
    f.codex.sessions = f.codex.sessions.filter(s => s.id !== 'thread-a');
    await f.bridge.discover();
    await f.bridge.update(message(908, 101, '/sessions'));
    await f.drain();
    const reply = f.telegram.sent().map(messageBody).at(-1)!;
    assert.match(reply, /Saved topic: #101 \(not attached; saved binding only\)/u);
    assert.match(reply, /Saved topic: #102 \(connected\)/u);
  } finally { f.close(); }
});

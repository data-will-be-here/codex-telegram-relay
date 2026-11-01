import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Topics } from '../src/topics.js';
import { State } from '../src/state.js';
import { TelegramError } from '../src/telegram.js';
import { temporary, FakeTelegram } from './helpers.js';

function setup() {
  const temp = temporary(); const state = new State(join(temp.dir, 'state')); const telegram = new FakeTelegram();
  const config = { version: 1 as const, ownerId: 42, roots: [temp.dir], codexBinary: process.execPath };
  return { temp, state, telegram, config, topics: new Topics(config, state, telegram), close: () => { state.close(); temp.close(); } };
}

test('a definite creation rejection waits for explicit retry and never stops other sessions', async () => {
  const f = setup();
  try {
    const call = f.telegram.call.bind(f.telegram); let fail = true;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'createForumTopic' && fail) { fail = false; f.telegram.calls.push({ method, params }); throw new TelegramError('Bad Request: synthetic permission error', 400); }
      return call(method, params);
    };
    const session = { id: 'thread-a', cwd: f.temp.dir };
    assert.equal(await f.topics.ensure(session), undefined);
    assert.equal(f.state.topicOperation(session.id)?.status, 'failed');
    await f.topics.ensure(session);
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 1);
    assert.ok(await f.topics.ensure({ id: 'thread-b', cwd: f.temp.dir }));
    assert.ok(await f.topics.retry('thread-a'));
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 3);
    await assert.rejects(f.topics.retry('thread-a'), /healthy topic/u);
    assert.equal(f.telegram.calls.filter(c => c.method === 'createForumTopic').length, 3);
  } finally { f.close(); }
});

test('rate-limited topic creation waits until retry_after rather than retrying each discovery', async () => {
  const f = setup();
  try {
    f.telegram.call = async () => { throw new TelegramError('Too Many Requests', 429, 60); };
    await f.topics.ensure({ id: 'thread-a', cwd: f.temp.dir });
    assert.equal(f.state.topicOperation('thread-a')?.status, 'retry');
    let attempts = 0;
    f.telegram.call = async () => { attempts++; return { message_thread_id: 101 }; };
    assert.equal(await f.topics.ensure({ id: 'thread-a', cwd: f.temp.dir }), undefined);
    assert.equal(attempts, 0);
    assert.ok(await f.topics.retry('thread-a'));
    assert.equal(attempts, 1);
  } finally { f.close(); }
});

test('topic repair cannot hijack another session, bypass roots, unignore a session or race in-flight creation', () => {
  const f = setup();
  try {
    f.state.bind('thread-b', 102, f.temp.dir, 'B');
    f.state.beginTopic('thread-a', f.temp.dir, 'A');
    assert.throws(() => f.topics.bind('thread-a', 103), /in progress/u);
    const attempt = f.state.topicOperation('thread-a')!;
    f.state.topicResult('thread-a', attempt.attempt, 'uncertain');
    assert.throws(() => f.topics.bind('thread-a', 102), /another session/u);
    const ignored = new Topics({ ...f.config, ignoredThreadIds: ['thread-a'] }, f.state, f.telegram);
    assert.throws(() => ignored.bind('thread-a', 103), /ignored/u);
    const outside = new Topics({ ...f.config, roots: [join(f.temp.dir, 'missing')] }, f.state, f.telegram);
    assert.throws(() => outside.bind('thread-a', 103), /outside/u);
    assert.equal(f.topics.bind('thread-a', 103).topicId, 103);
    assert.equal(f.state.binding('thread-b')?.topicId, 102);
  } finally { f.close(); }
});

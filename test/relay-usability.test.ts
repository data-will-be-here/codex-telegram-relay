import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, click, messageBody } from './helpers.js';
import { array, object, string } from '../src/types.js';
import { TelegramError } from '../src/telegram.js';
import { State } from '../src/state.js';
import { temporary } from './helpers.js';
import { join } from 'node:path';

test('/say is removed; /questions restores actionable question cards that can be answered', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(1, 101, '/say Separate instruction'));
    assert.equal(f.codex.writes.length, 0, 'Removed commands must not become native instructions');
    f.codex.pending.add('question');
    await f.bridge.request({ id: 'question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-a', turnId: 'turn', questions: [{ id: 'q', question: 'Choose?', options: [{ label: 'Yes' }] }],
    } });
    await f.drain();
    await f.bridge.update(message(2, 101, '/questions')); await f.drain();
    const cards = f.telegram.sent().filter(m => messageBody(m).includes('Choose?'));
    assert.equal(cards.length, 2);
    const choice = object(array(array(object(cards[1]!.reply_markup).inline_keyboard)[0])[0]);
    await f.bridge.update(click(3, string(choice.callback_data)));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'question', result: { answers: { q: { answers: ['Yes'] } } } } }]);
  } finally { f.close(); }
});

test('rich answers and live previews use the same task identity captured before a rename', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.name = 'Native title'; await f.bridge.discover();
    f.state.enqueue('assistant/rich-task', 101, '# Answer\n\n| Item | Value |\n| --- | --- |\n| A | B |');
    f.bridge.streamEvent('item/started', { threadId: 'thread-a', turnId: 'turn', item: { type: 'agentMessage', id: 'preview', phase: 'final_answer', text: '' } });
    f.bridge.streamEvent('item/agentMessage/delta', { threadId: 'thread-a', turnId: 'turn', itemId: 'preview', delta: 'Preview answer' });
    await f.bridge.notification('thread/name/updated', { threadId: 'thread-a', threadName: 'New title' });
    await f.drain(); await f.bridge.flushDraft();
    for (const method of ['sendRichMessage', 'sendRichMessageDraft']) {
      const call = f.telegram.calls.find(call => call.method === method);
      assert.ok(call, method);
      assert.ok(JSON.stringify(call.params.rich_message).includes('» project-a • Native title'));
    }
  } finally { f.close(); }
});

test('queued task labels survive reopening SQLite and later renaming', () => {
  const temp = temporary(); let state = new State(join(temp.dir, 'state'));
  try {
    state.bind('session-id', 100, temp.dir, 'Topic'); state.sessionName('session-id', 'Original task');
    state.enqueue('assistant/saved', 100, 'Queued answer'); state.close();
    state = new State(join(temp.dir, 'state')); state.sessionName('session-id', 'Renamed task');
    assert.equal(state.next()?.sessionName, 'Original task');
  } finally { state.close(); temp.close(); }
});

test('a native rename received during discovery cannot be overwritten by its older snapshot', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    f.codex.sessions[0]!.name = 'Old name'; await f.bridge.discover();
    const list = f.codex.list.bind(f.codex); let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.codex.list = async eligible => { const snapshot = (await list(eligible)).map(s => ({ ...s })); started(); await held; return snapshot; };
    const discovering = f.bridge.discover(); await waiting;
    await f.bridge.notification('thread/name/updated', { threadId: 'thread-a', threadName: 'New name' });
    release(); await discovering;
    f.state.enqueue('assistant/after-race', 101, 'Answer'); await f.drain();
    assert.ok(string(f.telegram.sent().at(-1)!.text).startsWith('» project-a • New name\n\n'));
  } finally { release?.(); f.close(); }
});

test('/questions does not repost a question resolved during a live eligibility read', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    f.codex.pending.add('question');
    await f.bridge.request({ id: 'question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-a', questions: [{ id: 'q', question: 'Race question?', options: [{ label: 'Yes' }] }],
    } }); await f.drain();
    const read = f.codex.read.bind(f.codex); let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.codex.read = async id => { started(); await held; return read(id); };
    const restoring = f.bridge.update(message(1, 101, '/questions')); await waiting;
    f.codex.pending.delete('question');
    await f.bridge.notification('serverRequest/resolved', { threadId: 'thread-a', requestId: 'question' });
    release(); await restoring; await f.drain();
    assert.equal(f.telegram.sent().filter(m => messageBody(m).includes('Race question?')).length, 1);
  } finally { release?.(); f.close(); }
});

for (const changed of ['moved', 'unloaded']) test(`ID-free bind revalidates a session that ${changed} after the recovery click`, async () => {
  const f = await fixture();
  try {
    f.codex.sessions.push({ id: 'thread-new', cwd: f.projectA, name: '', status: 'idle' });
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params) => { if (method === 'createForumTopic') throw new TelegramError('Lost acknowledgement', 0); return call(method, params); };
    await f.bridge.discover(); await f.drain();
    const rows = array(object(f.telegram.sent().at(-1)!.reply_markup).inline_keyboard).flatMap(r => array(r).map(object));
    const update = click(1, string(rows[0]!.callback_data)); delete object(object(update.callback_query).message).message_thread_id;
    await f.bridge.update(update);
    if (changed === 'moved') f.codex.sessions.at(-1)!.cwd = f.dir;
    else f.codex.sessions = f.codex.sessions.filter(s => s.id !== 'thread-new');
    await f.bridge.update(message(2, 777, '/bind'));
    assert.equal(f.state.binding('thread-new'), undefined);
  } finally { f.close(); }
});

for (const action of ['bind', 'repair']) test(`topic recovery ${action} buttons avoid manual session IDs and repeated creation`, async () => {
  const f = await fixture();
  try {
    f.codex.sessions.push({ id: 'thread-new', cwd: f.projectA, name: 'New task', status: 'idle' });
    const call = f.telegram.call.bind(f.telegram); let creates = 0;
    f.telegram.call = async (method, params) => {
      if (method === 'createForumTopic' && ++creates === 1) throw new TelegramError('Synthetic lost creation acknowledgement', 0);
      return call(method, params);
    };
    await f.bridge.discover(); await f.drain();
    const problem = f.telegram.sent().find(m => messageBody(m).includes('Automatic creation is paused'))!;
    assert.ok(problem);
    const rows = array(object(problem.reply_markup).inline_keyboard).flatMap(r => array(r).map(object));
    const button = rows.find(b => string(b.text).includes(action === 'bind' ? 'появился — привязать' : 'не появился'))!;
    assert.ok(button, 'The recovery notice needs actionable buttons');
    const data = string(button.callback_data);
    const update = click(1, data); object(object(update.callback_query).message).message_thread_id = undefined;
    await f.bridge.update(update);
    if (action === 'bind') await f.bridge.update(message(2, 777, '/bind'));
    await f.bridge.update({ ...update, update_id: 3 });
    assert.equal(f.state.binding('thread-new')?.topicId, action === 'bind' ? 777 : 103);
    assert.equal(creates, action === 'bind' ? 1 : 2);
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('answers retain their native task name when queued, even if the session is renamed before delivery', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.name = 'Тестовая задача'; await f.bridge.discover();
    f.state.enqueue('assistant/task-one', 101, 'first '.repeat(1500));
    f.codex.sessions[0]!.name = 'Следующая задача'; await f.bridge.discover();
    f.state.enqueue('assistant/task-two', 101, 'Second answer');
    await f.drain();
    const first = f.telegram.sent().filter(m => string(m.text).includes('first'));
    assert.ok(first.length > 1);
    assert.ok(first.every(m => string(m.text).startsWith('» project-a • Тестовая задача\n\n')));
    assert.ok(string(f.telegram.sent().at(-1)!.text).startsWith('» project-a • Следующая задача\n\n'));
  } finally { f.close(); }
});

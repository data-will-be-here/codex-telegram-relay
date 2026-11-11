import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Widgets } from '../src/widgets.js';
import { taskTitle } from '../src/tasks.js';
import { displayName, object, string, type Json } from '../src/types.js';
import { widgetData } from '../src/widget-template.js';
import { RpcError } from '../src/codex.js';
import { fixture, message, temporary } from './helpers.js';

const user = (text: string): Json => ({ type: 'userMessage', id: 'input', content: [{ type: 'text', text, text_elements: [] }] });

test('task excerpts use the first user request, retain Unicode, strip Markdown and bound the heading', () => {
  assert.equal(taskTitle([user('**Check the queue**\n\nDetails below'), user('Later steering')]), 'Check the queue');
  const title = taskTitle([user('🧪 Проверка '.repeat(100))])!;
  assert.ok(Array.from(title).length <= 80); assert.ok(title.endsWith('…')); assert.doesNotMatch(title, /\ufffd/u);
  assert.equal(taskTitle([user('Safe\u202e title\u0000')]), 'Safe title');
  assert.equal(taskTitle([{ type: 'userMessage', content: [{ type: 'localImage', path: '/private/image.png' }] }]), 'Review attachment');
  assert.equal(taskTitle([{ type: 'agentMessage', text: 'Not a user task' }]), undefined);
});

test('terminal user events update each turn while session names and previous cards remain independent', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.state.sessionName('thread-a', 'Original session name');
    const start = (id: string, text: string): void => {
      f.bridge.streamEvent('turn/started', { threadId: 'thread-a', turn: { id, status: 'inProgress' } });
      f.bridge.streamEvent('item/started', { threadId: 'thread-a', turnId: id, item: user(text) });
    };
    start('first', 'Check the queue');
    assert.equal(f.state.binding('thread-a')!.sessionName, 'Original session name');
    assert.equal(f.state.binding('thread-a')!.taskName, 'Check the queue');
    assert.equal(JSON.parse(widgetData(f.state.widgetCard('thread-a', 'first')!)).t, 'Check the queue');
    await f.bridge.notification('thread/name/updated', { threadId: 'thread-a', threadName: 'Renamed session' });
    f.bridge.streamEvent('item/completed', { threadId: 'thread-a', turnId: 'first', item: user('Only a clarification') });
    assert.equal(displayName(f.state.binding('thread-a')!), 'Check the queue');
    start('second', 'Fix the reader');
    assert.equal(displayName(f.state.binding('thread-a')!), 'Fix the reader');
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'first', status: 'completed',
      items: [user('Check the queue'), { type: 'agentMessage', phase: 'final_answer', text: 'First result.' }] } });
    assert.equal(displayName(f.state.binding('thread-a')!), 'Fix the reader', 'late completion cannot replace the current task');
    assert.equal(f.state.widgetCard('thread-a', 'first')!.binding.taskName, 'Check the queue');
    await f.drain();
    const result = f.telegram.calls.find(call => call.method === 'sendWidget' && string(call.params.html).includes('First result.'))!;
    assert.equal(result.params.caption, 'Answer ready · project-a');
    assert.ok(string(result.params.html).includes('project-a • Check the queue'));
    const token = f.state.widgetCards('thread-a').find(card => card.turnId === 'first')!.token;
    // The reader uses a separate answer token, not the Working-card capability.
    const control = string(object((object(result.params.reply_markup).inline_keyboard as Json[][])[0]![0]).callback_data);
    const cached = f.state.widgetAnswer(control.slice(2))!;
    assert.notEqual(token, control.slice(2));
    await f.bridge.update({ update_id: 20, callback_query: { id: 'read-old', from: { id: 42 }, data: control,
      message: { message_id: cached.messageId, chat: { id: 42, type: 'private' }, message_thread_id: 101 } } });
    await f.drain();
    assert.ok(f.telegram.sent().some(message => string(message.text).startsWith('» project-a • Check the queue\n\n')));
    assert.deepEqual(f.codex.writes, [], 'presentation must not rename the native session or send instructions');
  } finally { f.close(); }
});

test('a delayed Telegram acknowledgement cannot replace a newer native task', async () => {
  const f = await fixture(); let release!: (value: unknown) => void;
  try {
    let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
    f.codex.start = async () => { started(); return new Promise(resolve => { release = resolve; }); };
    const sending = f.bridge.update(message(1, 101, 'Older submitted task')); await waiting;
    f.bridge.streamEvent('turn/started', { threadId: 'thread-a', turn: { id: 'newer' } });
    f.bridge.streamEvent('item/started', { threadId: 'thread-a', turnId: 'newer', item: user('New native task') });
    release({ turn: { id: 'older' } }); await sending;
    assert.equal(displayName(f.state.binding('thread-a')!), 'New native task');
    assert.equal(displayName(f.state.turnBinding(f.state.binding('thread-a')!, 'older')), 'Older submitted task');
  } finally { release?.({}); f.close(); }
});

test('a rejected instruction does not change the current task', async () => {
  const f = await fixture();
  try {
    f.state.rememberTask('thread-a', 'existing', 'Existing task', true);
    f.codex.start = async () => { throw new RpcError('Rejected by native session', false); };
    await f.bridge.update(message(1, 101, 'Rejected task'));
    assert.equal(displayName(f.state.binding('thread-a')!), 'Existing task');
  } finally { f.close(); }
});

test('confirmed Telegram turns set a task even before native user events; steering keeps its original heading', async () => {
  const f = await fixture();
  try {
    f.codex.start = async () => ({ turn: { id: 'accepted' } });
    await f.bridge.update(message(1, 101, 'Investigate delivery'));
    assert.equal(displayName(f.state.binding('thread-a')!), 'Investigate delivery');
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'accepted', status: 'inProgress', items: [user('Investigate delivery')] }]);
    await f.bridge.update(message(2, 101, 'Check one more detail'));
    assert.equal(displayName(f.state.binding('thread-a')!), 'Investigate delivery');
  } finally { f.close(); }
});

test('per-turn labels survive reopening and queued classic answers retain their own task', () => {
  const temp = temporary(); let state = new State(join(temp.dir, 'private'));
  try {
    state.bind('thread', 101, temp.dir, 'Topic'); state.sessionName('thread', 'Session');
    state.rememberTask('thread', 'first', 'First task', true);
    state.enqueue('final/thread/first', 101, 'Saved answer'); state.close();
    state = new State(join(temp.dir, 'private'));
    state.rememberTask('thread', 'second', 'Second task', true);
    state.rememberTask('thread', 'first', 'Replayed label', true);
    assert.equal(displayName(state.binding('thread')!), 'Second task');
    assert.equal(state.next()!.sessionName, 'First task');
    assert.equal(displayName(state.turnBinding(state.binding('thread')!, 'first')), 'First task');
  } finally { state.close(); temp.close(); }
});

test('recovery uses the first user item of a running turn and does not adopt an older recovered task', () => {
  const temp = temporary(); const state = new State(join(temp.dir, 'private'));
  try {
    state.bind('thread', 101, temp.dir, 'Topic'); state.sessionName('thread', 'Session'); state.setViewMode('widgets');
    const widgets = new Widgets(state, 'new-generation'); const original = state.binding('thread')!;
    const turns = [{ id: 'running', status: 'inProgress', items: [user('Recovered task'), user('Steering')] }];
    widgets.recover(original, turns);
    assert.equal(state.widgetCard('thread', 'running')!.binding.taskName, 'Recovered task');
    state.rememberTask('thread', 'newer', 'Newer task', true);
    widgets.recover(original, [{ id: 'old', status: 'inProgress', items: [user('Old task')] }]);
    assert.equal(displayName(state.binding('thread')!), 'Newer task');
    assert.equal(object(state.widgetCard('thread', 'running')!.binding).taskName, 'Recovered task');
  } finally { state.close(); temp.close(); }
});

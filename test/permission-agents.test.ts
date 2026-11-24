import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { array, object, string, type Json } from '../src/types.js';
import { click, fixture, message } from './helpers.js';

async function setup() {
  const f = await fixture(); f.state.setViewMode('classic');
  const children = new Map<string, Json>();
  for (const [id, parent] of [['child-a', 'thread-a'], ['nested-a', 'child-a'], ['other-child', 'thread-b']]) {
    children.set(id!, { id, cwd: f.projectA, source: { subAgent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id}` } } },
      parentThreadId: parent, canAcceptDirectInput: false, ephemeral: false, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    const snapshot = await f.codex.permissionCatalog(id!, f.projectA);
    snapshot.settings.activePermissionProfile = { id: ':read-only' }; snapshot.settings.sandboxPolicy = { type: 'readOnly' };
    f.codex.permissionStates.set(id!, snapshot.settings);
  }
  const read = f.codex.read.bind(f.codex);
  f.codex.read = async id => children.get(id) ?? { ...await read(id), source: 'cli', canAcceptDirectInput: true };
  f.codex.loaded = async () => [...f.codex.sessions.map(s => s.id), ...children.keys()];
  let update = 800;
  const buttons = (markup: unknown): Json[] => array(object(markup).inline_keyboard).flatMap(row => array(row).map(object));
  const edited = () => f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params;
  const press = async (text: string, markup?: unknown, owner = 42) => {
    const button = buttons(markup ?? edited().reply_markup).find(b => string(b.text).includes(text)); assert.ok(button, text);
    const input = click(++update, string(button.callback_data), 101, owner);
    object(object(input.callback_query).message).message_id = f.telegram.message;
    await f.bridge.update(input); return input;
  };
  const open = async () => { await f.bridge.update(message(++update, 101, '/permissions')); await f.drain(); return f.telegram.calls.filter(call => ['sendMessage', 'sendWidget'].includes(call.method)).at(-1)!.params; };
  const confirm = async () => { const menu = await open(); await press('Replace existing agents', menu.reply_markup); await press('Pause and request replacement'); };
  return { ...f, children, open, press, edited, confirm };
}

test('permissions show verified descendant settings; selecting a mode updates only the root and retains one replacement control', async () => {
  const f = await setup();
  try {
    const menu = await f.open();
    assert.match(string(menu.text), /Existing agents \(2\)/u); assert.match(string(menu.text), /Read Only/u);
    assert.doesNotMatch(string(menu.text), /other-child/u); assert.equal(f.codex.writes.length, 0);
    await f.press('Approve for me', menu.reply_markup);
    assert.deepEqual(f.codex.writes.map(w => w.params.threadId), ['thread-a']);
    assert.match(string(f.edited().text), /Selected: Approve for me/u);
    assert.match(string(f.edited().text), /pending approvals/u);
    assert.equal(f.codex.permissionState('child-a')!.approvalsReviewer, 'user');
    await f.press('Replace existing agents');
    assert.match(string(f.edited().text), /NEW root turn/u);
    assert.equal(f.state.agentRestarts().length, 0, 'opening confirmation cannot queue or interrupt work');
    await f.press('Cancel'); await f.bridge.workPermissionRestart();
    assert.equal(f.codex.writes.length, 1);
  } finally { f.close(); }
});

test('a confirmed idle-root replacement sends one new root instruction, preserving child approvals and ignoring duplicate or foreign clicks', async () => {
  const f = await setup();
  try {
    f.codex.pending.add('child-review');
    f.state.rememberTask('thread-a', 'original-task', 'Build MVP', true);
    const start = f.codex.start.bind(f.codex);
    f.codex.start = async (...args) => { await start(...args); return { turn: { id: 'replacement-turn' } }; };
    const menu = await f.open(); await f.press('Replace existing agents', menu.reply_markup);
    const confirmation = f.edited().reply_markup;
    await f.press('Pause and request replacement', confirmation, 99);
    assert.equal(f.state.agentRestarts().length, 0);
    const replay = await f.press('Pause and request replacement', confirmation);
    await f.bridge.update({ ...replay, update_id: 999 });
    assert.equal(f.state.agentRestarts().length, 1); assert.equal(f.codex.writes.length, 0);
    await f.bridge.workPermissionRestart(); await f.bridge.workPermissionRestart();
    const writes = f.codex.writes;
    assert.equal(writes.length, 1); assert.equal(writes[0]!.method, 'start'); assert.equal(writes[0]!.params.threadId, 'thread-a');
    assert.match(string(writes[0]!.params.text), /preserving all files/u);
    assert.match(string(writes[0]!.params.text), /text-only handoff summary/u);
    assert.match(string(writes[0]!.params.text), /child-a/u); assert.doesNotMatch(string(writes[0]!.params.text), /other-child/u);
    assert.equal(f.codex.pending.has('child-review'), true); assert.equal(f.state.agentRestarts().length, 0);
    assert.equal(f.state.binding('thread-a')!.taskName, 'Build MVP');
  } finally { f.close(); }
});

test('replacement pauses exactly the confirmed active root turn and waits for idle before starting a new turn', async () => {
  const f = await setup();
  try {
    f.codex.sessions[0]!.status = 'active'; f.codex.histories.set('thread-a', [{ id: 'old-turn', status: 'inProgress', items: [] }]);
    f.codex.interrupt = async (threadId, turnId) => { f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {}; };
    await f.confirm(); await f.bridge.workPermissionRestart();
    assert.deepEqual(f.codex.writes, [{ method: 'interrupt', params: { threadId: 'thread-a', turnId: 'old-turn' } }]);
    const job = f.state.agentRestarts()[0]!; f.state.changeAgentRestart(job, { retryAt: 0 });
    await f.bridge.workPermissionRestart(); assert.equal(f.codex.writes.length, 1, 'an acknowledged interrupt does not prove idle');
    f.codex.sessions[0]!.status = 'idle'; f.codex.histories.set('thread-a', [{ id: 'old-turn', status: 'interrupted', items: [] }]);
    f.state.changeAgentRestart(f.state.agentRestarts()[0]!, { retryAt: 0 }); await f.bridge.workPermissionRestart();
    assert.deepEqual(f.codex.writes.map(w => w.method), ['interrupt', 'start']);
  } finally { f.close(); }
});

test('a changed root turn or revoked agent ancestry cannot be interrupted by an old replacement confirmation', async () => {
  for (const change of ['turn', 'ancestry']) {
    const f = await setup();
    try {
      await f.confirm();
      if (change === 'turn') { f.codex.sessions[0]!.status = 'active'; f.codex.histories.set('thread-a', [{ id: 'new-task', status: 'inProgress' }]); }
      else f.children.clear();
      await f.bridge.workPermissionRestart();
      assert.equal(f.codex.writes.length, 0); assert.equal(f.state.agentRestarts().length, 0);
    } finally { f.close(); }
  }
});

test('an uncertain replacement start is not replayed after reconnect and reconciles only an exact user-message marker', async () => {
  const f = await setup();
  try {
    f.codex.start = async (threadId, text) => { f.codex.writes.push({ method: 'start', params: { threadId, text } }); throw new RpcError('Lost response', true); };
    await f.confirm(); await f.bridge.workPermissionRestart();
    assert.equal(f.state.agentRestarts()[0]!.status, 'uncertain');
    f.bridge.close();
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    try {
      await bridge.discover();
      f.state.changeAgentRestart(f.state.agentRestarts()[0]!, { retryAt: 0 }); await bridge.workPermissionRestart();
      assert.equal(f.codex.writes.filter(w => w.method === 'start').length, 1);
      const text = string(f.codex.writes.find(w => w.method === 'start')!.params.text);
      f.codex.histories.set('thread-a', [{ id: 'agent-output', status: 'completed', items: [{ type: 'agentMessage', content: [{ type: 'text', text }] }] }]);
      f.state.changeAgentRestart(f.state.agentRestarts()[0]!, { retryAt: 0 }); await bridge.workPermissionRestart();
      assert.equal(f.state.agentRestarts()[0]!.status, 'uncertain', 'Agent output cannot prove receipt of the owner instruction');
      f.codex.histories.set('thread-a', [{ id: 'received', status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] }]);
      f.state.changeAgentRestart(f.state.agentRestarts()[0]!, { retryAt: 0 }); await bridge.workPermissionRestart();
      assert.equal(f.state.agentRestarts().length, 0); assert.equal(f.codex.writes.filter(w => w.method === 'start').length, 1);
    } finally { bridge.close(); }
  } finally { f.close(); }
});

test('root settings changed during agent inspection prevent interruption and replacement', async () => {
  const f = await setup();
  try {
    f.codex.sessions[0]!.status = 'active'; f.codex.histories.set('thread-a', [{ id: 'original', status: 'inProgress' }]);
    f.codex.interrupt = async () => { throw new Error('must not interrupt'); };
    await f.confirm();
    const loaded = f.codex.loaded!;
    f.codex.loaded = async () => { f.codex.permissionStates.get('thread-a')!.approvalsReviewer = 'auto_review'; return loaded(); };
    await f.bridge.workPermissionRestart(); assert.equal(f.codex.writes.length, 0);
    assert.equal(f.state.agentRestarts().length, 0);
  } finally { f.close(); }
});

test('permissions changed while completed replies are caught up cancel the final replacement dispatch', async () => {
  const f = await setup();
  try {
    let changed = false;
    const completed: Json = { id: 'new-completion', status: 'completed' };
    // Consuming completed native history races with a settings notification from another client.
    Object.defineProperty(completed, 'items', { enumerable: true, get: () => {
      changed = true; f.codex.permissionStates.get('thread-a')!.approvalsReviewer = 'auto_review';
      return [{ type: 'agentMessage', text: 'Completed result' }];
    } });
    f.codex.histories.set('thread-a', [completed]);
    await f.confirm(); await f.bridge.workPermissionRestart();
    assert.equal(changed, true); assert.equal(f.codex.writes.length, 0);
    assert.equal(f.state.agentRestarts().length, 0); assert.match(string(f.edited().text), /permissions changed before dispatch/u);
  } finally { f.close(); }
});

test('a status delivery failure cannot reclassify an acknowledged replacement start or replay it', async () => {
  const f = await setup();
  try {
    await f.confirm(); const start = f.codex.start.bind(f.codex);
    f.codex.start = async (...args) => { const result = await start(...args); f.codex.read = async () => { throw new RpcError('Disconnected', true); }; return result; };
    await f.bridge.workPermissionRestart(); await f.bridge.workPermissionRestart();
    assert.equal(f.state.agentRestarts().length, 0); assert.equal(f.codex.writes.filter(w => w.method === 'start').length, 1);
  } finally { f.close(); }
});

test('clearing an uncertain request requires a separate owner confirmation and sends no native action', async () => {
  const f = await setup();
  try {
    f.codex.start = async () => { throw new RpcError('Uncertain', true); };
    await f.confirm(); await f.bridge.workPermissionRestart();
    const menu = await f.open(); await f.press('Clear uncertain request', menu.reply_markup);
    assert.equal(f.state.agentRestarts()[0]!.status, 'uncertain');
    await f.press('Checked history — clear record');
    assert.equal(f.state.agentRestarts().length, 0); assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('widget-to-text replacement keeps permissions actions bound to the new delivered message', async () => {
  const f = await setup();
  try {
    f.state.setViewMode('widgets');
    for (const id of ['third-a', 'fourth-a']) {
      f.children.set(id, { ...f.children.get('child-a')!, id });
      f.codex.permissionStates.set(id, structuredClone(f.codex.permissionStates.get('child-a')!));
    }
    for (const id of ['child-a', 'nested-a', 'third-a', 'fourth-a']) {
      const child = f.children.get(id)!;
      object(object(object(child.source).subAgent).thread_spawn).agent_path = '/root/' + id + '_'.repeat(70);
    }
    const menu = await f.open();
    assert.ok(f.telegram.calls.some(call => call.method === 'sendWidget'), 'the original menu should fit in a widget');
    await f.press('Approve for me', menu.reply_markup); await f.drain();
    const replacement = f.telegram.sent().at(-1)!;
    assert.ok(replacement, 'the updated menu should be delivered as native text');
    assert.ok(string(replacement.text).includes('Selected: Approve for me'), 'the larger updated menu should use native text');
    await f.press('Replace existing agents', replacement.reply_markup);
    assert.match(string(f.edited().text), /Request replacement of 4 existing agents/u);
  } finally { f.close(); }
});

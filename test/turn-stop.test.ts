import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, fixture, message } from './helpers.js';
import { RpcError } from '../src/codex.js';
import { Bridge } from '../src/bridge.js';
import { array, object, string } from '../src/types.js';

// Exercise owner Telegram input and native completion, without invoking a real daemon.
test('/stop interrupts the exact active turn once while native approvals remain unanswered', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress', items: [] }]);
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {};
    } });
    f.codex.pending.add('pending-approval');
    await f.bridge.request({ id: 'pending-approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'active-turn', itemId: 'command', command: 'echo fixture', availableDecisions: ['accept', 'decline'],
    } });
    await f.drain(); f.telegram.calls.length = 0;
    await f.bridge.update(message(1, 101, '/stop'));
    await f.bridge.update(message(2, 101, '/stop'));
    assert.deepEqual(f.codex.writes, [{ method: 'interrupt', params: { threadId: 'thread-a', turnId: 'active-turn' } }]);
    assert.equal(f.codex.pending.has('pending-approval'), true);
    f.codex.sessions[0]!.status = 'idle';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'interrupted', items: [] }]);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'active-turn', status: 'interrupted', items: [] } });
    await f.drain();
    assert.equal(f.telegram.sent().filter(x => String(x.text).includes('Turn interrupted')).length, 1);
  } finally { f.close(); }
});

test('ordinary stop-agent text keeps steering semantics without extra waiting notices or approval cards', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress' }]);
    f.codex.pending.add('approval');
    await f.bridge.request({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'active-turn', itemId: 'command', command: 'echo fixture', availableDecisions: ['accept', 'decline'],
    } });
    await f.drain(); f.telegram.calls.length = 0;
    await f.bridge.update(message(1, 101, 'стоп агенту'));
    await f.drain();
    assert.deepEqual(f.codex.writes, [{ method: 'steer', params: { threadId: 'thread-a', turnId: 'active-turn', text: 'стоп агенту' } }]);
    assert.equal(f.telegram.sent().length, 0);
    assert.equal(f.codex.pending.has('approval'), true);
  } finally { f.close(); }
});

test('concurrent /stop requests send once and a completion before acknowledgement remains completed', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress', items: [] }]);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); entered(); await held; return {};
    } });
    const first = f.bridge.update(message(1, 101, '/stop')); await started;
    await f.bridge.update(message(2, 101, '/stop'));
    f.codex.sessions[0]!.status = 'idle';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'interrupted', items: [] }]);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'active-turn', status: 'interrupted', items: [] } });
    release(); await first;
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.state.turnStop('thread-a', 'active-turn')?.status, 'completed');
  } finally { f.close(); }
});

test('/stop rejects invalid targets and arguments without native mutation', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress' }]);
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {};
    } });
    await f.bridge.update(message(1, 101, '/stop', 99));
    const root = message(2, 101, '/stop'); delete object(root.message).message_thread_id; await f.bridge.update(root);
    await f.bridge.update(message(3, 999, '/stop'));
    await f.bridge.update(message(4, 101, '/stop extra'));
    for (const [index, status] of ['idle', 'notLoaded', 'systemError'].entries()) {
      f.codex.sessions[0]!.status = status; await f.bridge.update(message(5 + index, 101, '/stop'));
    }
    assert.deepEqual(f.codex.writes, []);
    assert.equal(f.state.pendingTurnStops().length, 0);
  } finally { f.close(); }
});

test('/stop aborts if its topic binding changes during the final history read', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active'; let reads = 0;
    f.codex.turns = async () => {
      if (++reads === 2) f.state.installTopic('thread-a', 999, f.projectA, 'Moved topic');
      return [{ id: 'active-turn', status: 'inProgress' }];
    };
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {};
    } });
    await f.bridge.update(message(1, 101, '/stop'));
    assert.deepEqual(f.codex.writes, []);
    assert.equal(f.state.pendingTurnStops().length, 0);
  } finally { f.close(); }
});

test('a definite interrupt rejection permits a later explicit retry; uncertain writes do not', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress' }]);
    let fail = true;
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } });
      if (fail) { fail = false; throw new RpcError('Rejected before stopping.', false); }
      return {};
    } });
    await f.bridge.update(message(1, 101, '/stop'));
    assert.equal(f.state.turnStop('thread-a', 'active-turn'), undefined);
    await f.bridge.update(message(2, 101, '/stop'));
    assert.equal(f.codex.writes.length, 2);
    assert.equal(f.state.turnStop('thread-a', 'active-turn')?.status, 'acknowledged');
  } finally { f.close(); }
});

test('a stopped turn closes native and host questions without answering them or capturing later text', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress', items: [] }]);
    Object.assign(f.codex, {
      interrupt: async (threadId: string, turnId: string) => { f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {}; },
      asyncQuestions: async (threadId: string) => threadId === 'thread-a' ? [{ callId: 'host-question', turnId: 'active-turn', questions: [{ title: 'Choose', options: ['A', 'B'] }] }] : [],
    });
    await f.bridge.discover();
    f.codex.pending.add('native-question');
    await f.bridge.request({ id: 'native-question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-a', turnId: 'active-turn', questions: [{ id: 'choice', header: 'Choose', question: 'Choose', options: [{ label: 'A', description: 'A' }] }],
    } });
    await f.drain();
    const stale = f.telegram.sent().flatMap(sent => array(object(sent.reply_markup).inline_keyboard).flatMap(row => array(row).map(object)))
      .map(button => string(button.callback_data)).find(data => data.startsWith('r:'));
    assert.ok(stale);
    await f.bridge.update(message(1, 101, '/stop'));
    f.codex.sessions[0]!.status = 'idle';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'interrupted', items: [] }]);
    await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'active-turn', status: 'interrupted', items: [] } });
    await f.bridge.discover();
    await f.bridge.update(click(2, stale));
    await f.bridge.update(message(3, 101, 'Continue with a new instruction'));
    assert.deepEqual(f.codex.writes.map(write => write.method), ['interrupt', 'start']);
    assert.equal(f.codex.pending.has('native-question'), true, 'Relay did not manufacture a native answer.');
  } finally { f.close(); }
});

test('a question callback acknowledged while stopping cannot answer after native completion wins the race', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress', items: [] }]);
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {};
    } });
    f.codex.pending.add('native-question');
    await f.bridge.request({ id: 'native-question', method: 'item/tool/requestUserInput', params: {
      threadId: 'thread-a', turnId: 'active-turn', questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }] }],
    } });
    await f.drain();
    const data = string(object(array(array(object(f.telegram.sent()[0]!.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.update(message(1, 101, '/stop'));
    const telegramCall = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'answerCallbackQuery') {
        f.codex.sessions[0]!.status = 'idle';
        f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'interrupted', items: [] }]);
        await f.bridge.notification('turn/completed', { threadId: 'thread-a', turn: { id: 'active-turn', status: 'interrupted', items: [] } });
      }
      return telegramCall(method, params);
    };
    await f.bridge.update(click(2, data));
    assert.deepEqual(f.codex.writes.map(write => write.method), ['interrupt']);
  } finally { f.close(); }
});

test('/stop refuses a different active turn observed during verification', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    let reads = 0;
    f.codex.turns = async () => [{ id: ++reads === 1 ? 'old-turn' : 'new-turn', status: 'inProgress' }];
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); return {};
    } });
    await f.bridge.update(message(1, 101, '/stop'));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('uncertain /stop survives reconnect without replay and recovers the terminal answer once', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'inProgress', items: [] }]);
    Object.assign(f.codex, { interrupt: async (threadId: string, turnId: string) => {
      f.codex.writes.push({ method: 'interrupt', params: { threadId, turnId } }); throw new RpcError('Native response lost.', true);
    } });
    await assert.rejects(f.bridge.update(message(1, 101, '/stop')), /response lost/u);
    f.bridge.close();
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await bridge.discover();
    await bridge.update(message(2, 101, '/stop'));
    assert.equal(f.codex.writes.length, 1);
    f.codex.sessions[0]!.status = 'idle';
    f.codex.histories.set('thread-a', [{ id: 'active-turn', status: 'interrupted', items: [] }]);
    await bridge.discover(); await bridge.discover(); await f.drain();
    assert.equal(f.codex.writes.length, 1);
    assert.equal(f.telegram.sent().filter(x => String(x.text).includes('Turn interrupted')).length, 1);
    assert.equal(f.state.turnStop('thread-a', 'active-turn')?.status, 'completed');
    bridge.close();
  } finally { f.close(); }
});

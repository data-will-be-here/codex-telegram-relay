import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { array, object, string, type Json } from '../src/types.js';
import { Screens } from '../src/screens.js';
import { TelegramError, Outbox } from '../src/telegram.js';
import { limitMeters } from '../src/limits.js';
import { RpcError } from '../src/codex.js';
import { fixture, message, click } from './helpers.js';

function payload(html: string): Json {
  const node = () => ({ textContent: '', style: {}, clientWidth: 0, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const nodes = new Map(); const context: Json = { document: { body: {}, createElement: node, getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } },
    TelegramWidget: { ready() {}, onEvent() {} }, ResizeObserver: class { observe() {} }, getComputedStyle: () => ({ fontSize: '20px' }) };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!, context);
  assert.equal(context.pwned, undefined); return object(context.D);
}
function buttons(value: unknown): Json[] { return array(object(value).inline_keyboard).flatMap(row => array(row).map(object)); }
function tap(id: number, button: Json, messageId: number, topic = 101): Json {
  const update = click(id, string(button.callback_data), topic);
  object(object(update.callback_query).message).message_id = messageId; return update;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const widgets = (f: Fixture) => f.telegram.calls.filter(call => call.method === 'sendWidget').map(call => call.params);
const keyboard = (f: Fixture) => f.telegram.calls.filter(call => ['editMessageReplyMarkup', 'editMessageCaption'].includes(call.method) && call.params.reply_markup).at(-1)!.params.reply_markup;

test('information and settings screens use themed widgets with useful captions without a native write', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets');
    f.codex.rateLimits = async () => ({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 } } });
    for (const [index, text] of ['/limits', '/status', '/sessions', '/mode', '/stream', '/view'].entries()) {
      await f.bridge.update(message(index + 1, 101, text)); await f.drain();
    }
    assert.equal(widgets(f).length, 6);
    for (const part of widgets(f)) {
      assert.equal(part.message_thread_id, 101, 'Every response must stay in the topic where its command was issued');
      assert.ok(string(part.caption).length > 0); assert.ok(string(part.caption).length <= 1024);
      assert.equal(part.allow_queries, false); assert.equal(part.is_shared, false);
      assert.ok(deflateSync(string(part.html), { level: 9 }).length <= 4000);
      assert.ok(Buffer.byteLength(string(part.html)) <= 32768);
      assert.ok(buttons(part.reply_markup).some(button => button.text === 'Text version'));
      assert.notEqual(payload(string(part.html)).status, 'Answer ready');
    }
    const limits = payload(string(widgets(f)[0]!.html));
    assert.equal(object(array(limits.meters)[0]).remaining, 75);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('text version revalidates its original topic binding after an awaited acknowledgement', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); const screens = new Screens(f.state, f.telegram, f.bridge.config);
    screens.enqueue('prompt/synthetic-review', 101, 'SYNTHETIC_PRIVATE_REVIEW', null, { kind: 'question', title: 'Review' }); await f.drain();
    const button = buttons(widgets(f)[0]!.reply_markup).find(b => b.text === 'Text version')!; const source = f.telegram.message;
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'answerCallbackQuery') {
        f.state.installTopic('thread-a', 505, f.projectA, 'Old project'); f.state.installTopic('thread-b', 101, f.projectB, 'New project');
      }
      return call(method, params);
    };
    await f.bridge.update(tap(1, button, source)); await f.drain();
    assert.equal(f.telegram.sent().some(part => string(part.text).includes('SYNTHETIC_PRIVATE_REVIEW')), false);
  } finally { f.close(); }
});

test('account screen text can be read in the root chat and cannot be read from a copied message', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); const update = message(1, 101, '/status'); delete object(update.message).message_thread_id;
    await f.bridge.update(update); await f.drain();
    const source = f.telegram.message; const textButton = buttons(widgets(f)[0]!.reply_markup).find(button => button.text === 'Text version')!;
    const invalid = tap(2, textButton, source + 10); delete object(object(invalid.callback_query).message).message_thread_id;
    await f.bridge.update(invalid); await f.drain(); assert.equal(f.telegram.sent().length, 0);
    const valid = tap(3, textButton, source); delete object(object(valid.callback_query).message).message_thread_id;
    await f.bridge.update(valid); await f.drain();
    assert.ok(f.telegram.sent().some(part => string(part.text).includes('Pending final answers')));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a long text version preserves the full body while notifying only for its first part', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); const screens = new Screens(f.state, f.telegram, f.bridge.config);
    const text = 'Complete synthetic body. '.repeat(300);
    screens.enqueue('prompt/synthetic-long-text', 101, text, null, { kind: 'info', title: 'Synthetic review' }); await f.drain();
    const read = buttons(widgets(f).at(-1)!.reply_markup).find(b => b.text === 'Text version')!;
    await f.bridge.update(tap(1, read, f.telegram.message)); await f.drain();
    assert.ok(f.telegram.sent().length > 1);
    assert.equal(f.telegram.sent().filter(part => part.disable_notification === false).length, 1);
    assert.ok(f.telegram.sent().slice(1).every(part => part.disable_notification === true));
    assert.equal(f.telegram.sent().map(part => string(part.text).split('\n\n').slice(1).join('\n\n')).join(''), text);
  } finally { f.close(); }
});

test('widget approval keeps exact native authority and offers the full command as text after closing', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review');
    const command = 'node -e "' + '/* synthetic code line */\n'.repeat(100) + 'console.log(1)"';
    await f.bridge.request({ id: 'review', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'turn', itemId: 'command', command, reason: 'Synthetic review reason', availableDecisions: ['accept', 'decline'] } });
    await f.drain();
    const part = widgets(f)[0]!; const id = f.telegram.message;
    assert.equal(part.reply_markup, undefined, 'Widget reviews stay passive until their receipt is confirmed');
    await f.bridge.flushApproval();
    assert.equal(payload(string(part.html)).status, 'Command approval');
    assert.equal(part.caption, 'Command approval · project-a', 'command and task belong in the body, not the caption');
    assert.ok(string(payload(string(part.html)).text).includes('Abbreviated preview'));
    const choices = buttons(keyboard(f)); const approve = choices.find(button => button.text === 'Allow once')!;
    const textButton = choices.find(button => button.text === 'Text version')!;
    await f.bridge.update(tap(1, approve, id)); await f.bridge.update(tap(2, approve, id));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'review', result: { decision: 'accept' } } }]);
    assert.ok(f.telegram.calls.some(call => call.method === 'editMessageWidgetData' && string(call.params.chat_data).includes('Review closed')));
    await f.bridge.update(tap(3, textButton, id)); await f.drain();
    assert.ok(f.telegram.sent().map(part => string(part.text)).join('').includes(command));
  } finally { f.close(); }
});

test('a rejected widget menu falls back to native text and later steps edit the actual text message', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.modelCatalog = [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => { if (method === 'sendWidget') throw new TelegramError('Widgets unsupported', 400); return call(method, params); };
    await f.bridge.update(message(1, 101, '/model')); await f.drain();
    const select = buttons(f.telegram.sent()[0]!.reply_markup).find(button => button.text === 'Synthetic')!;
    await f.bridge.update(tap(2, select, f.telegram.message));
    assert.ok(f.telegram.calls.some(call => call.method === 'editMessageText' && string(call.params.text).includes('Choose reasoning effort')));
    assert.equal(f.telegram.calls.some(call => call.method === 'editMessageWidgetData'), false);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('model and permission widget menus retain live choices, explicit selection and elevated-access confirmation', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.modelCatalog = [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }];
    await f.bridge.update(message(1, 101, '/model')); await f.drain();
    const id = f.telegram.message; await f.bridge.update(tap(2, buttons(widgets(f)[0]!.reply_markup).find(b => b.text === 'Synthetic')!, id));
    assert.ok(f.telegram.calls.some(call => call.method === 'editMessageWidgetData' && string(call.params.chat_data).includes('Choose reasoning effort')));
    await f.bridge.update(tap(3, buttons(keyboard(f)).find(b => b.text === 'High')!, id));
    assert.equal(f.codex.writes.filter(write => write.method === 'settings').length, 1);
    await f.bridge.update(message(4, 101, '/permissions')); await f.drain();
    const permissionsId = f.telegram.message;
    await f.bridge.update(tap(5, buttons(widgets(f).at(-1)!.reply_markup).find(b => b.text === 'Full Access')!, permissionsId));
    assert.equal(f.codex.writes.filter(write => write.method === 'permissions').length, 0);
    const warning = f.telegram.calls.filter(call => call.method === 'editMessageCaption').at(-1)!.params;
    assert.ok(string(warning.caption).includes('without approval prompts'), 'The entire warning must also be visible outside local pages and on unsupported clients');
    assert.ok(string(warning.caption).length <= 1024);
    await f.bridge.update(tap(6, buttons(keyboard(f)).find(b => b.text === 'Enable Full Access')!, permissionsId));
    assert.equal(f.codex.writes.filter(write => write.method === 'permissions').length, 1);
    assert.equal(f.codex.writes.some(write => ['start', 'steer'].includes(write.method)), false);
  } finally { f.close(); }
});

test('oversized menu changes preserve full native text and rotate the message key', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); const screens = new Screens(f.state, f.telegram, f.bridge.config);
    screens.enqueue('prompt/synthetic-menu', 101, 'Short initial screen', null, { kind: 'menu', title: 'Synthetic', editable: true }); await f.drain();
    const text = 'Synthetic extended context. '.repeat(100);
    const next = await screens.edit('prompt/synthetic-menu', 101, text, { inline_keyboard: [] }, { kind: 'menu', title: 'Extended review', editable: true });
    assert.notEqual(next, 'prompt/synthetic-menu'); await f.drain();
    assert.ok(f.telegram.sent().map(part => string(part.text)).join('').includes(text));
    assert.equal(f.state.screen(next)!.parts[0]!.method, 'sendMessage'); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a native menu continuation cannot adopt a topic rebound during old-control cleanup', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); const screens = new Screens(f.state, f.telegram, f.bridge.config);
    screens.enqueue('prompt/synthetic-edit-race', 101, 'Short screen', null, { kind: 'menu', title: 'Menu', editable: true }); await f.drain();
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'editMessageReplyMarkup') {
        f.state.installTopic('thread-a', 505, f.projectA, 'Old project'); f.state.installTopic('thread-b', 101, f.projectB, 'New project');
      }
      return call(method, params);
    };
    await assert.rejects(screens.edit('prompt/synthetic-edit-race', 101, 'PRIVATE_OLD_MENU '.repeat(100), { inline_keyboard: [] },
      { kind: 'menu', title: 'Menu', editable: true }), /destination changed/u);
    await f.drain(); assert.equal(f.telegram.sent().length, 0); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('unknown widget approval sends stay uncertain and require explicit recovery with fresh controls', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review');
    await f.bridge.request({ id: 'review', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'turn', command: 'echo synthetic', availableDecisions: ['accept', 'decline'] } });
    const old = buttons(f.state.next()!.markup).find(b => b.text === 'Allow once')!;
    const call = f.telegram.call.bind(f.telegram); let failed = false;
    f.telegram.call = async (method, params = {}) => { const result = await call(method, params);
      if (method === 'sendWidget' && !failed) { failed = true; throw new TelegramError('Lost widget acknowledgement', 0); } return result; };
    await assert.rejects(f.drain(), /Lost widget acknowledgement/u); assert.equal(widgets(f).length, 1);
    await f.bridge.flushApproval(); await f.drain();
    await f.bridge.update(message(1, 101, '/approvals')); await f.drain(); assert.equal(widgets(f).length, 2);
    await f.bridge.update(tap(2, old, 1001)); assert.deepEqual(f.codex.writes, []);
    await f.bridge.flushApproval();
    await f.bridge.update(tap(3, buttons(keyboard(f)).find(b => b.text === 'Allow once')!, f.telegram.message));
    assert.equal(f.codex.writes.length, 1);
  } finally { f.close(); }
});

test('a widget review cannot rearm an uncertain native decision', async () => {
  const f = await fixture(); let responses = 0;
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review');
    await f.bridge.request({ id: 'review', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'turn', command: 'echo synthetic', availableDecisions: ['accept', 'decline'] } }); await f.drain();
    await f.bridge.flushApproval();
    const id = f.telegram.message; const approve = buttons(keyboard(f)).find(b => b.text === 'Allow once')!;
    f.codex.respond = async () => { responses++; throw new RpcError('Unknown native outcome', true); };
    await assert.rejects(f.bridge.update(tap(1, approve, id)), /Unknown native outcome/u);
    await f.bridge.update(message(2, 101, '/approvals')); await f.bridge.update(tap(3, approve, id)); await f.drain();
    assert.equal(responses, 1); assert.equal(widgets(f).length, 1);
  } finally { f.close(); }
});

test('approval presentation uses the running turn view even after the global preference changes', async () => {
  for (const view of ['classic', 'widgets'] as const) {
    const f = await fixture();
    try {
      f.state.setViewMode(view);
      await f.bridge.notification('turn/started', { threadId: 'thread-a', turn: { id: 'turn', status: 'inProgress' } });
      f.state.setViewMode(view === 'classic' ? 'widgets' : 'classic'); f.codex.pending.add('review');
      await f.bridge.request({ id: 'review', method: 'item/commandExecution/requestApproval', params: {
        threadId: 'thread-a', turnId: 'turn', command: 'echo synthetic', availableDecisions: ['accept', 'decline'] } }); await f.drain();
      assert.equal(widgets(f).length, view === 'widgets' ? 1 : 0); assert.deepEqual(f.codex.writes, []);
    } finally { f.close(); }
  }
});

test('quota charts exclude unknown and invalid percentages even if a label contains a fake value', () => {
  assert.deepEqual(limitMeters({ rateLimits: { limitName: 'remaining 99%', primary: { usedPercent: -1 } } }), []);
  assert.deepEqual(limitMeters({ rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: 0 } } }).map(m => m.remaining), [100]);
});

test('long widget approvals keep decisions unavailable until every review part is confirmed', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('long-review');
    await f.bridge.request({ id: 'long-review', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'turn', command: 'echo synthetic', reason: 'Synthetic complete security review context. '.repeat(1000), availableDecisions: ['accept', 'decline'] } });
    const original = f.state.next()!; assert.ok(original.richPlan!.length > 1);
    const outbox = new Outbox(f.state, f.telegram, f.bridge.config, 0);
    await outbox.flushOne(); assert.equal(widgets(f)[0]!.reply_markup, undefined);
    assert.equal(await f.bridge.flushApproval(), false);
    await f.drain(); assert.ok(widgets(f).every(part => part.reply_markup === undefined));
    await f.bridge.flushApproval();
    assert.ok(buttons(keyboard(f)).some(button => button.text === 'Allow once'));
    assert.equal(f.state.approvalReceipt(original.key)!.status, 'sent'); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('/new keeps scratch first and renders its menu in Widgets without creating a session', async () => {
  const f = await fixture(); let creations = 0;
  try {
    f.state.setViewMode('widgets');
    Object.assign(f.codex, { createThread: async () => { creations++; return {}; }, setThreadName: async () => {}, nonArchivedThread: async () => ({}), findCreatedThread: async () => undefined });
    const update = message(1, 101, '/new'); delete object(update.message).message_thread_id;
    await f.bridge.update(update); await f.drain();
    const menu = widgets(f)[0]!; assert.ok(menu); assert.equal(payload(string(menu.html)).status, 'New conversation');
    assert.match(string(buttons(menu.reply_markup)[0]!.text), /No project/u); assert.equal(creations, 0);
  } finally { f.close(); }
});

test('a proven not-sent widget screen retries in three seconds without changing view or duplicating content', async () => {
  const f = await fixture(); const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    f.state.setViewMode('widgets'); await f.bridge.update(message(1, 101, '/status'));
    const call = f.telegram.call.bind(f.telegram); let failed = false;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendWidget' && !failed) { failed = true; throw new TelegramError('Before connect', 0, undefined, true); }
      return call(method, params);
    };
    const outbox = new Outbox(f.state, f.telegram, f.bridge.config, 0);
    await outbox.flushOne(); assert.equal(f.state.uncertainCount(), 0); assert.equal(await outbox.flushOne(), false);
    now += 3000; await f.drain(); assert.equal(widgets(f).length, 1); assert.equal(f.state.viewMode(), 'widgets');
  } finally { Date.now = realNow; f.close(); }
});

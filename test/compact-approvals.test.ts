import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { State } from '../src/state.js';
import { Screens } from '../src/screens.js';
import { approvalOverview } from '../src/approvals.js';
import { renderMarkdown } from '../src/format.js';
import { Bridge } from '../src/bridge.js';
import { Outbox, TelegramError } from '../src/telegram.js';
import { array, object, string, type Json, type RpcRequest } from '../src/types.js';
import { fixture, click, temporary, FakeTelegram } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const widgets = (f: Fixture) => f.telegram.calls.filter(call => call.method === 'sendWidget').map(call => call.params);
const buttons = (markup: unknown) => array(object(markup).inline_keyboard).flatMap(row => array(row).map(object));
const controls = (f: Fixture) => buttons(f.telegram.calls.filter(call => call.method === 'editMessageReplyMarkup').at(-1)!.params.reply_markup);
function data(part: Json): Json {
  const script = string(part.html).match(/<script>([\s\S]*?)<\/script>/u)![1]!;
  const context: Json = {}; runInNewContext(script.slice(0, script.indexOf('function el(')), context); return object(context.D);
}
function tap(id: number, button: Json, messageId: number, topic = 101): Json {
  const update = click(id, string(button.callback_data), topic);
  object(object(update.callback_query).message).message_id = messageId; return update;
}
const request = (params: Json): RpcRequest => ({ id: 'review', method: 'item/commandExecution/requestApproval', params: {
  threadId: 'thread-a', turnId: 'turn', itemId: 'item', command: 'npm test', reason: 'Run tests.', availableDecisions: ['accept', 'decline'], ...params } });

test('compact reviews retain exact ordinary commands, visible access, origin and outside-project targets', () => {
  const command = 'echo ' + 'ordinary-argument '.repeat(300);
  const overview = approvalOverview('item/commandExecution/requestApproval', {
    command, cwd: 'C:\\outside', reason: 'Run tests. '.repeat(100), approvalId: 'opaque-callback',
    additionalPermissions: { network: { enabled: true }, fileSystem: { read: ['C:\\private'], write: ['D:\\other'] } },
    networkApprovalContext: { host: 'example.com', protocol: 'https', port: 443 }, environmentId: 'remote-worker',
    proposedExecpolicyAmendment: ['echo'],
  }, 'D:\\project', { name: 'Reviewer', threadId: '12345678-rest-of-agent-id' })!;
  const text = renderMarkdown(overview).text;
  assert.ok(text.includes(command)); assert.match(text, /Reason shortened; full reason in Details/u);
  for (const value of ['Reviewer · 12345678', 'outside project', 'C:\\outside', 'C:\\private', 'D:\\other', 'example.com', '443', 'Network: enabled', 'remote-worker']) assert.ok(text.includes(value), value);
  assert.doesNotMatch(text, /opaque-callback|rest-of-agent-id|proposedExecpolicyAmendment/u);
  assert.match(text, /no persistent policy rule is selected/u);
});

test('unrecognized access schemas retain full review instead of silently hiding fields', () => {
  for (const extra of [
    { futureSecurityContext: { scope: 'forever' } },
    { additionalPermissions: { fileSystem: { entries: [{ access: 'write', path: '/private' }] } } },
    { additionalPermissions: { network: true } },
    { additionalPermissions: { fileSystem: { write: 'all files' } } },
    { networkApprovalContext: { host: 'example.com', protocol: 'https', futureRule: 'persistent' } },
    { kind: 'future-command' },
  ]) assert.equal(approvalOverview('item/commandExecution/requestApproval', { command: 'npm test', ...extra }, '/project'), undefined);
});

test('a long file diff has one primary widget, on-demand complete details and reconnect-stable disclosure deduplication', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review');
    const diff = Array.from({ length: 72 }, (_, i) => '+' + createHash('sha256').update(String(i)).digest('hex')).join('\n');
    const native: RpcRequest = { id: 'review', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-a', turnId: 'turn', itemId: 'item',
      reason: 'Update the test fixture.', changes: [{ path: 'sample.ts', kind: { type: 'update', move_path: null }, diff }], availableDecisions: ['accept', 'decline'] } };
    await f.bridge.request(native); await f.drain();
    assert.equal(widgets(f).length, 1);
    const primary = string(data(widgets(f)[0]!).text);
    assert.match(primary, /sample\.ts/u); assert.doesNotMatch(primary, /proposedChanges|threadId/u); assert.equal(primary.includes(diff), false);
    await f.bridge.flushApproval(); const id = f.telegram.message;
    const choices = controls(f); const details = choices.find(b => b.text === 'Details')!; assert.ok(details);
    await f.bridge.update(tap(1, details, id)); await f.bridge.update(tap(2, details, id)); await f.drain();
    const readers = widgets(f).slice(1); assert.ok(readers.length > 0);
    const full = readers.map(part => string(data(part).text)).join('');
    assert.ok(full.includes(diff)); assert.ok(full.includes('sample.ts'));
    assert.ok(readers.some(part => JSON.stringify(data(part).entities).includes('pre')));
    for (const part of readers) {
      assert.deepEqual(part.reply_parameters, { message_id: id });
      assert.ok(buttons(part.reply_markup).every(b => b.text === 'Text version'));
    }
    assert.deepEqual(f.codex.writes, []); const count = widgets(f).length;
    const restarted = new Bridge(f.bridge.config, f.state, f.codex, f.telegram); await restarted.discover(); await restarted.request(native);
    await restarted.update(tap(3, details, id)); await f.drain(); assert.equal(widgets(f).length, count);
    await restarted.flushApproval();
    await restarted.update(tap(4, controls(f).find(b => b.text === 'Allow once')!, id));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'review', result: { decision: 'accept' } } }]);
  } finally { f.close(); }
});

test('Details capabilities and delivery deduplication survive closing and reopening SQLite', async () => {
  const temp = temporary(); const project = join(temp.dir, 'project'); mkdirSync(project);
  const config = { version: 1 as const, ownerId: 42, roots: [project], codexBinary: process.execPath };
  const telegram = new FakeTelegram(); let state = new State(join(temp.dir, 'private'));
  try {
    state.installTopic('thread-a', 101, project, 'Project'); state.setViewMode('widgets');
    let screens = new Screens(state, telegram, config);
    const drain = async () => { const outbox = new Outbox(state, telegram, config, 0); while (await outbox.flushOne()) {} };
    screens.enqueue('notice/synthetic-review', 101, 'Overview', null, { kind: 'approval', title: 'Approval', details: true, fullText: 'Complete synthetic request' });
    await drain(); const id = telegram.message;
    const details = buttons(telegram.calls.find(c => c.method === 'sendWidget')!.params.reply_markup)[0]!;
    const update = tap(1, details, id); const callback = object(update.callback_query), message = object(callback.message);
    await screens.text(callback, message, 101); await drain(); const count = telegram.calls.filter(c => c.method === 'sendWidget').length;
    state.close(); state = new State(join(temp.dir, 'private')); screens = new Screens(state, telegram, config);
    await screens.text({ ...callback, id: 'another-click' }, message, 101); await drain();
    assert.equal(telegram.calls.filter(c => c.method === 'sendWidget').length, count);
    assert.match(string(telegram.calls.filter(c => c.method === 'answerCallbackQuery').at(-1)!.params.text), /already below/u);
  } finally { state.close(); temp.close(); }
});

test('permission overviews show all requested paths, network and turn scope while preserving the native response', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review');
    const permissions = { network: { enabled: true }, fileSystem: { read: ['/project'], write: ['/outside/one', '/outside/two'] } };
    await f.bridge.request({ id: 'review', method: 'item/permissions/requestApproval', params: { threadId: 'thread-a', turnId: 'turn', permissions } }); await f.drain();
    assert.equal(widgets(f).length, 1); const text = string(data(widgets(f)[0]!).text);
    for (const expected of ['Network: enabled', '/outside/one', '/outside/two', 'Scope: this turn']) assert.ok(text.includes(expected));
    assert.doesNotMatch(text, /threadId|fileSystem/u);
    await f.bridge.flushApproval(); await f.bridge.update(tap(1, controls(f).find(b => b.text === 'Allow once')!, f.telegram.message));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'review', result: { permissions, scope: 'turn' } } }]);
  } finally { f.close(); }
});

test('details reject copied messages, other owners/topics and a binding changed during acknowledgement', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review'); await f.bridge.request(request({})); await f.drain(); await f.bridge.flushApproval();
    const id = f.telegram.message; const details = controls(f).find(b => b.text === 'Details')!;
    const foreign = tap(1, details, id); object(object(foreign.callback_query).from).id = 99;
    await f.bridge.update(foreign); await f.bridge.update(tap(2, details, id + 1)); await f.bridge.update(tap(3, details, id, 102)); await f.drain();
    assert.equal(widgets(f).length, 1);
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'answerCallbackQuery') { f.state.installTopic('thread-a', 505, f.projectA, 'Old'); f.state.installTopic('thread-b', 101, f.projectB, 'New'); }
      return call(method, params);
    };
    await f.bridge.update(tap(4, details, id)); await f.drain(); assert.equal(widgets(f).length, 1); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('uncertain details delivery is never automatically repeated by another click', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review'); await f.bridge.request(request({})); await f.drain(); await f.bridge.flushApproval();
    const id = f.telegram.message; const details = controls(f).find(b => b.text === 'Details')!;
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => { const result = await call(method, params);
      if (method === 'sendWidget') throw new TelegramError('Lost details acknowledgement', 0); return result; };
    await f.bridge.update(tap(1, details, id)); await assert.rejects(f.drain(), /Lost details acknowledgement/u);
    await f.bridge.update(tap(2, details, id)); await f.drain();
    assert.equal(widgets(f).length, 2); assert.deepEqual(f.codex.writes, []);
    assert.match(string(f.telegram.calls.filter(c => c.method === 'answerCallbackQuery').at(-1)!.params.text), /uncertain/u);
  } finally { f.close(); }
});

test('definite widget rejection keeps Details available in native text with the original reply anchor', async () => {
  const f = await fixture();
  try {
    f.state.setViewMode('widgets'); f.codex.pending.add('review'); const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => { if (method === 'sendWidget') throw new TelegramError('Unsupported widget', 400); return call(method, params); };
    await f.bridge.request(request({})); await f.drain(); await f.bridge.flushApproval();
    const id = f.telegram.message; const details = controls(f).find(b => b.text === 'Details')!;
    await f.bridge.update(tap(1, details, id)); await f.drain();
    const reader = f.telegram.sent().at(-1)!;
    assert.deepEqual(reader.reply_parameters, { message_id: id }); assert.ok(string(reader.text).includes('npm test'));
    assert.ok(buttons(reader.reply_markup).every(b => b.text === 'Text version')); assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('file overviews highlight deletions, moves outside the project and requested session write roots', () => {
  const text = renderMarkdown(approvalOverview('item/fileChange/requestApproval', { grantRoot: '/outside', proposedChanges: [
    { path: 'old.ts', kind: { type: 'delete' }, diff: '-old' },
    { path: 'new.ts', kind: { type: 'update', move_path: '/outside/new.ts' }, diff: '+new' },
  ] }, '/project')!).text;
  for (const expected of ['DELETE: ./old.ts', '/outside/new.ts (outside project)', 'Requested write root', 'session']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /applies to this operation/u);
});

test('abbreviated embedded commands put the full-command warning ahead of reason and preview', () => {
  const text = renderMarkdown(approvalOverview('item/commandExecution/requestApproval', {
    command: 'node -e "' + 'console.log(1);\n'.repeat(100) + '"', reason: 'Run the synthetic script.',
  }, '/project')!).text;
  assert.ok(text.indexOf('Abbreviated preview') < text.indexOf('Reason'));
  assert.ok(text.includes('including omitted code')); assert.match(text, /Command abbreviated/u);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { array, object, string, type Json } from '../src/types.js';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { click, fixture, message } from './helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const buttons = (markup: unknown): Json[] => array(object(markup).inline_keyboard).flatMap(row => array(row).map(object));
function action(f: Fixture, id: number, data: string): Json {
  const update = click(id, data); object(object(update.callback_query).message).message_id = f.telegram.message; return update;
}
const edited = (f: Fixture): Json => f.telegram.calls.filter(call => call.method === 'editMessageText').at(-1)!.params;
async function open(f: Fixture, id = 1): Promise<Json[]> {
  await f.bridge.update(message(id, 101, '/permissions')); await f.drain(); return buttons(f.telegram.sent().at(-1)!.reply_markup);
}
async function choose(f: Fixture, choices: Json[], name: string, id: number): Promise<void> {
  const button = choices.find(item => string(item.text).includes(name)); assert.ok(button, name);
  await f.bridge.update(action(f, id, string(button.callback_data)));
}

test('/permissions shows live current settings and profiles without changing a session or starting a turn', async () => {
  const f = await fixture();
  try {
    const choices = await open(f);
    assert.ok(choices.some(item => string(item.text).includes('Ask for approval')));
    assert.match(string(f.telegram.sent().at(-1)!.text), /Current: Ask for approval/u);
    assert.equal(f.codex.writes.length, 0);
    f.codex.permissionProfiles.push({ id: 'new-profile', allowed: true, description: 'New policy' });
    assert.ok((await open(f, 2)).some(item => item.text === 'new-profile'));
    assert.equal(f.codex.permissionReads, 2);
  } finally { f.close(); }
});

test('standard presets apply the native profile, policy and reviewer together', async () => {
  const f = await fixture();
  try {
    await f.codex.permissionCatalog('thread-a', f.projectA); f.codex.permissionStates.get('thread-a')!.approvalsReviewer = 'auto_review';
    await choose(f, await open(f), 'Read Only', 2);
    assert.deepEqual(f.codex.writes, [{ method: 'permissions', params: { threadId: 'thread-a', permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' } }]);
    assert.equal(f.codex.permissionStates.get('thread-a')!.approvalsReviewer, 'user');
    assert.match(string(edited(f).text), /following requests/u);
  } finally { f.close(); }
});

test('full access requires a distinct confirmation and duplicate clicks cannot apply it twice', async () => {
  const f = await fixture();
  try {
    const first = await open(f); const original = string(first.find(item => item.text === 'Full Access')!.callback_data);
    await f.bridge.update(action(f, 2, original)); assert.equal(f.codex.writes.length, 0);
    assert.match(string(edited(f).text), /outside the project/u);
    const confirm = string(buttons(edited(f).reply_markup).find(item => item.text === 'Enable Full Access')!.callback_data);
    await f.bridge.update(action(f, 3, original)); assert.equal(f.codex.writes.length, 0);
    await f.bridge.update(action(f, 4, confirm)); await f.bridge.update(action(f, 5, confirm));
    assert.deepEqual(f.codex.writes, [{ method: 'permissions', params: { threadId: 'thread-a', permissions: ':danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' } }]);
  } finally { f.close(); }
});

test('custom profiles come from Codex, show their description, and preserve existing approval policy', async () => {
  const f = await fixture();
  try {
    f.codex.permissionProfiles = [{ id: 'audit-custom', allowed: true, description: 'Read Only audit policy' }];
    await choose(f, await open(f), 'audit-custom', 2); assert.equal(f.codex.writes.length, 0);
    assert.match(string(edited(f).text), /Read Only audit policy/u);
    await choose(f, buttons(edited(f).reply_markup), 'Choose profile', 3);
    assert.deepEqual(f.codex.writes[0]!.params, { threadId: 'thread-a', permissions: 'audit-custom' });
  } finally { f.close(); }
});

test('the native four choices use the whole tuple for selection and honor live feature/managed gates', async () => {
  const f = await fixture();
  try {
    const first = await open(f);
    assert.deepEqual(first.map(item => string(item.text).replace(/^✓ /u, '')), ['Ask for approval', 'Approve for me', 'Full Access', 'Read Only', 'Close']);
    await choose(f, first, 'Approve for me', 2);
    assert.deepEqual(f.codex.writes[0]!.params, { threadId: 'thread-a', permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    const current = await open(f, 3);
    assert.equal(current.filter(item => string(item.text).startsWith('✓ ')).length, 1);
    assert.ok(current.some(item => item.text === '✓ Approve for me'));
    f.codex.autoReview = false;
    assert.equal((await open(f, 4)).some(item => string(item.text).includes('Approve for me')), false);
    f.codex.autoReview = true; f.codex.permissionRequirements = { allowedApprovalsReviewers: ['user'] };
    assert.equal((await open(f, 5)).some(item => string(item.text).includes('Approve for me')), false);
    f.codex.permissionRequirements = { allowedApprovalsReviewers: ['auto_review'] };
    assert.deepEqual((await open(f, 6)).map(item => item.text), ['✓ Approve for me', 'Close']);
  } finally { f.close(); }
});

test('native policy changes or a withdrawn profile invalidate full-access confirmation before a write', async () => {
  for (const change of ['state', 'catalog', 'requirements']) {
    const f = await fixture();
    try {
      await choose(f, await open(f), 'Full Access', 2);
      const confirm = string(buttons(edited(f).reply_markup)[0]!.callback_data);
      if (change === 'state') f.codex.permissionStates.get('thread-a')!.approvalsReviewer = 'auto_review';
      if (change === 'catalog') f.codex.permissionProfiles.find(profile => profile.id === ':danger-full-access')!.allowed = false;
      if (change === 'requirements') f.codex.permissionRequirements = { allowedApprovalPolicies: ['on-request'] };
      await f.bridge.update(action(f, 3, confirm)); assert.equal(f.codex.writes.length, 0);
    } finally { f.close(); }
  }
});

test('unconfirmed permission writes are consumed and never automatically replayed', async () => {
  const f = await fixture(); let writes = 0;
  try {
    f.codex.updatePermissions = async () => { writes++; throw new RpcError('Response lost', true); };
    const option = string((await open(f)).find(item => string(item.text).includes('Read Only'))!.callback_data);
    await f.bridge.update(action(f, 2, option)); await f.bridge.update(action(f, 3, option));
    assert.equal(writes, 1); assert.equal(f.state.uncertainCount(), 1);
    assert.match(string(edited(f).text), /It will not be retried automatically/u);
  } finally { f.close(); }
});

test('only the authorized owner in the original private topic/message can change permissions', async () => {
  const f = await fixture();
  try {
    await f.bridge.update(message(1, 101, '/permissions', 99)); assert.equal(f.codex.permissionReads, 0);
    const option = string((await open(f, 2)).find(item => string(item.text).includes('Read Only'))!.callback_data);
    await f.bridge.update(click(3, option, 101, 99)); await f.bridge.update(click(4, option, 102));
    const wrong = action(f, 5, option); object(object(wrong.callback_query).message).message_id = 9999; await f.bridge.update(wrong);
    const group = action(f, 6, option); object(object(object(group.callback_query).message).chat).type = 'group'; await f.bridge.update(group);
    assert.equal(f.codex.writes.length, 0);
    f.state.installTopic('thread-a', 555, f.projectA, 'Moved');
    await f.bridge.update(action(f, 7, option)); assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('cancellation, expiry and relay reconnection retire permission controls', async () => {
  const f = await fixture(); const now = Date.now;
  try {
    const first = await open(f); const option = string(first[0]!.callback_data);
    await choose(f, first, 'Close', 2); await f.bridge.update(action(f, 3, option));
    const second = await open(f, 4); Date.now = () => now() + 11 * 60_000;
    await f.bridge.update(action(f, 5, string(second[0]!.callback_data))); Date.now = now;
    const third = await open(f, 6); const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram); await bridge.discover();
    await bridge.update(action(f, 7, string(third[0]!.callback_data))); bridge.close();
    assert.equal(f.codex.writes.length, 0);
  } finally { Date.now = now; f.close(); }
});

test('concurrent clicks consume only one permission selection while callback acknowledgement waits', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const option = string((await open(f))[0]!.callback_data);
    const call = f.telegram.call.bind(f.telegram); let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    let once = true;
    f.telegram.call = async (method, params) => { if (method === 'answerCallbackQuery' && once) { once = false; started(); await held; } return call(method, params); };
    const first = f.bridge.update(action(f, 2, option)); await waiting;
    await f.bridge.update(action(f, 3, option)); release(); await first;
    assert.equal(f.codex.writes.length, 1);
  } finally { release?.(); f.close(); }
});

test('profile paging and a running turn do not steer, interrupt or answer approvals', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active';
    f.codex.permissionProfiles.push(...Array.from({ length: 10 }, (_, i) => ({ id: `custom-${i}`, allowed: true, description: 'Configured' })));
    await choose(f, await open(f), '→', 2);
    assert.ok(buttons(edited(f).reply_markup).some(item => string(item.text).includes('custom-9')));
    await choose(f, await open(f, 4), 'Read Only', 5);
    assert.deepEqual(f.codex.writes.map(write => write.method), ['permissions']);
  } finally { f.close(); }
});

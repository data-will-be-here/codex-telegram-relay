import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient, RpcError } from '../src/codex.js';
import { findCodex } from '../src/config.js';
import { permissionSignature } from '../src/permission-settings.js';
import { PermissionPicker } from '../src/permission-picker.js';
import { State } from '../src/state.js';
import { Outbox } from '../src/telegram.js';
import { object, string, type Binding, type Json } from '../src/types.js';
import { FakeTelegram, temporary } from './helpers.js';

test('native /permissions: confirmed profiles and reviewer persist across restart without model turns or config edits', {
  skip: process.env.CODEX_RELAY_NATIVE_PERMISSIONS !== '1', timeout: 60_000,
}, async () => {
  const temp = temporary(); const home = join(temp.dir, 'codex'); const project = join(temp.dir, 'project');
  mkdirSync(home); mkdirSync(project);
  const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  const configFile = join(home, 'config.toml');
  const initialConfig = 'default_permissions = ":workspace"\napproval_policy = "on-request"\napprovals_reviewer = "user"\n[features]\nguardian_approval = true\n';
  writeFileSync(configFile, initialConfig);
  const native = new CodexClient(); const telegram = new FakeTelegram();
  const state = new State(join(temp.dir, 'relay'));
  let child: ChildProcessWithoutNullStreams | undefined; let sequence = 0;
  const records: { method: string; params: Json }[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const rpc = (method: string, params: Json): Promise<unknown> => new Promise((resolve, reject) => {
    records.push({ method, params }); const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new RpcError(`Native timeout: ${method}`, true)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  native.call = rpc;
  const boot = async () => {
    child = spawn(findCodex(), ['app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe', windowsHide: true });
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      let response: Json; try { response = object(JSON.parse(line)); } catch { return; }
      if (response.method && response.id === undefined) { native.emit('notification', string(response.method), object(response.params)); return; }
      const entry = pending.get(Number(response.id)); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(Number(response.id));
      if (response.error) entry.reject(new RpcError(JSON.stringify(response.error), false)); else entry.resolve(response.result);
    });
    await rpc('initialize', { clientInfo: { name: 'relay_permissions_qualification', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const running = child; const exited = new Promise<void>(resolve => running.once('exit', () => resolve()));
    running.stdin.end(); const timer = setTimeout(() => running.kill(), 3000); await exited; clearTimeout(timer);
  };
  try {
    await boot();
    const created = object(await native.createThread(project, 'relay-permissions-qualification'));
    const threadId = string(created.id); assert.ok(threadId);
    await native.setThreadName(threadId, 'Isolated permissions qualification');
    await native.attach(threadId);
    const initial = await native.permissionCatalog(threadId, project);
    assert.equal(object(initial.settings.activePermissionProfile).id, ':workspace');
    assert.equal(initial.autoReview, true);
    const binding: Binding = { threadId, topicId: 101, cwd: project, title: 'Qualification', lastTurn: null };
    state.bind(threadId, 101, project, binding.title);
    const picker = new PermissionPicker(state, native, telegram, 42, async () => ({ id: threadId, cwd: project }));
    const outbox = new Outbox(state, telegram, { ownerId: 42, roots: [project] }, 0);
    await picker.open(binding); while (await outbox.flushOne()) { /* Deliver menu to the adapter. */ }
    const sent = telegram.calls.filter(call => call.method === 'sendMessage').at(-1)!;
    const buttons = (markup: unknown): Json[] => (object(markup).inline_keyboard as Json[][]).flat();
    const click = async (data: unknown) => picker.callback({ id: String(++sequence), data }, { message_id: telegram.message }, 101);
    const full = buttons(sent.params.reply_markup).find(button => button.text === 'Full Access')!; assert.ok(full);
    await click(full.callback_data);
    assert.equal(records.filter(record => record.method === 'thread/settings/update').length, 0, 'first click only displays confirmation');
    const confirmation = telegram.calls.filter(call => call.method === 'editMessageText').at(-1)!;
    await click(buttons(confirmation.params.reply_markup).find(button => button.text === 'Enable Full Access')!.callback_data);
    let snapshot = await native.permissionCatalog(threadId, project);
    assert.equal(object(snapshot.settings.activePermissionProfile).id, ':danger-full-access');
    assert.equal(snapshot.settings.approvalPolicy, 'never');
    await native.updatePermissions(threadId, { permissions: ':workspace', approvalPolicy: 'on-request' }, permissionSignature(snapshot.settings));
    snapshot = await native.permissionCatalog(threadId, project);
    await native.updatePermissions(threadId, { approvalsReviewer: 'auto_review' }, permissionSignature(snapshot.settings));
    assert.equal(readFileSync(configFile, 'utf8'), initialConfig);
    assert.deepEqual(await native.turns(threadId), []);
    await stop(); await boot(); await native.attach(threadId);
    snapshot = await native.permissionCatalog(threadId, project);
    assert.equal(object(snapshot.settings.activePermissionProfile).id, ':workspace');
    assert.equal(snapshot.settings.approvalPolicy, 'on-request');
    assert.equal(snapshot.settings.approvalsReviewer, 'auto_review');
    assert.equal(readFileSync(configFile, 'utf8'), initialConfig);
    assert.equal(records.some(record => record.method.startsWith('turn/') && record.method !== 'thread/turns/list'), false);
  } finally {
    await stop(); for (const entry of pending.values()) clearTimeout(entry.timer);
    state.close(); if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    for (let attempt = 0; attempt < 8; attempt++) {
      try { temp.close(); break; } catch (error) { if (attempt === 7) throw error; await delay(300); }
    }
  }
});

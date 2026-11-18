import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient, RpcError } from '../src/codex.js';
import { findCodex } from '../src/config.js';
import { object, string, type Json } from '../src/types.js';
import { temporary } from './helpers.js';

test('isolated native clear transfers effective permission presets and workspace network/roots without model turns', {
  skip: process.env.CODEX_RELAY_NATIVE_CLEAR !== '1', timeout: 60_000,
}, async () => {
  const temp = temporary(); const home = join(temp.dir, 'codex'); const project = join(temp.dir, 'project');
  const extra = join(temp.dir, 'extra'); mkdirSync(home); mkdirSync(project); mkdirSync(extra);
  const configFile = join(home, 'config.toml');
  const initial = 'default_permissions = ":workspace"\napproval_policy = "on-request"\napprovals_reviewer = "user"\n[features]\nguardian_approval = true\n';
  writeFileSync(configFile, initial);
  const native = new CodexClient(); let child: ChildProcessWithoutNullStreams | undefined; let sequence = 0;
  const records: { method: string; params: Json }[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const rpc = (method: string, params: Json): Promise<unknown> => new Promise((resolve, reject) => {
    records.push({ method, params }); const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new RpcError(`Native timeout: ${method}`, true)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  native.call = rpc;
  try {
    child = spawn(findCodex(), ['app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe', windowsHide: true });
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      let response: Json; try { response = object(JSON.parse(line)); } catch { return; }
      if (response.method && response.id === undefined) { native.emit('notification', string(response.method), object(response.params)); return; }
      const entry = pending.get(Number(response.id)); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(Number(response.id));
      if (response.error) entry.reject(new RpcError(JSON.stringify(response.error), false)); else entry.resolve(response.result);
    });
    await rpc('initialize', { clientInfo: { name: 'relay_clear_qualification', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    for (const [profile, reviewer] of [[':workspace', 'user'], [':workspace', 'auto_review'], [':danger-full-access', 'user'], [':read-only', 'user']]) {
      const source = object(object(await rpc('thread/start', { cwd: project, ephemeral: false, permissions: profile,
        approvalPolicy: profile === ':danger-full-access' ? 'never' : 'on-request', approvalsReviewer: reviewer,
        runtimeWorkspaceRoots: [project, extra], ...(profile === ':workspace' ? { config: { sandbox_workspace_write: {
          writable_roots: [extra], network_access: true, exclude_tmpdir_env_var: true, exclude_slash_tmp: true,
        } } } : {}) })).thread);
      await native.setThreadName(string(source.id), `Clear source ${profile} ${reviewer}`);
      const snapshot = await native.captureClearSettings(string(source.id), project);
      const created = await native.createThread(project, `clear-qualification-${profile}-${reviewer}`, 'clear', snapshot);
      assert.ok(created.id);
      await native.setThreadName(string(created.id), `Clear replacement ${profile} ${reviewer}`);
      await native.validateClearSettings(string(created.id), snapshot);
      assert.equal(native.clearSettingsCurrent(string(created.id), snapshot), true);
      await native.unsubscribe(string(source.id)); await native.unsubscribe(string(created.id));
    }
    assert.equal(readFileSync(configFile, 'utf8'), initial);
    assert.equal(records.some(record => record.method.startsWith('turn/') || record.method.startsWith('config/')), false);
  } finally {
    if (child && child.exitCode === null) {
      const running = child; const exited = new Promise<void>(resolve => running.once('close', () => resolve()));
      running.stdin.end(); const timer = setTimeout(() => running.kill(), 3000); await exited; clearTimeout(timer);
    }
    for (const entry of pending.values()) clearTimeout(entry.timer);
    for (let attempt = 0; attempt < 8; attempt++) {
      try { temp.close(); break; } catch (error) { if (attempt === 7) throw error; await delay(300); }
    }
  }
});

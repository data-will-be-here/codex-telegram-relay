import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.js';
import { CodexClient } from '../src/codex.js';
import { findCodex, type Config } from '../src/config.js';
import { Outbox } from '../src/telegram.js';
import { State } from '../src/state.js';
import { object, type Json } from '../src/types.js';
import { FakeTelegram, message, temporary } from './helpers.js';

test('native /new: empty workspace-write thread persists across app-server restart without a model turn', {
  skip: process.env.CODEX_RELAY_NATIVE_NEW !== '1', timeout: 60_000,
}, async () => {
  const temp = temporary(); const home = join(temp.dir, 'codex');
  mkdirSync(home); const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  const configFile = join(home, 'config.toml');
  const initialConfig = 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n';
  writeFileSync(configFile, initialConfig);
  let child: ChildProcessWithoutNullStreams | undefined; let sequence = 0;
  const pending = new Map<number, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const records: string[] = [];
  const rpc = (method: string, params: Json): Promise<unknown> => new Promise((resolve, reject) => {
    records.push(method); const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native timeout: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const boot = async () => {
    child = spawn(findCodex(), ['app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home }, stdio: 'pipe', windowsHide: true });
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      let response: Json; try { response = object(JSON.parse(line)); } catch { return; }
      const entry = pending.get(Number(response.id)); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(Number(response.id));
      if (response.error) entry.reject(new Error(JSON.stringify(response.error))); else entry.resolve(response.result);
    });
    await rpc('initialize', { clientInfo: { name: 'relay_new_qualification', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const running = child; const exited = new Promise<void>(resolve => running.once('close', () => resolve()));
    running.stdin.end(); const timer = setTimeout(() => running.kill(), 3000); await exited; clearTimeout(timer);
  };
  const native = new CodexClient(); native.call = rpc;
  let state: State | undefined; let bridge: Bridge | undefined;
  try {
    await boot();
    state = new State(join(temp.dir, 'relay'));
    const project = join(temp.dir, 'project'); mkdirSync(project);
    const config: Config = { version: 1, ownerId: 42, roots: [project], codexBinary: findCodex() };
    const telegram = new FakeTelegram(); bridge = new Bridge(config, state, native, telegram);
    const outbox = new Outbox(state, telegram, config, 0);
    const update = message(1, 999, '/new'); delete object(update.message).message_thread_id;
    await bridge.update(update); while (await outbox.flushOne()) { /* Deliver picker. */ }
    const op = state.newSessions()[0]!;
    await bridge.update({ update_id: 2, callback_query: { id: '2', from: { id: 42 }, data: `n:${op.token}:0`, message: {
      message_id: state.promptMessage(op.menuKey), chat: { id: 42, type: 'private' } } } });
    await bridge.workNewSession();
    const saved = state.newSession(op.id)!;
    assert.equal(saved.status, 'ready', JSON.stringify(saved));
    assert.deepEqual(await native.turns(saved.threadId!), []);
    assert.equal(records.includes('turn/start'), false);
    assert.ok((await native.nonArchivedThread(saved.threadId!))?.id === saved.threadId);
    assert.equal(readFileSync(configFile, 'utf8'), initialConfig, 'this isolated native configuration required no trust rewrite');
    bridge.close(); await stop(); await boot();
    bridge = new Bridge(config, state, native, telegram); await bridge.discover();
    assert.deepEqual(await native.turns(saved.threadId!), []);
    assert.equal((await native.read(saved.threadId!)).id, saved.threadId);
    assert.equal(records.filter(method => method === 'thread/start').length, 1);
    await rpc('thread/archive', { threadId: saved.threadId });
    await delay(50);
    assert.equal(await native.nonArchivedThread(saved.threadId!), undefined);
    bridge.close(); bridge = new Bridge(config, state, native, telegram);
    const resumes = records.filter(method => method === 'thread/resume').length;
    await bridge.discover();
    assert.equal(records.filter(method => method === 'thread/resume').length, resumes);
    assert.equal(records.includes('thread/unarchive'), false);
  } finally {
    bridge?.close(); await stop(); for (const entry of pending.values()) clearTimeout(entry.timer);
    state?.close(); if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    for (let attempt = 0; attempt < 8; attempt++) {
      try { temp.close(); break; }
      catch (error) { if (attempt === 7) throw error; await delay(300); }
    }
  }
});

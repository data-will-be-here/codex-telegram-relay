import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { State } from '../src/state.js';
import { Bridge } from '../src/bridge.js';
import { Outbox } from '../src/telegram.js';
import { type Codex, type Json, type Session, type Telegram } from '../src/types.js';

export function temporary(): { dir: string; close: () => void } {
  const base = realpathSync(tmpdir());
  const dir = mkdtempSync(join(base, 'codex-relay-test-'));
  return { dir, close: () => {
    const target = realpathSync(dir);
    if (dirname(target) !== resolve(base) || !basename(target).startsWith('codex-relay-test-')) throw new Error('Unsafe test cleanup path.');
    rmSync(target, { recursive: true, force: true });
  } };
}

export class FakeCodex implements Codex {
  sessions: Session[] = [];
  histories = new Map<string, Json[]>();
  writes: { method: string; params: Json }[] = [];
  pending = new Set<string | number>();
  failSteer = false;
  async list(): Promise<Session[]> { return this.sessions; }
  async attach(threadId: string): Promise<Json> { return this.read(threadId); }
  async read(threadId: string): Promise<Json> {
    const session = this.sessions.find(s => s.id === threadId)!;
    return { ...session, status: { type: session.status } };
  }
  async turns(threadId: string): Promise<Json[]> { return this.histories.get(threadId) ?? []; }
  async start(threadId: string, text: string): Promise<unknown> { this.writes.push({ method: 'start', params: { threadId, text } }); return {}; }
  async steer(threadId: string, turnId: string, text: string): Promise<unknown> {
    this.writes.push({ method: 'steer', params: { threadId, turnId, text } });
    if (this.failSteer) throw new Error('Ambiguous native timeout.');
    return {};
  }
  async respond(id: string | number, result: Json): Promise<void> {
    if (!this.pending.delete(id)) throw new Error('Request is closed.');
    this.writes.push({ method: 'respond', params: { id, result: JSON.parse(JSON.stringify(result)) as Json } });
  }
  hasRequest(id: string | number): boolean { return this.pending.has(id); }
}

export class FakeTelegram implements Telegram {
  calls: { method: string; params: Json }[] = [];
  topic = 100;
  message = 1000;
  async call(method: string, params: Json = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'createForumTopic') return { message_thread_id: ++this.topic };
    if (method === 'sendMessage') return { message_id: ++this.message };
    return true;
  }
  sent(): Json[] { return this.calls.filter(c => c.method === 'sendMessage').map(c => c.params); }
}

export async function fixture(): Promise<{
  dir: string; projectA: string; projectB: string; state: State; codex: FakeCodex; telegram: FakeTelegram; bridge: Bridge;
  drain: () => Promise<void>; close: () => void;
}> {
  const temp = temporary();
  const projectA = join(temp.dir, 'project-a'); const projectB = join(temp.dir, 'project-b');
  mkdirSync(projectA); mkdirSync(projectB);
  const codex = new FakeCodex(); const telegram = new FakeTelegram();
  codex.sessions = [{ id: 'thread-a', cwd: projectA, name: '', status: 'idle' }, { id: 'thread-b', cwd: projectB, name: '', status: 'idle' }];
  const state = new State(join(temp.dir, 'private'));
  const bridge = new Bridge({ version: 1, ownerId: 42, roots: [projectA, projectB], codexBinary: process.execPath }, state, codex, telegram);
  await bridge.discover();
  const outbox = new Outbox(state, telegram, 42, 0);
  return { dir: temp.dir, projectA, projectB, state, codex, telegram, bridge, drain: async () => { while (await outbox.flushOne()) { /* Drain persisted deliveries. */ } }, close: () => { state.close(); temp.close(); } };
}

export function message(id: number, topic = 101, text = 'Continue', owner = 42): Json {
  return { update_id: id, message: { message_id: id, from: { id: owner, is_bot: false }, chat: { id: owner, type: 'private' }, message_thread_id: topic, text } };
}

export function click(id: number, data: string, topic = 101, owner = 42): Json {
  return { update_id: id, callback_query: { id: String(id), from: { id: owner, is_bot: false }, data, message: { message_id: 1001, chat: { id: owner, type: 'private' }, message_thread_id: topic } } };
}

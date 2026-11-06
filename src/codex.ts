import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import { type createConnection } from 'node:net';
import WebSocket from 'ws';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AsyncQuestionReader, type AsyncQuestion } from './async-questions.js';
import { array, object, string, type Codex, type Json, type RpcRequest, type Session, type UserInput, type ModelSettings } from './types.js';

const MAX_DISCOVERED_SESSIONS = 64;
const METADATA_READ_CONCURRENCY = 8;

export class RpcError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

export class FirstMessageRequiredError extends RpcError {
  constructor() { super('Send the first message in this session locally in Codex. The relay will connect automatically afterwards.', false); }
}

export class CodexClient extends EventEmitter implements Codex {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private requests = new Set<string | number>();
  private socket?: WebSocket;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private failure?: Error;
  private questionReaders = new Map<string, AsyncQuestionReader>();

  async connect(binary: string, args = ['app-server', 'proxy']): Promise<void> {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/telegram.*token|bot.*token|relay.*token/iu.test(key)) delete env[key];
    }
    const child = spawn(binary, args, { stdio: 'pipe', shell: false, windowsHide: true, env });
    this.child = child;
    // Proxy is raw WebSocket-over-pipes, not JSONL. HTTP upgrade stays entirely local.
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    child.stderr.resume(); // Do not copy native transcripts or credential-bearing errors into logs.
    const socket = new WebSocket('ws://localhost/', {
      createConnection: (() => stream) as unknown as typeof createConnection,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 10_000,
    });
    this.socket = socket;
    socket.on('message', data => {
      try { this.receive(object(JSON.parse(data.toString()))); }
      catch { this.disconnect(new RpcError('Invalid Codex protocol message.', true)); }
    });
    socket.on('error', error => {
      const code = string(object(error).code);
      const message = code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
        ? 'Codex response exceeded the 16 MiB transport limit. This is a protocol payload issue, not a stopped daemon.'
        : `Codex proxy transport failed${/^[A-Z0-9_]+$/u.test(code) ? ` (${code})` : ''}. Run doctor to check daemon availability.`;
      this.disconnect(new RpcError(message, true));
    });
    socket.on('close', () => this.disconnect(new RpcError('Codex connection closed; pending writes will not be replayed.', true)));
    child.on('error', () => this.disconnect(new RpcError('Cannot start the native Codex proxy.', false)));
    child.on('exit', () => { if (!this.closed) socket.terminate(); });
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => reject(this.failure ?? new Error('Codex proxy handshake failed. No alternate daemon was started.'));
      socket.once('error', fail);
      socket.once('close', fail);
      socket.once('open', () => { socket.off('error', fail); socket.off('close', fail); resolve(); });
    });
    await this.call('initialize', {
      clientInfo: { name: 'codex_telegram_relay', title: 'Codex Telegram Relay', version: '0.1.17' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['item/commandExecution/outputDelta', 'item/reasoning/textDelta'] },
    });
    socket.send(JSON.stringify({ method: 'initialized' }));
  }

  private receive(message: Json): void {
    if (typeof message.method === 'string') {
      const params = object(message.params);
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        this.requests.add(message.id);
        this.emit('request', { id: message.id, method: message.method, params } satisfies RpcRequest);
      } else {
        if (message.method === 'serverRequest/resolved') {
          const id = params.requestId;
          if (typeof id === 'string' || typeof id === 'number') this.requests.delete(id);
        }
        this.emit('notification', message.method, params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new RpcError('Codex rejected the request: ' + string(object(message.error).message).slice(0, 300), false));
    else pending.resolve(message.result);
  }

  call(method: string, params: Json, timeoutMs = 20_000): Promise<unknown> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError('Codex is disconnected.', false));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError('Codex request timed out; its effect is uncertain. Check the terminal before retrying.', true)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RpcError('Codex write failed; its effect is uncertain.', true)); }
      });
    });
  }

  async loaded(): Promise<string[]> {
    return [...new Set(array(object(await this.call('thread/loaded/list', {})).data).filter((id): id is string => typeof id === 'string'))];
  }

  async list(eligible: (session: Session) => boolean = () => true): Promise<Session[]> {
    const loaded = await this.loaded();
    const loadedSet = new Set(loaded);
    for (const id of this.questionReaders.keys()) if (!loadedSet.has(id)) this.questionReaders.delete(id);
    const result: Session[] = [];
    // Bound concurrent metadata reads, not the number of ineligible contexts we can skip.
    for (let offset = 0; offset < loaded.length; offset += METADATA_READ_CONCURRENCY) {
      const ids = loaded.slice(offset, offset + METADATA_READ_CONCURRENCY);
      const batch = await Promise.allSettled(ids.map(id => this.read(id)));
      for (let index = 0; index < batch.length; index++) {
        const read = batch[index]!;
        if (read.status === 'rejected') {
          if (read.reason instanceof RpcError && read.reason.uncertain) throw read.reason;
          this.emit('sessionUnavailable', ids[index]!); continue;
        }
        const thread = read.value;
        if (!['cli', 'vscode', 'appServer'].includes(string(thread.source)) || thread.ephemeral === true || thread.parentThreadId || thread.canAcceptDirectInput === false || !string(thread.cwd) || ('path' in thread && !thread.path)) continue;
        const session: Session = { id: ids[index]!, cwd: string(thread.cwd), name: string(thread.name), status: string(object(thread.status).type) };
        if (typeof thread.createdAt === 'number') session.createdAt = thread.createdAt;
        if (!eligible(session)) continue;
        if (result.length === MAX_DISCOVERED_SESSIONS) { this.emit('discoveryLimit', MAX_DISCOVERED_SESSIONS); return result; }
        result.push(session);
      }
      await new Promise<void>(done => setImmediate(done));
    }
    return result;
  }

  async read(threadId: string, timeoutMs?: number): Promise<Json> { return object(object(await this.call('thread/read', { threadId }, timeoutMs)).thread); }
  async models(): Promise<Json[]> {
    const models: Json[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = object(await this.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(result.data)) throw new RpcError('Codex returned an invalid model catalog.', false);
      models.push(...result.data.map(object));
      if (models.length > 512) throw new RpcError('The model catalog exceeds the relay limit of 512 entries.', false);
      if (result.nextCursor == null) return models;
      cursor = string(result.nextCursor);
      if (!cursor || seen.has(cursor)) throw new RpcError('Codex returned an invalid model catalog cursor.', false);
      seen.add(cursor);
    }
    throw new RpcError('The model catalog exceeded the pagination limit.', false);
  }
  async updateSettings(threadId: string, settings: ModelSettings): Promise<void> {
    await this.call('thread/settings/update', { threadId, model: settings.model,
      ...(settings.effort === undefined ? {} : { effort: settings.effort }), serviceTier: settings.serviceTier });
  }
  async asyncQuestions(threadId: string, historySinceMs?: number, answeredCallIds: readonly string[] = []): Promise<AsyncQuestion[]> {
    const thread = await this.read(threadId);
    const path = string(thread.path);
    const turn = (await this.turns(threadId))[0];
    if (!turn || !path || typeof turn.startedAt !== 'number') { this.questionReaders.delete(threadId); return []; }
    const sessionsRoot = await realpath(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'));
    const target = await realpath(path);
    const diff = relative(sessionsRoot, target);
    if (!diff || isAbsolute(diff) || diff === '..' || diff.startsWith(`..${sep}`) || !target.endsWith('.jsonl') || (await lstat(path)).isSymbolicLink()) throw new Error('Native question journal is outside the Codex sessions directory.');
    let reader = this.questionReaders.get(threadId);
    if (!reader) { reader = new AsyncQuestionReader(); this.questionReaders.set(threadId, reader); }
    const since = historySinceMs === undefined ? Math.max(turn.startedAt * 1000, Date.now() - 7 * 24 * 60 * 60 * 1000) : Math.min(turn.startedAt * 1000, historySinceMs);
    return reader.read(target, string(turn.id), since, answeredCallIds);
  }
  async attach(threadId: string): Promise<Json> {
    // Deliberately omit cwd/model/instructions/approval/sandbox/permissions overrides.
    return object(object(await this.call('thread/resume', { threadId, excludeTurns: true })).thread);
  }
  async turns(threadId: string): Promise<Json[]> {
    try {
      // Display summaries retain agent replies while excluding enormous historical tool outputs.
      return array(object(await this.call('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'summary' })).data).map(object);
    } catch (error) {
      // A reserved rollout path is not proof of materialization. Keep this state distinct from readable empty history.
      if (error instanceof RpcError && !error.uncertain &&
          error.message === `Codex rejected the request: thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`) throw new FirstMessageRequiredError();
      throw error;
    }
  }
  start(threadId: string, text: string | UserInput[]): Promise<unknown> {
    return this.call('turn/start', { threadId, input: typeof text === 'string' ? [{ type: 'text', text }] : text });
  }
  steer(threadId: string, turnId: string, text: string | UserInput[]): Promise<unknown> {
    return this.call('turn/steer', { threadId, expectedTurnId: turnId, input: typeof text === 'string' ? [{ type: 'text', text }] : text });
  }
  hasRequest(id: string | number): boolean { return this.requests.has(id); }
  async respond(id: string | number, result: Json): Promise<void> {
    if (!this.requests.has(id) || this.socket?.readyState !== WebSocket.OPEN) throw new Error('This native request is no longer pending.');
    this.requests.delete(id);
    await new Promise<void>((resolve, reject) => this.socket!.send(JSON.stringify({ id, result }), error => error ? reject(new RpcError('Native response delivery is uncertain.', true)) : resolve()));
  }
  close(): void { this.closed = true; this.socket?.terminate(); this.child?.kill(); this.disconnect(new RpcError('Codex disconnected.', true)); }
  private disconnect(error: Error): void {
    this.failure ??= error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.requests.clear();
    if (!this.closed) { this.closed = true; this.child?.kill(); this.emit('disconnected', this.failure); }
  }
}

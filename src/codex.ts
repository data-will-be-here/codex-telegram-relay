import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import { type createConnection } from 'node:net';
import WebSocket from 'ws';
import { array, object, string, type Codex, type Json, type RpcRequest, type Session } from './types.js';

export class RpcError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

export class CodexClient extends EventEmitter implements Codex {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private requests = new Set<string | number>();
  private socket?: WebSocket;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private failure?: Error;

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
      clientInfo: { name: 'codex_telegram_relay', title: 'Codex Telegram Relay', version: '0.1.3' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta'] },
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

  async list(): Promise<Session[]> {
    const loaded = array(object(await this.call('thread/loaded/list', {})).data).filter((id): id is string => typeof id === 'string').slice(0, 64);
    const result: Session[] = [];
    for (const id of loaded) {
      const thread = await this.read(id);
      if (!['cli', 'vscode', 'appServer'].includes(string(thread.source)) || thread.ephemeral === true || thread.parentThreadId || thread.canAcceptDirectInput === false || !string(thread.cwd) || ('path' in thread && !thread.path)) continue;
      const session: Session = { id, cwd: string(thread.cwd), name: string(thread.name), status: string(object(thread.status).type) };
      if (typeof thread.createdAt === 'number') session.createdAt = thread.createdAt;
      result.push(session);
    }
    return result;
  }

  async read(threadId: string): Promise<Json> { return object(object(await this.call('thread/read', { threadId })).thread); }
  async attach(threadId: string): Promise<Json> {
    // Deliberately omit cwd/model/instructions/approval/sandbox/permissions overrides.
    return object(object(await this.call('thread/resume', { threadId, excludeTurns: true })).thread);
  }
  async turns(threadId: string): Promise<Json[]> {
    try {
      // Display summaries retain agent replies while excluding enormous historical tool outputs.
      return array(object(await this.call('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'summary' })).data).map(object);
    } catch (error) {
      // A newly opened interactive session has no persisted history until its first input.
      if (error instanceof RpcError && !error.uncertain && /not materialized yet.*unavailable before first user message/u.test(error.message)) return [];
      throw error;
    }
  }
  start(threadId: string, text: string): Promise<unknown> {
    return this.call('turn/start', { threadId, input: [{ type: 'text', text }] });
  }
  steer(threadId: string, turnId: string, text: string): Promise<unknown> {
    return this.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
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

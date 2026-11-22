import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectCodex, type ConnectionClient } from '../src/codex-connection.js';
import { type Config } from '../src/config.js';
import { temporary } from './helpers.js';

function fixture() {
  const temp = temporary();
  const previousHome = process.env.CODEX_HOME; const previousPath = process.env.PATH;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const home = join(temp.dir, 'codex-home'); const path = join(temp.dir, 'path');
  mkdirSync(home); mkdirSync(path);
  process.env.CODEX_HOME = home; process.env.PATH = path;
  const managed = join(home, 'packages', 'app-server-daemon', 'current', 'bin', name);
  const previous = join(temp.dir, 'previous', name); const pathBinary = join(path, name);
  const binary = (target: string): string => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(process.platform === 'win32' ? '4d5a0000' : process.platform === 'darwin' ? 'cffaedfe' : '7f454c46', 'hex'));
    chmodSync(target, 0o755); return realpathSync(target);
  };
  const config: Config = { version: 1, ownerId: 42, roots: [temp.dir], sessionScope: 'all', outgoingFiles: true,
    ignoredThreadIds: ['ignored-session'], codexBinary: binary(previous), codexSelection: { mode: 'auto', source: 'path' } };
  return { managed, previous, pathBinary, binary, config, close: () => {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    temp.close();
  } };
}

class Client implements ConnectionClient {
  binary = ''; closed = false;
  constructor(readonly events: string[], private readonly failures: ReadonlySet<string> = new Set(),
    private readonly invalidProbes: ReadonlySet<string> = new Set()) {}
  async connect(binary: string): Promise<void> {
    this.binary = binary; this.events.push(`connect:${binary}`);
    if (this.failures.has(binary)) throw new Error('Synthetic native initialization failure');
  }
  async probeReadOnly(): Promise<boolean> { this.events.push(`probe:${this.binary}`); return !this.invalidProbes.has(this.binary); }
  close(): void { this.closed = true; this.events.push(`close:${this.binary}`); }
}

test('automatic native selection closes an incompatible managed candidate and keeps the previous working selection', async () => {
  const f = fixture(); const events: string[] = []; const clients: Client[] = [];
  try {
    const managed = f.binary(f.managed); const previous = realpathSync(f.previous);
    const before = structuredClone(f.config);
    const result = await connectCodex(f.config, { createClient: () => {
      const client = new Client(events, new Set([managed])); clients.push(client); return client;
    } });
    assert.equal(result.candidate.binary, previous);
    assert.equal(result.candidate.source, 'previous');
    assert.equal(result.fallback, true);
    assert.equal(result.changed, false);
    assert.deepEqual(result.config, before);
    assert.deepEqual(f.config, before);
    assert.deepEqual(events, [`connect:${managed}`, `close:${managed}`, `connect:${previous}`, `probe:${previous}`]);
    assert.equal(clients[0]!.closed, true);
    assert.equal(result.client.closed, false);
    result.client.close();
  } finally { f.close(); }
});

test('an incompatible read-only probe falls back to PATH before publishing a new automatic selection', async () => {
  const f = fixture(); const events: string[] = []; const clients: Client[] = [];
  try {
    const managed = f.binary(f.managed); const path = f.binary(f.pathBinary); const before = structuredClone(f.config);
    const result = await connectCodex(f.config, { createClient: () => {
      assert.deepEqual(f.config, before);
      const client = new Client(events, new Set(), new Set([managed])); clients.push(client); return client;
    } });
    assert.deepEqual(events, [`connect:${managed}`, `probe:${managed}`, `close:${managed}`, `connect:${path}`, `probe:${path}`]);
    assert.equal(result.candidate.source, 'path'); assert.equal(result.candidate.binary, path);
    assert.equal(result.changed, true); assert.equal(result.fallback, true);
    assert.equal(result.config.codexBinary, path);
    assert.deepEqual(result.config.codexSelection, { mode: 'auto', source: 'path' });
    assert.deepEqual({ ...result.config, codexBinary: before.codexBinary }, before);
    assert.deepEqual(f.config, before);
    assert.equal(clients[0]!.closed, true); assert.equal(result.client.closed, false); result.client.close();
  } finally { f.close(); }
});

test('failed legacy, fixed and explicit native selections never try another installed binary', async () => {
  for (const selection of ['legacy', 'fixed', 'override']) {
    const f = fixture(); const events: string[] = []; const clients: Client[] = [];
    try {
      const managed = f.binary(f.managed); f.binary(f.pathBinary);
      const config: Config = { ...f.config };
      if (selection === 'legacy') delete config.codexSelection;
      if (selection === 'fixed') config.codexSelection = { mode: 'fixed' };
      const selected = selection === 'override' ? managed : realpathSync(f.previous);
      const before = structuredClone(config);
      await assert.rejects(connectCodex(config, {
        ...(selection === 'override' ? { override: managed } : {}),
        createClient: () => { const client = new Client(events, new Set([selected])); clients.push(client); return client; },
      }));
      assert.deepEqual(events, [`connect:${selected}`, `close:${selected}`], selection);
      assert.equal(clients.length, 1, selection); assert.equal(clients[0]!.closed, true, selection);
      assert.deepEqual(config, before, selection);
    } finally { f.close(); }
  }
});

test('a successful explicit override returns a fixed selection without mutating the saved automatic configuration', async () => {
  const f = fixture(); const events: string[] = [];
  try {
    const override = f.binary(f.pathBinary); f.binary(f.managed); const before = structuredClone(f.config);
    const result = await connectCodex(f.config, { override, createClient: () => new Client(events) });
    assert.equal(result.candidate.binary, override); assert.equal(result.candidate.source, 'fixed');
    assert.equal(result.changed, true); assert.equal(result.fallback, false);
    assert.deepEqual(result.config.codexSelection, { mode: 'fixed' });
    assert.deepEqual({ ...result.config, codexBinary: before.codexBinary, codexSelection: before.codexSelection }, before);
    assert.deepEqual(f.config, before); assert.deepEqual(events, [`connect:${override}`, `probe:${override}`]);
    result.client.close();
  } finally { f.close(); }
});

test('all failed automatic candidates close their clients and leave pairing and the previous selection unchanged', async () => {
  const f = fixture(); const events: string[] = []; const clients: Client[] = [];
  try {
    const managed = f.binary(f.managed); const path = f.binary(f.pathBinary); const previous = realpathSync(f.previous);
    const before = structuredClone(f.config);
    await assert.rejects(connectCodex(f.config, { createClient: () => {
      const client = new Client(events, new Set([managed, path, previous])); clients.push(client); return client;
    } }));
    assert.deepEqual(events, [managed, path, previous].flatMap(binary => [`connect:${binary}`, `close:${binary}`]));
    assert.ok(clients.every(client => client.closed)); assert.deepEqual(f.config, before);
  } finally { f.close(); }
});

test('each reconnect resolves newly available managed Codex rather than pinning the previous successful PATH executable', async () => {
  const f = fixture(); const events: string[] = [];
  try {
    const path = f.binary(f.pathBinary);
    const first = await connectCodex(f.config, { createClient: () => new Client(events) });
    assert.equal(first.candidate.binary, path); first.client.close();
    const managed = f.binary(f.managed); events.length = 0;
    const second = await connectCodex(first.config, { createClient: () => new Client(events) });
    assert.equal(second.candidate.binary, managed); assert.equal(second.candidate.source, 'managed');
    assert.equal(second.fallback, false); assert.equal(second.changed, true);
    assert.deepEqual(events, [`connect:${managed}`, `probe:${managed}`]);
    assert.deepEqual(second.config.codexSelection, { mode: 'auto', source: 'managed' });
    assert.equal(first.config.codexBinary, path); second.client.close();
  } finally { f.close(); }
});

test('cancelling during native initialization closes that client without probing or falling back', async () => {
  const f = fixture(); const events: string[] = []; const clients: Client[] = []; const controller = new AbortController();
  try {
    const managed = f.binary(f.managed); f.binary(f.pathBinary); const before = structuredClone(f.config);
    class CancelClient extends Client {
      override async connect(binary: string): Promise<void> { await super.connect(binary); controller.abort(); }
    }
    await assert.rejects(connectCodex(f.config, { signal: controller.signal, createClient: () => {
      const client = new CancelClient(events); clients.push(client); return client;
    } }), /cancel/iu);
    assert.equal(clients.length, 1); assert.equal(clients[0]!.closed, true);
    assert.equal(events.some(event => event.startsWith('probe:')), false);
    assert.equal(events.filter(event => event.startsWith('connect:')).length, 1);
    assert.equal(clients[0]!.binary, managed); assert.deepEqual(f.config, before);
  } finally { f.close(); }
});

test('a cancelled connection attempt never constructs a native client', async () => {
  const f = fixture(); const controller = new AbortController(); let clients = 0;
  try {
    controller.abort();
    await assert.rejects(connectCodex(f.config, { signal: controller.signal, createClient: () => {
      clients++; return new Client([]);
    } }), /cancel/iu);
    assert.equal(clients, 0);
  } finally { f.close(); }
});

test('cancelling a read-only probe never publishes its candidate or attempts fallback', async () => {
  const f = fixture(); const events: string[] = []; const clients: Client[] = []; const controller = new AbortController();
  try {
    f.binary(f.managed); f.binary(f.pathBinary); const before = structuredClone(f.config);
    class CancelClient extends Client {
      override async probeReadOnly(): Promise<boolean> { const result = await super.probeReadOnly(); controller.abort(); return result; }
    }
    await assert.rejects(connectCodex(f.config, { signal: controller.signal, createClient: () => {
      const client = new CancelClient(events); clients.push(client); return client;
    } }), /cancel/iu);
    assert.equal(clients.length, 1); assert.equal(clients[0]!.closed, true); assert.deepEqual(f.config, before);
  } finally { f.close(); }
});

test('cancellation does not wait for an unresponsive native handshake to settle', { timeout: 1000 }, async () => {
  const f = fixture(); const events: string[] = []; const clients: Client[] = []; const controller = new AbortController();
  try {
    f.binary(f.managed);
    class WaitingClient extends Client {
      override async connect(binary: string): Promise<void> {
        await super.connect(binary);
        queueMicrotask(() => controller.abort());
        await new Promise<void>(() => { /* A lost transport need not complete its pending handshake. */ });
      }
    }
    await assert.rejects(connectCodex(f.config, { signal: controller.signal, createClient: () => {
      const client = new WaitingClient(events); clients.push(client); return client;
    } }), /cancel/iu);
    assert.equal(clients.length, 1); assert.equal(clients[0]!.closed, true);
    assert.equal(events.some(event => event.startsWith('probe:')), false);
  } finally { f.close(); }
});

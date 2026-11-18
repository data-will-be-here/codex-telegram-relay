import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexClient, RpcError } from '../src/codex.js';
import { findCodex } from '../src/config.js';
import { object, string, type Json } from '../src/types.js';
import { temporary } from './helpers.js';

test('isolated native interrupt ends the exact active turn and the same thread accepts a following turn', {
  skip: process.env.CODEX_RELAY_NATIVE_STOP !== '1', timeout: 45_000,
}, async () => {
  const temp = temporary(); const home = join(temp.dir, 'codex'); const project = join(temp.dir, 'project');
  mkdirSync(home); mkdirSync(project);
  const native = new CodexClient(); let child: ChildProcessWithoutNullStreams | undefined; let sequence = 0;
  let requests = 0; let stalled: ServerResponse | undefined;
  const urls: string[] = [];
  const events: { method: string; params: Json }[] = [];
  const records: { method: string; params: Json }[] = [];
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const server = createServer((request, response) => {
    urls.push(request.url ?? '');
    request.resume();
    if (!request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    const send = (event: Json) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: `resp-${requests}` } });
    if (requests === 1) { stalled = response; return; }
    send({ type: 'response.output_item.done', item: { id: 'next-message', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'NEXT_OK' }] } });
    send({ type: 'response.completed', response: { id: `resp-${requests}`, usage: {
      input_tokens: 1, output_tokens: 1, total_tokens: 2,
    } } });
    response.end();
  });
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!predicate() && Date.now() < deadline) await delay(20);
    assert.equal(predicate(), true, `${label}; local URLs=${JSON.stringify(urls)}; errors=${JSON.stringify(events.filter(event => event.method === 'error').map(event => event.params))}`);
  };
  const rpc = (method: string, params: Json): Promise<unknown> => new Promise((resolve, reject) => {
    records.push({ method, params }); const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new RpcError(`Native timeout: ${method}`, true)); }, 10_000);
    pending.set(id, { resolve, reject, timer }); child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  native.call = rpc;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const configFile = join(home, 'config.toml');
    const config = `model = "gpt-5.2"\nmodel_provider = "relay_local_test"\ndefault_permissions = ":workspace"\napproval_policy = "on-request"\n[model_providers.relay_local_test]\nname = "Local test"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`;
    writeFileSync(configFile, config);
    child = spawn(findCodex(), ['app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: 'pipe', windowsHide: true });
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      let message: Json; try { message = object(JSON.parse(line)); } catch { return; }
      if (message.method && message.id === undefined) {
        const method = string(message.method); const params = object(message.params);
        events.push({ method, params }); native.emit('notification', method, params); return;
      }
      const entry = pending.get(Number(message.id)); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(Number(message.id));
      if (message.error) entry.reject(new RpcError(JSON.stringify(message.error), false)); else entry.resolve(message.result);
    });
    await rpc('initialize', { clientInfo: { name: 'relay_stop_qualification', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const created = await native.createThread(project, 'relay-stop-qualification'); const id = string(created.id); assert.ok(id);
    await native.setThreadName(id, 'Isolated stop qualification');
    const first = object(object(await native.start(id, 'First local test turn')).turn); const firstId = string(first.id); assert.ok(firstId);
    await waitFor(() => !!stalled || events.some(event => event.method === 'turn/completed'), 'the first real native turn reached the isolated local model');
    assert.ok(stalled, JSON.stringify(events.filter(event => ['error', 'turn/completed'].includes(event.method))));
    const completed = (turnId: string): Json | undefined => events.find(event => event.method === 'turn/completed' &&
      event.params.threadId === id && object(event.params.turn).id === turnId)?.params;
    assert.equal(completed(firstId), undefined);
    await native.interrupt(id, firstId);
    await waitFor(() => !!completed(firstId), 'interrupt emits terminal completion');
    assert.equal(object(completed(firstId)?.turn).status, 'interrupted');
    const next = object(object(await native.start(id, 'Second local test turn')).turn); const nextId = string(next.id);
    assert.ok(nextId && nextId !== firstId);
    await waitFor(() => !!completed(nextId), 'the same native thread completes a following turn');
    assert.equal(object(completed(nextId)?.turn).status, 'completed');
    const turns = await native.turns(id);
    assert.equal(turns.find(turn => turn.id === firstId)?.status, 'interrupted');
    assert.equal(turns.find(turn => turn.id === nextId)?.status, 'completed');
    assert.equal(requests, 2);
    assert.deepEqual(records.filter(record => record.method === 'turn/interrupt').map(record => record.params), [{ threadId: id, turnId: firstId }]);
    assert.equal(events.some(event => event.method === 'item/commandExecution/outputDelta'), false);
    assert.equal(readFileSync(configFile, 'utf8'), config);
  } finally {
    stalled?.destroy();
    if (child && child.exitCode === null) {
      const running = child; const exited = new Promise<void>(resolve => running.once('close', () => resolve()));
      running.stdin.end(); const timer = setTimeout(() => running.kill(), 3000); await exited; clearTimeout(timer);
    }
    for (const entry of pending.values()) clearTimeout(entry.timer);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (let attempt = 0; attempt < 8; attempt++) {
      try { temp.close(); break; } catch (error) { if (attempt === 7) throw error; await delay(300); }
    }
  }
});

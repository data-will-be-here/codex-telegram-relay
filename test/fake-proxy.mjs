// A real HTTP/WebSocket peer behind stdio, used only by transport integration tests.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
const server = http.createServer();
const wss = new WebSocketServer({ server });
const records = [];
let discoveryThreads;
const waitingThreads = new Set(['empty']);
const histories = new Map();
const historyErrors = new Map();
const pendingRequests = new Map();
let deferReplay = false;
const deferredReplays = [];
let modelPages = [{ cursor: null, response: { data: [], nextCursor: null } }];
const modelSettings = new Map();
wss.on('connection', ws => ws.on('message', bytes => {
  const message = JSON.parse(bytes.toString());
  if (!message.method) { records.push(message); pendingRequests.delete(message.id); return; }
  if (message.id === undefined) return;
  records.push(message);
  let result = {};
  if (message.method === 'test/models') modelPages = message.params.pages;
  if (message.method === 'model/list') result = modelPages.find(p => p.cursor === (message.params.cursor ?? null))?.response ?? { data: [], nextCursor: null };
  if (message.method === 'thread/settings/update') modelSettings.set(message.params.threadId, message.params);
  if (message.method === 'test/discovery') discoveryThreads = message.params.threads;
  if (message.method === 'test/waiting') waitingThreads.add(message.params.threadId);
  if (message.method === 'test/historyError') historyErrors.set(message.params.threadId, message.params.message);
  if (message.method === 'test/materialize') {
    waitingThreads.delete(message.params.threadId);
    if (message.params.turns) histories.set(message.params.threadId, message.params.turns);
  }
  if (message.method === 'thread/loaded/list') result = { data: ['a', 'b', 'worker', 'empty', 'ephemeral'] };
  if (message.method === 'thread/loaded/list' && discoveryThreads) result = { data: discoveryThreads.map(thread => thread.id) };
  if (message.method === 'thread/read') result = { thread: { id: message.params.threadId, source: message.params.threadId === 'worker' ? { subAgent: {} } : message.params.threadId === 'a' ? 'cli' : 'vscode', cwd: process.cwd(), status: { type: 'idle' }, path: message.params.threadId === 'empty' ? null : '/synthetic/history', ephemeral: message.params.threadId === 'ephemeral' } };
  if (message.method === 'thread/read' && discoveryThreads) result = { thread: discoveryThreads.find(thread => thread.id === message.params.threadId) };
  if (message.method === 'thread/read' && result.thread && modelSettings.has(message.params.threadId)) {
    const settings = modelSettings.get(message.params.threadId);
    result.thread = { ...result.thread, model: settings.model, reasoningEffort: settings.effort };
  }
  if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId } };
  if (message.method === 'thread/turns/list') result = { data: [] };
  if (message.method === 'thread/turns/list' && histories.has(message.params.threadId)) result = { data: histories.get(message.params.threadId) };
  if (message.method === 'thread/turns/list' && message.params.threadId === 'large') result = { data: [{ id: 'large-turn', status: 'completed', items: message.params.itemsView === 'full' ? [{ type: 'commandExecution', aggregatedOutput: 'x'.repeat(17 * 1024 * 1024) }] : [{ type: 'agentMessage', phase: 'final_answer', text: 'Display summary' }] }] };
  if (message.method === 'thread/turns/list' && historyErrors.has(message.params.threadId)) {
    ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: historyErrors.get(message.params.threadId) } })); return;
  }
  if (message.method === 'thread/turns/list' && waitingThreads.has(message.params.threadId)) {
    ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: `thread ${message.params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message` } })); return;
  }
  if (message.method === 'thread/resume' && waitingThreads.has(message.params.threadId)) {
    ws.send(JSON.stringify({ id: message.id, error: { code: -32600, message: `no rollout found for thread id ${message.params.threadId}` } })); return;
  }
  if (message.method === 'test/deferReplay') deferReplay = true;
  if (message.method === 'test/records') {
    for (const request of deferredReplays.splice(0)) ws.send(JSON.stringify(request));
    result = records;
  }
  if (message.method === 'test/timeout') return;
  if (message.method === 'test/oversized') result = { output: 'x'.repeat(17 * 1024 * 1024) };
  if (message.method === 'test/request') {
    const request = message.params.request ?? { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'a', command: 'echo safe' } };
    pendingRequests.set(request.id, request);
    if (message.params.emit !== false) ws.send(JSON.stringify(request));
  }
  if (message.method === 'test/resolved') {
    pendingRequests.delete('approval-1');
    ws.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'a', requestId: 'approval-1' } }));
  }
  if (message.method === 'test/notification') {
    if (message.params.method === 'serverRequest/resolved') pendingRequests.delete(message.params.params.requestId);
    if (message.params.method === 'turn/completed') {
      for (const [id, request] of pendingRequests) if (request.params.threadId === message.params.params.threadId && request.params.turnId === message.params.params.turn.id) pendingRequests.delete(id);
    }
    ws.send(JSON.stringify({ method: message.params.method, params: message.params.params }));
  }
  if (message.method === 'test/stream') {
    const params = { threadId: 'a', turnId: 'turn-1' };
    ws.send(JSON.stringify({ method: 'item/started', params: { ...params, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '' } } }));
    ws.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'answer', delta: 'Streamed answer' } }));
    ws.send(JSON.stringify({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Streamed answer' } } }));
  }
  ws.send(JSON.stringify({ id: message.id, result }));
  if (message.method === 'thread/resume') {
    for (const request of pendingRequests.values()) if (request.params.threadId === message.params.threadId) {
      if (deferReplay) deferredReplays.push(request);
      else ws.send(JSON.stringify(request));
    }
  }
}));
server.listen(0, '127.0.0.1', () => {
  const socket = net.connect(server.address().port, '127.0.0.1');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('close', () => { wss.close(); server.close(); });
});

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
wss.on('connection', ws => ws.on('message', bytes => {
  const message = JSON.parse(bytes.toString());
  if (!message.method) { records.push(message); return; }
  if (message.id === undefined) return;
  records.push(message);
  let result = {};
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
  if (message.method === 'test/records') result = records;
  if (message.method === 'test/timeout') return;
  if (message.method === 'test/oversized') result = { output: 'x'.repeat(17 * 1024 * 1024) };
  if (message.method === 'test/request') ws.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'a', command: 'echo safe' } }));
  if (message.method === 'test/resolved') ws.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'a', requestId: 'approval-1' } }));
  if (message.method === 'test/stream') {
    const params = { threadId: 'a', turnId: 'turn-1' };
    ws.send(JSON.stringify({ method: 'item/started', params: { ...params, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '' } } }));
    ws.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { ...params, itemId: 'answer', delta: 'Streamed answer' } }));
    ws.send(JSON.stringify({ method: 'item/completed', params: { ...params, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Streamed answer' } } }));
  }
  ws.send(JSON.stringify({ id: message.id, result }));
}));
server.listen(0, '127.0.0.1', () => {
  const socket = net.connect(server.address().port, '127.0.0.1');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('close', () => { wss.close(); server.close(); });
});

// A real HTTP/WebSocket peer behind stdio, used only by transport integration tests.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
const server = http.createServer();
const wss = new WebSocketServer({ server });
const records = [];
wss.on('connection', ws => ws.on('message', bytes => {
  const message = JSON.parse(bytes.toString());
  if (!message.method) { records.push(message); return; }
  if (message.id === undefined) return;
  records.push(message);
  let result = {};
  if (message.method === 'thread/loaded/list') result = { data: ['a', 'b', 'worker', 'empty', 'ephemeral'] };
  if (message.method === 'thread/read') result = { thread: { id: message.params.threadId, source: message.params.threadId === 'worker' ? { subAgent: {} } : message.params.threadId === 'a' ? 'cli' : 'vscode', cwd: process.cwd(), status: { type: 'idle' }, path: message.params.threadId === 'empty' ? null : '/synthetic/history', ephemeral: message.params.threadId === 'ephemeral' } };
  if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId } };
  if (message.method === 'thread/turns/list') result = { data: [] };
  if (message.method === 'thread/turns/list' && message.params.threadId === 'large') result = { data: [{ id: 'large-turn', status: 'completed', items: message.params.itemsView === 'full' ? [{ type: 'commandExecution', aggregatedOutput: 'x'.repeat(17 * 1024 * 1024) }] : [{ type: 'agentMessage', phase: 'final_answer', text: 'Display summary' }] }] };
  if (message.method === 'thread/turns/list' && message.params.threadId === 'empty') {
    ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'thread empty is not materialized yet; thread/turns/list is unavailable before first user message' } })); return;
  }
  if (message.method === 'test/records') result = records;
  if (message.method === 'test/timeout') return;
  if (message.method === 'test/oversized') result = { output: 'x'.repeat(17 * 1024 * 1024) };
  if (message.method === 'test/request') ws.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'a', command: 'echo safe' } }));
  if (message.method === 'test/resolved') ws.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'a', requestId: 'approval-1' } }));
  ws.send(JSON.stringify({ id: message.id, result }));
}));
server.listen(0, '127.0.0.1', () => {
  const socket = net.connect(server.address().port, '127.0.0.1');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('close', () => { wss.close(); server.close(); });
});

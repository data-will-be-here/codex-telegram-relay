import { open } from 'node:fs/promises';
import { array, object, string, type Json } from './types.js';

export interface AsyncQuestion { callId: string; turnId: string; questions: Json[]; needsTerminal?: boolean; }

/** Some host tools never appear in app-server items. Read only their bounded, public question payloads. */
export class AsyncQuestionReader {
  private position = 0;
  private context = '';
  private remainder = Buffer.alloc(0);
  private dropping = false;
  private pending = new Map<string, AsyncQuestion>();
  private recoveryGap = false;

  async read(path: string, turnId: string, startedAtMs: number): Promise<AsyncQuestion[]> {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Invalid native session journal.');
      const context = `${path}/${turnId}`;
      if (context !== this.context || stat.size < this.position) {
        this.context = context; this.position = Math.max(0, stat.size - 8 * 1024 * 1024);
        this.remainder = Buffer.alloc(0); this.dropping = this.position > 0; this.pending.clear();
        this.recoveryGap = this.position > 0;
      }
      const chunk = Buffer.alloc(Math.min(stat.size - this.position, 8 * 1024 * 1024));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, this.position);
      this.position += bytesRead;
      const data = Buffer.concat([this.remainder, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
        if (!this.dropping && end - start <= 256 * 1024) this.record(data.subarray(start, end).toString('utf8'), turnId, startedAtMs);
        this.dropping = false; start = end + 1;
      }
      this.remainder = Buffer.from(data.subarray(start));
      if (this.remainder.length > 256 * 1024) { this.remainder = Buffer.alloc(0); this.dropping = true; }
      return [...this.pending.values(), ...(this.recoveryGap ? [{ callId: `recovery-gap/${turnId}`, turnId, questions: [], needsTerminal: true }] : [])];
    } finally { await file.close(); }
  }

  private record(line: string, turnId: string, startedAtMs: number): void {
    // Avoid parsing unrelated command output or internal reasoning records.
    if (!line.includes('request_user_input_async') && !line.includes('send_user_message_question_reply')) return;
    let record: Json;
    try { record = object(JSON.parse(line)); } catch { return; }
    const timestamp = Date.parse(string(record.timestamp));
    if (!Number.isFinite(timestamp) || timestamp < startedAtMs || record.type !== 'response_item') return;
    const payload = object(record.payload);
    if (payload.type === 'function_call' && payload.name === 'request_user_input_async') {
      const callId = string(payload.call_id);
      if (!callId || callId.length > 200 || this.pending.size >= 32) return;
      try {
        const args = object(JSON.parse(string(payload.arguments)));
        const questions = array(args.questions).map(object);
        if (questions.length < 1 || questions.length > 10 || JSON.stringify(questions).length > 18_000 ||
            questions.some(q => !string(q.title) || q.isSecret === true || array(q.options).length > 10 || array(q.options).some(o => !string(o)))) {
          this.pending.set(callId, { callId, turnId, questions: [], needsTerminal: true }); return;
        }
        this.pending.set(callId, { callId, turnId, questions: questions.map((q, index) => ({ ...q, id: String(index) })) });
      } catch { this.pending.set(callId, { callId, turnId, questions: [], needsTerminal: true }); }
    } else if (payload.type === 'message' && payload.role === 'user') {
      for (const content of array(payload.content).map(object)) {
        const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/u.exec(string(content.text).trim());
        if (!match) continue;
        try {
          for (const reply of array(JSON.parse(match[1]!)).map(object)) {
            const id = array(JSON.parse(string(reply.questionItemId)));
            if (id[0] !== 'request_user_input_async') continue;
            const pending = this.pending.get(string(id[1]));
            if (!pending) continue;
            pending.questions = pending.questions.filter(q => string(q.id) !== String(id[2]));
            if (!pending.questions.length) this.pending.delete(pending.callId);
          }
        } catch { /* Ordinary text is not a native question answer. */ }
      }
    }
  }
}

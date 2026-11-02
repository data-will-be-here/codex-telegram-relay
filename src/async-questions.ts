import { open } from 'node:fs/promises';
import { array, object, string, type Json } from './types.js';

export interface AsyncQuestion { callId: string; turnId: string; questions: Json[]; askedAtMs?: number; needsTerminal?: boolean; reason?: 'oversized' | 'capacity'; }

/** Scan journals incrementally in bounded chunks; retain only public host question payloads. */
export class AsyncQuestionReader {
  private position = 0;
  private context = '';
  private sinceMs = 0;
  private activeTurn = '';
  private remainder = Buffer.alloc(0);
  private dropping = false;
  private pending = new Map<string, AsyncQuestion>();
  private notices = new Map<string, AsyncQuestion>();
  private answered = new Set<string>();

  async read(path: string, turnId: string, startedAtMs: number, answeredCallIds: readonly string[] = []): Promise<AsyncQuestion[]> {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Invalid native session journal.');
      const context = path;
      const answered = new Set(answeredCallIds);
      const answerRemoved = [...this.answered].some(id => !answered.has(id));
      this.answered = answered;
      if (context !== this.context || stat.size < this.position || startedAtMs < this.sinceMs || answerRemoved) {
        this.context = context; this.position = 0; this.sinceMs = startedAtMs; this.activeTurn = '';
        this.remainder = Buffer.alloc(0); this.dropping = false; this.pending.clear(); this.notices.clear();
      }
      for (const id of answered) { this.pending.delete(id); this.notices.delete(id); }
      if (this.pending.size < 32 && [...this.notices.values()].some(q => q.reason === 'capacity' && q.callId !== 'notice-capacity')) {
        // Refill freed slots from the journal without keeping over-capacity payloads in memory.
        this.position = 0; this.remainder = Buffer.alloc(0); this.dropping = false; this.activeTurn = '';
        this.pending.clear(); this.notices.clear();
      }
      // Size limits apply to each buffer/record, not to how far back a question can be found.
      // Finish the snapshot before publishing questions: a later record may already answer one.
      const chunk = Buffer.alloc(Math.min(stat.size - this.position, 1024 * 1024));
      while (this.position < stat.size) {
        const dataOffset = this.position - this.remainder.length;
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, stat.size - this.position), this.position);
        if (!bytesRead) break;
        this.position += bytesRead;
        const data = Buffer.concat([this.remainder, chunk.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
          if (!this.dropping) {
            if (end - start <= 256 * 1024) this.record(data.subarray(start, end).toString('utf8'), turnId, this.sinceMs);
            else this.oversized(data.subarray(start, Math.min(end, start + 4096)), dataOffset + start, this.activeTurn || turnId, this.sinceMs);
          }
          this.dropping = false; start = end + 1;
        }
        this.remainder = Buffer.from(data.subarray(start));
        if (this.remainder.length > 256 * 1024) {
          if (!this.dropping) this.oversized(this.remainder.subarray(0, 4096), dataOffset + start, this.activeTurn || turnId, this.sinceMs);
          this.remainder = Buffer.alloc(0); this.dropping = true;
        }
      }
      return [...this.pending.values(), ...this.notices.values()];
    } finally { await file.close(); }
  }

  private oversized(prefix: Buffer, offset: number, turnId: string, sinceMs: number): void {
    // Native 0.166.0 writes the envelope/name before arguments. Never parse a large payload.
    const head = prefix.toString('utf8');
    const args = /(?<!\\)"arguments"\s*:/u.exec(head);
    if (!args) return;
    try {
      const record = object(JSON.parse(head.slice(0, args.index).trimEnd().replace(/,$/u, '') + '}}'));
      const payload = object(record.payload);
      const timestamp = Date.parse(string(record.timestamp));
      if (record.type !== 'response_item' || payload.type !== 'function_call' || payload.name !== 'request_user_input_async' || !Number.isFinite(timestamp) || timestamp < sinceMs) return;
      const callId = string(payload.call_id) || `oversized/${offset}`;
      if (this.answered.has(callId)) return;
      this.notice(callId, turnId, 'oversized', timestamp);
    } catch { /* Unrelated tool output must not create question notices. */ }
  }

  private notice(callId: string, turnId: string, reason: 'oversized' | 'capacity', askedAtMs: number): void {
    if (this.notices.size >= 32 && !this.notices.has(callId)) {
      this.notices.set('notice-capacity', { callId: 'notice-capacity', turnId, askedAtMs, questions: [], needsTerminal: true, reason: 'capacity' }); return;
    }
    this.notices.set(callId, { callId, turnId, askedAtMs, questions: [], needsTerminal: true, reason });
  }

  private record(line: string, turnId: string, startedAtMs: number): void {
    // Avoid parsing unrelated command output or internal reasoning records.
    if (!line.includes('request_user_input_async') && !line.includes('send_user_message_question_reply') && !line.includes('task_started')) return;
    let record: Json;
    try { record = object(JSON.parse(line)); } catch { return; }
    const payload = object(record.payload);
    if (record.type === 'event_msg' && payload.type === 'task_started' && string(payload.turn_id)) { this.activeTurn = string(payload.turn_id); return; }
    const timestamp = Date.parse(string(record.timestamp));
    if (!Number.isFinite(timestamp) || timestamp < startedAtMs || record.type !== 'response_item') return;
    turnId = this.activeTurn || turnId;
    if (payload.type === 'function_call' && payload.name === 'request_user_input_async') {
      const callId = string(payload.call_id);
      if (!callId || callId.length > 200) return;
      if (this.answered.has(callId)) return;
      if (this.pending.size >= 32 && !this.pending.has(callId)) { this.notice(callId, turnId, 'capacity', timestamp); return; }
      try {
        const args = object(JSON.parse(string(payload.arguments)));
        const questions = array(args.questions).map(object);
        if (questions.length < 1 || questions.length > 10 || JSON.stringify(questions).length > 18_000 ||
            questions.some(q => !string(q.title) || q.isSecret === true || array(q.options).length > 10 || array(q.options).some(o => !string(o)))) {
          this.pending.set(callId, { callId, turnId, askedAtMs: timestamp, questions: [], needsTerminal: true }); return;
        }
        this.pending.set(callId, { callId, turnId, askedAtMs: timestamp, questions: questions.map((q, index) => ({ ...q, id: String(index) })) });
      } catch { this.pending.set(callId, { callId, turnId, askedAtMs: timestamp, questions: [], needsTerminal: true }); }
    } else if (payload.type === 'message' && payload.role === 'user') {
      for (const content of array(payload.content).map(object)) {
        const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/u.exec(string(content.text).trim());
        if (!match) continue;
        try {
          for (const reply of array(JSON.parse(match[1]!)).map(object)) {
            const id = array(JSON.parse(string(reply.questionItemId)));
            if (id[0] !== 'request_user_input_async') continue;
            this.notices.delete(string(id[1]));
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

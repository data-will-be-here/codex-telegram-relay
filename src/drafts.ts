import { randomInt } from 'node:crypto';
import { formatMessages, withProjectHeader } from './format.js';
import { richMessages } from './rich.js';
import { TelegramError } from './telegram.js';
import { type Binding, type Json, type Telegram } from './types.js';

interface Draft {
  binding: Binding;
  turnId: string;
  itemId: string;
  phase: string;
  id: number;
  text: string;
  revision: number;
  sentRevision: number;
  sentAt: number;
  truncated: boolean;
  plain: boolean;
}

const PREVIEW_LIMIT = 12_000;
const REFRESH_MS = 15_000;

function tail(text: string, limit: number): string {
  const start = Math.max(0, text.length - limit);
  // Never start with the low half of a UTF-16 surrogate pair.
  return text.slice(start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!) ? start + 1 : start);
}

/** Ephemeral previews only. The caller serializes flushOne with permanent outbox sends. */
export class Drafts {
  private pending = new Map<string, Draft>();
  private nextSendAt = 0;
  private richSupported = true;
  private flushing = false;

  constructor(private readonly telegram: Telegram, private readonly ownerId: number, private readonly now = Date.now) {}

  begin(binding: Binding, turnId: string, itemId: string, phase: string, text = ''): void {
    if (!turnId || !itemId || !['', 'commentary', 'partial_answer', 'final_answer'].includes(phase)) return;
    const previous = this.pending.get(binding.threadId);
    if (previous?.turnId === turnId && previous.itemId === itemId && previous.binding.topicId === binding.topicId) return;
    if (!previous && this.pending.size >= 64) return;
    this.pending.set(binding.threadId, {
      binding, turnId, itemId, phase, id: randomInt(1, 2 ** 48), text: tail(text, PREVIEW_LIMIT),
      revision: text ? 1 : 0, sentRevision: 0, sentAt: 0, truncated: text.length > PREVIEW_LIMIT, plain: false,
    });
  }

  append(threadId: string, turnId: string, itemId: string, delta: string): void {
    const draft = this.pending.get(threadId);
    if (!draft || draft.turnId !== turnId || draft.itemId !== itemId || !delta) return;
    const combined = draft.text + tail(delta, PREVIEW_LIMIT);
    draft.truncated ||= delta.length > PREVIEW_LIMIT || combined.length > PREVIEW_LIMIT;
    draft.text = tail(combined, PREVIEW_LIMIT);
    draft.revision++;
  }

  finish(threadId: string, turnId?: string, itemId?: string): void {
    const draft = this.pending.get(threadId);
    if (draft && (turnId === undefined || draft.turnId === turnId) && (itemId === undefined || draft.itemId === itemId)) this.pending.delete(threadId);
  }

  clear(): void { this.pending.clear(); }

  async flushOne(allowed: (binding: Binding, turnId: string, phase: string) => Promise<boolean>): Promise<boolean> {
    if (this.flushing || this.now() < this.nextSendAt) return false;
    const draft = [...this.pending.values()].find(d => d.text.trim() &&
      (d.revision !== d.sentRevision || this.now() - d.sentAt >= REFRESH_MS));
    if (!draft) return false;
    this.flushing = true;
    try {
      if (!await allowed(draft.binding, draft.turnId, draft.phase)) { this.finish(draft.binding.threadId, draft.turnId, draft.itemId); return false; }
      // Completion, detach, mode changes and disconnect can happen during the native scope check.
      if (this.pending.get(draft.binding.threadId) !== draft) return false;
      const revision = draft.revision;
      const source = (draft.truncated ? '… Live preview: latest part\n\n' : '') + draft.text;
      const params: Json = { chat_id: this.ownerId, message_thread_id: draft.binding.topicId, draft_id: draft.id };
      const rich = this.richSupported && !draft.plain ? richMessages(source, draft.binding.cwd, true) : undefined;
      let method: string;
      if (rich?.length) {
        // A draft has only one message. Preview its latest part; the durable final retains every part.
        method = 'sendRichMessageDraft';
        params.rich_message = rich.at(-1)!.richMessage;
      } else {
        method = 'sendMessageDraft';
        const chunk = formatMessages(source, true, 3500).at(-1)!;
        Object.assign(params, withProjectHeader(chunk, draft.binding.cwd));
      }
      // One budget for all topics, preserved across reconnects. No sleeps in the control-event path.
      this.nextSendAt = this.now() + 1000;
      try {
        await this.telegram.call(method, params);
        draft.sentRevision = revision;
        draft.sentAt = this.now();
      } catch (error) {
        if (error instanceof TelegramError && error.status === 429) {
          this.nextSendAt = this.now() + Math.max(error.retryAfter ?? 3, 1) * 1000;
        } else if (method === 'sendRichMessageDraft' && error instanceof TelegramError && [400, 404].includes(error.status)) {
          if (/unknown method|method (?:is )?not found|not supported|unsupported/iu.test(error.message)) this.richSupported = false;
          draft.plain = true;
        } else {
          // Preview failures never mark permanent deliveries uncertain or trigger a native reconnect.
          this.finish(draft.binding.threadId, draft.turnId, draft.itemId);
        }
      }
      if (this.pending.get(draft.binding.threadId) === draft) {
        this.pending.delete(draft.binding.threadId);
        this.pending.set(draft.binding.threadId, draft);
      }
      return true;
    } catch {
      // A failed native scope check is not permission to forward a preview.
      this.finish(draft.binding.threadId, draft.turnId, draft.itemId);
      return false;
    } finally { this.flushing = false; }
  }
}

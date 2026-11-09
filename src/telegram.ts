import { setTimeout as delay } from 'node:timers/promises';
import { integer, object, string, type Json, type Telegram } from './types.js';
import { type State, type Delivery, type DeliveryContext, type RichDeliveryPart } from './state.js';
import { allowedSessionDirectory, type Config } from './config.js';
import { formatMessages, withoutFormatting, projectHeader, withProjectHeader, type FormattedText } from './format.js';
import { approvalParts } from './approvals.js';
import { AttachmentError, MAX_ATTACHMENT_BYTES } from './attachments.js';
import { richMessages, type RichPart } from './rich.js';
import { WIDGET_HTML, widgetData } from './widget-template.js';
import { type WidgetDeliveryGuard } from './widget-types.js';
export { splitMessage } from './format.js';

export class TelegramError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number, readonly notSent = false) { super(message); }
}

function failedBeforeConnect(error: unknown): boolean {
  const connectFailure = (value: unknown): boolean => {
    const failure = object(value); const code = string(failure.code);
    return code === 'UND_ERR_CONNECT_TIMEOUT' || ['ENOTFOUND', 'EAI_AGAIN'].includes(code) && failure.syscall === 'getaddrinfo' ||
      ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code) && failure.syscall === 'connect';
  };
  const cause = object(object(error).cause);
  return Array.isArray(cause.errors) && cause.errors.length > 0 ? cause.errors.every(connectFailure) : connectFailure(cause);
}

export function isMissingTopic(error: unknown): error is TelegramError {
  return error instanceof TelegramError && error.status === 400 && /message thread not found|message_thread_id.*invalid|TOPIC_DELETED|TOPIC_ID_INVALID/iu.test(error.message);
}

export class TelegramClient implements Telegram {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async upload(method: 'sendVideo' | 'sendDocument', params: Json, file: { name: string; bytes: Buffer }, signal: AbortSignal): Promise<unknown> {
    if (method !== 'sendVideo' && method !== 'sendDocument') throw new Error('Invalid upload method.');
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    form.set(method === 'sendVideo' ? 'video' : 'document', new Blob([new Uint8Array(file.bytes)], { type: method === 'sendVideo' ? 'video/mp4' : 'application/octet-stream' }), file.name);
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', body: form, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      const result = object(JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString('utf8')));
      if (!response.ok || result.ok !== true) {
        throw new TelegramError(`Telegram ${method} failed (${integer(result.error_code) ?? response.status}): ${string(result.description).replaceAll(this.token, '[redacted]').slice(0, 200)}`, integer(result.error_code) ?? response.status, integer(object(result.parameters).retry_after));
      }
      return result.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError(`Telegram ${method} connection failed. Delivery may be uncertain.`, 0);
    }
  }
  async call(method: string, params: Json = {}): Promise<unknown> {
    if (!/^[A-Za-z]+$/u.test(method)) throw new Error('Invalid Telegram method.');
    let responseReceived = false;
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 35_000 : method.endsWith('MessageDraft') ? 3000 : /^(?:get|set)MyCommands$/u.test(method) ? 5000 : 15_000), redirect: 'error',
      });
      responseReceived = true;
      const body = (await boundedBody(response, 2 * 1024 * 1024)).toString('utf8');
      const result = object(JSON.parse(body));
      if (!response.ok || result.ok !== true) {
        const retry = integer(object(result.parameters).retry_after);
        throw new TelegramError(`Telegram ${method} failed (${integer(result.error_code) ?? response.status}): ${string(result.description).replaceAll(this.token, '[redacted]').slice(0, 200)}`, integer(result.error_code) ?? response.status, retry);
      }
      return result.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      // Never preserve an HTTP error cause: it can contain the credential-bearing URL.
      const notSent = !responseReceived && failedBeforeConnect(error);
      throw new TelegramError(notSent ? `Telegram ${method} could not connect. No request was sent.` :
        `Telegram ${method} connection failed. Delivery may be uncertain.`, 0, undefined, notSent);
    }
  }
  async download(fileId: string): Promise<Buffer> {
    try {
      const file = object(await this.call('getFile', { file_id: fileId }));
      const path = string(file.file_path);
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*(?:\.[a-zA-Z0-9]+)?$/u.test(path) || Number(file.file_size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('Invalid or oversized Telegram file.');
      const response = await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(45_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Download failed.'); }
      return await boundedBody(response, MAX_ATTACHMENT_BYTES);
    } catch {
      // A failed download has no native effect and must never leak its credential-bearing URL.
      throw new AttachmentError('Telegram attachment download failed or exceeded 20 MiB. No instruction was sent.');
    }
  }
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty HTTP response.');
  try {
    if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('HTTP response too large.');
    let length = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('HTTP response too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

class DeliveryCancelled extends Error {}

export class Outbox {
  private widgetSending = false;
  private widgetNextAt = 0;
  private widgetWrites = new Map<string, () => void>();
  private persistWidget(id: string, write: () => void): void {
    try { write(); }
    catch { this.widgetWrites.set(id, write); }
  }
  private acceptWidgetReceipt(id: string, revision: number, messageId: number): void {
    this.persistWidget(id, () => this.state.widgetDelivered(id, revision, messageId, Date.now()));
  }
  constructor(private readonly state: State, private readonly telegram: Telegram,
    private readonly config: Pick<Config, 'ownerId' | 'roots' | 'sessionScope' | 'ignoredThreadIds' | 'newSessions'>, private readonly interval = 1100) {}
  private allowed(context: DeliveryContext): boolean {
    if (context.ownerNotice) return true;
    const binding = context.topicId === null ? context.sourceThreadId ? this.state.binding(context.sourceThreadId) : undefined : this.state.topic(context.topicId);
    if (context.topicId !== null && !binding) return context.ownerNotice;
    if (context.sourceThreadId && this.config.ignoredThreadIds?.includes(context.sourceThreadId)) return false;
    if (context.topicId !== null && context.sourceThreadId && binding?.threadId !== context.sourceThreadId) return false;
    if (binding && this.config.ignoredThreadIds?.includes(binding.threadId)) return false;
    return [context.projectCwd, binding?.cwd].every(cwd => !cwd || allowedSessionDirectory(cwd, this.config, this.state.ownsScratch(cwd, context.sourceThreadId ?? binding?.threadId)));
  }
  private check(delivery: Delivery): void {
    if (this.allowed(delivery) && (!delivery.key.startsWith('prompt/approval/') || this.state.approvalDeliveryActive(delivery.key))) return;
    this.state.cancelDelivery(delivery.id);
    throw new DeliveryCancelled();
  }
  /** Durable low-priority widget queue, serialized by the same sender as ordinary output. */
  async flushWidget(guard: WidgetDeliveryGuard): Promise<boolean> {
    const now = Date.now();
    if (this.widgetSending || now < this.widgetNextAt) return false;
    const pendingWrite = this.widgetWrites.entries().next().value;
    if (pendingWrite) {
      const [id, write] = pendingWrite;
      try { write(); this.widgetWrites.delete(id); return true; }
      catch { this.widgetNextAt = now + 3000; return false; }
    }
    let card = this.state.nextWidgetDelivery(guard.generation, now);
    if (!card) return false;
    this.widgetSending = true;
    try {
      const context = { topicId: card.binding.topicId, projectCwd: card.binding.cwd, sourceThreadId: card.binding.threadId, ownerNotice: false };
      const binding = this.state.binding(card.binding.threadId);
      if (!this.allowed(context) || binding?.topicId !== card.binding.topicId || binding.cwd !== card.binding.cwd) {
        this.state.widgetResult(card.id, 'retired'); return false;
      }
      if (!await guard.allowed(card)) {
        this.state.widgetResult(card.id, card.delivery, now + 5000); return false;
      }
      // Events, detach or completion may have arrived during native authorization.
      const fresh = this.state.widgetCards(card.binding.threadId).find(current => current.id === card!.id);
      if (!fresh || fresh.generation !== guard.generation || !['new', 'active'].includes(fresh.delivery) ||
          fresh.delivery === 'new' && fresh.snapshot.finishedAt !== null || !this.allowed(context)) return false;
      card = fresh;
      const editing = card.messageId !== null;
      const data = widgetData(card);
      if (!this.state.claimWidget(card.id, editing)) return false;
      this.widgetNextAt = now + 1000;
      try {
        if (editing) {
          const result = await this.telegram.call('editMessageWidgetData', { chat_id: this.config.ownerId, message_id: card.messageId, chat_data: data });
          if (result !== true) throw new TelegramError('Widget edit receipt was not confirmed.', 0);
          this.acceptWidgetReceipt(card.id, card.revision, card.messageId!);
        } else {
          const result = object(await this.telegram.call('sendWidget', { chat_id: this.config.ownerId, message_thread_id: card.binding.topicId,
            html: WIDGET_HTML, chat_data: data, allow_queries: false, is_shared: false, disable_notification: true,
            reply_markup: { inline_keyboard: [[{ text: 'Classic mode', callback_data: `v:${card.token}:c` }]] } }));
          const id = integer(result.message_id);
          if (!id || id < 1) throw new TelegramError('Widget send receipt was not confirmed.', 0);
          this.acceptWidgetReceipt(card.id, card.revision, id);
        }
      } catch (error) {
        if (editing && error instanceof TelegramError && error.status === 400 && /message is not modified/iu.test(error.message)) {
          this.acceptWidgetReceipt(card.id, card.revision, card.messageId!);
        } else if (error instanceof TelegramError && error.notSent) {
          const next = Date.now() + 3000;
          this.widgetNextAt = next; this.persistWidget(card.id, () => this.state.widgetResult(card!.id, editing ? 'active' : 'new', next, 'before-connect'));
        } else if (error instanceof TelegramError && error.status === 429) {
          const next = Date.now() + Math.max(1, error.retryAfter ?? 3) * 1000;
          this.widgetNextAt = next; this.persistWidget(card.id, () => this.state.widgetResult(card!.id, editing ? 'active' : 'new', next));
        } else if (editing && (!(error instanceof TelegramError) || error.status === 0 || error.status >= 500)) {
          // An edit writes a complete revision to a known message; retries cannot create another card.
          this.persistWidget(card.id, () => this.state.widgetResult(card!.id, 'active', Date.now() + 5000));
        } else {
          const definite = error instanceof TelegramError && error.status >= 400 && error.status < 500;
          const failure = error instanceof TelegramError ? (error.message.includes('receipt was not confirmed') ? 'missing-receipt' :
            error.status === 0 ? 'transport-outcome-unknown' : `http-${error.status}`) : 'unexpected-failure';
          this.persistWidget(card.id, () => {
            this.state.widgetResult(card!.id, definite ? 'disabled' : 'uncertain', 0, failure);
            this.state.setViewMode(card!.binding.threadId, 'classic');
            this.state.enqueue(`attention/widgets/${card!.id}`, card!.binding.topicId, definite ?
            'Widgets are unavailable for this session. Classic view selected; replies and approvals continue normally. Use /view widgets to try again when widget support is available.' :
            'Widget delivery could not be confirmed and will not be repeated. Classic view selected for following turns; replies and approvals continue normally. Use /view widgets to enable cards again.');
            const progress = this.state.widgetCard(card!.binding.threadId, card!.turnId)?.snapshot.summary;
            if (progress) this.state.enqueue(`attention/widget-progress/${card!.id}`, card!.binding.topicId, `Latest progress: ${progress}`, null, card!.binding.cwd, card!.binding.threadId);
          });
        }
      }
      return true;
    } finally { this.widgetSending = false; }
  }
  async flushOne(): Promise<boolean> {
    let cancelled = false;
    for (const context of this.state.deliveryContexts()) if (!this.allowed(context)) {
      this.state.cancelContext(context); cancelled = true;
    }
    const delivery = this.state.next();
    if (!delivery) return cancelled;
    const binding = delivery.topicId === null ? undefined : this.state.topic(delivery.topicId);
    this.state.sending(delivery.id);
    try {
      // Approval cards fence literal commands/diffs and escape justification text before rendering.
      const project = delivery.projectCwd ?? binding?.cwd;
      const approval = delivery.key.startsWith('prompt/approval/');
      const review = !delivery.richPlan && approval ? approvalParts(delivery.text, delivery.key.split('/').at(-1)!, project, delivery.sessionName, delivery.projectLabel) : undefined;
      if (review) {
        delivery.richPlan = review.map(part => ({ method: 'sendMessage', params: { ...part, link_preview_options: { is_disabled: true } } }));
        this.state.saveRichPlan(delivery.id, delivery.richPlan);
      }
      if (approval && delivery.richPlan) {
        let changed = false;
        for (const part of delivery.richPlan.slice(delivery.nextPart)) {
          if (!Array.isArray(part.params.entities)) continue;
          for (const value of part.params.entities) {
            const entity = object(value);
            if (entity.type === 'spoiler') { entity.type = 'expandable_blockquote'; changed = true; }
          }
        }
        if (changed) this.state.saveRichPlan(delivery.id, delivery.richPlan);
      }
      const rich = !delivery.richPlan && /^(?:final|reply|assistant)\//u.test(delivery.key) ? richMessages(delivery.text, project, false, delivery.sessionName, delivery.projectLabel) : undefined;
      if (delivery.richPlan || rich) {
        const result = await this.richDelivery(delivery, rich, project, approval);
        if (result.complete) {
          if (approval) this.state.completeApprovalDelivery(delivery.id, delivery.richPlan!.length);
          else this.state.delivered(delivery.id, result.messageId);
        }
        return true;
      }
      const limit = 3500 - projectHeader(project, delivery.sessionName, delivery.projectLabel).length - 2;
      const chunks: (FormattedText & { plain?: boolean })[] = formatMessages(delivery.text, /^(?:(?:final|reply|assistant)\/|prompt\/approval\/)/u.test(delivery.key), limit);
      let messageId: number | null = null;
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        const { text, entities } = withProjectHeader(chunk, project, delivery.sessionName, delivery.projectLabel);
        const params: Json = { chat_id: this.config.ownerId, text };
        if (!chunk.plain && entities.length) params.entities = entities;
        if (delivery.topicId !== null) params.message_thread_id = delivery.topicId;
        if (index === chunks.length - 1 && delivery.markup) params.reply_markup = delivery.markup;
        let retries = 0;
        try {
          while (true) {
            this.check(delivery);
            try { messageId = integer(object(await this.telegram.call('sendMessage', params)).message_id) ?? null; break; }
            catch (error) {
              if (!(error instanceof TelegramError) || error.status !== 429 || ++retries > 3) throw error;
              await delay(Math.min(error.retryAfter ?? 2, 60) * 1000);
            }
          }
        } catch (error) {
          // A definite 400 entity rejection sent no message. Retry only that chunk without markup.
          if (!(error instanceof TelegramError) || error.status !== 400 || chunk.plain ||
              !/can't parse entities|entity.*(?:URL|offset|length|invalid)|wrong HTTP URL/iu.test(error.message)) throw error;
          chunks.splice(index, 1, ...formatMessages(withoutFormatting(chunk), false, limit).map(part => ({ ...part, plain: true })));
          index--; continue;
        }
        if (this.interval > 0) await delay(this.interval);
      }
      this.state.delivered(delivery.id, messageId);
    } catch (error) {
      if (error instanceof DeliveryCancelled) return true;
      if (binding && isMissingTopic(error)) {
        this.state.missingTopic(binding);
        return true;
      }
      // Neither timeouts nor partial multi-part sends authorize blindly replaying a message.
      this.state.uncertain(delivery.id);
      throw error;
    }
    return true;
  }

  private async richDelivery(delivery: Delivery, rich: RichPart[] | undefined, project?: string | null, approval = false): Promise<{ messageId: number | null; complete: boolean }> {
    const parts: RichDeliveryPart[] = delivery.richPlan ?? rich!.map(part => ({
      method: 'sendRichMessage', params: { rich_message: part.richMessage }, fallback: part.fallback,
    }));
    if (!delivery.richPlan) this.state.saveRichPlan(delivery.id, parts);
    let messageId: number | null = delivery.messageId;
    for (let index = delivery.nextPart; index < parts.length; index++) {
      const part = parts[index]!;
      const params = { ...part.params, chat_id: this.config.ownerId } as Json;
      if (delivery.topicId !== null) params.message_thread_id = delivery.topicId;
      if (!approval && index === parts.length - 1 && delivery.markup) params.reply_markup = delivery.markup;
      try {
        let retries = 0;
        while (true) {
          this.check(delivery);
          try { messageId = integer(object(await this.telegram.call(part.method, params)).message_id) ?? null; break; }
          catch (error) {
            if (approval && error instanceof TelegramError && error.status === 429) {
              if (!this.state.pauseApprovalPart(delivery.id, index, Date.now() + Math.max(1, error.retryAfter ?? 2) * 1000)) throw new DeliveryCancelled();
              return { messageId, complete: false };
            }
            if (!(error instanceof TelegramError) || error.status !== 429 || ++retries > 3) throw error;
            await delay(Math.min(error.retryAfter ?? 2, 60) * 1000);
          }
        }
      } catch (error) {
        if (part.method === 'sendMessage' && Array.isArray(part.params.entities) && error instanceof TelegramError && error.status === 400 &&
            /can't parse entities|entity.*(?:URL|offset|length|invalid)|wrong HTTP URL/iu.test(error.message)) {
          delete part.params.entities;
          this.state.saveRichPlan(delivery.id, parts);
          index--; continue;
        }
        const rejectedRich = error instanceof TelegramError && [400, 404].includes(error.status) &&
          /can't parse|\bunknown method\b|\bmethod (?:is )?not found\b|\brich[ _]message.*(?:invalid|unsupported|not supported|too|limit)|\b(?:table|block).*(?:invalid|too|limit)|\bmessage is too long\b/iu.test(error.message);
        if (part.method !== 'sendRichMessage' || part.fallback === undefined || !rejectedRich || isMissingTopic(error)) throw error;
        const limit = 3500 - projectHeader(project, delivery.sessionName, delivery.projectLabel).length - 2;
        parts.splice(index, 1, ...formatMessages(part.fallback, false, limit).map(chunk => {
          const formatted = withProjectHeader(chunk, project, delivery.sessionName, delivery.projectLabel);
          return { method: 'sendMessage' as const, params: { ...formatted, link_preview_options: { is_disabled: true } } };
        }));
        this.state.saveRichPlan(delivery.id, parts);
        index--; continue;
      }
      if (approval) {
        if (messageId === null) throw new TelegramError('Approval part receipt was not confirmed.', 0);
        if (!this.state.acceptApprovalPart(delivery.id, index, messageId)) throw new DeliveryCancelled();
      } else this.state.acceptRichPart(delivery.id, index, messageId);
      if (this.interval > 0) await delay(this.interval);
      if (approval && index < parts.length - 1) return { messageId, complete: false };
    }
    return { messageId, complete: true };
  }
}

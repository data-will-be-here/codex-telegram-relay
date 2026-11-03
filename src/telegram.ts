import { setTimeout as delay } from 'node:timers/promises';
import { integer, object, string, type Json, type Telegram } from './types.js';
import { type State, type Delivery, type RichDeliveryPart } from './state.js';
import { formatMessages, withoutFormatting, projectHeader, withProjectHeader, type FormattedText } from './format.js';
import { AttachmentError, MAX_ATTACHMENT_BYTES } from './attachments.js';
import { richMessages, type RichPart } from './rich.js';
export { splitMessage } from './format.js';

export class TelegramError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}

export function isMissingTopic(error: unknown): error is TelegramError {
  return error instanceof TelegramError && error.status === 400 && /message thread not found|message_thread_id.*invalid|TOPIC_DELETED|TOPIC_ID_INVALID/iu.test(error.message);
}

export class TelegramClient implements Telegram {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async call(method: string, params: Json = {}): Promise<unknown> {
    if (!/^[A-Za-z]+$/u.test(method)) throw new Error('Invalid Telegram method.');
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 35_000 : method.endsWith('MessageDraft') ? 3000 : /^(?:get|set)MyCommands$/u.test(method) ? 5000 : 15_000), redirect: 'error',
      });
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
      throw new TelegramError(`Telegram ${method} connection failed. Delivery may be uncertain.`, 0);
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

export class Outbox {
  constructor(private readonly state: State, private readonly telegram: Telegram, private readonly ownerId: number, private readonly interval = 1100, private readonly ignoredThreadIds: readonly string[] = []) {}
  async flushOne(): Promise<boolean> {
    const delivery = this.state.next();
    if (!delivery) return false;
    const binding = delivery.topicId === null ? undefined : this.state.topic(delivery.topicId);
    if (binding && this.ignoredThreadIds.includes(binding.threadId)) { this.state.cancelDelivery(delivery.id); return true; }
    this.state.sending(delivery.id);
    try {
      // Approval cards fence literal commands/diffs and escape justification text before rendering.
      const project = delivery.projectCwd ?? binding?.cwd;
      const rich = !delivery.richPlan && /^(?:final|reply|assistant)\//u.test(delivery.key) ? richMessages(delivery.text, project) : undefined;
      if (delivery.richPlan || rich) {
        this.state.delivered(delivery.id, await this.richDelivery(delivery, rich, project));
        return true;
      }
      const limit = 3500 - projectHeader(project).length - 2;
      const chunks: (FormattedText & { plain?: boolean })[] = formatMessages(delivery.text, /^(?:(?:final|reply|assistant)\/|prompt\/approval\/)/u.test(delivery.key), limit);
      let messageId: number | null = null;
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!;
        const { text, entities } = withProjectHeader(chunk, project);
        const params: Json = { chat_id: this.ownerId, text };
        if (!chunk.plain && entities.length) params.entities = entities;
        if (delivery.topicId !== null) params.message_thread_id = delivery.topicId;
        if (index === chunks.length - 1 && delivery.markup) params.reply_markup = delivery.markup;
        let retries = 0;
        try {
          while (true) {
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

  private async richDelivery(delivery: Delivery, rich: RichPart[] | undefined, project?: string | null): Promise<number | null> {
    const parts: RichDeliveryPart[] = delivery.richPlan ?? rich!.map(part => ({
      method: 'sendRichMessage', params: { rich_message: part.richMessage }, fallback: part.fallback,
    }));
    if (!delivery.richPlan) this.state.saveRichPlan(delivery.id, parts);
    let messageId: number | null = delivery.messageId;
    for (let index = delivery.nextPart; index < parts.length; index++) {
      const part = parts[index]!;
      const params = { ...part.params, chat_id: this.ownerId } as Json;
      if (delivery.topicId !== null) params.message_thread_id = delivery.topicId;
      if (index === parts.length - 1 && delivery.markup) params.reply_markup = delivery.markup;
      try {
        let retries = 0;
        while (true) {
          try { messageId = integer(object(await this.telegram.call(part.method, params)).message_id) ?? null; break; }
          catch (error) {
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
        const limit = 3500 - projectHeader(project).length - 2;
        parts.splice(index, 1, ...formatMessages(part.fallback, false, limit).map(chunk => {
          const formatted = withProjectHeader(chunk, project);
          return { method: 'sendMessage' as const, params: { ...formatted, link_preview_options: { is_disabled: true } } };
        }));
        this.state.saveRichPlan(delivery.id, parts);
        index--; continue;
      }
      this.state.acceptRichPart(delivery.id, index, messageId);
      if (this.interval > 0) await delay(this.interval);
    }
    return messageId;
  }
}

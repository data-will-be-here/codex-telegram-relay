import { setTimeout as delay } from 'node:timers/promises';
import { integer, object, string, type Json, type Telegram } from './types.js';
import { type State } from './state.js';
import { formatMessages, withoutFormatting, projectHeader, withProjectHeader, type FormattedText } from './format.js';
export { splitMessage } from './format.js';

export class TelegramError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}

export class TelegramClient implements Telegram {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async call(method: string, params: Json = {}): Promise<unknown> {
    if (!/^[A-Za-z]+$/u.test(method)) throw new Error('Invalid Telegram method.');
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 15_000), redirect: 'error',
      });
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024) throw new Error('Telegram response exceeds the relay limit.');
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
      // Approval payloads stay verbatim so Markdown cannot conceal command/diff characters.
      const project = delivery.projectCwd ?? binding?.cwd;
      const limit = 3500 - projectHeader(project).length - 2;
      const chunks: (FormattedText & { plain?: boolean })[] = formatMessages(delivery.text, /^(?:final|reply|assistant)\//u.test(delivery.key), limit);
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
      if (binding && error instanceof TelegramError && error.status === 400 && /message thread not found|message_thread_id.*invalid|TOPIC_DELETED|TOPIC_ID_INVALID/iu.test(error.message)) {
        this.state.missingTopic(binding);
        return true;
      }
      // Neither timeouts nor partial multi-part sends authorize blindly replaying a message.
      this.state.uncertain(delivery.id);
      throw error;
    }
    return true;
  }
}

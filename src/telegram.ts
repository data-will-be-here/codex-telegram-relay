import { setTimeout as delay } from 'node:timers/promises';
import { integer, object, string, type Json, type Telegram } from './types.js';
import { type State } from './state.js';
import { formatMessages } from './format.js';
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
  constructor(private readonly state: State, private readonly telegram: Telegram, private readonly ownerId: number, private readonly interval = 1100) {}
  async flushOne(): Promise<boolean> {
    const delivery = this.state.next();
    if (!delivery) return false;
    this.state.sending(delivery.id);
    try {
      // Approval payloads stay verbatim so Markdown cannot conceal command/diff characters.
      const chunks = formatMessages(delivery.text, delivery.key.startsWith('final/'));
      let messageId: number | null = null;
      for (const [index, { text, entities }] of chunks.entries()) {
        const params: Json = { chat_id: this.ownerId, text };
        if (entities.length) params.entities = entities;
        if (delivery.topicId !== null) params.message_thread_id = delivery.topicId;
        if (index === chunks.length - 1 && delivery.markup) params.reply_markup = delivery.markup;
        let retries = 0;
        while (true) {
          try { messageId = integer(object(await this.telegram.call('sendMessage', params)).message_id) ?? null; break; }
          catch (error) {
            if (!(error instanceof TelegramError) || error.status !== 429 || ++retries > 3) throw error;
            await delay(Math.min(error.retryAfter ?? 2, 60) * 1000);
          }
        }
        if (this.interval > 0) await delay(this.interval);
      }
      this.state.delivered(delivery.id, messageId);
    } catch (error) {
      // Neither timeouts nor partial multi-part sends authorize blindly replaying a message.
      this.state.uncertain(delivery.id);
      throw error;
    }
    return true;
  }
}

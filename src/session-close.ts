import { randomBytes } from 'node:crypto';
import { State } from './state.js';
import { integer, string, type Binding, type Json, type Keyboard, type Telegram } from './types.js';

const PAGE_SIZE = 8;
const MENU_LIFETIME = 10 * 60_000;

interface CloseMenu {
  topicId: number | null;
  key: string;
  bindings: Binding[];
  page: number;
  expires: number;
}

export class SessionClose {
  private readonly menus = new Map<string, CloseMenu>();

  constructor(private readonly state: State, private readonly telegram: Telegram, private readonly ownerId: number,
    private readonly candidates: () => Binding[], private readonly closeSession: (binding: Binding) => Promise<string>) {}

  open(topicId: number | null): void {
    const token = randomBytes(16).toString('hex');
    const key = `notice/session-close/${token}`;
    const bindings = this.candidates();
    if (!bindings.length) { this.state.enqueueOwnerNotice(key, topicId, 'No saved sessions are available to close.'); return; }
    const now = Date.now();
    for (const [id, menu] of this.menus) if (menu.expires <= now || menu.topicId === topicId) this.menus.delete(id);
    if (this.menus.size >= 32) this.menus.delete(this.menus.keys().next().value!);
    const menu = { bindings, topicId, key, page: 0, expires: now + MENU_LIFETIME };
    this.menus.set(token, menu);
    this.state.enqueueOwnerNotice(key, topicId, this.description(menu), { ...this.keyboard(token, menu) });
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<void> {
    const match = /^cl:([a-f0-9]{32}):(x|p?\d+)$/u.exec(string(callback.data));
    const token = match?.[1];
    const action = match?.[2];
    const menu = token && this.menus.get(token);
    const messageId = integer(message.message_id);
    if (!token || !action || !menu || menu.expires <= Date.now() || menu.topicId !== topicId ||
        !messageId || this.state.promptMessage(menu.key) !== messageId) {
      await this.ack(callback, 'This menu expired. Send /close again.'); return;
    }
    if (action.startsWith('p')) {
      const page = Number(action.slice(1));
      if (page >= 0 && page * PAGE_SIZE < menu.bindings.length && Math.abs(page - menu.page) === 1) {
        await this.ack(callback);
        const next = { ...menu, page };
        if (await this.edit(messageId, this.description(next), this.keyboard(token, next))) menu.page = page;
      } else await this.ack(callback, 'This page has changed.');
      return;
    }
    const index = Number(action);
    const binding = menu.bindings[index];
    if (action !== 'x' && (!binding || Math.floor(index / PAGE_SIZE) !== menu.page)) {
      await this.ack(callback, 'This selection has changed. Send /close again.'); return;
    }
    this.menus.delete(token);
    await this.ack(callback);
    const result = action === 'x' ? 'Close session cancelled.' : await this.closeSession(binding!);
    if (!await this.edit(messageId, result)) this.state.enqueueOwnerNotice(`${menu.key}/result`, topicId, result);
  }

  private description(menu: CloseMenu): string {
    const pages = Math.ceil(menu.bindings.length / PAGE_SIZE);
    return 'Close a Codex session\n\nChoose a session to unload it now and archive its Codex history. Its Telegram topic stays available. Active work blocks closing.' +
      (pages > 1 ? `\n\nPage ${menu.page + 1} of ${pages}` : '');
  }

  private keyboard(token: string, menu: CloseMenu): Keyboard {
    const offset = menu.page * PAGE_SIZE;
    const rows = menu.bindings.slice(offset, offset + PAGE_SIZE).map((binding, index) => {
      const title = Array.from((binding.customTitle || binding.sessionName || binding.projectLabel || binding.title)
        .replace(/\s+/gu, ' ')).slice(0, 36).join('');
      return [{ text: `Close ${title} · ${binding.threadId.slice(0, 8)} · #${binding.topicId}`, callback_data: `cl:${token}:${offset + index}` }];
    });
    const navigation = [];
    if (menu.page > 0) navigation.push({ text: '←', callback_data: `cl:${token}:p${menu.page - 1}` });
    if (offset + PAGE_SIZE < menu.bindings.length) navigation.push({ text: '→', callback_data: `cl:${token}:p${menu.page + 1}` });
    if (navigation.length) rows.push(navigation);
    rows.push([{ text: 'Cancel', callback_data: `cl:${token}:x` }]);
    return { inline_keyboard: rows };
  }

  private async edit(messageId: number, text: string, keyboard: Keyboard = { inline_keyboard: [] }): Promise<boolean> {
    try {
      await this.telegram.call('editMessageText', { chat_id: this.ownerId, message_id: messageId, text, reply_markup: keyboard });
      return true;
    } catch { return false; }
  }

  private async ack(callback: Json, text?: string): Promise<void> {
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) }); }
    catch { /* An acknowledgement is separate from processing the selection. */ }
  }
}

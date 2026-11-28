import { randomBytes } from 'node:crypto';
import { State } from './state.js';
import { TelegramError } from './telegram.js';
import { integer, string, type Binding, type Json, type Keyboard, type Telegram } from './types.js';

const PAGE_SIZE = 8;
const MENU_LIFETIME = 10 * 60_000;

interface CloseMenu {
  topicId: number | null;
  key: string;
  bindings: Binding[];
  page: number;
  expires: number;
  busy: boolean;
}

/** Codex UUIDv7 IDs contain the session creation time. Order legacy IDs by topic. */
function createdAt(binding: Binding): number {
  const id = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.exec(binding.threadId);
  return id ? Number.parseInt(id[1]! + id[2]!, 16) : 0;
}

export class SessionClose {
  private readonly menus = new Map<string, CloseMenu>();

  constructor(private readonly state: State, private readonly telegram: Telegram, private readonly ownerId: number,
    private readonly candidates: () => Binding[], private readonly closeSession: (binding: Binding) => Promise<string>) {}

  open(topicId: number | null): void {
    const token = randomBytes(16).toString('hex');
    const key = `notice/session-close/${token}`;
    const bindings = this.candidates().sort((a, b) => createdAt(a) - createdAt(b) || a.topicId - b.topicId);
    if (!bindings.length) { this.state.enqueueOwnerNotice(key, topicId, 'No saved sessions are available to close.'); return; }
    const now = Date.now();
    for (const [id, menu] of this.menus) if (menu.expires <= now || menu.topicId === topicId) this.menus.delete(id);
    if (this.menus.size >= 32) this.menus.delete(this.menus.keys().next().value!);
    const menu = { bindings, topicId, key, page: 0, expires: now + MENU_LIFETIME, busy: false };
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
    if (menu.busy) { await this.ack(callback, 'This menu is updating.'); return; }
    const page = action.startsWith('p') ? Number(action.slice(1)) : undefined;
    if (page !== undefined && (page * PAGE_SIZE >= menu.bindings.length || Math.abs(page - menu.page) !== 1)) {
      await this.ack(callback, 'This page has changed.'); return;
    }
    const binding = this.visibleBindings(menu).find(item => String(item.topicId) === action);
    if (action !== 'x' && page === undefined && !binding) {
      await this.ack(callback, 'This selection has changed. Send /close again.'); return;
    }
    menu.busy = true;
    try {
      await this.ack(callback);
      if (page !== undefined) {
        menu.page = page;
        await this.refresh(messageId, token, menu);
        return;
      }
      const result = binding ? await this.closeSession(binding) : 'Close session cancelled.';
      const archived = binding && this.state.archivedSession(binding.threadId);
      if (archived) {
        menu.bindings = menu.bindings.filter(item => item.threadId !== binding.threadId);
        menu.page = Math.max(0, Math.min(menu.page, Math.ceil(menu.bindings.length / PAGE_SIZE) - 1));
      }
      if (binding && menu.bindings.length) {
        await this.refresh(messageId, token, menu, archived ? '' : result);
      } else {
        this.menus.delete(token);
        if (!await this.edit(messageId, result)) this.state.enqueueOwnerNotice(`${menu.key}/result`, topicId, result);
      }
    } finally { menu.busy = false; }
  }

  private description(menu: CloseMenu): string {
    const pages = Math.ceil(menu.bindings.length / PAGE_SIZE);
    return 'Close a Codex session\n\nChoose a session to unload it now and archive its Codex history. Its Telegram topic stays available. Active work blocks closing.' +
      (pages > 1 ? `\n\nPage ${menu.page + 1} of ${pages}` : '');
  }

  private keyboard(token: string, menu: CloseMenu): Keyboard {
    const rows = this.visibleBindings(menu).map(binding => {
      const title = Array.from((binding.customTitle || binding.sessionName || binding.projectLabel || binding.title)
        .replace(/\s+/gu, ' ')).slice(0, 36).join('');
      return [{ text: `Close ${title} · ${binding.threadId.slice(0, 8)} · #${binding.topicId}`, callback_data: `cl:${token}:${binding.topicId}` }];
    });
    const navigation = [];
    if (menu.page > 0) navigation.push({ text: '←', callback_data: `cl:${token}:p${menu.page - 1}` });
    if ((menu.page + 1) * PAGE_SIZE < menu.bindings.length) navigation.push({ text: '→', callback_data: `cl:${token}:p${menu.page + 1}` });
    if (navigation.length) rows.push(navigation);
    rows.push([{ text: 'Cancel', callback_data: `cl:${token}:x` }]);
    return { inline_keyboard: rows };
  }

  private visibleBindings(menu: CloseMenu): Binding[] {
    const offset = menu.page * PAGE_SIZE;
    return menu.bindings.slice(offset, offset + PAGE_SIZE);
  }

  private async refresh(messageId: number, token: string, menu: CloseMenu, status = ''): Promise<void> {
    const text = this.description(menu) + (status ? `\n\n${status}` : '');
    const keyboard = this.keyboard(token, menu);
    if (await this.edit(messageId, text, keyboard)) return;
    menu.key = `notice/session-close/${randomBytes(16).toString('hex')}`;
    this.state.enqueueOwnerNotice(menu.key, menu.topicId, text, { ...keyboard });
  }

  private async edit(messageId: number, text: string, keyboard: Keyboard = { inline_keyboard: [] }): Promise<boolean> {
    try {
      await this.telegram.call('editMessageText', { chat_id: this.ownerId, message_id: messageId, text, reply_markup: keyboard });
      return true;
    } catch (error) {
      return error instanceof TelegramError && error.status === 400 && /message is not modified/iu.test(error.message);
    }
  }

  private async ack(callback: Json, text?: string): Promise<void> {
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) }); }
    catch { /* An acknowledgement is separate from processing the selection. */ }
  }
}

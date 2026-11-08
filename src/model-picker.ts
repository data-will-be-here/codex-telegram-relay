import { randomBytes, randomUUID } from 'node:crypto';
import { RpcError } from './codex.js';
import { withProjectHeader } from './format.js';
import { type State } from './state.js';
import { array, object, string, integer, type Binding, type Codex, type Json, type Keyboard, type Telegram, type ModelSettings } from './types.js';

const PAGE_SIZE = 8;
const MENU_LIFETIME = 10 * 60 * 1000;
interface Model { id: string; name: string; raw: Json; }
type Action = { kind: 'model'; model: Model } | { kind: 'page'; page: number } | { kind: 'back' } | { kind: 'close' } |
  { kind: 'select'; settings: ModelSettings; text: string };
interface Menu {
  binding: Binding; key: string; token: string; catalog: Model[]; thread: Json; expires: number;
  page: number; selected?: Model; actions: Map<string, Action>; busy: boolean;
}
function label(value: string): string { return Array.from(value.replace(/[\x00-\x1f\x7f]/gu, ' ')).slice(0, 100).join(''); }
const EFFORT_NAMES = new Map([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'], ['max', 'Max'], ['ultra', 'Ultra']]);

function choices(model: Model): { text: string; settings: ModelSettings }[] {
  const rawEfforts = array(model.raw.supportedReasoningEfforts).map(e => string(object(e).reasoningEffort)).filter(Boolean);
  const efforts: (string | undefined)[] = [...new Set(rawEfforts.length ? rawEfforts : [string(model.raw.defaultReasoningEffort) || undefined])];
  // Deprecated additionalSpeedTiers contains display-mode names, not trustworthy native tier IDs.
  const advertised = array(model.raw.serviceTiers).map(object);
  if (efforts.length > 32 || advertised.length > 16) throw new Error('The model exposes too many settings.');
  const tiers = new Map<string, string>([['default', '']]);
  for (const tier of advertised) if (string(tier.id) && tier.id !== 'default') tiers.set(string(tier.id), label(string(tier.name) || string(tier.id)));
  return efforts.flatMap(effort => [...tiers].map(([id, name]) => ({
    text: `${effort ? EFFORT_NAMES.get(effort) ?? label(effort) : 'По умолчанию'}${name ? ` · ${name}` : ''}`,
    settings: { model: model.id, ...(effort === undefined ? {} : { effort }), serviceTier: id },
  })));
}

/** Native catalogs and topic-scoped controls; opening the picker never changes session settings. */
export class ModelPicker {
  private menus = new Map<string, Menu>();
  constructor(private readonly state: State, private readonly codex: Codex, private readonly telegram: Telegram,
    private readonly ownerId: number, private readonly allowed: (binding: Binding) => Promise<Json | undefined>) {}

  async open(binding: Binding): Promise<void> {
    for (const menu of this.menus.values()) if (!menu.busy && menu.expires < Date.now()) this.retire(menu);
    const previous = this.menus.get(binding.threadId);
    if (previous?.busy) { this.notice(binding, 'Меню модели уже обрабатывается. Дождитесь завершения.'); return; }
    if (previous) await this.close(previous);
    if (this.menus.size >= 64) { this.notice(binding, 'Закройте одно из открытых меню моделей и повторите /model.'); return; }
    const menu: Menu = { binding, key: `prompt/model/${randomUUID()}`, token: '', catalog: [], thread: {}, expires: Date.now() + MENU_LIFETIME,
      page: 0, actions: new Map(), busy: true };
    this.menus.set(binding.threadId, menu);
    try {
      const thread = await this.allowed(binding);
      if (!thread) { this.retire(menu); this.notice(binding, 'Сессия недоступна для этого топика. Откройте её в Codex и отправьте /model.'); return; }
      menu.thread = thread;
      menu.catalog = await this.catalog();
      if (this.menus.get(binding.threadId) !== menu) { this.retire(menu); return; }
      if (!await this.allowed(binding)) { this.retire(menu); this.notice(binding, 'Сессия недоступна для этого топика. Откройте её в Codex и отправьте /model.'); return; }
      const screen = this.screen(menu);
      this.state.enqueue(menu.key, binding.topicId, screen.text, screen.markup as unknown as Json);
    } catch {
      if (this.menus.get(binding.threadId) === menu) {
        await this.close(menu);
        this.notice(binding, 'Не удалось загрузить модели из Codex. Проверьте подключение и отправьте /model ещё раз.');
      }
    } finally { menu.busy = false; }
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<'done' | 'rejected' | 'uncertain'> {
    const match = /^m:([a-f0-9]{32}):([a-z0-9]+)$/u.exec(string(callback.data));
    const menu = match ? [...this.menus.values()].find(m => m.token === match[1]) : undefined;
    const action = match && menu?.actions.get(match[2]!);
    if (!menu || !action || menu.expires < Date.now() || topicId !== menu.binding.topicId ||
        integer(message.message_id) !== this.state.promptMessage(menu.key)) {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'Это меню устарело или относится к другому топику. Отправьте /model.' }); return 'done';
    }
    if (menu.busy) { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'Выбор уже обрабатывается.' }); return 'done'; }
    menu.busy = true;
    let writing = false;
    try {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id });
      const thread = await this.allowed(menu.binding);
      if (!thread || !this.current(menu)) { await this.complete(menu, 'Сессия недоступна для этого топика. Откройте её в Codex и отправьте /model.'); return 'rejected'; }
      if (action.kind === 'close') { await this.complete(menu, 'Выбор модели отменён.'); return 'done'; }
      if (action.kind === 'select') {
        const fresh = (await this.catalog()).find(model => model.id === action.settings.model);
        if (!fresh || !choices(fresh).some(choice => JSON.stringify(choice.settings) === JSON.stringify(action.settings))) {
          await this.complete(menu, 'Модель или выбранный режим больше не доступны в каталоге Codex. Отправьте /model для нового выбора.'); return 'rejected';
        }
        const currentThread = await this.allowed(menu.binding);
        if (!currentThread || !this.current(menu)) { await this.complete(menu, 'Сессия больше не доступна для этого топика. Отправьте /model.'); return 'rejected'; }
        menu.actions.clear(); menu.token = '';
        writing = true;
        await this.codex.updateSettings(menu.binding.threadId, action.settings);
        await this.complete(menu, `Выбрано: ${fresh.name} · ${action.text}.\nСохранено для всех следующих запросов в этой сессии.${object(currentThread.status).type === 'active' ? '\nТекущий ответ завершится с прежними настройками.' : ''}`);
        return 'done';
      }
      if (action.kind === 'model') { menu.selected = action.model; menu.page = 0; }
      else if (action.kind === 'back') { delete menu.selected; menu.page = 0; }
      else menu.page = action.page;
      const screen = this.screen(menu);
      await this.edit(menu, screen.text, screen.markup);
      return 'done';
    } catch (error) {
      const uncertain = writing && (!(error instanceof RpcError) || error.uncertain);
      const text = uncertain ? 'Не удалось подтвердить изменение модели. Проверьте настройки в Codex перед повторным выбором. Автоматического повтора не будет.' :
        writing ? `Codex отклонил изменение настроек. ${label(error instanceof Error ? error.message : '')}\nОтправьте /model для нового выбора.` :
          'Не удалось открыть или обновить меню модели. Проверьте подключение и отправьте /model ещё раз.';
      await this.complete(menu, text);
      return uncertain ? 'uncertain' : 'rejected';
    } finally { menu.busy = false; }
  }

  private current(menu: Menu): boolean { return this.menus.get(menu.binding.threadId) === menu && menu.expires >= Date.now(); }
  private async catalog(): Promise<Model[]> {
    const catalog = (await this.codex.models()).filter(m => m.hidden !== true && string(m.model)).map(raw => ({ id: string(raw.model), name: label(string(raw.displayName) || string(raw.model)), raw }));
    if (!catalog.length || catalog.length > 512 || new Set(catalog.map(m => m.id)).size !== catalog.length) throw new Error('Invalid model catalog.');
    return catalog;
  }

  private screen(menu: Menu): { text: string; markup: Keyboard } {
    menu.token = randomBytes(16).toString('hex'); menu.actions.clear();
    const button = (text: string, action: Action) => {
      const code = menu.actions.size.toString(36); menu.actions.set(code, action);
      return { text, callback_data: `m:${menu.token}:${code}` };
    };
    const options = menu.selected ? choices(menu.selected) : [];
    const total = menu.selected ? options.length : menu.catalog.length;
    const pageSize = menu.selected ? 12 : PAGE_SIZE;
    const pages = Math.ceil(total / pageSize);
    menu.page = Math.max(0, Math.min(menu.page, pages - 1));
    const start = menu.page * pageSize;
    const rows: Keyboard['inline_keyboard'] = [];
    if (menu.selected) {
      const selected = options.slice(start, start + pageSize).map(option => button(option.text, { kind: 'select', ...option }));
      for (let index = 0; index < selected.length; index += 2) rows.push(selected.slice(index, index + 2));
    } else {
      for (const model of menu.catalog.slice(start, start + pageSize)) rows.push([button((model.id === menu.thread.model ? '✓ ' : '') + model.name, { kind: 'model', model })]);
    }
    const navigation = [];
    if (menu.page) navigation.push(button('←', { kind: 'page', page: menu.page - 1 }));
    if (menu.page + 1 < pages) navigation.push(button('→', { kind: 'page', page: menu.page + 1 }));
    if (navigation.length) rows.push(navigation);
    const footer = menu.selected ? [button('Назад', { kind: 'back' })] : [];
    footer.push(button(menu.selected ? 'Отмена' : 'Закрыть', { kind: 'close' })); rows.push(footer);
    const current = [label(string(menu.thread.model)), label(string(menu.thread.reasoningEffort))].filter(Boolean).join(' · ');
    const text = menu.selected ? `Модель: ${menu.selected.name}\nВыберите уровень рассуждений и скорость.${options.some(o => o.settings.serviceTier !== 'default') ? '\nБыстрые режимы могут расходовать больше лимитов.' : ''}` :
      `Выберите модель для этой сессии.${current ? `\nСейчас: ${current}` : ''}`;
    return { text: text + (pages > 1 ? `\nСтраница ${menu.page + 1}/${pages}` : ''), markup: { inline_keyboard: rows } };
  }

  private async edit(menu: Menu, text: string, markup: Keyboard): Promise<void> {
    const messageId = this.state.promptMessage(menu.key);
    if (!messageId) throw new Error('Menu delivery is not confirmed.');
    await this.telegram.call('editMessageText', { chat_id: this.ownerId, message_id: messageId,
      ...withProjectHeader({ text, entities: [] }, menu.binding.cwd, menu.binding.sessionName, menu.binding.projectLabel), reply_markup: markup });
  }
  private notice(binding: Binding, text: string): void { this.state.enqueue(`attention/model/${randomUUID()}`, binding.topicId, text); }
  private retire(menu: Menu): void {
    if (this.menus.get(menu.binding.threadId) === menu) this.menus.delete(menu.binding.threadId);
    menu.token = ''; menu.actions.clear(); this.state.cancelPrompt(menu.key);
  }
  private async complete(menu: Menu, text: string): Promise<void> {
    this.retire(menu);
    try { await this.edit(menu, text, { inline_keyboard: [] }); }
    catch { this.notice(menu.binding, text); }
  }

  private async close(menu: Menu): Promise<void> {
    this.retire(menu);
    const messageId = this.state.promptMessage(menu.key);
    if (messageId) {
      try { await this.telegram.call('editMessageReplyMarkup', { chat_id: this.ownerId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
      catch { /* Expired tokens cannot change settings even when old controls remain visible. */ }
    }
  }
}

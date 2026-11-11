import { randomBytes, randomUUID } from 'node:crypto';
import { RpcError } from './codex.js';
import { withProjectHeader } from './format.js';
import { type State } from './state.js';
import { type Screens } from './screens.js';
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
    text: `${effort ? EFFORT_NAMES.get(effort) ?? label(effort) : 'Default'}${name ? ` · ${name}` : ''}`,
    settings: { model: model.id, ...(effort === undefined ? {} : { effort }), serviceTier: id },
  })));
}

/** Native catalogs and topic-scoped controls; opening the picker never changes session settings. */
export class ModelPicker {
  private menus = new Map<string, Menu>();
  constructor(private readonly state: State, private readonly codex: Codex, private readonly telegram: Telegram,
    private readonly ownerId: number, private readonly allowed: (binding: Binding) => Promise<Json | undefined>, private readonly screens?: Screens) {}

  async open(binding: Binding): Promise<void> {
    for (const menu of this.menus.values()) if (!menu.busy && menu.expires < Date.now()) this.retire(menu);
    const previous = this.menus.get(binding.threadId);
    if (previous?.busy) { this.notice(binding, 'The model menu is already being processed. Please wait.'); return; }
    if (previous) await this.close(previous);
    if (this.menus.size >= 64) { this.notice(binding, 'Close an open model menu and retry /model.'); return; }
    const menu: Menu = { binding, key: `prompt/model/${randomUUID()}`, token: '', catalog: [], thread: {}, expires: Date.now() + MENU_LIFETIME,
      page: 0, actions: new Map(), busy: true };
    this.menus.set(binding.threadId, menu);
    try {
      const thread = await this.allowed(binding);
      if (!thread) { this.retire(menu); this.notice(binding, 'The session is unavailable for this topic. Open it in Codex and send /model.'); return; }
      menu.thread = thread;
      menu.catalog = await this.catalog();
      if (this.menus.get(binding.threadId) !== menu) { this.retire(menu); return; }
      if (!await this.allowed(binding)) { this.retire(menu); this.notice(binding, 'The session is unavailable for this topic. Open it in Codex and send /model.'); return; }
      const screen = this.screen(menu);
      if (this.screens) this.screens.enqueue(menu.key, binding.topicId, screen.text, screen.markup as unknown as Json, { kind: 'menu', title: 'Model', editable: true });
      else this.state.enqueue(menu.key, binding.topicId, screen.text, screen.markup as unknown as Json);
    } catch {
      if (this.menus.get(binding.threadId) === menu) {
        await this.close(menu);
        this.notice(binding, 'Could not load models from Codex. Check the connection and retry /model.');
      }
    } finally { menu.busy = false; }
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<'done' | 'rejected' | 'uncertain'> {
    const match = /^m:([a-f0-9]{32}):([a-z0-9]+)$/u.exec(string(callback.data));
    const menu = match ? [...this.menus.values()].find(m => m.token === match[1]) : undefined;
    const action = match && menu?.actions.get(match[2]!);
    if (!menu || !action || menu.expires < Date.now() || topicId !== menu.binding.topicId ||
        integer(message.message_id) !== this.state.promptMessage(menu.key)) {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'This menu expired or belongs to another topic. Send /model.' }); return 'done';
    }
    if (menu.busy) { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'Your selection is already being processed.' }); return 'done'; }
    menu.busy = true;
    let writing = false;
    try {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id });
      const thread = await this.allowed(menu.binding);
      if (!thread || !this.current(menu)) { await this.complete(menu, 'The session is unavailable for this topic. Open it in Codex and send /model.'); return 'rejected'; }
      if (action.kind === 'close') { await this.complete(menu, 'Model selection cancelled.'); return 'done'; }
      if (action.kind === 'select') {
        const fresh = (await this.catalog()).find(model => model.id === action.settings.model);
        if (!fresh || !choices(fresh).some(choice => JSON.stringify(choice.settings) === JSON.stringify(action.settings))) {
          await this.complete(menu, 'The model or selected mode is no longer available in the Codex catalog. Send /model to choose again.'); return 'rejected';
        }
        const currentThread = await this.allowed(menu.binding);
        if (!currentThread || !this.current(menu)) { await this.complete(menu, 'The session is no longer available for this topic. Send /model.'); return 'rejected'; }
        menu.actions.clear(); menu.token = '';
        writing = true;
        await this.codex.updateSettings(menu.binding.threadId, action.settings);
        await this.complete(menu, `Selected: ${fresh.name} · ${action.text}.\nSaved for all following requests in this session.${object(currentThread.status).type === 'active' ? '\nThe current response will finish with its previous settings.' : ''}`);
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
      const text = uncertain ? 'The model change could not be confirmed. Check settings in Codex before choosing again. It will not be retried automatically.' :
        writing ? `Codex rejected the settings change. ${label(error instanceof Error ? error.message : '')}\nSend /model to choose again.` :
          'Could not open or update the model menu. Check the connection and retry /model.';
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
    const footer = menu.selected ? [button('Back', { kind: 'back' })] : [];
    footer.push(button(menu.selected ? 'Cancel' : 'Close', { kind: 'close' })); rows.push(footer);
    const current = [label(string(menu.thread.model)), label(string(menu.thread.reasoningEffort))].filter(Boolean).join(' · ');
    const text = menu.selected ? `Model: ${menu.selected.name}\nChoose reasoning effort and speed.${options.some(o => o.settings.serviceTier !== 'default') ? '\nFast modes may use more of your limits.' : ''}` :
      `Choose a model for this session.${current ? `\nCurrent: ${current}` : ''}`;
    return { text: text + (pages > 1 ? `\nPage ${menu.page + 1}/${pages}` : ''), markup: { inline_keyboard: rows } };
  }

  private async edit(menu: Menu, text: string, markup: Keyboard): Promise<void> {
    if (this.screens) { menu.key = await this.screens.edit(menu.key, menu.binding.topicId, text, markup as unknown as Json, { kind: 'menu', title: 'Model', editable: true }); return; }
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

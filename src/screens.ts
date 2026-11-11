import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { formatMessages, renderMarkdown, withProjectHeader, type FormattedText } from './format.js';
import { allowedSessionDirectory, type Config } from './config.js';
import { type State, type RichDeliveryPart, type DeliveryContext } from './state.js';
import { type ScreenOptions, type ScreenSpec } from './screen-types.js';
import { screenDocuments } from './widget-result.js';
import { widgetCaption as screenCaption } from './widget-template.js';
import { type WidgetCard } from './widget-types.js';
import { array, integer, object, string, type Binding, type Json, type Telegram } from './types.js';

const textOf = (text: string, spec: ScreenOptions): FormattedText => spec.markdown ? renderMarkdown(text) : { text, entities: [] };
function withoutHeading(message: FormattedText, title: string): FormattedText {
  const line = message.text.split('\n')[0]!.replace(/^(?:🔐|❓)\s*/u, '');
  const start = message.text.indexOf('\n');
  if (start < 0 || line.toLowerCase() !== title.toLowerCase()) return message;
  const offset = start + message.text.slice(start).match(/^\n*/u)![0].length;
  return { text: message.text.slice(offset), entities: message.entities.flatMap(entity => {
    const from = Math.max(offset, entity.offset); const end = entity.offset + entity.length;
    return end > from ? [{ ...entity, offset: from - offset, length: end - from }] : [];
  }) };
}
const addTextButton = (markup: Json | null, token: string): Json => ({ inline_keyboard: [...array(markup?.inline_keyboard),
  [{ text: 'Text version', callback_data: `sc:${token}` }]] });

/** One presentation module owns format selection, persisted render kind and native keyboard editing. */
export class Screens {
  constructor(private readonly state: State, private readonly telegram: Telegram, private readonly config: Config) {}
  private eligible(saved: DeliveryContext): boolean {
    if (!saved.sourceThreadId) return saved.ownerNotice;
    const current = saved.topicId === null ? undefined : this.state.topic(saved.topicId);
    return !!current && current.threadId === saved.sourceThreadId && current.cwd === saved.projectCwd &&
      !this.config.ignoredThreadIds?.includes(current.threadId) && !this.state.topicOperation(current.threadId) &&
      allowedSessionDirectory(current.cwd, this.config, this.state.ownsScratch(current.cwd, current.threadId));
  }

  prepare(topicId: number | null, text: string, options: ScreenOptions): RichDeliveryPart[] {
    const spec: ScreenSpec = { ...options, token: randomBytes(16).toString('hex') };
    const binding: Binding = (topicId === null ? undefined : this.state.topic(topicId)) ??
      { threadId: '', topicId: topicId ?? 0, cwd: '', title: 'Codex Telegram Relay', projectLabel: 'Codex Telegram Relay', sessionName: 'All topics', lastTurn: null };
    const card: WidgetCard = { id: spec.token, token: spec.token, generation: '', kind: 'status', view: 'widgets', binding, turnId: '', revision: 1,
      createdAt: Date.now(), snapshot: { status: 'working', startedAt: null, finishedAt: null, updatedAt: Date.now(), plan: null, activities: [] } };
    const message = withoutHeading(textOf(text, spec), spec.title);
    const data = this.data(spec.title, text);
    const documents = spec.widgets === false || (spec.caption?.length ?? 0) > 1000 || spec.editable && !data ? undefined : screenDocuments(card, message, spec);
    const parts: RichDeliveryPart[] = documents ? documents.map(part => ({ method: 'sendWidget', params: {
      html: part.html, caption: spec.caption ?? screenCaption(spec.title, binding.projectLabel || binding.cwd.split(/[\\/]/u).at(-1)),
      chat_data: '{}', allow_queries: false, is_shared: false }, fallbackText: part.message })) :
      formatMessages(text, spec.markdown === true, 3300).map(part => ({ method: 'sendMessage', params: {
        ...withProjectHeader(part, binding.cwd || undefined, binding.sessionName, binding.projectLabel), link_preview_options: { is_disabled: true } } }));
    parts[0]!.screen = spec;
    parts.forEach((part, index) => { if (index) part.params.disable_notification = true; });
    return parts;
  }
  enqueue(key: string, topicId: number | null, text: string, markup: Json | null, options: ScreenOptions, ownerNotice = false): void {
    const enabled = options.widgets ?? this.state.viewMode() === 'widgets';
    if (!enabled) { if (ownerNotice) this.state.enqueueOwnerNotice(key, topicId, text, markup); else this.state.enqueue(key, topicId, text, markup); return; }
    const parts = this.prepare(topicId, text, options);
    this.state.enqueueScreen(key, topicId, text, addTextButton(markup, parts[0]!.screen!.token), parts, ownerNotice);
  }
  markup(key: string, markup: Json | null): Json | null {
    const saved = this.state.screen(key); return saved ? addTextButton(markup, saved.spec.token) : markup;
  }
  replacement(key: string, markup: Json): { markup: Json; parts?: RichDeliveryPart[] } {
    const saved = this.state.screen(key); if (!saved) return { markup };
    const parts = this.prepare(saved.topicId, saved.text, saved.spec);
    return { parts, markup: addTextButton(markup, parts[0]!.screen!.token) };
  }
  private data(title: string, text: string): string | undefined {
    const data = JSON.stringify({ v: 1, title, text: withoutHeading({ text, entities: [] }, title).text });
    return Buffer.byteLength(data) <= 900 ? data : undefined;
  }
  async edit(key: string, topicId: number | null, text: string, markup: Json, options: ScreenOptions): Promise<string> {
    const id = this.state.promptMessage(key); if (!id) throw new Error('Menu delivery is not confirmed.');
    const saved = this.state.screen(key);
    const binding = topicId === null ? undefined : this.state.topic(topicId);
    if (!saved) {
      await this.telegram.call('editMessageText', { chat_id: this.config.ownerId, message_id: id,
        ...withProjectHeader({ text, entities: [] }, binding?.cwd, binding?.sessionName, binding?.projectLabel), reply_markup: markup }); return key;
    }
    const widget = saved.parts[0]!.method === 'sendWidget'; const data = this.data(options.title, text);
    if (widget && (!data || (options.caption?.length ?? 0) > 1000) || !widget && text.length > 3300) {
      this.state.cancelPrompt(key);
      try { await this.telegram.call('editMessageReplyMarkup', { chat_id: this.config.ownerId, message_id: id, reply_markup: { inline_keyboard: [] } }); } catch { /* Caller has already rotated its action tokens. */ }
      if (!this.eligible(saved)) throw new Error('The screen destination changed while replacing its controls.');
      const next = `notice/screen/${randomUUID()}`;
      this.enqueue(next, topicId, text, markup, { ...options, widgets: false }, saved.ownerNotice);
      // Persist a native replacement so later edits never address it as widget media.
      if (!this.state.screen(next)) {
        const parts = this.prepare(topicId, text, { ...options, widgets: false });
        this.state.attachScreen(next, parts);
      }
      return next;
    }
    const spec = { ...saved.spec, ...options, fullText: options.fullText, caption: options.caption };
    this.state.updateScreen(key, text, spec);
    const common = { chat_id: this.config.ownerId, message_id: id };
    if (widget) {
      await this.telegram.call('editMessageWidgetData', { ...common, chat_data: data! });
      await this.telegram.call('editMessageCaption', { ...common, caption: options.caption ?? screenCaption(options.title), reply_markup: addTextButton(markup, spec.token) });
    } else await this.telegram.call('editMessageText', { ...common,
      ...withProjectHeader({ text, entities: [] }, binding?.cwd, binding?.sessionName, binding?.projectLabel), reply_markup: addTextButton(markup, spec.token) });
    return key;
  }
  async close(key: string, title: string): Promise<boolean> {
    const saved = this.state.screen(key); if (!saved || !saved.messageId) return false;
    const common = { chat_id: this.config.ownerId, message_id: saved.messageId };
    if (saved.parts.at(-1)!.method === 'sendWidget') {
      await Promise.all([
        this.telegram.call('editMessageWidgetData', { ...common, chat_data: JSON.stringify({ v: 1, title }) }),
        this.telegram.call('editMessageCaption', { ...common, caption: screenCaption(title), reply_markup: addTextButton(null, saved.spec.token) }),
      ]);
    } else await this.telegram.call('editMessageReplyMarkup', { ...common, reply_markup: addTextButton(null, saved.spec.token) });
    return true;
  }
  async text(callback: Json, message: Json, topicId: number | null): Promise<void> {
    const match = /^sc:([a-f0-9]{32})$/u.exec(string(callback.data));
    const saved = match ? this.state.screenToken(match[1]!) : undefined;
    const valid = (): boolean => {
      return !!saved && integer(message.message_id) !== undefined && integer(message.message_id)! > 0 && saved.messageId === integer(message.message_id) &&
      saved.topicId === topicId && object(callback.from).id === this.config.ownerId && object(message.chat).id === this.config.ownerId && object(message.chat).type === 'private' &&
      this.eligible(saved);
    };
    const authorized = valid();
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(!authorized ? { text: 'This text version is no longer available in this topic.' } : {}) }); } catch { /* Read-only access is independent of acknowledgement. */ }
    if (!authorized || !valid() || !saved) return;
    const current = topicId === null ? undefined : this.state.topic(topicId);
    const text = saved.spec.fullText ?? saved.text;
    const parts: RichDeliveryPart[] = formatMessages(text, saved.spec.markdown === true, 3300).map((part, index) => ({ method: 'sendMessage', params: {
      ...withProjectHeader(part, saved.projectCwd, current?.sessionName, current?.projectLabel), link_preview_options: { is_disabled: true }, disable_notification: index > 0 } }));
    parts[0]!.screen = { kind: 'text', title: 'Text version', token: randomBytes(16).toString('hex') };
    const key = `notice/screen-text/${saved.spec.token}/${createHash('sha256').update(string(callback.id)).digest('hex')}`;
    this.state.enqueueScreen(key, topicId, text, null, parts, saved.ownerNotice);
  }
}

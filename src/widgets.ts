import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { type State } from './state.js';
import { array, object, string, type Binding, type Json, type Telegram } from './types.js';
import { widgetLabel, widgetPreview } from './widget-template.js';
import { resultParts } from './widget-result.js';
import { type WidgetActivity, type WidgetCard, type WidgetDelivery, type ViewMode } from './widget-types.js';

const finalStatuses = new Map([['completed', 'done'], ['failed', 'failed'], ['interrupted', 'interrupted']] as const);
const millis = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;
function activityLabel(item: Json): string | undefined {
  const file = (path: unknown): string => widgetLabel(basename(string(path).replaceAll('\\', '/')), 64);
  if (item.type === 'commandExecution') {
    const actions = array(item.commandActions).map(object);
    const read = actions.find(action => action.type === 'read');
    if (read) return `Read file${file(read.path || read.name) ? ' · ' + file(read.path || read.name) : ''}`;
    const search = actions.find(action => action.type === 'search');
    if (search) return `Search files${file(search.path) ? ' · ' + file(search.path) : ''}`;
    const list = actions.find(action => action.type === 'listFiles');
    if (list) return `List files${file(list.path) ? ' · ' + file(list.path) : ''}`;
    const executable = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/u.exec(string(item.command).trim());
    const name = file(executable?.[1] || executable?.[2] || executable?.[3]).replace(/\.(?:exe|cmd)$/iu, '').toLowerCase();
    return /^(?:node|npm|npx|pnpm|yarn|python|python3|py|powershell|pwsh|git|rg|tsc|tsx|cargo|dotnet|go|bash|sh|cmd)$/u.test(name) ? `Run command · ${name}` : 'Run command';
  }
  if (['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall'].includes(string(item.type))) {
    const name = string(item.tool);
    return /^[\w./:-]{1,128}$/u.test(name) ? `Use tool · ${widgetLabel(name, 64)}` : 'Use tool';
  }
  if (item.type === 'fileChange') {
    const paths = array(item.changes).map(value => file(object(value).path)).filter(Boolean);
    return paths.length ? `Update files · ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ''}` : 'Update files';
  }
  return new Map([['fileChange', 'Update files'], ['mcpToolCall', 'Use tool'], ['dynamicToolCall', 'Use tool'],
    ['webSearch', 'Search the web'], ['imageGeneration', 'Generate image'], ['collabAgentToolCall', 'Coordinate agents']]).get(string(item.type));
}

/** Durable, bounded activity summaries. No native writes and no transport calls. */
export class Widgets {
  constructor(private readonly state: State, readonly generation: string, private readonly now = Date.now) {}

  private card(binding: Binding, turnId: string, startedAt: number | null = null): WidgetCard {
    const previous = this.state.widgetCard(binding.threadId, turnId);
    if (previous) return { ...previous, binding, generation: this.generation };
    const now = this.now();
    return { id: randomUUID(), token: randomBytes(16).toString('hex'), generation: this.generation,
      binding, turnId, view: this.state.viewMode(), revision: 1, createdAt: now,
      snapshot: { status: 'working', startedAt, finishedAt: null, updatedAt: now, plan: null, activities: [] } };
  }
  observe(binding: Binding, method: string, params: Json): void {
    if (!['turn/started', 'turn/plan/updated', 'turn/completed', 'item/started', 'item/completed'].includes(method)) return;
    const turn = object(params.turn); const turnId = string(params.turnId) || string(turn.id);
    if (!turnId || turnId.length > 256) return;
    const previous = this.state.widgetCard(binding.threadId, turnId);
    // No historical cards: completion can only finish work observed while it was running.
    if (!previous && method !== 'turn/started') return;
    const card = this.card(binding, turnId, millis(turn.startedAt));
    if (previous && (previous.binding.topicId !== binding.topicId || previous.binding.cwd !== binding.cwd)) {
      this.state.widgetResult(previous.id, 'retired'); return;
    }
    const before = JSON.stringify(card.snapshot);
    if (card.snapshot.finishedAt !== null) return;
    if (method !== 'turn/completed' && ['unavailable', 'disconnected'].includes(card.snapshot.status)) card.snapshot.status = 'working';
    if (method === 'turn/completed') {
      const status = finalStatuses.get(string(turn.status) as 'completed'); if (!status) return;
      card.snapshot.status = status; card.snapshot.finishedAt = millis(turn.completedAt) ?? this.now();
      this.hydrate(card, array(turn.items)); this.settle(card);
    } else if (card.view === 'widgets' && method.startsWith('item/') && object(params.item).type === 'agentMessage') {
      const item = object(params.item);
      if (['commentary', 'partial_answer'].includes(string(item.phase)) && string(item.text).trim()) {
        const text = string(item.text).trim();
        let progress = text.slice(0, 16_000);
        if (/[\uD800-\uDBFF]$/u.test(progress)) progress = progress.slice(0, -1);
        card.snapshot.progressText = progress + (progress.length < text.length ? '\n\n[Progress text shortened. See Codex for the full message.]' : '');
        card.snapshot.summary = widgetPreview(text, 512);
      }
    } else if (card.view === 'widgets' && method === 'turn/plan/updated') {
      const raw = array(params.plan); const plan = raw.length > 512 ? [] : raw.map(object);
      card.snapshot.plan = plan.length ? { done: plan.filter(step => step.status === 'completed').length, total: plan.length,
        current: widgetLabel(string(plan.find(step => step.status === 'inProgress')?.step), 96) } : null;
    } else if (card.view === 'widgets' && method.startsWith('item/')) {
      const item = object(params.item); const label = activityLabel(item); const id = string(item.id);
      if (!label || !id) return;
      const key = createHash('sha256').update(id.slice(0, 2048)).digest('hex').slice(0, 24);
      const existing = card.snapshot.activities.find(activity => activity.id === key);
      // A replayed start must not turn a completed operation back into a running one.
      if (method === 'item/started' && existing) return;
      const status: WidgetActivity['status'] = method === 'item/started' ? 'running' : ['failed', 'declined'].includes(string(item.status)) ||
        typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' : 'done';
      card.snapshot.activities = [...card.snapshot.activities.filter(activity => activity.id !== key), { id: key, label, status }].slice(-3);
    }
    if (!previous || before !== JSON.stringify(card.snapshot) || previous.generation !== this.generation) this.save(card);
  }
  private save(card: WidgetCard): void {
    card.revision++; card.snapshot.updatedAt = this.now();
    if (!this.state.saveWidget(card)) this.state.enqueue(`attention/widget-capacity/${card.binding.threadId}`, card.binding.topicId,
      'Activity cards are paused because the widget history is full of unresolved deliveries. Replies and approvals continue normally.');
  }
  private hydrate(card: WidgetCard, items: unknown[]): void {
    for (const value of items.slice(-16)) {
      const item = object(value); const label = activityLabel(item); const id = string(item.id);
      if (!label || !id) continue;
      const key = createHash('sha256').update(id.slice(0, 2048)).digest('hex').slice(0, 24);
      const running = item.status === 'inProgress';
      if (!running && !['completed', 'failed', 'declined'].includes(string(item.status)) && typeof item.completedAtMs !== 'number') continue;
      const status: WidgetActivity['status'] = running ? 'running' : ['failed', 'declined'].includes(string(item.status)) ||
        typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' : 'done';
      card.snapshot.activities = [...card.snapshot.activities.filter(activity => activity.id !== key), { id: key, label, status }].slice(-3);
    }
  }
  private settle(card: WidgetCard): void {
    card.snapshot.activities = card.snapshot.activities.map(activity => activity.status === 'running' ? { ...activity, status: 'stopped' } : activity);
  }
  widgetTurn(threadId: string, turnId: string): WidgetDelivery | undefined {
    const card = this.state.widgetCard(threadId, turnId);
    return card && card.generation === this.generation && card.view === 'widgets' && !['uncertain', 'disabled', 'retired'].includes(card.delivery) ? card : undefined;
  }
  usesCard(threadId: string, turnId: string): boolean {
    const card = this.widgetTurn(threadId, turnId);
    return !!card && !['unavailable', 'disconnected'].includes(card.snapshot.status);
  }
  reconcile(saved: WidgetDelivery, turns: Json[]): void {
    const current = this.state.widgetCard(saved.binding.threadId, saved.turnId);
    if (!current || current.id !== saved.id || current.revision !== saved.revision || current.generation !== this.generation || current.snapshot.finishedAt !== null) return;
    const turn = turns.find(turn => turn.id === saved.turnId);
    const card: WidgetCard = current;
    if (turn?.status === 'inProgress') {
      if (!['approval', 'answer'].includes(card.snapshot.status)) card.snapshot.status = 'working';
      card.snapshot.startedAt ??= millis(turn.startedAt); this.hydrate(card, array(turn.items));
    } else {
      const status = finalStatuses.get(string(turn?.status) as 'completed');
      card.snapshot.status = status || 'unavailable';
      if (status) { card.snapshot.finishedAt = millis(turn?.completedAt) ?? this.now(); this.hydrate(card, array(turn?.items)); this.settle(card); }
    }
    this.save(card);
  }
  recover(binding: Binding, turns: Json[]): void {
    const active = turns.find(turn => turn.status === 'inProgress');
    for (const saved of this.state.widgetCards(binding.threadId)) {
      if (saved.binding.topicId !== binding.topicId || saved.binding.cwd !== binding.cwd) { this.state.widgetResult(saved.id, 'retired'); continue; }
      if (saved.generation === this.generation) continue;
      const turn = turns.find(turn => turn.id === saved.turnId);
      const card: WidgetCard = { ...saved, generation: this.generation, binding };
      if (saved.snapshot.finishedAt !== null) {
        // Bounded native history omits older turns; an observed terminal snapshot stays terminal.
        card.binding = saved.binding; this.state.saveWidget(card); continue;
      }
      if (turn?.status === 'inProgress') {
        card.snapshot.status = 'working'; card.snapshot.startedAt ??= millis(turn.startedAt);
        // Structured plan notifications are not returned by turns/list. Wait for a fresh plan event.
        card.snapshot.plan = null; this.hydrate(card, array(turn.items));
      } else {
        const status = finalStatuses.get(string(turn?.status) as 'completed');
        if (status) { card.snapshot.status = status; card.snapshot.finishedAt ??= millis(turn?.completedAt) ?? this.now(); this.hydrate(card, array(turn?.items)); this.settle(card); }
        else card.snapshot.status = 'unavailable';
        if (saved.messageId === null) this.state.widgetResult(saved.id, 'retired');
      }
      this.save(card);
    }
    if (active && !this.state.widgetCard(binding.threadId, string(active.id))) {
      const card = this.card(binding, string(active.id), millis(active.startedAt));
      // Recovery only uses safe activity categories, never historical reply/tool output.
      this.hydrate(card, array(active.items)); this.save(card);
    }
  }
  waiting(threadId: string, approvals: number, questions: number): void {
    const saved = this.state.activeWidget(threadId, this.generation);
    if (!saved || saved.view !== 'widgets') return;
    const status = approvals ? 'approval' : questions ? 'answer' : 'working';
    if (saved.snapshot.status !== status && ['working', 'approval', 'answer'].includes(saved.snapshot.status)) {
      saved.snapshot.status = status; this.save(saved);
    }
  }
  close(): void {
    for (const card of this.state.widgetCards()) if (card.generation === this.generation && card.view === 'widgets' && card.snapshot.finishedAt === null) {
      card.snapshot.status = 'disconnected'; this.save(card);
    }
  }
}

interface ViewMenu { topicId: number | null; key: string; expires: number; }
export class ViewPicker {
  private menus = new Map<string, ViewMenu>();
  constructor(private readonly state: State, private readonly telegram: Telegram,
    private readonly allowed: (binding: Binding) => Promise<boolean>, private readonly prepare: () => Promise<void>) {}

  private notice(topicId: number | null, text: string): void { this.state.enqueue(`notice/view/${randomUUID()}`, topicId, text); }
  async open(topicId: number | null, choice?: ViewMode): Promise<void> {
    if (choice) { await this.apply(topicId, choice); return; }
    for (const [token, menu] of this.menus) if (menu.expires < Date.now() || menu.topicId === topicId) {
      this.state.cancelPrompt(menu.key); this.menus.delete(token);
    }
    if (this.menus.size >= 64) { this.notice(topicId, 'Close an open view menu and retry /view.'); return; }
    const token = randomBytes(16).toString('hex'); const key = `notice/view/${token}`;
    this.menus.set(token, { topicId, key, expires: Date.now() + 10 * 60_000 });
    this.state.enqueue(key, topicId, `View for all topics: ${this.state.viewMode() === 'widgets' ? 'Widgets · experimental' : 'Classic'}\nChoose the view for following turns in all current and new sessions. Running turns keep their view.`, {
      inline_keyboard: [[{ text: 'Classic', callback_data: `v:${token}:c` }, { text: 'Widgets · experimental', callback_data: `v:${token}:w` }]],
    });
  }
  private async apply(topicId: number | null, view: ViewMode): Promise<void> {
    if (this.state.viewMode() !== view) await this.prepare();
    this.state.setViewMode(view);
    this.notice(topicId, `${view === 'widgets' ? 'Widgets · experimental' : 'Classic'} selected for following turns in all current and new sessions. Running turns keep their view.\n${view === 'widgets' ? 'Progress stays in the card. Complete final replies use a separate swipeable reader. Approvals keep their normal controls.' : '/mode controls permanent messages; /stream controls answer previews.'}`);
  }
  async callback(callback: Json, message: Json, topic: number | null): Promise<void> {
    const match = /^v:([a-f0-9]{32}):([cwd])$/u.exec(string(callback.data));
    const menu = match && match[2] !== 'd' ? this.menus.get(match[1]!) : undefined;
    const fallback = match && !menu && ['c', 'd'].includes(match[2]!) ? this.state.widgetCards().find(card => card.token === match[1]) : undefined;
    const binding = fallback?.binding;
    const current = binding && this.state.binding(binding.threadId);
    const messageId = typeof message.message_id === 'number' && Number.isSafeInteger(message.message_id) && message.message_id > 0 ? message.message_id : undefined;
    const validMessage = messageId && (menu ? menu.expires >= Date.now() && messageId === this.state.promptMessage(menu.key) :
      fallback && fallback.delivery !== 'retired' && messageId === fallback.messageId);
    const valid = validMessage && (menu ? topic === menu.topicId : binding && current?.topicId === binding.topicId && current.cwd === binding.cwd && topic === binding.topicId);
    // Consume a menu selection before any asynchronous acknowledgement or native read.
    if (valid && menu) { this.menus.delete(match![1]!); this.state.cancelPrompt(menu.key); }
    await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(!valid ? { text: 'This view control expired. Send /view again.' } : {}) });
    if (!valid) return;
    if (menu) { await this.apply(topic, match![2] === 'w' ? 'widgets' : 'classic'); return; }
    if (!binding || !await this.allowed(binding)) return;
    if (match![2] === 'd' && fallback) {
      const card = this.state.widgetCard(binding.threadId, fallback.turnId);
      if (!card || card.id !== fallback.id || card.delivery === 'retired' || card.messageId !== messageId) return;
      const text = card.snapshot.progressText || card.snapshot.summary || card.snapshot.plan?.current || 'No progress explanation is available yet.';
      const key = `attention/widget-answer/status/${card.id}/${card.revision}`;
      const token = randomBytes(16).toString('hex');
      const body = `Current status\n\n${text}`;
      if (!this.state.enqueueWidgetAnswer(key, binding, body, token, resultParts({ ...card, kind: 'status' }, text, token)))
        this.state.enqueue(key, binding.topicId, body, null, binding.cwd, binding.threadId);
      return;
    }
    await this.prepare();
    if (!await this.allowed(binding)) return;
    this.state.setViewMode('classic');
    this.notice(topic, 'Classic selected for following turns in all current and new sessions. Running turns keep their view.');
  }
}

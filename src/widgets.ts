import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type State } from './state.js';
import { array, object, string, type Binding, type Json, type Telegram } from './types.js';
import { widgetLabel } from './widget-template.js';
import { projectHeader } from './format.js';
import { type WidgetActivity, type WidgetCard, type WidgetDelivery, type ViewMode } from './widget-types.js';

const finalStatuses = new Map([['completed', 'done'], ['failed', 'failed'], ['interrupted', 'interrupted']] as const);
const millis = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : null;
function activityLabel(item: Json): string | undefined {
  if (item.type === 'commandExecution') {
    const kinds = array(item.commandActions).map(value => object(value).type);
    return kinds.includes('read') ? 'Read file' : kinds.includes('search') ? 'Search files' : kinds.includes('listFiles') ? 'List files' : 'Run command';
  }
  return new Map([['fileChange', 'Update files'], ['mcpToolCall', 'Use tool'], ['dynamicToolCall', 'Use tool'],
    ['webSearch', 'Search the web'], ['imageGeneration', 'Generate image'], ['collabAgentToolCall', 'Coordinate agents']]).get(string(item.type));
}

/** Durable, bounded activity summaries. No native writes and no transport calls. */
export class Widgets {
  constructor(private readonly state: State, readonly generation: string, private readonly now = Date.now) {}

  private card(binding: Binding, turnId: string, startedAt: number | null = null): WidgetCard {
    const previous = this.state.widgetCards(binding.threadId).find(card => card.turnId === turnId);
    if (previous) return { ...previous, binding, generation: this.generation };
    const now = this.now();
    return { id: randomUUID(), token: randomBytes(16).toString('hex'), generation: this.generation,
      binding, turnId, view: this.state.viewMode(binding.threadId), revision: 1, createdAt: now,
      snapshot: { status: 'working', startedAt, finishedAt: null, updatedAt: now, plan: null, activities: [] } };
  }
  observe(binding: Binding, method: string, params: Json): void {
    if (!['turn/started', 'turn/plan/updated', 'turn/completed', 'item/started', 'item/completed'].includes(method)) return;
    const turn = object(params.turn); const turnId = string(params.turnId) || string(turn.id);
    if (!turnId || turnId.length > 256) return;
    const previous = this.state.widgetCards(binding.threadId).find(card => card.turnId === turnId);
    // No historical cards: completion can only finish work observed while it was running.
    if (!previous && method === 'turn/completed') return;
    if (!previous && method === 'item/completed') return;
    const card = this.card(binding, turnId, millis(turn.startedAt));
    if (previous && (previous.binding.topicId !== binding.topicId || previous.binding.cwd !== binding.cwd)) {
      this.state.widgetResult(previous.id, 'retired'); return;
    }
    const before = JSON.stringify(card.snapshot);
    if (card.snapshot.finishedAt !== null) return;
    if (method === 'turn/completed') {
      const status = finalStatuses.get(string(turn.status) as 'completed'); if (!status) return;
      card.snapshot.status = status; card.snapshot.finishedAt = millis(turn.completedAt) ?? this.now();
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
    card.revision++; card.snapshot.updatedAt = this.now(); this.state.saveWidget(card);
  }
  recover(binding: Binding, turns: Json[]): void {
    const active = turns.find(turn => turn.status === 'inProgress');
    for (const saved of this.state.widgetCards(binding.threadId)) {
      if (saved.binding.topicId !== binding.topicId || saved.binding.cwd !== binding.cwd) { this.state.widgetResult(saved.id, 'retired'); continue; }
      if (saved.generation === this.generation) continue;
      const turn = turns.find(turn => turn.id === saved.turnId);
      const card: WidgetCard = { ...saved, generation: this.generation, binding };
      if (turn?.status === 'inProgress') {
        card.snapshot.status = 'working'; card.snapshot.startedAt ??= millis(turn.startedAt);
      } else {
        const status = finalStatuses.get(string(turn?.status) as 'completed');
        if (status) { card.snapshot.status = status; card.snapshot.finishedAt ??= millis(turn?.completedAt) ?? this.now(); }
        else card.snapshot.status = 'unavailable';
        if (saved.messageId === null) this.state.widgetResult(saved.id, 'retired');
      }
      this.save(card);
    }
    if (active && !this.state.widgetCards(binding.threadId).some(card => card.turnId === active.id)) {
      const card = this.card(binding, string(active.id), millis(active.startedAt));
      this.save(card);
      // Recovery only uses safe activity categories, never historical reply/tool output.
      for (const value of array(active.items).slice(-16)) {
        const item = object(value);
        this.observe(binding, item.status === 'inProgress' ? 'item/started' : 'item/completed', { turnId: active.id, item });
      }
    }
  }
  waiting(threadId: string, approvals: number, questions: number): void {
    const saved = this.state.widgetCards(threadId).filter(card => card.generation === this.generation && card.snapshot.finishedAt === null).at(-1);
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

interface ViewMenu { binding: Binding; key: string; expires: number; }
export class ViewPicker {
  private menus = new Map<string, ViewMenu>();
  constructor(private readonly state: State, private readonly telegram: Telegram,
    private readonly allowed: (binding: Binding) => Promise<boolean>, private readonly prepare: (binding: Binding) => Promise<void>) {}

  private notice(binding: Binding, text: string): void { this.state.enqueue(`attention/view/${randomUUID()}`, binding.topicId, text); }
  async open(binding: Binding, choice?: ViewMode): Promise<void> {
    if (!await this.allowed(binding)) { this.notice(binding, 'This session is unavailable. Open it in Codex and retry /view.'); return; }
    await this.prepare(binding);
    if (!await this.allowed(binding)) return;
    if (choice) { this.apply(binding, choice); return; }
    for (const [token, menu] of this.menus) if (menu.expires < Date.now() || menu.binding.threadId === binding.threadId) {
      this.state.cancelPrompt(menu.key); this.menus.delete(token);
    }
    if (this.menus.size >= 64) { this.notice(binding, 'Close an open view menu and retry /view.'); return; }
    const token = randomBytes(16).toString('hex'); const key = `prompt/view/${token}`;
    this.menus.set(token, { binding, key, expires: Date.now() + 10 * 60_000 });
    this.state.enqueue(key, binding.topicId, `Session view: ${this.state.viewMode(binding.threadId) === 'widgets' ? 'Widgets · experimental' : 'Classic'}\nChoose the view for following turns. Text previews and message mode keep their existing settings.`, {
      inline_keyboard: [[{ text: 'Classic', callback_data: `v:${token}:c` }, { text: 'Widgets · experimental', callback_data: `v:${token}:w` }]],
    });
  }
  private apply(binding: Binding, view: ViewMode): void {
    this.state.setViewMode(binding.threadId, view);
    this.notice(binding, `${view === 'widgets' ? 'Widgets · experimental' : 'Classic'} selected for following turns in this session. The current turn keeps its view.\n/mode controls permanent messages; /stream controls answer previews.`);
  }
  async callback(callback: Json, message: Json, topic: number | null): Promise<void> {
    const match = /^v:([a-f0-9]{32}):([cw])$/u.exec(string(callback.data));
    const menu = match ? this.menus.get(match[1]!) : undefined;
    const fallback = match && !menu && match[2] === 'c' ? this.state.widgetCards().find(card => card.token === match[1]) : undefined;
    const binding = menu?.binding ?? fallback?.binding;
    const current = binding && this.state.binding(binding.threadId);
    const validMessage = menu ? menu.expires >= Date.now() && message.message_id === this.state.promptMessage(menu.key) :
      fallback && fallback.delivery !== 'retired' && message.message_id === fallback.messageId;
    const valid = binding && current?.topicId === binding.topicId && current.cwd === binding.cwd && topic === binding.topicId && validMessage;
    // Consume a menu selection before any asynchronous acknowledgement or native read.
    if (valid && menu) { this.menus.delete(match![1]!); this.state.cancelPrompt(menu.key); }
    await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(!valid ? { text: 'This view control expired. Send /view in the current session topic.' } : {}) });
    if (!valid || !await this.allowed(binding)) return;
    await this.prepare(binding);
    if (!await this.allowed(binding)) return;
    this.apply(binding, match![2] === 'w' ? 'widgets' : 'classic');
  }
}

export function widgetCaption(card: WidgetDelivery): string {
  return `${projectHeader(card.binding.cwd, widgetLabel(card.binding.sessionName || card.binding.threadId.slice(0, 8), 96), card.binding.projectLabel)}\nCodex activity. Final replies and approvals stay in the conversation. Use /view classic for the classic view.`;
}

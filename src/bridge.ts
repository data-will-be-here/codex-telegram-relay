import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { approvalCardIdentity, approvalIdentity, approvalMessage, approvalDisplayMessage } from './approvals.js';
import { allowedSessionDirectory, type Config } from './config.js';
import { FirstMessageRequiredError, RpcError } from './codex.js';
import { Drafts } from './drafts.js';
import { commandHelp } from './commands.js';
import { State, type ApprovalCard } from './state.js';
import { Topics } from './topics.js';
import { Attachments, AttachmentError } from './attachments.js';
import { agentRoute } from './subagents.js';
import { isMissingTopic, TelegramError } from './telegram.js';
import { ModelPicker } from './model-picker.js';
import { PermissionPicker } from './permission-picker.js';
import { NewSessions } from './new-sessions.js';
import { formatLimits } from './limits.js';
import { array, integer, object, string, type AgentOrigin, type Binding, type Codex, type Json, type Keyboard, type RpcRequest, type Telegram, type UserInput } from './types.js';

interface Prompt {
  approval?: ApprovalCard;
  approvalMarkup?: Json;
  refreshAfter?: number;
  refreshAttempts?: number;
  refreshing?: boolean;
  asyncCallId?: string;
  token: string;
  request: RpcRequest;
  binding: Binding;
  options: Map<string, Json>;
  questions: Json[];
  answers: Record<string, { answers: string[] }>;
  index: number;
  freeText: boolean;
}

export function finalAnswer(turn: Json): string {
  const messages = array(turn.items).map(object).filter(i => i.type === 'agentMessage');
  return messages.filter(i => i.phase === 'final_answer').map(i => string(i.text)).join('\n\n') ||
    string(messages.filter(i => !i.phase).at(-1)?.text);
}

export class Bridge {
  private attached = new Set<string>();
  private agentSubscriptions = new Map<string, string>();
  private observedUnmaterialized = new Set<string>();
  private prompts = new Map<string, Prompt>();
  private finals = new Map<string, string>();
  private fileChanges = new Map<string, unknown[]>();
  private generation = randomUUID();
  private discovering = false;
  private approvalRefreshAt = 0;
  private startedAt = Date.now();
  private topics: Topics;
  private models: ModelPicker;
  private permissions: PermissionPicker;
  private newSessions: NewSessions;
  private pendingBind: { threadId: string; attempt: string; expires: number } | undefined;
  private nameVersions = new Map<string, number>();

  constructor(readonly config: Config, readonly state: State, private readonly codex: Codex, private readonly telegram: Telegram,
    private readonly drafts = new Drafts(telegram, config.ownerId)) {
    this.topics = new Topics(config, state, telegram);
    this.newSessions = new NewSessions(config, state, codex, telegram, this.topics, binding => this.connectCreated(binding));
    this.models = new ModelPicker(state, codex, telegram, config.ownerId, binding => this.settingsThread(binding));
    this.permissions = new PermissionPicker(state, codex, telegram, config.ownerId, binding => this.settingsThread(binding));
  }

  private allowed(cwd: string, threadId: string): boolean { return allowedSessionDirectory(cwd, this.config, this.state.ownsScratch(cwd, threadId)); }
  workNewSession(): Promise<void> { return this.newSessions.tick(); }
  close(): void { this.newSessions.close(); }
  private async connectCreated(binding: Binding): Promise<void> {
    if (!this.allowed(binding.cwd, binding.threadId) || this.config.ignoredThreadIds?.includes(binding.threadId)) throw new RpcError('New session is no longer eligible.', false);
    if (binding.lastTurn === null) this.state.baseline(binding.threadId, '-');
    this.attached.add(binding.threadId);
    try {
      const thread = await this.codex.attach(binding.threadId);
      if (thread.id !== binding.threadId || thread.cwd !== binding.cwd || thread.parentThreadId || thread.ephemeral === true ||
          thread.canAcceptDirectInput === false || !['cli', 'vscode', 'appServer'].includes(string(thread.source))) throw new Error('Created session attachment returned incompatible metadata.');
      this.state.sessionName(binding.threadId, string(thread.name));
    }
    catch (error) { this.attached.delete(binding.threadId); throw error; }
  }

  private async settingsThread(binding: Binding): Promise<Json | undefined> {
    const eligible = (): boolean => this.attached.has(binding.threadId) && !this.config.ignoredThreadIds?.includes(binding.threadId) &&
      this.state.binding(binding.threadId)?.topicId === binding.topicId && this.state.binding(binding.threadId)?.cwd === binding.cwd && !this.state.topicOperation(binding.threadId);
    if (!eligible()) return;
    const thread = await this.codex.read(binding.threadId, 1000);
    if (eligible() && string(thread.cwd) === binding.cwd && this.allowed(binding.cwd, binding.threadId) &&
        ['idle', 'active'].includes(string(object(thread.status).type)) && !thread.parentThreadId && thread.canAcceptDirectInput !== false) return thread;
  }

  /** Synchronous, bounded accumulation: token volume must not fill the control-event queue. */
  streamEvent(method: string, params: Json): void {
    if (!['item/started', 'item/agentMessage/delta', 'item/completed', 'turn/completed'].includes(method)) return;
    const threadId = string(params.threadId);
    const binding = this.state.binding(threadId);
    if (!this.state.streamingEnabled() || !binding || !this.attached.has(threadId) ||
        this.config.ignoredThreadIds?.includes(threadId)) return;
    const turnId = string(params.turnId);
    if (method === 'item/started') {
      const item = object(params.item);
      if (item.type === 'agentMessage') this.drafts.begin(binding, turnId, string(item.id), string(item.phase), string(item.text));
    } else if (method === 'item/agentMessage/delta') {
      this.drafts.append(threadId, turnId, string(params.itemId), string(params.delta));
    } else if (method === 'item/completed') {
      this.drafts.finish(threadId, turnId, string(object(params.item).id));
    } else if (method === 'turn/completed') {
      this.drafts.finish(threadId, string(object(params.turn).id));
    }
  }

  async flushDraft(): Promise<boolean> {
    if (!this.state.streamingEnabled()) { this.drafts.clear(); return false; }
    return this.drafts.flushOne(async (binding, turnId, phase) => {
      const eligible = (): boolean => {
        const current = this.state.binding(binding.threadId);
        const reply = this.state.reply(binding.threadId);
        return this.state.streamingEnabled() && this.attached.has(binding.threadId) && current?.topicId === binding.topicId &&
          !this.state.topicOperation(binding.threadId) && !this.config.ignoredThreadIds?.includes(binding.threadId) &&
          (!phase || phase === 'final_answer' || this.state.messageMode() === 'all' || !!reply && (!reply.turnId || reply.turnId === turnId));
      };
      if (!eligible()) return false;
      // Recheck the live native directory before forwarding text, with a short read-only timeout.
      const current = await this.codex.read(binding.threadId, 1000);
      return this.allowed(string(current.cwd), binding.threadId) && eligible();
    });
  }

  /** File exports require a still-loaded, attached session and its original destination. */
  async allowsFile(binding: Binding): Promise<boolean> {
    const eligible = (): boolean => this.attached.has(binding.threadId) &&
      this.state.binding(binding.threadId)?.topicId === binding.topicId && !this.state.topicOperation(binding.threadId) &&
      !this.config.ignoredThreadIds?.includes(binding.threadId);
    if (!eligible() || !(await this.codex.list(session => session.id === binding.threadId)).some(session => session.id === binding.threadId)) return false;
    const current = await this.codex.read(binding.threadId, 1000);
    return string(current.cwd) === binding.cwd && this.allowed(binding.cwd, binding.threadId) && eligible();
  }

  async discover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      const nameVersions = new Map(this.nameVersions);
      const readSessions = () => this.codex.list(session => !this.config.ignoredThreadIds?.includes(session.id) && this.allowed(session.cwd, session.id));
      let sessions = await readSessions();
      if (await this.newSessions.restore(sessions.map(session => session.id))) sessions = await readSessions();
      const loaded = new Set(sessions.map(s => s.id));
      for (const id of this.nameVersions.keys()) if (!loaded.has(id)) this.nameVersions.delete(id);
      for (const id of this.attached) if (!loaded.has(id)) { this.attached.delete(id); this.drafts.finish(id); }
      for (const id of this.observedUnmaterialized) if (!loaded.has(id)) this.observedUnmaterialized.delete(id);
      for (const session of sessions) {
        if (this.newSessions.busy(session.id, session.threadSource)) continue;
        if (this.config.ignoredThreadIds?.includes(session.id) || !this.allowed(session.cwd, session.id)) { this.attached.delete(session.id); continue; }
        try {
          const previous = this.state.binding(session.id);
          // Check native readiness before creating/replacing a topic. Keep the binding before attach so replayed requests can route.
          const history = !this.attached.has(session.id) || this.state.topicOperation(session.id) ? await this.codex.turns(session.id) : undefined;
          let binding = await this.topics.ensure(session);
          if (!binding) { this.attached.delete(session.id); continue; }
          if ((this.nameVersions.get(session.id) ?? 0) === (nameVersions.get(session.id) ?? 0)) this.state.sessionName(session.id, session.name);
          binding = this.state.binding(session.id)!;
          if (this.attached.has(session.id) && previous?.topicId === binding.topicId) { await this.syncAsyncQuestions(binding); continue; }
          if (previous && previous.topicId !== binding.topicId) {
            await this.retireTopicPrompts(session.id);
          }
          if (binding.lastTurn === null) {
            const completed = (history ?? await this.codex.turns(session.id)).find(t => t.status !== 'inProgress');
            const createdWhileRunning = session.createdAt !== undefined && session.createdAt * 1000 >= this.startedAt;
            this.state.baseline(session.id, createdWhileRunning || this.observedUnmaterialized.has(session.id) ? '-' : string(completed?.id) || '-');
            binding = this.state.binding(session.id)!;
          }
          this.observedUnmaterialized.delete(session.id); // Baseline now preserves the first answer across attachment retries.
          this.attached.add(session.id);
          await this.codex.attach(session.id);
          // Replayed requests identify what needs attention. Attachment itself is not a new prompt.
          await this.catchUp(binding);
          await this.syncAsyncQuestions(binding);
        } catch (error) {
          this.attached.delete(session.id);
          if (error instanceof FirstMessageRequiredError) { this.observedUnmaterialized.add(session.id); continue; }
          if (error instanceof RpcError && error.uncertain) throw error;
          this.state.enqueue(`session-unavailable/${this.generation}/${session.id}`, null,
            `Codex session ${session.id.slice(0, 8)} is temporarily unavailable. Other sessions remain connected; this session will be retried automatically.`, null, session.cwd, session.id);
        }
      }
      await this.discoverAgents();
      await this.flushApproval();
    } finally { this.discovering = false; }
  }

  private async discoverAgents(): Promise<void> {
    if (!this.codex.loaded) return;
    const loaded = await this.codex.loaded();
    const eligible = new Set<string>();
    for (const id of loaded) {
      if (this.attached.has(id)) continue;
      let route;
      try {
        route = await agentRoute(id, this.codex, this.config, root => this.attached.has(root) ? this.state.binding(root) : undefined, cwd => this.state.ownsScratch(cwd));
        if (!route) continue;
        if (eligible.size >= 128) {
          this.state.enqueue(`notice/subagent-limit/${this.generation}`, null, 'The relay reached its limit of 128 loaded subagents. Check Codex locally for additional approvals.');
          continue;
        }
        eligible.add(id);
        if (this.agentSubscriptions.get(id) === route.binding.threadId) continue;
        await this.codex.turns(id);
        this.agentSubscriptions.set(id, route.binding.threadId);
        await this.codex.attach(id); // Pending requests replay for this exact origin, not its root.
      } catch (error) {
        eligible.delete(id);
        if (error instanceof RpcError && error.uncertain) throw error;
        if (route && !(error instanceof FirstMessageRequiredError)) {
          this.state.enqueue(`attention/subagent-unavailable/${this.generation}/${id}`, route.binding.topicId,
            `Subagent ${id} could not be connected. Check its approvals in Codex; the relay will retry automatically.`);
        }
      }
    }
    for (const id of this.agentSubscriptions.keys()) if (!eligible.has(id)) {
      this.agentSubscriptions.delete(id);
      for (const prompt of [...this.prompts.values()]) if (prompt.request.params.threadId === id) await this.clearPrompt(prompt);
    }
  }

  async catchUp(binding: Binding): Promise<void> {
    const turns = await this.codex.turns(binding.threadId);
    const saved = this.state.binding(binding.threadId)?.lastTurn;
    const missed: Json[] = [];
    for (const turn of turns) {
      if (turn.id === saved) break;
      if (['completed', 'failed', 'interrupted'].includes(string(turn.status))) missed.push(turn);
    }
    for (const turn of missed.reverse()) await this.complete(binding, turn);
  }

  async notification(method: string, params: Json): Promise<void> {
    if (method === 'thread/started') { this.newSessions.observeStarted(object(params.thread)); return; }
    if (method === 'thread/name/updated') {
      const threadId = string(params.threadId);
      if (this.attached.has(threadId)) {
        this.nameVersions.set(threadId, (this.nameVersions.get(threadId) ?? 0) + 1);
        this.state.sessionName(threadId, string(params.threadName));
      }
      return;
    }
    this.streamEvent(method, params);
    const threadId = string(params.threadId) || string(object(params.thread).id);
    if (method === 'serverRequest/resolved') {
      if (typeof params.requestId === 'string' || typeof params.requestId === 'number') this.state.resolveApproval(threadId, params.requestId);
      for (const prompt of [...this.prompts.values()]) {
        if ((string(prompt.request.params.threadId) || prompt.binding.threadId) === threadId && prompt.request.id === params.requestId) await this.clearPrompt(prompt);
      }
      return;
    }
    if (method === 'item/started' && object(params.item).type === 'fileChange') {
      if (!await this.requestRoute(threadId)) return;
      const item = object(params.item);
      const changes = array(item.changes);
      if (changes.length && JSON.stringify(changes).length <= 18_000) {
        if (this.fileChanges.size >= 128) this.fileChanges.delete(this.fileChanges.keys().next().value!);
        this.fileChanges.set(`${threadId}/${string(item.id)}`, changes);
      }
      return;
    }
    const binding = this.state.binding(threadId);
    if (!binding || !this.attached.has(threadId)) {
      if (method === 'turn/completed') await this.clearTurnPrompts(threadId, string(object(params.turn).id));
      return;
    }
    if (method === 'item/completed') {
      const item = object(params.item);
      if (item.type === 'agentMessage' && ['commentary', 'partial_answer'].includes(string(item.phase)) && string(item.text).trim()) {
        const reply = this.state.reply(threadId);
        const matchingReply = reply && (!reply.turnId || reply.turnId === params.turnId);
        const all = this.state.messageMode() === 'all';
        if ((all || matchingReply) && await this.stillAllowed(binding)) {
          const itemId = string(item.id) || createHash('sha256').update(string(item.text)).digest('hex');
          const key = all ? `assistant/${threadId}/${string(params.turnId)}/${itemId}` : `reply/${threadId}/${reply!.inputId}`;
          this.state.enqueue(key, binding.topicId, string(item.text));
          if (matchingReply) this.state.clearReply(threadId, reply.inputId);
        }
      }
      if (item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer')) {
        this.finals.set(`${threadId}/${string(params.turnId)}`, string(item.text));
      }
    } else if (method === 'turn/completed') {
      await this.complete(binding, object(params.turn));
    }
  }

  private async complete(binding: Binding, turn: Json): Promise<void> {
    const turnId = string(turn.id);
    if (!turnId) return;
    const status = string(turn.status);
    if (!['completed', 'failed', 'interrupted'].includes(status)) return;
    if (!await this.stillAllowed(binding)) return;
    let text = finalAnswer(turn) || this.finals.get(`${binding.threadId}/${turnId}`) || '';
    if (!text) {
      const snapshot = (await this.codex.turns(binding.threadId)).find(t => t.id === turnId);
      if (snapshot) text = finalAnswer(snapshot);
    }
    const header = status === 'completed' ? '✅ Turn finished' : status === 'interrupted' ? '⏹ Turn interrupted' : '❌ Turn failed';
    const error = string(object(turn.error).message);
    this.state.enqueue(`final/${binding.threadId}/${turnId}`, binding.topicId, `${header}\n\n${text || error || 'See the terminal for details.'}`);
    this.state.baseline(binding.threadId, turnId);
    const reply = this.state.reply(binding.threadId);
    if (reply && (!reply.turnId || reply.turnId === turnId)) this.state.clearReply(binding.threadId, reply.inputId);
    this.finals.delete(`${binding.threadId}/${turnId}`);
    await this.clearTurnPrompts(binding.threadId, turnId);
  }

  async request(request: RpcRequest): Promise<void> {
    const route = await this.requestRoute(string(request.params.threadId));
    if (!route) return;
    const { binding, agent } = route;
    const existing = [...this.prompts.values()].find(p => p.request.id === request.id);
    if (existing) {
      if (approvalIdentity(existing.request) === approvalIdentity(request)) return;
      await this.clearPrompt(existing);
    }
    if (agent && !request.method.endsWith('/requestApproval')) {
      this.attention(binding, request, `A subagent needs input in Codex. Check agent ${agent.threadId} in the terminal.`); return;
    }
    const prompt: Prompt = {
      token: randomBytes(16).toString('hex'), request, binding, options: new Map(), questions: [], answers: Object.create(null) as Record<string, { answers: string[] }>, index: 0, freeText: false,
    };
    if (request.method === 'item/tool/requestUserInput') {
      prompt.questions = array(request.params.questions).map(object);
      if (prompt.questions.length === 0 || prompt.questions.length > 10 ||
          new Set(prompt.questions.map(q => string(q.id))).size !== prompt.questions.length ||
          prompt.questions.some(q => !string(q.id) || !string(q.question) || q.isSecret === true ||
            JSON.stringify(q).length > 18_000 || array(q.options).length > 10 ||
            array(q.options).some(o => !string(object(o).label)))) {
        this.attention(binding, request, 'A native question needs the terminal (unsupported or sensitive input).'); return;
      }
      this.prompts.set(prompt.token, prompt);
      this.restoreQuestionAnswers(prompt);
      this.showQuestion(prompt);
      return;
    }
    const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
    if (!methods.includes(request.method)) {
      this.attention(binding, request, 'Codex needs input that this relay cannot safely answer. Use the terminal.'); return;
    }
    const detailsParams = { ...request.params };
    if (request.method === 'item/fileChange/requestApproval') {
      const changes = array(request.params.changes).length ? array(request.params.changes) : this.fileChanges.get(`${string(request.params.threadId)}/${string(request.params.itemId)}`);
      if (!changes?.length) { this.attention(binding, request, 'Review this file change in the terminal: its complete proposed diff is not available to the relay.'); return; }
      detailsParams.proposedChanges = changes;
    }
    const card = approvalMessage(request.method, detailsParams, agent);
    if (request.method === 'item/permissions/requestApproval') {
      prompt.options.set('a', { permissions: object(request.params.permissions), scope: 'turn' });
      prompt.options.set('d', { permissions: {}, scope: 'turn' });
    } else {
      const decisions = array(request.params.availableDecisions);
      const advertised = Array.isArray(request.params.availableDecisions);
      if (!advertised || decisions.includes('accept')) prompt.options.set('a', { decision: 'accept' });
      if (!advertised || decisions.includes('decline')) prompt.options.set('d', { decision: 'decline' });
      if (advertised && decisions.includes('cancel')) prompt.options.set('c', { decision: 'cancel' });
    }
    if (!prompt.options.size) { this.attention(binding, request, 'Approval choices are unsupported. Use the terminal.'); return; }
    const keyboard: Keyboard = { inline_keyboard: [[...prompt.options.keys()].map(code => ({ text: code === 'a' ? 'Allow once' : code === 'c' ? 'Cancel turn' : 'Decline', callback_data: `r:${prompt.token}:${code}` }))] };
    const identity = approvalIdentity(request);
    prompt.approval = this.state.approvalCard(approvalCardIdentity(identity, binding, card), identity, string(request.params.threadId), string(request.params.turnId), request.id, prompt.token);
    if (prompt.approval.status !== 'pending') {
      if (prompt.approval.status === 'consumed') this.attention(binding, request, 'A decision was already submitted for this approval. Check its outcome in Codex; it will not be submitted again.');
      return;
    }
    this.prompts.set(prompt.token, prompt);
    const key = this.promptKey(prompt);
    const markup = keyboard as unknown as Json;
    prompt.approvalMarkup = markup;
    const receipt = this.state.approvalReceipt(key);
    if (!receipt) this.state.enqueue(key, binding.topicId, approvalDisplayMessage(request.method, detailsParams, agent), markup);
    else if (receipt.status === 'pending' || receipt.status === 'held') this.state.approvalMarkup(key, markup, prompt.token);
    else await this.refreshApproval(prompt);
  }

  /** Refresh known card controls; edits never manufacture another message after a lost acknowledgement. */
  async flushApproval(): Promise<boolean> {
    for (const prompt of this.prompts.values()) if (await this.refreshApproval(prompt)) return true;
    return false;
  }

  private async refreshApproval(prompt: Prompt): Promise<boolean> {
    if (!prompt.approval || !prompt.approvalMarkup || prompt.refreshing ||
        Date.now() < Math.max(this.approvalRefreshAt, prompt.refreshAfter ?? 0) || !this.pending(prompt)) return false;
    const key = this.promptKey(prompt);
    const receipt = this.state.approvalReceipt(key);
    if (!receipt || ['pending', 'sending'].includes(receipt.status)) return false;
    if (receipt.status !== 'held' && (receipt.status !== 'sent' || receipt.messageId === null)) {
      this.attention(prompt.binding, prompt.request, 'This approval card could not be confirmed in Telegram. Check the existing messages and answer in Codex; another copy will not be sent automatically.');
      prompt.refreshAfter = Infinity; return true;
    }
    if (receipt.status === 'sent' && JSON.stringify(receipt.markup) === JSON.stringify(prompt.approvalMarkup)) return false;
    prompt.refreshing = true;
    this.approvalRefreshAt = Date.now() + 1000;
    let editing = false;
    try {
      if (!await this.promptAllowed(prompt)) { await this.clearPrompt(prompt); return true; }
      if (this.prompts.get(prompt.token) !== prompt || !this.pending(prompt)) return false;
      if (receipt.status === 'held') return this.state.approvalMarkup(key, prompt.approvalMarkup, prompt.token);
      try {
        editing = true;
        await this.telegram.call('editMessageReplyMarkup', { chat_id: this.config.ownerId, message_id: receipt.messageId, reply_markup: prompt.approvalMarkup });
      } catch (error) {
        if (!(error instanceof TelegramError) || error.status !== 400 || !/message is not modified|MESSAGE_NOT_MODIFIED/iu.test(error.message)) throw error;
      }
      if (!this.state.ownsApprovalCard(key, prompt.token)) return true;
      if (this.prompts.get(prompt.token) !== prompt || !this.pending(prompt)) {
        await this.clearPrompt(prompt); return true;
      }
      this.state.approvalMarkup(key, prompt.approvalMarkup, prompt.token);
      prompt.refreshAttempts = 0;
    } catch (error) {
      const binding = this.state.binding(prompt.binding.threadId);
      if (this.prompts.get(prompt.token) !== prompt || !this.pending(prompt) ||
          binding?.topicId !== prompt.binding.topicId || binding.cwd !== prompt.binding.cwd) return true;
      if (isMissingTopic(error)) { this.state.missingTopic(prompt.binding); prompt.refreshAfter = Infinity; }
      else if (error instanceof TelegramError && [400, 403, 404].includes(error.status)) {
        this.attention(prompt.binding, prompt.request, 'The existing approval card cannot be updated. Review and answer this request in Codex.');
        prompt.refreshAfter = Infinity;
      } else {
        prompt.refreshAttempts = Math.min((prompt.refreshAttempts ?? 0) + 1, 5);
        const seconds = error instanceof TelegramError && error.status === 429 ? Math.min(Math.max(error.retryAfter ?? 2, 1), 60) : Math.min(2 ** prompt.refreshAttempts, 30);
        prompt.refreshAfter = Date.now() + seconds * 1000;
        this.approvalRefreshAt = prompt.refreshAfter;
      }
    } finally {
      prompt.refreshing = false;
      // An old HTTP edit may arrive after the new owner wrote its controls. Reconcile that known message again.
      if (editing && !this.state.ownsApprovalCard(key, prompt.token)) {
        this.state.invalidateApprovalMarkup(key);
        if (!this.state.approvalPending(prompt.approval.identity)) await this.clearPrompt(prompt);
      }
    }
    return true;
  }

  async update(update: Json): Promise<void> {
    const id = integer(update.update_id);
    if (id === undefined) return;
    const callback = object(update.callback_query);
    const message = Object.keys(callback).length ? object(callback.message) : object(update.message);
    const from = Object.keys(callback).length ? object(callback.from) : object(message.from);
    const chat = object(message.chat);
    // Authorize before any payload journal, task allocation, native request, or outbound reply.
    if (from.id !== this.config.ownerId || from.is_bot === true || chat.id !== this.config.ownerId || chat.type !== 'private') {
      this.state.advance(id); return;
    }
    const topic = integer(message.message_thread_id) ?? null;
    if (!this.state.admit(id, topic)) { this.state.advance(id); return; }
    try {
      if (Object.keys(callback).length && string(callback.data).startsWith('recover:')) {
        await this.recoverTopic(callback, message, topic); this.state.finish(id, 'done'); return;
      }
      if (Object.keys(callback).length && string(callback.data).startsWith('n:')) {
        await this.newSessions.callback(callback, message, topic); this.state.finish(id, 'done'); return;
      }
      if (Object.keys(callback).length && string(callback.data).startsWith('m:')) {
        this.state.finish(id, await this.models.callback(callback, message, topic)); return;
      }
      if (Object.keys(callback).length && string(callback.data).startsWith('p:')) {
        this.state.finish(id, await this.permissions.callback(callback, message, topic)); return;
      }
      if (Object.keys(callback).length) await this.callback(callback, message, topic, id);
      else await this.message(message, topic, id);
      this.state.finish(id, 'done');
    } catch (error) {
      if (error instanceof AttachmentError) { this.state.finish(id, 'rejected'); this.notice(topic, error.message); return; }
      if (error instanceof RpcError && !error.uncertain) { this.state.finish(id, 'rejected'); this.notice(topic, error.message + '\nNo instruction was accepted. You can retry after resolving this issue.'); return; }
      this.state.finish(id, 'uncertain');
      this.notice(topic, '⚠️ Delivery could not be confirmed. Check the terminal before sending the same instruction again.');
      throw error;
    } finally { this.state.advance(id); }
  }

  private async message(message: Json, topicId: number | null, inputId: number): Promise<void> {
    if (['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'animation'].some(key => message[key])) {
      await this.mediaMessage(message, topicId, inputId); return;
    }
    const text = string(message.text).trim();
    if (!text) return;
    if (/^\/(start|help)(?:\s|$)/u.test(text)) {
      this.notice(topicId, commandHelp()); return;
    }
    if (/^\/new(?:\s|$)/u.test(text)) { await this.newSessions.open(topicId, text); return; }
    if (/^\/limits(?:\s|$)/u.test(text)) {
      if (text !== '/limits') { this.notice(topicId, 'Используйте /limits без аргументов.'); return; }
      try { this.notice(topicId, formatLimits(await this.codex.rateLimits())); }
      catch { this.notice(topicId, 'Не удалось получить лимиты Codex. Проверьте подключение и вход в аккаунт Codex, затем повторите /limits.'); }
      return;
    }
    if (text === '/sessions') {
      this.notice(topicId, this.state.bindings().map(b => `${b.title}\n${b.threadId}\nSaved topic: #${b.topicId}${this.config.ignoredThreadIds?.includes(b.threadId) ? ' (ignored)' : this.attached.has(b.threadId) ? ' (connected)' : ' (not attached; saved binding only)'}`).join('\n\n') || 'No sessions attached. Open Codex in an eligible project and send its first prompt.'); return;
    }
    if (text === '/status') { this.state.enqueue(`attention/status/${randomUUID()}`, topicId, `Connected sessions: ${this.attached.size}\nSession discovery: ${this.config.sessionScope === 'all' ? 'automatic (all projects)' : 'selected projects'}\nMessage mode: ${this.state.messageMode()}\nLive previews: ${this.state.streamingEnabled() ? 'on' : 'off'}\nPending final answers: ${this.state.pendingFinalCount()}\nUncertain deliveries: ${this.state.uncertainCount()}\nTopics awaiting recovery: ${this.state.topicOperations().length}\nPermissions: inherited from Codex; /permissions explicitly changes this session’s settings.`); return; }
    if (/^\/stream(?:\s|$)/u.test(text)) {
      const [, mode, extra] = text.split(/\s+/u);
      if (extra || mode !== undefined && mode !== 'on' && mode !== 'off') { this.notice(topicId, 'Use /stream on or /stream off.'); return; }
      if (mode) { this.state.setStreaming(mode === 'on'); if (mode === 'off') this.drafts.clear(); }
      this.notice(topicId, `Live previews for all sessions: ${this.state.streamingEnabled() ? 'on' : 'off'}.\n/stream on — show answers as they are generated, with rich formatting\n/stream off — deliver completed messages only\nComplete answers and tables are saved separately in both modes. Changes apply immediately; an existing preview may take up to 30 seconds to disappear.`); return;
    }
    if (/^\/(?:bind|repair)(?:\s|$)/u.test(text)) {
      const [command, supplied, extra] = text.split(/\s+/u);
      let prefix = supplied;
      let selectedBind: typeof this.pendingBind;
      if (command === '/bind' && !prefix && this.pendingBind) {
        const pending = this.pendingBind;
        if (pending.expires < Date.now() || this.state.topicOperation(pending.threadId)?.attempt !== pending.attempt) {
          this.pendingBind = undefined; this.notice(topicId, 'Выбор для привязки устарел. Нажмите кнопку восстановления ещё раз.'); return;
        }
        prefix = pending.threadId;
        selectedBind = pending;
      }
      if (!prefix || extra || (command === '/bind' && topicId === null)) { this.notice(topicId, 'Use /bind SESSION_ID inside the existing topic, or /repair SESSION_ID to explicitly retry creation.'); return; }
      try {
        const session = this.topics.resolve(prefix);
        const saved = this.state.binding(session.id);
        if (saved && !this.state.topicOperation(session.id)) {
          if (topicId !== saved.topicId) {
            this.notice(topicId, `Session ${session.id.slice(0, 8)} has a saved binding to topic #${saved.topicId}.\n${await this.connectionStatus(saved)}\nOpen that topic and send /bind ${session.id}. No replacement was created and its binding was not changed.`);
            return;
          }
          await this.discover();
          this.notice(topicId, `Saved topic #${saved.topicId} for session ${session.id.slice(0, 8)}.\n${await this.connectionStatus(saved)}\nNo replacement was created; no Codex instruction was sent.`);
          return;
        }
        await this.codex.turns(session.id); // Explicit recovery must respect the same first-message gate as discovery.
        if (selectedBind) {
          const live = (await this.codex.list(s => s.id === session.id)).find(s => s.id === session.id);
          if (!live || live.cwd !== session.cwd || !this.allowed(live.cwd, session.id) || this.config.ignoredThreadIds?.includes(session.id))
            throw new Error('Сессия больше не доступна в выбранном проекте. Возобновите её в Codex и повторите восстановление.');
          if (this.pendingBind !== selectedBind || selectedBind.expires < Date.now() || this.state.topicOperation(session.id)?.attempt !== selectedBind.attempt)
            throw new Error('Выбор для привязки устарел. Нажмите кнопку восстановления ещё раз.');
        }
        const binding = command === '/bind' ? this.topics.bind(prefix, topicId!) : await this.topics.retry(prefix);
        if (binding) {
          if (this.pendingBind?.threadId === binding.threadId) this.pendingBind = undefined;
          this.attached.delete(binding.threadId);
          await this.retireTopicPrompts(binding.threadId);
          this.notice(topicId, `Topic bound to session ${binding.threadId.slice(0, 8)}. The relay will reconnect it automatically; no Codex instruction was sent.`);
        }
      } catch (error) { this.notice(topicId, string(object(error).message) || 'Topic recovery failed.'); }
      return;
    }
    if (/^\/mode(?:\s|$)/u.test(text)) {
      const mode = text.split(/\s+/u)[1];
      if (mode !== undefined && mode !== 'all' && mode !== 'compact') { this.notice(topicId, 'Use /mode all or /mode compact.'); return; }
      if (mode) this.state.setMessageMode(mode);
      this.notice(topicId, `Message mode for all sessions: ${this.state.messageMode()}.\n/mode all — every assistant message, without tool/system output\n/mode compact — first reply to Telegram input and final answer\nChanges apply immediately to future messages.`); return;
    }
    if (text === '/questions') {
      let count = 0;
      for (const p of [...this.prompts.values()].filter(p => p.binding.topicId === topicId && p.questions.length)) {
        if (this.pending(p) && await this.asyncStillPending(p) && await this.promptAllowed(p) && this.prompts.get(p.token) === p && this.pending(p)) { this.showQuestion(p, true); count++; }
        else if (this.prompts.get(p.token) === p) await this.clearPrompt(p);
      }
      if (!count) this.notice(topicId, 'No current questions. Requests from before connection may still need the terminal.');
      return;
    }
    if (/^\/permissions(?:\s|$)/u.test(text)) {
      const binding = topicId === null ? undefined : this.state.topic(topicId);
      if (!binding) { this.notice(topicId, 'Откройте топик подключённой сессии и отправьте /permissions.'); return; }
      if (text !== '/permissions') { this.notice(topicId, 'Используйте /permissions и выберите режим кнопками.'); return; }
      await this.permissions.open(binding); return;
    }
    if (/^\/model(?:\s|$)/u.test(text)) {
      const binding = topicId === null ? undefined : this.state.topic(topicId);
      if (!binding) { this.notice(topicId, 'Откройте топик подключённой сессии и отправьте /model.'); return; }
      if (text !== '/model') { this.notice(topicId, 'Используйте /model и выберите модель кнопками.'); return; }
      await this.models.open(binding); return;
    }
    const binding = topicId === null ? undefined : this.state.topic(topicId);
    if (!binding) { this.notice(topicId, 'This topic has no saved session binding. Use /sessions to find the session and its saved topic; /bind SESSION_ID only recovers a topic awaiting recovery.'); return; }
    if (!this.attached.has(binding.threadId)) { this.notice(topicId, `Saved topic #${binding.topicId} for session ${binding.threadId.slice(0, 8)}.\n${await this.connectionStatus(binding)}\nNo instruction was sent.`); return; }
    if (!this.allowed(binding.cwd, binding.threadId)) throw new Error('Project is outside configured roots.');
    const question = [...this.prompts.values()].filter(p => p.binding.topicId === topicId && p.questions.length && this.pending(p));
    if (!text.startsWith('/') && question.length) {
      const focused = question.filter(p => p.freeText);
      const target = focused.length === 1 ? focused[0] : question.length === 1 ? question[0] : undefined;
      if (!target) { this.notice(topicId, 'Several questions are pending. Choose “Type an answer” on the question you want to answer.'); return; }
      await this.answer(target, text, inputId); return;
    }
    if (text.startsWith('/')) { this.notice(topicId, 'Unknown command. Use /help; /model changes this session’s model settings.'); return; }
    const prompt = text;
    if (!prompt || prompt.length > 16_000) { this.notice(topicId, 'Send a text instruction of at most 16000 characters.'); return; }
    await this.sendInput(binding, inputId, prompt);
  }

  private async connectionStatus(binding: Binding): Promise<string> {
    if (this.config.ignoredThreadIds?.includes(binding.threadId)) return 'This session is ignored. Re-enable it locally before reconnecting.';
    if (!this.allowed(binding.cwd, binding.threadId)) return 'This session is outside your selected projects. Select its project locally before reconnecting.';
    if (this.attached.has(binding.threadId)) return 'The native session is connected. Send instructions in its saved topic.';
    try {
      const sessions = await this.codex.list(session => session.id === binding.threadId);
      if (!sessions.length) return `The session is not loaded as an eligible interactive session in Codex. Resume this exact session locally (codex resume ${binding.threadId}, or reopen the same conversation in the IDE). The relay will reconnect automatically; /bind ${binding.threadId} in the saved topic retries the connection.`;
      await this.codex.turns(binding.threadId);
    } catch (error) {
      if (error instanceof FirstMessageRequiredError) return error.message;
      return 'The native connection could not be checked. The saved binding does not confirm that the session is running. Check Codex locally and retry /bind in the saved topic.';
    }
    return `The native session is loaded but relay attachment has not succeeded. Check Codex locally and retry /bind ${binding.threadId} in the saved topic. Creating another Telegram topic will not reconnect it.`;
  }

  private async recoverTopic(callback: Json, message: Json, topicId: number | null): Promise<void> {
    const match = /^recover:([a-f0-9]{32}):([br])$/u.exec(string(callback.data));
    const operation = match ? this.state.topicOperations().find(op => op.attempt.replaceAll('-', '') === match[1]) : undefined;
    if (!operation || topicId !== null || !['failed', 'uncertain'].includes(operation.status) ||
        integer(message.message_id) !== this.state.promptMessage(`topic-problem/${operation.attempt}`)) {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'Это действие восстановления уже недоступно.' }); return;
    }
    await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id });
    try {
      const session = this.topics.resolve(operation.threadId);
      const live = (await this.codex.list(s => s.id === session.id)).find(s => s.id === session.id);
      if (!live || live.cwd !== session.cwd) throw new Error('Возобновите эту сессию локально в Codex перед восстановлением топика.');
      await this.codex.turns(session.id);
      const current = this.state.topicOperation(session.id);
      if (current?.attempt !== operation.attempt || !['failed', 'uncertain'].includes(current.status)) throw new Error('Состояние восстановления уже изменилось. Проверьте /sessions.');
      if (match![2] === 'b') {
        this.pendingBind = { threadId: session.id, attempt: operation.attempt, expires: Date.now() + 10 * 60 * 1000 };
        this.state.enqueue(`notice/recovery/${randomUUID()}`, topicId, `${operation.title}\nОткройте появившийся топик и отправьте /bind без ID. Выбор действует 10 минут; инструкция в Codex отправлена не будет.`, null, operation.cwd, session.id);
      } else {
        const binding = await this.topics.retry(session.id);
        if (binding) {
          this.attached.delete(binding.threadId); await this.retireTopicPrompts(binding.threadId);
          this.notice(binding.topicId, 'Топик восстановлен. Релей подключит сессию автоматически.');
        }
      }
    } catch (error) { this.notice(topicId, string(object(error).message) || 'Не удалось восстановить топик.'); }
  }

  private async mediaMessage(message: Json, topicId: number | null, inputId: number): Promise<void> {
    const binding = topicId === null ? undefined : this.state.topic(topicId);
    if (!binding) throw new AttachmentError('Send attachments in an attached project topic. No instruction was sent.');
    if (!this.attached.has(binding.threadId)) throw new AttachmentError(`${await this.connectionStatus(binding)} No attachment was downloaded or instruction sent.`);
    if (!await this.stillAllowed(binding)) throw new AttachmentError('This session is outside your selected projects. No attachment was downloaded or instruction sent.');
    const caption = string(message.caption).trim();
    if (caption.length > 16_000) throw new AttachmentError('Attachment captions are limited to 16000 characters. No instruction was sent.');
    const pending = [...this.prompts.values()].filter(p => p.binding.threadId === binding.threadId && p.questions.length && this.pending(p));
    const focused = pending.filter(p => p.freeText);
    const question = focused.length === 1 ? focused[0] : pending.length === 1 ? pending[0] : undefined;
    if (pending.length && !question) throw new AttachmentError('Several questions are pending. Choose “Type an answer” on the intended question before attaching a file. No attachment was downloaded.');
    let inputs: UserInput[];
    try { inputs = await new Attachments(this.state.home, this.telegram).prepare(message); }
    catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError('The attachment could not be saved in the private cache. No instruction was sent.');
    }
    if (!inputs.length) throw new AttachmentError('The attachment could not be identified. No instruction was sent.');
    if (question) {
      const text = [caption, ...inputs.map(i => i.type === 'text' ? i.text : `Image file available for inspection: ${JSON.stringify(i.path)}`)].filter(Boolean).join('\n\n');
      await this.answer(question, text, inputId, inputs.filter(i => i.type === 'localImage'));
    } else {
      await this.sendInput(binding, inputId, [{ type: 'text', text: caption || 'Please inspect the attached file.' }, ...inputs]);
    }
  }

  private async callback(callback: Json, _message: Json, topicId: number | null, inputId: number): Promise<void> {
    const data = string(callback.data);
    const match = /^r:([a-f0-9]{32}):([a-z0-9]+)$/u.exec(data);
    const prompt = match ? this.prompts.get(match[1]!) : undefined;
    if (!prompt || prompt.binding.topicId !== topicId || !this.attached.has(prompt.binding.threadId) || !this.pending(prompt)) {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'This request is closed or belongs to another topic.' }); return;
    }
    if (!await this.asyncStillPending(prompt)) { await this.clearPrompt(prompt); await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'This question is closed or cannot currently be verified. Check Codex.' }); return; }
    if (!await this.promptAllowed(prompt)) { await this.clearPrompt(prompt); await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'This session or its parent is no longer eligible for this topic.' }); return; }
    await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id });
    const code = match![2]!;
    if (prompt.questions.length) {
      if (code === 't') {
        for (const p of this.prompts.values()) if (p.binding.topicId === topicId) p.freeText = false;
        prompt.freeText = true; this.notice(topicId, 'Send your answer as a text message in this topic.'); return;
      }
      const option = array(prompt.questions[prompt.index]?.options)[Number(code)];
      if (!option || !/^\d+$/u.test(code)) return;
      await this.answer(prompt, string(object(option).label), inputId); return;
    }
    const result = prompt.options.get(code);
    if (!result) return;
    // Consume before writing the response; a duplicated click cannot repeat a decision.
    if (prompt.approval && !this.state.consumeApproval(prompt.approval.identity)) { await this.clearPrompt(prompt); return; }
    await this.clearPrompt(prompt);
    if (string(prompt.request.params.threadId) !== prompt.binding.threadId) await this.codex.respond(prompt.request.id, result);
    else await this.awaitAssistant(prompt.binding.threadId, inputId, string(prompt.request.params.turnId) || null,
      () => this.codex.respond(prompt.request.id, result));
  }

  private showQuestion(prompt: Prompt, repeat = false): void {
    const waiting = this.state.reply(prompt.binding.threadId);
    if (waiting) this.state.clearReply(prompt.binding.threadId, waiting.inputId);
    const question = prompt.questions[prompt.index]!;
    const options = array(question.options).map(object);
    const rows = options.slice(0, 10).map((o, i) => [{ text: Array.from(`${i + 1} · ${string(o.label)}`).slice(0, 60).join(''), callback_data: `r:${prompt.token}:${i}` }]);
    rows.push([{ text: 'Type an answer', callback_data: `r:${prompt.token}:t` }]);
    const progress = prompt.questions.length > 1 ? ` · ${prompt.index + 1}/${prompt.questions.length}` : '';
    const choices = options.map((o, i) => `${i + 1}. ${string(o.label)}${o.description ? '\n' + string(o.description) : ''}`).join('\n\n');
    const text = `❓ ${string(question.header) || 'Codex needs your answer'}${progress}\n\n${string(question.question)}` +
      (choices ? '\n\n' + choices : '') + '\n\nChoose a button or write your own answer in this topic.';
    this.state.enqueue(this.promptKey(prompt) + (repeat ? '/' + randomUUID() : ''), prompt.binding.topicId, text, { inline_keyboard: rows });
  }
  private async answer(prompt: Prompt, text: string, inputId: number, images: UserInput[] = []): Promise<void> {
    if (!await this.stillAllowed(prompt.binding)) { await this.clearPrompt(prompt); return; }
    if (!await this.asyncStillPending(prompt)) { await this.clearPrompt(prompt); this.notice(prompt.binding.topicId, 'This question is closed or cannot currently be verified. Check Codex before answering again.'); return; }
    const question = prompt.questions[prompt.index]!;
    prompt.answers[string(question.id)] = { answers: [text] };
    const saved = this.progressIdentity(prompt);
    if (saved) this.state.saveQuestionAnswers(saved.key, saved.signature, prompt.answers);
    if (prompt.index + 1 < prompt.questions.length) {
      await this.clearPrompt(prompt);
      prompt.index++; prompt.freeText = false;
      // Each question gets a fresh capability; old buttons cannot answer the next question.
      prompt.token = randomBytes(16).toString('hex');
      this.prompts.set(prompt.token, prompt);
      this.showQuestion(prompt);
    } else {
      if (prompt.asyncCallId) {
        // Host async tools have no pending app-server RPC. Deliver a normal, explicit user answer.
        if (!this.state.beginAsyncAnswer(prompt.binding.threadId, prompt.asyncCallId)) return;
        const text = prompt.questions.map(q => `Question: ${string(q.question)}\nAnswer: ${prompt.answers[string(q.id)]!.answers.join(', ')}`).join('\n\n');
        try {
          await this.sendInput(prompt.binding, inputId, images.length ? [{ type: 'text', text }, ...images] : text);
          this.state.finishAsyncAnswer(prompt.binding.threadId, prompt.asyncCallId, 'accepted');
          if (saved) this.state.clearQuestionAnswers(saved.key);
          await this.clearPrompt(prompt);
        } catch (error) {
          const rejected = error instanceof RpcError && !error.uncertain;
          this.state.finishAsyncAnswer(prompt.binding.threadId, prompt.asyncCallId, rejected ? 'rejected' : 'uncertain');
          if (!rejected) await this.clearPrompt(prompt);
          if (!rejected && saved) this.state.clearQuestionAnswers(saved.key);
          throw error;
        }
      } else {
        await this.clearPrompt(prompt);
        await this.awaitAssistant(prompt.binding.threadId, inputId, string(prompt.request.params.turnId) || null,
          () => this.codex.respond(prompt.request.id, { answers: prompt.answers }));
        if (saved) this.state.clearQuestionAnswers(saved.key);
      }
    }
  }
  private pending(prompt: Prompt): boolean {
    return prompt.asyncCallId ? !this.state.asyncAnswered(prompt.binding.threadId, prompt.asyncCallId) :
      (!prompt.approval || this.state.approvalPending(prompt.approval.identity) && this.state.ownsApprovalCard(prompt.approval.deliveryKey, prompt.token)) && this.codex.hasRequest(prompt.request.id);
  }
  private async asyncStillPending(prompt: Prompt): Promise<boolean> {
    if (!prompt.asyncCallId) return true;
    try {
      const questions = await this.codex.asyncQuestions?.(prompt.binding.threadId, this.state.hostSince(prompt.binding.threadId), this.state.asyncAnswerIds(prompt.binding.threadId));
      return questions?.some(q => q.callId === prompt.asyncCallId && !q.needsTerminal) === true;
    } catch { return false; }
  }
  private async syncAsyncQuestions(binding: Binding): Promise<void> {
    if (!this.codex.asyncQuestions) return;
    let questions;
    try { questions = await this.codex.asyncQuestions(binding.threadId, this.state.hostSince(binding.threadId), this.state.asyncAnswerIds(binding.threadId)); }
    catch (error) {
      if (error instanceof RpcError && error.uncertain) throw error;
      this.state.enqueue(`question-source-unavailable/${this.generation}/${binding.threadId}`, binding.topicId,
        'Host questions cannot currently be read from this Codex session. Check the terminal for questions; ordinary messages and native approvals remain connected.'); return;
    }
    this.state.trackHostQuestions(binding.threadId, questions);
    const current = new Set(questions.map(q => q.callId));
    for (const p of [...this.prompts.values()]) {
      if (p.binding.threadId === binding.threadId && p.asyncCallId && !current.has(p.asyncCallId)) await this.clearPrompt(p);
      else if (p.binding.threadId === binding.threadId && p.asyncCallId) {
        const updated = questions.find(q => q.callId === p.asyncCallId);
        if (updated && updated.questions.length < p.questions.length) await this.clearPrompt(p);
      }
    }
    for (const q of questions) {
      if (q.needsTerminal) {
        this.attention(binding, { id: q.callId, method: 'request_user_input_async', params: { turnId: q.turnId, itemId: q.callId } },
          q.reason === 'capacity' ? 'More host questions are pending than this relay can display safely. Answer the additional questions in Codex; they were not auto-accepted.' :
            'A host question needs the terminal: its format is unsupported, too large, or marked as sensitive. Its contents were not forwarded.'); continue;
      }
      if (this.state.asyncAnswered(binding.threadId, q.callId) || [...this.prompts.values()].some(p => p.binding.threadId === binding.threadId && p.asyncCallId === q.callId)) continue;
      const prompt: Prompt = {
        token: randomBytes(16).toString('hex'), asyncCallId: q.callId, binding,
        request: { id: q.callId, method: 'request_user_input_async', params: { turnId: q.turnId } },
        options: new Map(), questions: q.questions.map((question, index) => ({ id: string(question.id) || String(index), question: question.title, options: array(question.options).map(o => ({ label: o })) })),
        answers: Object.create(null) as Record<string, { answers: string[] }>, index: 0, freeText: false,
      };
      this.restoreQuestionAnswers(prompt);
      this.prompts.set(prompt.token, prompt); this.showQuestion(prompt);
    }
  }
  private progressIdentity(prompt: Prompt): { key: string; signature: string } | undefined {
    const turn = string(prompt.request.params.turnId), item = string(prompt.request.params.itemId);
    if (!prompt.asyncCallId && (!turn || !item)) return;
    const identity = [prompt.binding.threadId, prompt.asyncCallId ?? [prompt.request.method, turn, item]];
    const signature = createHash('sha256').update(JSON.stringify(prompt.questions.map(q => ({ id: q.id, question: q.question, options: q.options })))).digest('hex');
    return { key: JSON.stringify(identity), signature };
  }
  private restoreQuestionAnswers(prompt: Prompt): void {
    const saved = this.progressIdentity(prompt);
    if (!saved) return;
    const answers = this.state.questionAnswers(saved.key, saved.signature);
    for (const q of prompt.questions) {
      const values = array(object(answers[string(q.id)]).answers);
      if (values.length && values.every(a => typeof a === 'string')) prompt.answers[string(q.id)] = { answers: values as string[] };
    }
    const missing = prompt.questions.findIndex(q => !prompt.answers[string(q.id)]);
    // Never replay a completed/uncertain native write automatically; require a fresh last answer.
    prompt.index = missing >= 0 ? missing : prompt.questions.length - 1;
  }
  private async sendInput(binding: Binding, inputId: number, prompt: string | UserInput[]): Promise<void> {
    const thread = await this.codex.read(binding.threadId);
    if (!this.allowed(string(thread.cwd), binding.threadId)) throw new RpcError('Native session moved outside configured roots.', false);
    const status = string(object(thread.status).type);
    if (status === 'active') {
      const turn = (await this.codex.turns(binding.threadId)).find(t => t.status === 'inProgress');
      if (!string(turn?.id)) throw new RpcError('The active turn could not be identified safely. Check Codex before retrying.', false);
      await this.awaitAssistant(binding.threadId, inputId, string(turn?.id), () => this.codex.steer(binding.threadId, string(turn?.id), prompt));
    } else if (status === 'idle') {
      await this.awaitAssistant(binding.threadId, inputId, null, () => this.codex.start(binding.threadId, prompt));
    } else throw new RpcError('This session is not ready. Open it in Codex before retrying.', false);
  }
  private async awaitAssistant(threadId: string, inputId: number, turnId: string | null, write: () => Promise<unknown>): Promise<void> {
    this.state.awaitReply(threadId, inputId, turnId);
    try {
      const result = object(await write());
      const acceptedTurn = string(object(result.turn).id) || string(result.turnId);
      if (acceptedTurn) this.state.replyTurn(threadId, inputId, acceptedTurn);
    } catch (error) { this.state.clearReply(threadId, inputId); throw error; }
  }
  private promptKey(prompt: Prompt): string { return prompt.approval?.deliveryKey ?? `prompt/${this.generation}/${prompt.token}/${prompt.index}`; }
  private async clearPrompt(prompt: Prompt): Promise<void> {
    this.prompts.delete(prompt.token);
    const key = this.promptKey(prompt);
    if (prompt.approval && this.state.approvalPending(prompt.approval.identity) && !this.state.ownsApprovalCard(key, prompt.token)) return;
    const messageId = this.state.cancelPrompt(key);
    if (messageId) {
      try {
        await this.telegram.call('editMessageReplyMarkup', { chat_id: this.config.ownerId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
        if (prompt.approval) this.state.approvalMarkup(key, { inline_keyboard: [] }, prompt.token);
      }
      catch { /* A stale keyboard cannot pass hasRequest/token checks. */ }
      finally { if (prompt.approval && !this.state.ownsApprovalCard(key, prompt.token)) this.state.invalidateApprovalMarkup(key); }
    }
  }
  private async retireTopicPrompts(threadId: string): Promise<void> {
    // A parent resume cannot replay child requests whose old destination controls were retired.
    for (const [id, rootId] of this.agentSubscriptions) if (rootId === threadId) this.agentSubscriptions.delete(id);
    for (const prompt of [...this.prompts.values()]) if (prompt.binding.threadId === threadId) await this.clearPrompt(prompt);
  }

  private async clearTurnPrompts(threadId: string, turnId: string): Promise<void> {
    if (!threadId || !turnId) return;
    this.state.resolveApprovalTurn(threadId, turnId);
    for (const prompt of [...this.prompts.values()]) {
      if (!prompt.asyncCallId && (string(prompt.request.params.threadId) || prompt.binding.threadId) === threadId &&
          (!prompt.request.params.turnId || prompt.request.params.turnId === turnId)) await this.clearPrompt(prompt);
    }
  }
  private notice(topicId: number | null, text: string): void { this.state.enqueue(`notice/${randomUUID()}`, topicId, text); }
  private attention(binding: Binding, request: RpcRequest, text: string): void {
    // Terminal-only notices use native item/context identity independently of the connection.
    const identity = JSON.stringify([string(request.params.threadId) || binding.threadId, request.method, request.params.turnId,
      request.params.itemId ?? request.params.elicitationId ?? request.params]);
    const key = 'attention/' + createHash('sha256').update(identity).digest('hex');
    this.state.enqueue(key, binding.topicId, text);
  }
  private async stillAllowed(binding: Binding): Promise<boolean> {
    const current = await this.codex.read(binding.threadId);
    if (this.allowed(string(current.cwd), binding.threadId)) return true;
    this.attached.delete(binding.threadId);
    this.notice(binding.topicId, 'This native session moved outside your selected projects. Relaying is paused; select that project locally to reconnect it.');
    return false;
  }

  private async requestRoute(threadId: string): Promise<{ binding: Binding; agent?: AgentOrigin } | undefined> {
    if (!threadId || this.config.ignoredThreadIds?.includes(threadId)) return;
    const binding = this.state.binding(threadId);
    if (binding && this.attached.has(threadId)) return await this.stillAllowed(binding) ? { binding } : undefined;
    try {
      const route = await agentRoute(threadId, this.codex, this.config, id => this.attached.has(id) ? this.state.binding(id) : undefined, cwd => this.state.ownsScratch(cwd));
      if (!route) this.agentSubscriptions.delete(threadId);
      return route;
    } catch (error) { this.agentSubscriptions.delete(threadId); throw error; }
  }

  private async promptAllowed(prompt: Prompt): Promise<boolean> {
    const route = await this.requestRoute(string(prompt.request.params.threadId) || prompt.binding.threadId);
    return route?.binding.threadId === prompt.binding.threadId && route.binding.topicId === prompt.binding.topicId && route.binding.cwd === prompt.binding.cwd;
  }
}

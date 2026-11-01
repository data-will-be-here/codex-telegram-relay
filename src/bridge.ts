import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { allowedDirectory, type Config } from './config.js';
import { State } from './state.js';
import { array, integer, object, string, type Binding, type Codex, type Json, type Keyboard, type RpcRequest, type Telegram } from './types.js';

interface Prompt {
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
  private prompts = new Map<string, Prompt>();
  private finals = new Map<string, string>();
  private fileChanges = new Map<string, unknown[]>();
  private generation = randomUUID();
  private discovering = false;
  private startedAt = Date.now();

  constructor(readonly config: Config, readonly state: State, private readonly codex: Codex, private readonly telegram: Telegram) {}

  async discover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      for (const session of await this.codex.list()) {
        if (this.config.ignoredThreadIds?.includes(session.id) || this.attached.has(session.id) || !allowedDirectory(session.cwd, this.config.roots)) continue;
        let binding = this.state.binding(session.id);
        if (!binding) {
          const title = `${basename(session.cwd)} · ${session.id.slice(0, 8)}`.slice(0, 128);
          const topic = object(await this.telegram.call('createForumTopic', { chat_id: this.config.ownerId, name: title }));
          const topicId = integer(topic.message_thread_id);
          if (!topicId) throw new Error('Telegram did not return a topic identifier.');
          this.state.bind(session.id, topicId, session.cwd, title);
          binding = this.state.binding(session.id)!;
        }
        if (binding.lastTurn === null) {
          const completed = (await this.codex.turns(session.id)).find(t => t.status !== 'inProgress');
          const createdWhileRunning = session.createdAt !== undefined && session.createdAt * 1000 >= this.startedAt;
          this.state.baseline(session.id, createdWhileRunning ? '-' : string(completed?.id) || '-');
          binding = this.state.binding(session.id)!;
        }
        await this.codex.attach(session.id);
        this.attached.add(session.id);
        // Replayed requests identify what needs attention. Attachment itself is not a new prompt.
        await this.catchUp(binding);
      }
    } finally { this.discovering = false; }
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
    const threadId = string(params.threadId) || string(object(params.thread).id);
    const binding = this.state.binding(threadId);
    if (!binding || !this.attached.has(threadId)) return;
    if (method === 'item/started' && object(params.item).type === 'fileChange') {
      const item = object(params.item);
      const changes = array(item.changes);
      if (changes.length && JSON.stringify(changes).length <= 18_000) {
        if (this.fileChanges.size >= 128) this.fileChanges.delete(this.fileChanges.keys().next().value!);
        this.fileChanges.set(`${threadId}/${string(item.id)}`, changes);
      }
    } else if (method === 'item/completed') {
      const item = object(params.item);
      if (item.type === 'agentMessage' && item.phase === 'commentary' && string(item.text).trim()) {
        const reply = this.state.reply(threadId);
        if (reply && (!reply.turnId || reply.turnId === params.turnId) && await this.stillAllowed(binding)) {
          this.state.enqueue(`reply/${threadId}/${reply.inputId}`, binding.topicId, string(item.text));
          this.state.clearReply(threadId, reply.inputId);
        }
      }
      if (item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer')) {
        this.finals.set(`${threadId}/${string(params.turnId)}`, string(item.text));
      }
    } else if (method === 'turn/completed') {
      await this.complete(binding, object(params.turn));
    } else if (method === 'serverRequest/resolved') {
      for (const prompt of [...this.prompts.values()]) if (prompt.request.id === params.requestId) await this.clearPrompt(prompt);
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
    for (const prompt of [...this.prompts.values()]) if (prompt.binding.threadId === binding.threadId) await this.clearPrompt(prompt);
  }

  async request(request: RpcRequest): Promise<void> {
    const binding = this.state.binding(string(request.params.threadId));
    if (!binding || !this.attached.has(binding.threadId)) return;
    if (!await this.stillAllowed(binding)) return;
    if ([...this.prompts.values()].some(p => p.request.id === request.id)) return;
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
      this.showQuestion(prompt);
      return;
    }
    const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
    if (!methods.includes(request.method)) {
      this.attention(binding, request, 'Codex needs input that this relay cannot safely answer. Use the terminal.'); return;
    }
    const detailsParams = { ...request.params };
    if (request.method === 'item/fileChange/requestApproval') {
      const changes = array(request.params.changes).length ? array(request.params.changes) : this.fileChanges.get(`${binding.threadId}/${string(request.params.itemId)}`);
      if (!changes?.length) { this.attention(binding, request, 'Review this file change in the terminal: its complete proposed diff is not available to the relay.'); return; }
      detailsParams.proposedChanges = changes;
    }
    const details = JSON.stringify(detailsParams, null, 2);
    if (details.length > 18_000) {
      this.attention(binding, request, 'An approval is too large to display completely here. Review and answer it in the terminal.'); return;
    }
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
    this.prompts.set(prompt.token, prompt);
    const keyboard: Keyboard = { inline_keyboard: [[...prompt.options.keys()].map(code => ({ text: code === 'a' ? 'Allow once' : code === 'c' ? 'Cancel turn' : 'Decline', callback_data: `r:${prompt.token}:${code}` }))] };
    this.state.enqueue(this.promptKey(prompt), binding.topicId, '🔐 Approval required\n\n' + details, keyboard as unknown as Json);
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
      if (Object.keys(callback).length) await this.callback(callback, message, topic, id);
      else await this.message(message, topic, id);
      this.state.finish(id, 'done');
    } catch (error) {
      this.state.finish(id, 'uncertain');
      this.notice(topic, '⚠️ Delivery could not be confirmed. Check the terminal before sending the same instruction again.');
      throw error;
    } finally { this.state.advance(id); }
  }

  private async message(message: Json, topicId: number | null, inputId: number): Promise<void> {
    const text = string(message.text).trim();
    if (!text) { if (message.document || message.voice || message.photo) this.notice(topicId, 'This version supports text only.'); return; }
    if (/^\/(start|help)(?:\s|$)/u.test(text)) {
      this.notice(topicId, 'Codex Telegram Relay\n\nOpen a project topic and send a message to its existing Codex session.\n/sessions — attached sessions\n/status — connection status\n/questions — pending questions\n/say TEXT — steer work while a question is pending'); return;
    }
    if (text === '/sessions') {
      this.notice(topicId, this.state.bindings().map(b => `${b.title}\n${b.threadId}${this.config.ignoredThreadIds?.includes(b.threadId) ? ' (ignored)' : this.attached.has(b.threadId) ? '' : ' (not attached)'}`).join('\n\n') || 'No sessions attached. Start Codex in a configured project.'); return;
    }
    if (text === '/status') { this.notice(topicId, `Connected sessions: ${this.attached.size}\nUncertain deliveries: ${this.state.uncertainCount()}\nPermissions: inherited from Codex; the relay sends no sandbox overrides.`); return; }
    if (text === '/questions') {
      const prompts = [...this.prompts.values()].filter(p => p.binding.topicId === topicId && p.questions.length);
      for (const p of prompts) this.showQuestion(p, true);
      if (!prompts.length) this.notice(topicId, 'No current questions. Requests from before connection may still need the terminal.');
      return;
    }
    const binding = topicId === null ? undefined : this.state.topic(topicId);
    if (!binding || !this.attached.has(binding.threadId)) { this.notice(topicId, 'Use an attached project topic. Open Codex in a configured project if it is missing.'); return; }
    if (!allowedDirectory(binding.cwd, this.config.roots)) throw new Error('Project is outside configured roots.');
    const question = [...this.prompts.values()].filter(p => p.binding.topicId === topicId && p.questions.length && this.codex.hasRequest(p.request.id));
    if (!text.startsWith('/say ') && !text.startsWith('/') && question.length) {
      const focused = question.filter(p => p.freeText);
      const target = focused.length === 1 ? focused[0] : question.length === 1 ? question[0] : undefined;
      if (!target) { this.notice(topicId, 'Several questions are pending. Choose “Type an answer” on the question you want to answer.'); return; }
      await this.answer(target, text, inputId); return;
    }
    if (text.startsWith('/') && !text.startsWith('/say ')) { this.notice(topicId, 'Unknown command. Use /help. Codex settings cannot be changed through this bot.'); return; }
    const prompt = text.startsWith('/say ') ? text.slice(5).trim() : text;
    if (!prompt || prompt.length > 16_000) { this.notice(topicId, 'Send a text instruction of at most 16000 characters.'); return; }
    const thread = await this.codex.read(binding.threadId);
    if (!allowedDirectory(string(thread.cwd), this.config.roots)) throw new Error('Native session moved outside configured roots.');
    const status = string(object(thread.status).type);
    if (status === 'active') {
      const latest = (await this.codex.turns(binding.threadId)).find(t => t.status === 'inProgress');
      const turnId = string(latest?.id);
      if (!turnId) { this.notice(topicId, 'The active turn could not be identified safely. Send this instruction in the terminal.'); return; }
      // A failed or ambiguous steer never falls back to a second turn.
      await this.awaitAssistant(binding.threadId, inputId, turnId, () => this.codex.steer(binding.threadId, turnId, prompt));
    } else if (status === 'idle') {
      await this.awaitAssistant(binding.threadId, inputId, null, () => this.codex.start(binding.threadId, prompt));
    } else { this.notice(topicId, 'This session is not ready. Open it in Codex and retry.'); return; }
  }

  private async callback(callback: Json, _message: Json, topicId: number | null, inputId: number): Promise<void> {
    const data = string(callback.data);
    const match = /^r:([a-f0-9]{32}):([a-z0-9]+)$/u.exec(data);
    const prompt = match ? this.prompts.get(match[1]!) : undefined;
    if (!prompt || prompt.binding.topicId !== topicId || !this.codex.hasRequest(prompt.request.id)) {
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: 'This request is closed or belongs to another topic.' }); return;
    }
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
    await this.clearPrompt(prompt);
    await this.awaitAssistant(prompt.binding.threadId, inputId, string(prompt.request.params.turnId) || null,
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
  private async answer(prompt: Prompt, text: string, inputId: number): Promise<void> {
    const question = prompt.questions[prompt.index]!;
    prompt.answers[string(question.id)] = { answers: [text] };
    await this.clearPrompt(prompt);
    prompt.index++; prompt.freeText = false;
    if (prompt.index < prompt.questions.length) {
      // Each question gets a fresh capability; old buttons cannot answer the next question.
      prompt.token = randomBytes(16).toString('hex');
      this.prompts.set(prompt.token, prompt);
      this.showQuestion(prompt);
    } else {
      await this.awaitAssistant(prompt.binding.threadId, inputId, string(prompt.request.params.turnId) || null,
        () => this.codex.respond(prompt.request.id, { answers: prompt.answers }));
    }
  }
  private async awaitAssistant(threadId: string, inputId: number, turnId: string | null, write: () => Promise<unknown>): Promise<void> {
    this.state.awaitReply(threadId, inputId, turnId);
    try {
      const result = object(await write());
      const acceptedTurn = string(object(result.turn).id) || string(result.turnId);
      if (acceptedTurn) this.state.replyTurn(threadId, inputId, acceptedTurn);
    } catch (error) { this.state.clearReply(threadId, inputId); throw error; }
  }
  private promptKey(prompt: Prompt): string { return `prompt/${this.generation}/${prompt.token}/${prompt.index}`; }
  private async clearPrompt(prompt: Prompt): Promise<void> {
    this.prompts.delete(prompt.token);
    const messageId = this.state.cancelPrompt(this.promptKey(prompt));
    if (messageId) {
      try { await this.telegram.call('editMessageReplyMarkup', { chat_id: this.config.ownerId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); }
      catch { /* A stale keyboard cannot pass hasRequest/token checks. */ }
    }
  }
  private notice(topicId: number | null, text: string): void { this.state.enqueue(`notice/${randomUUID()}`, topicId, text); }
  private attention(binding: Binding, request: RpcRequest, text: string): void {
    // JSON-RPC IDs change with each connection; native turn/item identity survives a reconnect.
    const identity = JSON.stringify([binding.threadId, request.method, request.params.turnId,
      request.params.itemId ?? request.params.elicitationId ?? request.params]);
    const key = 'attention/' + createHash('sha256').update(identity).digest('hex');
    this.state.enqueue(key, binding.topicId, text);
  }
  private async stillAllowed(binding: Binding): Promise<boolean> {
    const current = await this.codex.read(binding.threadId);
    if (allowedDirectory(string(current.cwd), this.config.roots)) return true;
    this.attached.delete(binding.threadId);
    this.notice(binding.topicId, 'This native session moved outside your selected projects. Relaying is paused; select that project locally to reconnect it.');
    return false;
  }
}

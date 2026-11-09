import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { allowedSessionDirectory, newSessionDefaults, type Config } from './config.js';
import { RpcError } from './codex.js';
import { TelegramError } from './telegram.js';
import { State, type NewSessionOperation, type NewSessionPhase } from './state.js';
import { Topics } from './topics.js';
import { integer, object, string, type Binding, type Codex, type Json, type Keyboard, type Telegram } from './types.js';

const LIFETIME = 10 * 60_000;
const PAGE = 7;
const MARKER = 'codex-telegram-relay:new:';
const active: NewSessionPhase[] = ['checking', 'preparing', 'starting', 'uncertain', 'known', 'persisted', 'topic'];
const clean = (text: string): string => Array.from(text.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 70).join('');
const inside = (child: string, root: string): boolean => {
  const diff = relative(root, child);
  return diff === '' || !isAbsolute(diff) && diff !== '..' && !diff.startsWith(`..${sep}`);
};

/** Creation is a durable workflow. Unconfirmed starts are reconciled, never replayed. */
export class NewSessions {
  private working = false;
  private closed = false;
  private restoreAfter = new Map<string, number>();
  private pendingTopicBind: { id: string; attempt: number; expires: number } | undefined;
  constructor(private readonly config: Config, private readonly state: State, private readonly codex: Codex,
    private readonly telegram: Telegram, private readonly topics: Topics,
    private readonly connected: (binding: Binding) => Promise<void>, private readonly clearAllowed: (binding: Binding) => Promise<boolean> = async () => false) { newSessionDefaults(config, state.home); }

  close(): void { this.closed = true; }
  clearPendingBind(): void { this.pendingTopicBind = undefined; }
  async clear(binding: Binding): Promise<void> {
    if (!this.creationEnabled() || !this.codex.createThread || !this.codex.setThreadName || !this.codex.nonArchivedThread || !this.codex.findCreatedThread) {
      this.notice(binding.topicId, 'Session creation is unavailable. Check Codex and local relay settings.'); return;
    }
    if (this.state.newSessions(active).some(op => op.topicId === binding.topicId)) {
      this.notice(binding.topicId, 'A session operation is already pending in this topic. Creation will not be repeated.'); return;
    }
    const saved = this.state.newSessions(['failed']).find(op => op.threadId && op.reset?.threadId === binding.threadId &&
      op.reset.topicId === binding.topicId && op.reset.cwd === binding.cwd);
    if (saved) {
      if (!this.operationAllowed(saved)) { this.notice(binding.topicId, 'A replacement conversation is already saved, but its directory is unavailable. Restore local access before retrying /clear.'); return; }
      this.state.changeNewSession(saved.id, 'failed', { status: 'known', retryAt: 0 });
      this.notice(binding.topicId, 'Resuming the saved conversation switch. No additional conversation will be created.'); return;
    }
    if (this.state.newSessions(active).length >= 64) { this.notice(binding.topicId, 'Too many pending session operations. Finish them before using /clear.'); return; }
    const id = randomUUID();
    const op: NewSessionOperation = { id, status: 'checking', reset: binding, topicId: binding.topicId, targetTopic: binding.topicId,
      topicFirst: false, topicTitle: binding.title, menuKey: `notice/clear/${id}`, token: '', choices: [], page: 0,
      expires: Date.now() + LIFETIME, cwd: binding.cwd, root: binding.cwd, kind: this.state.ownsScratch(binding.cwd, binding.threadId) ? 'scratch' : 'project' };
    this.state.createNewSession(op);
    try {
      if (!this.operationAllowed(op) || !await this.clearAllowed(binding)) {
        this.state.changeNewSession(id, 'checking', { status: 'failed' });
        this.notice(binding.topicId, 'Cannot clear this session now. Finish the running task, answer pending questions/approvals and wait for queued deliveries, then retry /clear.'); return;
      }
      this.state.changeNewSession(id, 'checking', { status: 'preparing' });
      this.notice(binding.topicId, 'Starting a fresh conversation in this topic. Telegram history and the previous Codex session are preserved.');
    } catch {
      this.state.changeNewSession(id, 'checking', { status: 'failed' });
      this.notice(binding.topicId, 'Could not verify the current session. No new conversation was created; retry /clear when Codex is available.');
    }
  }
  async recoverOwned(threadId: string): Promise<boolean> {
    const op = this.state.findNewSession('threadId', threadId);
    if (!op || !['persisted', 'topic', 'ready'].includes(op.status)) return false;
    if (this.closed || !this.operationAllowed(op) || !this.codex.nonArchivedThread) throw new Error('The saved conversation is no longer available in the allowed workspace.');
    const saved = await this.codex.nonArchivedThread(threadId);
    if (!saved) throw new Error('The saved conversation is archived or unavailable. No replacement was created.');
    this.verify(saved, op);
    const current = this.state.findNewSession('threadId', threadId);
    if (this.closed || !current || current.id !== op.id || !['persisted', 'topic', 'ready'].includes(current.status) || !this.operationAllowed(current)) throw new Error('The saved conversation changed while checking recovery.');
    const restored = await this.codex.attach(threadId);
    this.verify(restored, op);
    await this.codex.turns(threadId);
    return true;
  }
  observeStarted(thread: Json): void {
    const marker = string(thread.threadSource);
    if (this.closed || !marker.startsWith(MARKER)) return;
    const op = this.state.newSession(marker.slice(MARKER.length));
    if (!op || !['starting', 'uncertain'].includes(op.status) || op.threadId || !this.operationAllowed(op)) return;
    try { this.verify(thread, op); } catch { return; }
    this.state.changeNewSession(op.id, op.status, { threadId: string(thread.id) });
  }
  busy(threadId: string, marker?: string): boolean {
    const op = this.state.findNewSession('threadId', threadId) ?? (marker?.startsWith(MARKER) ? this.state.newSession(marker.slice(MARKER.length)) : undefined);
    return !!op && !['ready', 'failed', 'cancelled'].includes(op.status);
  }

  async open(topicId: number | null, text: string): Promise<void> {
    if (text !== '/new') { this.notice(topicId, 'Use /new without arguments and choose an option with the buttons.'); return; }
    if (this.config.newSessions?.enabled === false) { this.notice(topicId, 'Session creation is disabled locally. Existing conversations remain available.'); return; }
    if (!this.codex.createThread || !this.codex.setThreadName || !this.codex.nonArchivedThread || !this.codex.findCreatedThread) {
      this.notice(topicId, 'This Codex connection does not support session creation.'); return;
    }
    const pending = this.state.newSessions(active).find(op => op.topicId === topicId);
    if (pending?.status === 'preparing' && ['failed', 'uncertain'].includes(pending.topicState ?? '')) {
      const fresh = this.state.changeNewSession(pending.id, pending.status, { expires: Date.now() + LIFETIME })!;
      await this.reportPreparation(fresh, true); return;
    }
    if (pending?.status === 'topic' && await this.reportTopic(pending, true)) return;
    if (pending) { this.notice(topicId, pending.status === 'uncertain' ?
      'The previous creation outcome is unknown. The relay is checking Codex without repeating creation. Check Codex locally.' :
      'A session is already being created for this menu. Please wait; creation will not be repeated.'); return; }
    for (const op of this.state.newSessions(['selecting']).filter(op => op.topicId === topicId || op.expires < Date.now())) {
      this.state.changeNewSession(op.id, 'selecting', { status: 'cancelled' }); this.state.cancelPrompt(op.menuKey);
    }
    if (this.state.newSessions([...active, 'selecting']).length >= 64) {
      this.notice(topicId, 'Too many open menus or pending session creations. Complete them and retry /new.'); return;
    }
    const choices: NewSessionOperation['choices'] = [];
    const scratch = this.config.newSessions?.scratchRoot;
    if (scratch && this.validRoot(scratch, true, true)) {
      try { mkdirSync(scratch, { recursive: true, mode: 0o700 }); }
      catch { /* Project choices remain available when the workspace cannot be prepared. */ }
      if (this.validRoot(scratch, true)) choices.push({ cwd: scratch, label: '💬 No project — question / research', kind: 'scratch' });
    }
    const current = topicId === null ? undefined : this.state.topic(topicId);
    const projects = this.projectPaths().filter(path => this.validRoot(path, false));
    projects.sort((a, b) => Number(b === current?.cwd) - Number(a === current?.cwd));
    for (const path of projects) choices.push({ cwd: path, kind: 'project', label:
      `${current?.cwd === path ? '📁 This project — ' : '📁 '}${clean(basename(path))} · ${clean(path)}` });
    if (!choices.length) { this.notice(topicId, 'Could not prepare a directory for the new conversation. Check access to the relay workspace locally and retry /new.'); return; }
    const id = randomUUID();
    const op: NewSessionOperation = { id, status: 'selecting', topicId, menuKey: `notice/new-menu/${id}`, token: randomBytes(16).toString('hex'),
      expires: Date.now() + LIFETIME, choices, page: 0, topicFirst: true };
    this.state.createNewSession(op);
    this.state.enqueueOwnerNotice(op.menuKey, topicId, 'Where should the new conversation start?', this.keyboard(op));
  }

  private keyboard(op: NewSessionOperation): Json {
    const rows: Keyboard['inline_keyboard'] = op.choices.slice(op.page * PAGE, (op.page + 1) * PAGE).map((choice, index) =>
      [{ text: choice.label, callback_data: `n:${op.token}:${op.page * PAGE + index}` }]);
    const navigation = [];
    if (op.page > 0) navigation.push({ text: '←', callback_data: `n:${op.token}:p${op.page - 1}` });
    if ((op.page + 1) * PAGE < op.choices.length) navigation.push({ text: '→', callback_data: `n:${op.token}:p${op.page + 1}` });
    if (navigation.length) rows.push(navigation);
    rows.push([{ text: 'Cancel', callback_data: `n:${op.token}:x` }]);
    return { inline_keyboard: rows };
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<'bind' | void> {
    const match = /^n:([a-f0-9]{32}):(x|p\d+|\d+|[rbx]\d+)$/u.exec(string(callback.data));
    const op = match ? this.state.findNewSession('token', match[1]!) : undefined;
    const messageId = integer(message.message_id);
    const sourceMessage = !!messageId && messageId > 0 && op && (this.state.promptMessage(op.menuKey) === messageId ||
      this.state.promptMessage(`notice/new-topic-first/${op.id}/${op.topicAttempt}/${op.topicState}`) === messageId);
    if (!op || op.topicId !== topicId || !sourceMessage || op.expires < Date.now()) {
      await this.ack(callback, 'This menu expired or belongs to another topic. Send /new.'); return;
    }
    const action = match![2]!;
    if (op.status === 'preparing' && !op.threadId && !op.targetTopic && ['failed', 'uncertain'].includes(op.topicState ?? '') && /^[rbx]\d+$/u.test(action)) {
      if (Number(action.slice(1)) !== op.topicAttempt || !this.operationAllowed(op)) { await this.ack(callback, 'This recovery action expired. Send /new.'); return; }
      if (action[0] === 'r') this.state.changeNewSession(op.id, op.status, { topicState: 'retry', retryAt: 0 });
      else if (action[0] === 'x') this.state.changeNewSession(op.id, op.status, { status: 'cancelled' });
      else {
        this.pendingTopicBind = { id: op.id, attempt: op.topicAttempt!, expires: Date.now() + LIFETIME };
        this.state.enqueueOwnerNotice(`notice/new-bind/${op.id}/${op.topicAttempt}`, op.topicId, 'Open the existing empty topic and send /bind without an ID. The selection expires in 10 minutes. No Codex session has been created yet.');
      }
      await this.ack(callback);
      if (action[0] === 'x') await this.edit(op, 'Creation cancelled. No Codex session was created.');
      if (action[0] === 'b') return 'bind';
      return;
    }
    if (op.status !== 'selecting') { await this.ack(callback, op.status === 'ready' ? 'The session has already been created.' : 'This selection has already been processed.'); return; }
    await this.ack(callback);
    if (action === 'x') {
      if (this.state.changeNewSession(op.id, 'selecting', { status: 'cancelled' })) await this.edit(op, 'Creation cancelled.');
      return;
    }
    if (action.startsWith('p')) {
      const page = Number(action.slice(1));
      if (!Number.isSafeInteger(page) || page < 0 || page * PAGE >= op.choices.length) return;
      const next = this.state.changeNewSession(op.id, 'selecting', { page });
      if (next) await this.edit(next, 'Where should the new conversation start?', this.keyboard(next));
      return;
    }
    const choice = op.choices[Number(action)];
    if (!choice || this.config.newSessions?.enabled === false || !this.choiceAllowed(choice.cwd, choice.kind)) { await this.edit(op, 'This directory is no longer allowed. Send /new.'); return; }
    const next = this.state.changeNewSession(op.id, 'selecting', { status: 'preparing', choices: [], kind: choice.kind, root: choice.cwd,
      cwd: choice.kind === 'scratch' ? join(choice.cwd, op.id) : choice.cwd, topicFirst: op.topicFirst ?? true });
    if (next) await this.edit(next, next.topicFirst ? 'Creating Telegram topic…' : 'Creating session…');
  }

  async bindPending(topicId: number | null): Promise<boolean> {
    const pending = this.pendingTopicBind;
    if (!pending) return false;
    const op = this.state.newSession(pending.id);
    if (!op || op.status !== 'preparing' || op.threadId || op.targetTopic || op.topicAttempt !== pending.attempt || pending.expires < Date.now() || !['failed', 'uncertain'].includes(op.topicState ?? '') || !this.operationAllowed(op)) {
      this.pendingTopicBind = undefined; this.notice(topicId, 'The topic selection expired. Open /new in the original chat and select recovery again.'); return true;
    }
    if (topicId === null || topicId < 1 || this.topicOccupied(topicId, op.id)) { this.notice(topicId, 'Open an empty, unbound topic and send /bind there. No Codex session was created.'); return true; }
    this.state.changeNewSession(op.id, op.status, { targetTopic: topicId, topicState: 'ready', retryAt: 0 });
    this.pendingTopicBind = undefined; await this.edit(op, 'Telegram topic selected. Creating Codex session…'); return true;
  }

  private async reportPreparation(op: NewSessionOperation, force = false): Promise<void> {
    const key = `${op.topicAttempt}/${op.topicState}`;
    if (!force && op.topicReport === key) return;
    const markup = { inline_keyboard: [
      [{ text: 'Topic appeared — use it', callback_data: `n:${op.token}:b${op.topicAttempt}` }],
      [{ text: 'Topic did not appear — retry', callback_data: `n:${op.token}:r${op.topicAttempt}` }],
      [{ text: 'Cancel', callback_data: `n:${op.token}:x${op.topicAttempt}` }],
    ] };
    const text = `Telegram topic creation is not confirmed. No Codex session has been created.\n${op.topicFailure || ''}\nCheck Telegram before retrying. If a topic appeared, select it below instead of creating another.`;
    if (!await this.edit(op, text, markup)) this.state.enqueueOwnerNotice(`notice/new-topic-first/${op.id}/${key}`, op.topicId, text, markup);
    this.state.changeNewSession(op.id, op.status, { topicReport: key });
  }

  private async prepareTopic(initial: NewSessionOperation): Promise<NewSessionOperation | undefined> {
    let op = initial;
    const save = (patch: Partial<NewSessionOperation>): void => { const next = this.state.changeNewSession(op.id, op.status, patch); if (!next) throw new Error('Creation operation changed.'); op = next; };
    if (op.targetTopic) return op;
    if (op.topicState === 'creating') save({ topicState: 'uncertain', topicFailure: 'The previous topic request was interrupted; its outcome is unknown.' });
    if (op.topicState === 'failed' || op.topicState === 'uncertain') {
      await this.reportPreparation(op); save({ retryAt: Date.now() + 10_000 }); return;
    }
    const title = `${op.kind === 'scratch' ? 'No project' : clean(basename(op.cwd!))} · ${op.id.slice(0, 8)}`;
    save({ topicState: 'creating', topicAttempt: (op.topicAttempt ?? 0) + 1, topicTitle: title });
    let id: number;
    try {
      id = integer(object(await this.telegram.call('createForumTopic', { chat_id: this.config.ownerId, name: title })).message_thread_id) ?? 0;
      if (id < 1) throw new TelegramError('Topic receipt is missing.', 0);
    } catch (error) {
      if (error instanceof TelegramError && (error.notSent || error.status === 429)) {
        save({ topicState: 'retry', retryAt: Date.now() + (error.notSent ? 3 : Math.max(1, error.retryAfter ?? 3)) * 1000 }); return;
      }
      const code = error instanceof TelegramError ? /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/u.exec(error.message)?.[1] : undefined;
      const failed = error instanceof TelegramError && error.status >= 400 && error.status < 500 && code !== 'BOT_TOPIC_WRONG_HOME';
      save({ topicState: failed ? 'failed' : 'uncertain', retryAt: Date.now() + 10_000,
        topicFailure: error instanceof TelegramError ? `Telegram topic request failed (${error.status}${code ? ', ' + code : ''}).` : 'The topic request outcome is unknown.' });
      await this.reportPreparation(op); return;
    }
    save({ targetTopic: id, topicState: 'ready', retryAt: 0 }); return op;
  }

  private async ack(callback: Json, text?: string): Promise<void> {
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) }); }
    catch { /* Callback acknowledgement is not evidence of a native write. */ }
  }
  private async edit(op: NewSessionOperation, text: string, markup: Json = { inline_keyboard: [] }): Promise<boolean> {
    const messageId = this.state.promptMessage(op.menuKey);
    if (!messageId) return false;
    try { await this.telegram.call('editMessageText', { chat_id: this.config.ownerId, message_id: messageId, text, reply_markup: markup }); return true; }
    catch { return false; /* The durable operation is authoritative; Telegram edits are best effort. */ }
  }
  private async reportTopic(op: NewSessionOperation, force = false): Promise<boolean> {
    const topic = op.threadId ? this.state.topicOperation(op.threadId) : undefined;
    if (!topic || !['failed', 'uncertain'].includes(topic.status)) return false;
    const reportKey = `${topic.attempt}/${topic.status}`;
    if (!force && op.reportedTopicAttempt === reportKey) return true;
    const prompt = this.topics.recovery(topic.threadId);
    const text = `Codex session created: ${op.name || op.threadId}.\n${op.threadId}\nA Telegram topic is still required.\n\n${prompt.text}`;
    if (!await this.edit(op, text, prompt.markup)) this.state.enqueueOwnerNotice(`notice/new-topic/${op.id}/${reportKey}`, op.topicId, text, prompt.markup);
    this.state.changeNewSession(op.id, op.status, { reportedTopicAttempt: reportKey });
    return true;
  }
  private notice(topicId: number | null, text: string): void { this.state.enqueueOwnerNotice(`notice/new/${randomUUID()}`, topicId, text); }

  private projectPaths(): string[] {
    const paths = [...(this.config.newSessions?.projects ?? [])];
    if (this.config.newSessions?.autoProjects) {
      paths.push(...this.config.roots, ...this.state.bindings().filter(binding =>
        !this.config.ignoredThreadIds?.includes(binding.threadId) && !this.state.ownsScratch(binding.cwd) &&
        allowedSessionDirectory(binding.cwd, this.config)).map(binding => binding.cwd));
    }
    const result = new Set<string>();
    for (const path of paths) {
      try {
        const canonical = realpathSync(path); const scratch = this.config.newSessions?.scratchRoot;
        // Only eligible projects participate in workspace-overlap checks. A home
        // directory containing private state is not a project and cannot hide scratch.
        if (!this.state.ownsScratch(canonical) && (!scratch || !inside(canonical, scratch)) && this.validRoot(canonical, false)) result.add(canonical);
      }
      catch { /* Removed projects cannot appear in a creation menu. */ }
    }
    return [...result];
  }
  private validRoot(path: string, scratch: boolean, allowMissing = false): boolean {
    try {
      if (!isAbsolute(path)) return false;
      if (existsSync(path)) {
        if (!statSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) return false;
      } else {
        if (!allowMissing) return false;
        let ancestor = dirname(path);
        while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) return false; ancestor = parent; }
        if (!statSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor) return false;
      }
      const forbidden = [this.state.home, process.env.CODEX_HOME ?? join(homedir(), '.codex')];
      if (forbidden.some(root => inside(path, existsSync(root) ? realpathSync(root) : resolve(root)) || inside(resolve(root), path))) return false;
      if (scratch) {
        if (this.projectPaths().some(root => inside(path, root) || inside(root, path))) return false;
        let parent = path;
        for (;;) { if (existsSync(join(parent, '.git'))) return false; const next = resolve(parent, '..'); if (next === parent) break; parent = next; }
      }
      return true;
    } catch { return false; }
  }
  private choiceAllowed(root: string, kind: 'scratch' | 'project'): boolean {
    return (kind === 'scratch' ? this.config.newSessions?.scratchRoot === root : this.projectPaths().includes(root)) === true && this.validRoot(root, kind === 'scratch');
  }
  private operationAllowed(op: NewSessionOperation): boolean {
    if (op.reset) return !!op.cwd && op.cwd === op.reset.cwd && this.validRoot(op.cwd, false) &&
      !this.config.ignoredThreadIds?.includes(op.reset.threadId) && (!op.threadId || !this.config.ignoredThreadIds?.includes(op.threadId)) &&
      allowedSessionDirectory(op.cwd, this.config, this.state.ownsScratch(op.cwd, op.reset.threadId));
    if (!op.root || !op.cwd || !op.kind || !this.choiceAllowed(op.root, op.kind)) return false;
    if (op.threadId && this.config.ignoredThreadIds?.includes(op.threadId)) return false;
    if (op.kind === 'project') return op.cwd === op.root && allowedSessionDirectory(op.cwd, this.config);
    return op.cwd === join(op.root, op.id) && (!existsSync(op.cwd) || !lstatSync(op.cwd).isSymbolicLink() && realpathSync(op.cwd) === op.cwd);
  }
  private creationEnabled(): boolean { return this.config.newSessions?.enabled !== false; }
  private topicOccupied(topicId: number, operationId: string): boolean {
    return !!this.state.topic(topicId) || this.state.newSessions().some(other => other.id !== operationId && other.targetTopic === topicId &&
      other.status !== 'cancelled' && (other.status !== 'failed' || !!other.threadId));
  }
  private verify(thread: Json, op: NewSessionOperation): void {
    if (!string(thread.id) || op.threadId && thread.id !== op.threadId || thread.cwd !== op.cwd || thread.ephemeral === true || thread.parentThreadId || thread.canAcceptDirectInput === false ||
        !['cli', 'vscode', 'appServer'].includes(string(thread.source))) throw new Error('Codex returned an ineligible session. Creation will not be repeated.');
  }

  async tick(): Promise<void> {
    if (this.working || this.closed) return;
    const op = this.state.newSessions(active).find(item => item.status !== 'checking' && (item.retryAt ?? 0) <= Date.now());
    if (!op) return;
    this.working = true;
    try { await this.advance(op); }
    finally { this.working = false; }
  }

  private async advance(initial: NewSessionOperation): Promise<void> {
    let op = initial;
    const save = (patch: Partial<NewSessionOperation>): void => {
      const next = this.state.changeNewSession(op.id, op.status, patch);
      if (!next) throw new Error('Creation operation changed.'); op = next;
    };
    try {
      if (!this.creationEnabled() || !this.operationAllowed(op)) throw new Error('The directory was removed, changed or is no longer allowed. Check settings locally.');
      if (op.status === 'preparing') {
        if (op.reset && !await this.clearAllowed(op.reset)) { save({ retryAt: Date.now() + 5000 }); return; }
        if (op.topicFirst === undefined) save({ topicFirst: true });
        const loaded = await this.codex.list(session => !this.state.retiredSession(session.id) && !this.config.ignoredThreadIds?.includes(session.id) &&
          allowedSessionDirectory(session.cwd, this.config, this.state.ownsScratch(session.cwd, session.id)));
        if (loaded.length >= 64) throw new Error('The limit of 64 attached sessions has been reached. Free a slot before using /new.');
        if (op.kind === 'scratch' && !op.reset) { if (!existsSync(op.cwd!)) mkdirSync(op.cwd!, { mode: 0o700 }); if (!this.operationAllowed(op)) throw new Error('The working directory changed.'); }
        if (this.closed) return;
        if (op.topicFirst && !op.reset) {
          const prepared = await this.prepareTopic(op);
          if (!prepared) return;
          op = prepared;
          if (this.closed || this.config.newSessions?.enabled === false || !this.operationAllowed(op)) throw new Error('The directory is no longer allowed. No Codex session was created.');
          if (this.topicOccupied(op.targetTopic!, op.id)) throw new Error('The selected topic is already bound or reserved. No Codex session was created.');
        }
        if (op.reset && !await this.clearAllowed(op.reset)) { save({ retryAt: Date.now() + 5000 }); return; }
        if (this.closed || !this.creationEnabled() || !this.operationAllowed(op)) throw new Error('Session creation or its directory is no longer allowed. No Codex session was created.');
        save({ status: 'starting' });
        let thread: Json;
        try { thread = await this.codex.createThread!(op.cwd!, MARKER + op.id, op.reset ? 'clear' : undefined); }
        catch (error) {
          if (error instanceof RpcError && !error.uncertain && !this.state.newSession(op.id)?.threadId) {
            save({ status: 'failed', error: 'Codex rejected session creation.' }); throw error;
          }
          save({ status: 'uncertain', retryAt: Date.now() + 15_000 }); await this.reportUnknown(op); return;
        }
        // Record the acknowledged ID before validating any other returned metadata.
        if (string(thread.id)) save({ threadId: string(thread.id), status: 'known' });
        else { save({ status: 'uncertain', retryAt: Date.now() + 15_000 }); await this.reportUnknown(op); return; }
        this.verify(thread, op);
      }
      if (op.status === 'uncertain' || op.status === 'starting') {
        const thread = op.threadId ? await this.codex.read(op.threadId) : await this.codex.findCreatedThread!(op.cwd!, MARKER + op.id);
        if (!thread) { save({ status: 'uncertain', retryAt: Date.now() + 30_000 }); await this.reportUnknown(op); return; }
        this.verify(thread, op);
        save({ threadId: string(thread.id), status: 'known' });
      }
      if (this.closed) return;
      if (op.status === 'known') {
        const thread = await this.codex.read(op.threadId!); this.verify(thread, op);
        if (string(object(thread.status).type) === 'notLoaded' && !await this.codex.nonArchivedThread!(op.threadId!)) throw new Error('Archived thread cannot be renamed.');
        const name = string(thread.name) || op.name || `${op.kind === 'scratch' ? 'Conversation' : clean(basename(op.cwd!))} · ${op.threadId!.slice(0, 8)}`;
        save({ name });
        if (!string(thread.name)) await this.codex.setThreadName!(op.threadId!, name);
        await this.codex.turns(op.threadId!); // A reserved path alone never qualifies a new empty session.
        if (this.closed) return;
        save({ status: 'persisted' });
      }
      if (this.closed) return;
      if (op.status === 'persisted' || op.status === 'topic') {
        if (!this.operationAllowed(op)) throw new Error('The working directory is no longer allowed.');
        // Only non-archived, exact-ID native threads may be resumed after a restart.
        const saved = await this.codex.nonArchivedThread!(op.threadId!);
        if (!saved) throw new Error('The session is archived or no longer available. Automatic replacement is disabled.');
        this.verify(saved, op);
        if (this.closed) return;
        save({ status: 'topic' });
        if (op.reset && !this.state.binding(op.threadId!)) {
          if (!await this.clearAllowed(op.reset)) {
            save({ retryAt: Date.now() + 5000 });
            this.state.enqueueOwnerNotice(`notice/clear-wait/${op.id}`, op.topicId, 'The new conversation is saved. Waiting for the previous session and its deliveries to become idle before switching this topic. No replacement will be created.');
            return;
          }
          this.state.resetTopic(op);
        }
        if (op.targetTopic && !this.state.binding(op.threadId!)) {
          if (this.topicOccupied(op.targetTopic, op.id)) throw new Error('The confirmed topic is now bound or reserved by another session.');
          this.state.installTopic(op.threadId!, op.targetTopic, op.cwd!, op.topicTitle!);
        }
        const binding = op.reset ? this.state.binding(op.threadId!) : await this.topics.ensure({ id: op.threadId!, cwd: op.cwd!, projectLabel: op.kind === 'scratch' ? 'No project' : undefined });
        if (!binding) {
          await this.reportTopic(op);
          const topic = this.state.topicOperation(op.threadId!);
          save({ retryAt: topic?.status === 'retry' ? topic.retryAt : Date.now() + 10_000 }); return;
        }
        await this.connected(binding);
        this.state.enqueue(`new-ready/${op.id}`, binding.topicId, op.reset ? `Fresh conversation started.\nSession: ${binding.threadId}\n\nTelegram history is preserved. An open terminal remains on the previous session. Model and permissions use this project's Codex defaults. Send the first task.` :
          op.kind === 'scratch' ? 'New conversation without a project. Send a question or task.' : 'Session created. Send the first task.');
        save({ status: 'ready', retryAt: 0 });
        if (!op.reset) await this.edit(op, `Session created: ${binding.title}. Open the new topic and send the first task.`);
      }
    } catch (error) {
      if (op.status === 'uncertain' || op.status === 'starting') {
        save({ status: 'uncertain', retryAt: Date.now() + 30_000 }); await this.reportUnknown(op); return;
      }
      // A known ID survives a retry, including an uncertain name/resume result.
      if (op.threadId && this.operationAllowed(op) && (op.reset || error instanceof RpcError || this.closed)) {
        save({ retryAt: Date.now() + 15_000 });
        this.state.enqueueOwnerNotice(`notice/new-retry/${op.id}`, op.topicId, `Session ${op.threadId} has already been created. The relay will retry attachment when Codex recovers; it will not create a replacement.`);
        return;
      }
      save({ status: 'failed', error: 'Creation stopped. Check Codex and local settings.' });
      const text = `Creation stopped.${op.threadId ? ` Session ${op.threadId} is saved; no replacement was created.` : ''} Check Codex and local settings.`;
      this.state.enqueueOwnerNotice(`notice/new-failed/${op.id}`, op.topicId, text); await this.edit(op, text);
    }
  }
  private async reportUnknown(op: NewSessionOperation): Promise<void> {
    const text = 'Creation is not yet confirmed. The relay is checking existing sessions without repeating the creation request. Check Codex locally.';
    this.state.enqueueOwnerNotice(`notice/new-uncertain/${op.id}`, op.topicId, text); await this.edit(op, text);
  }

  /** Load only recorded, non-archived relay-owned sessions, leaving ordinary discovery unchanged. */
  async restore(loadedIds: readonly string[]): Promise<boolean> {
    if (!this.codex.nonArchivedThread || this.closed) return false;
    let changed = false;
    const loaded = new Set(loadedIds);
    for (const op of this.state.newSessions(['ready']).filter(item => item.threadId && !this.state.retiredSession(item.threadId) &&
      !loaded.has(item.threadId) && (this.restoreAfter.get(item.threadId) ?? 0) <= Date.now()).slice(0, Math.max(0, 64 - loaded.size))) {
      if (!this.operationAllowed(op)) continue;
      this.restoreAfter.set(op.threadId!, Date.now() + 30_000);
      try {
        const saved = await this.codex.nonArchivedThread(op.threadId!);
        if (!saved) continue;
        this.verify(saved, op);
        const binding = this.state.binding(op.threadId!);
        if (binding) { await this.connected(binding); changed = true; }
      } catch (error) {
        if (error instanceof RpcError && error.uncertain) throw error;
        this.state.enqueueOwnerNotice(`notice/new-restore/${op.id}`, op.topicId,
          `Saved session ${op.threadId} is currently unavailable. Check it locally in Codex. Other sessions remain connected; no replacement was created.`);
      }
    }
    return changed;
  }
}

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { allowedSessionDirectory, newSessionDefaults, type Config } from './config.js';
import { RpcError } from './codex.js';
import { State, type NewSessionOperation, type NewSessionPhase } from './state.js';
import { Topics } from './topics.js';
import { integer, object, string, type Binding, type Codex, type Json, type Keyboard, type Telegram } from './types.js';

const LIFETIME = 10 * 60_000;
const PAGE = 7;
const MARKER = 'codex-telegram-relay:new:';
const active: NewSessionPhase[] = ['preparing', 'starting', 'uncertain', 'known', 'persisted', 'topic'];
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
  constructor(private readonly config: Config, private readonly state: State, private readonly codex: Codex,
    private readonly telegram: Telegram, private readonly topics: Topics,
    private readonly connected: (binding: Binding) => Promise<void>) { newSessionDefaults(config, state.home); }

  close(): void { this.closed = true; }
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
      expires: Date.now() + LIFETIME, choices, page: 0 };
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

  async callback(callback: Json, message: Json, topicId: number | null): Promise<void> {
    const match = /^n:([a-f0-9]{32}):(x|p\d+|\d+)$/u.exec(string(callback.data));
    const op = match ? this.state.findNewSession('token', match[1]!) : undefined;
    if (!op || op.topicId !== topicId || this.state.promptMessage(op.menuKey) !== integer(message.message_id) || op.expires < Date.now()) {
      await this.ack(callback, 'This menu expired or belongs to another topic. Send /new.'); return;
    }
    if (op.status !== 'selecting') { await this.ack(callback, op.status === 'ready' ? 'The session has already been created.' : 'This selection has already been processed.'); return; }
    await this.ack(callback);
    const action = match![2]!;
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
      cwd: choice.kind === 'scratch' ? join(choice.cwd, op.id) : choice.cwd });
    if (next) await this.edit(next, 'Creating session…');
  }

  private async ack(callback: Json, text?: string): Promise<void> {
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) }); }
    catch { /* Callback acknowledgement is not evidence of a native write. */ }
  }
  private async edit(op: NewSessionOperation, text: string, markup: Json = { inline_keyboard: [] }): Promise<void> {
    const messageId = this.state.promptMessage(op.menuKey);
    if (!messageId) return;
    try { await this.telegram.call('editMessageText', { chat_id: this.config.ownerId, message_id: messageId, text, reply_markup: markup }); }
    catch { /* The durable operation is authoritative; Telegram edits are best effort. */ }
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
    if (!op.root || !op.cwd || !op.kind || !this.choiceAllowed(op.root, op.kind)) return false;
    if (op.threadId && this.config.ignoredThreadIds?.includes(op.threadId)) return false;
    if (op.kind === 'project') return op.cwd === op.root && allowedSessionDirectory(op.cwd, this.config);
    return op.cwd === join(op.root, op.id) && (!existsSync(op.cwd) || !lstatSync(op.cwd).isSymbolicLink() && realpathSync(op.cwd) === op.cwd);
  }
  private verify(thread: Json, op: NewSessionOperation): void {
    if (!string(thread.id) || thread.cwd !== op.cwd || thread.ephemeral === true || thread.parentThreadId || thread.canAcceptDirectInput === false ||
        !['cli', 'vscode', 'appServer'].includes(string(thread.source))) throw new Error('Codex returned an ineligible session. Creation will not be repeated.');
  }

  async tick(): Promise<void> {
    if (this.working || this.closed) return;
    const op = this.state.newSessions(active).find(item => (item.retryAt ?? 0) <= Date.now());
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
      if (this.config.newSessions?.enabled === false || !this.operationAllowed(op)) throw new Error('The directory was removed, changed or is no longer allowed. Check settings locally.');
      if (op.status === 'preparing') {
        const loaded = await this.codex.list(session => !this.config.ignoredThreadIds?.includes(session.id) &&
          allowedSessionDirectory(session.cwd, this.config, this.state.ownsScratch(session.cwd, session.id)));
        if (loaded.length >= 64) throw new Error('The limit of 64 attached sessions has been reached. Free a slot before using /new.');
        if (op.kind === 'scratch') { if (!existsSync(op.cwd!)) mkdirSync(op.cwd!, { mode: 0o700 }); if (!this.operationAllowed(op)) throw new Error('The working directory changed.'); }
        if (this.closed) return;
        save({ status: 'starting' });
        let thread: Json;
        try { thread = await this.codex.createThread!(op.cwd!, MARKER + op.id); }
        catch (error) {
          if (!(error instanceof RpcError) || error.uncertain) { save({ status: 'uncertain', retryAt: Date.now() + 15_000 }); await this.reportUnknown(op); return; }
          throw error;
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
        const binding = await this.topics.ensure({ id: op.threadId!, cwd: op.cwd!, projectLabel: op.kind === 'scratch' ? 'No project' : undefined });
        if (!binding) { save({ retryAt: Date.now() + 10_000 }); return; }
        await this.connected(binding);
        this.state.enqueue(`new-ready/${op.id}`, binding.topicId, op.kind === 'scratch' ? 'New conversation without a project. Send a question or task.' : 'Session created. Send the first task.');
        save({ status: 'ready', retryAt: 0 });
        await this.edit(op, `Session created: ${binding.title}. Open the new topic and send the first task.`);
      }
    } catch (error) {
      if (op.status === 'uncertain' || op.status === 'starting') {
        save({ status: 'uncertain', retryAt: Date.now() + 30_000 }); await this.reportUnknown(op); return;
      }
      // A known ID survives a retry, including an uncertain name/resume result.
      if (op.threadId && this.operationAllowed(op) && (error instanceof RpcError || this.closed)) {
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
    for (const op of this.state.newSessions(['ready']).filter(item => item.threadId &&
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

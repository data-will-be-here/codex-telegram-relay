import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { allowedSessionDirectory, type Config } from './config.js';
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
    private readonly connected: (binding: Binding) => Promise<void>) {}

  close(): void { this.closed = true; }
  busy(threadId: string, marker?: string): boolean {
    const op = this.state.findNewSession('threadId', threadId) ?? (marker?.startsWith(MARKER) ? this.state.newSession(marker.slice(MARKER.length)) : undefined);
    return !!op && !['ready', 'failed', 'cancelled'].includes(op.status);
  }

  async open(topicId: number | null, text: string): Promise<void> {
    if (text !== '/new') { this.notice(topicId, 'Используйте /new без аргументов и выберите вариант кнопкой.'); return; }
    if (this.config.newSessions?.enabled === false) { this.notice(topicId, 'Создание сессий отключено локально. Существующие разговоры продолжают работать.'); return; }
    if (!this.codex.createThread || !this.codex.setThreadName || !this.codex.nonArchivedThread || !this.codex.findCreatedThread) {
      this.notice(topicId, 'Создание сессий не поддерживается этим подключением Codex.'); return;
    }
    const pending = this.state.newSessions(active).find(op => op.topicId === topicId);
    if (pending) { this.notice(topicId, pending.status === 'uncertain' ?
      'Результат предыдущего создания пока неизвестен. Релей проверяет Codex и не повторяет создание. Проверьте Codex локально.' :
      'Сессия уже создаётся для этого меню. Дождитесь результата; повторного создания не будет.'); return; }
    for (const op of this.state.newSessions(['selecting']).filter(op => op.topicId === topicId || op.expires < Date.now())) {
      this.state.changeNewSession(op.id, 'selecting', { status: 'cancelled' }); this.state.cancelPrompt(op.menuKey);
    }
    if (this.state.newSessions([...active, 'selecting']).length >= 64) {
      this.notice(topicId, 'Слишком много открытых меню или незавершённых созданий. Завершите их и повторите /new.'); return;
    }
    const choices: NewSessionOperation['choices'] = [];
    const scratch = this.config.newSessions?.scratchRoot;
    if (scratch && this.validRoot(scratch, true)) choices.push({ cwd: scratch, label: '💬 Без проекта — вопрос / исследование', kind: 'scratch' });
    const current = topicId === null ? undefined : this.state.topic(topicId);
    const projects = [...new Set(this.config.newSessions?.projects ?? [])].filter(path => this.validRoot(path, false) && !this.state.ownsScratch(path));
    projects.sort((a, b) => Number(b === current?.cwd) - Number(a === current?.cwd));
    for (const path of projects) choices.push({ cwd: path, kind: 'project', label:
      `${current?.cwd === path ? '📁 Этот проект — ' : '📁 '}${clean(basename(path))} · ${clean(path)}` });
    if (!choices.length) { this.notice(topicId, 'Создание сессий ещё не настроено локально. На компьютере выполните new enable --project PATH или new enable --scratch-root PATH, затем перезапустите релей.'); return; }
    const id = randomUUID();
    const op: NewSessionOperation = { id, status: 'selecting', topicId, menuKey: `notice/new-menu/${id}`, token: randomBytes(16).toString('hex'),
      expires: Date.now() + LIFETIME, choices, page: 0 };
    this.state.createNewSession(op);
    this.state.enqueueOwnerNotice(op.menuKey, topicId, 'Где начать новый разговор?', this.keyboard(op));
  }

  private keyboard(op: NewSessionOperation): Json {
    const rows: Keyboard['inline_keyboard'] = op.choices.slice(op.page * PAGE, (op.page + 1) * PAGE).map((choice, index) =>
      [{ text: choice.label, callback_data: `n:${op.token}:${op.page * PAGE + index}` }]);
    const navigation = [];
    if (op.page > 0) navigation.push({ text: '←', callback_data: `n:${op.token}:p${op.page - 1}` });
    if ((op.page + 1) * PAGE < op.choices.length) navigation.push({ text: '→', callback_data: `n:${op.token}:p${op.page + 1}` });
    if (navigation.length) rows.push(navigation);
    rows.push([{ text: 'Отмена', callback_data: `n:${op.token}:x` }]);
    return { inline_keyboard: rows };
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<void> {
    const match = /^n:([a-f0-9]{32}):(x|p\d+|\d+)$/u.exec(string(callback.data));
    const op = match ? this.state.findNewSession('token', match[1]!) : undefined;
    if (!op || op.topicId !== topicId || this.state.promptMessage(op.menuKey) !== integer(message.message_id) || op.expires < Date.now()) {
      await this.ack(callback, 'Меню устарело или относится к другому топику. Отправьте /new.'); return;
    }
    if (op.status !== 'selecting') { await this.ack(callback, op.status === 'ready' ? 'Сессия уже создана.' : 'Выбор уже обработан.'); return; }
    await this.ack(callback);
    const action = match![2]!;
    if (action === 'x') {
      if (this.state.changeNewSession(op.id, 'selecting', { status: 'cancelled' })) await this.edit(op, 'Создание отменено.');
      return;
    }
    if (action.startsWith('p')) {
      const page = Number(action.slice(1));
      if (!Number.isSafeInteger(page) || page < 0 || page * PAGE >= op.choices.length) return;
      const next = this.state.changeNewSession(op.id, 'selecting', { page });
      if (next) await this.edit(next, 'Где начать новый разговор?', this.keyboard(next));
      return;
    }
    const choice = op.choices[Number(action)];
    if (!choice || this.config.newSessions?.enabled === false || !this.choiceAllowed(choice.cwd, choice.kind)) { await this.edit(op, 'Каталог больше не разрешён. Отправьте /new.'); return; }
    const next = this.state.changeNewSession(op.id, 'selecting', { status: 'preparing', choices: [], kind: choice.kind, root: choice.cwd,
      cwd: choice.kind === 'scratch' ? join(choice.cwd, op.id) : choice.cwd });
    if (next) await this.edit(next, 'Создаю сессию…');
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

  private validRoot(path: string, scratch: boolean): boolean {
    try {
      if (!isAbsolute(path) || !statSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) return false;
      const forbidden = [this.state.home, process.env.CODEX_HOME ?? join(homedir(), '.codex')];
      if (forbidden.some(root => inside(path, existsSync(root) ? realpathSync(root) : resolve(root)) || inside(resolve(root), path))) return false;
      if (scratch) {
        if ((this.config.newSessions?.projects ?? []).some(root => inside(path, root) || inside(root, path))) return false;
        let parent = path;
        for (;;) { if (existsSync(join(parent, '.git'))) return false; const next = resolve(parent, '..'); if (next === parent) break; parent = next; }
      }
      return true;
    } catch { return false; }
  }
  private choiceAllowed(root: string, kind: 'scratch' | 'project'): boolean {
    return (kind === 'scratch' ? this.config.newSessions?.scratchRoot === root : this.config.newSessions?.projects.includes(root)) === true && this.validRoot(root, kind === 'scratch');
  }
  private operationAllowed(op: NewSessionOperation): boolean {
    if (!op.root || !op.cwd || !op.kind || !this.choiceAllowed(op.root, op.kind)) return false;
    if (op.threadId && this.config.ignoredThreadIds?.includes(op.threadId)) return false;
    if (op.kind === 'project') return op.cwd === op.root && allowedSessionDirectory(op.cwd, this.config);
    return op.cwd === join(op.root, op.id) && (!existsSync(op.cwd) || !lstatSync(op.cwd).isSymbolicLink() && realpathSync(op.cwd) === op.cwd);
  }
  private verify(thread: Json, op: NewSessionOperation): void {
    if (!string(thread.id) || thread.cwd !== op.cwd || thread.ephemeral === true || thread.parentThreadId || thread.canAcceptDirectInput === false ||
        !['cli', 'vscode', 'appServer'].includes(string(thread.source))) throw new Error('Codex вернул неподходящую сессию. Создание не будет повторено.');
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
      if (this.config.newSessions?.enabled === false || !this.operationAllowed(op)) throw new Error('Каталог удалён, изменён или больше не разрешён. Проверьте настройки локально.');
      if (op.status === 'preparing') {
        const loaded = await this.codex.list(session => !this.config.ignoredThreadIds?.includes(session.id) &&
          allowedSessionDirectory(session.cwd, this.config, this.state.ownsScratch(session.cwd, session.id)));
        if (loaded.length >= 64) throw new Error('Достигнут лимит 64 подключаемых сессий. Освободите место перед /new.');
        if (op.kind === 'scratch') { if (!existsSync(op.cwd!)) mkdirSync(op.cwd!, { mode: 0o700 }); if (!this.operationAllowed(op)) throw new Error('Рабочий каталог изменился.'); }
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
        const thread = await this.codex.findCreatedThread!(op.cwd!, MARKER + op.id);
        if (!thread) { save({ status: 'uncertain', retryAt: Date.now() + 30_000 }); await this.reportUnknown(op); return; }
        this.verify(thread, op);
        save({ threadId: string(thread.id), status: 'known' });
      }
      if (this.closed) return;
      if (op.status === 'known') {
        const thread = await this.codex.read(op.threadId!); this.verify(thread, op);
        if (string(object(thread.status).type) === 'notLoaded' && !await this.codex.nonArchivedThread!(op.threadId!)) throw new Error('Archived thread cannot be renamed.');
        const name = string(thread.name) || op.name || `${op.kind === 'scratch' ? 'Разговор' : clean(basename(op.cwd!))} · ${op.threadId!.slice(0, 8)}`;
        save({ name });
        if (!string(thread.name)) await this.codex.setThreadName!(op.threadId!, name);
        await this.codex.turns(op.threadId!); // A reserved path alone never qualifies a new empty session.
        if (this.closed) return;
        save({ status: 'persisted' });
      }
      if (this.closed) return;
      if (op.status === 'persisted' || op.status === 'topic') {
        if (!this.operationAllowed(op)) throw new Error('Рабочий каталог больше не разрешён.');
        // Only non-archived, exact-ID native threads may be resumed after a restart.
        const saved = await this.codex.nonArchivedThread!(op.threadId!);
        if (!saved) throw new Error('Сессия архивирована или больше не доступна. Автоматическая замена отключена.');
        this.verify(saved, op);
        if (this.closed) return;
        save({ status: 'topic' });
        const binding = await this.topics.ensure({ id: op.threadId!, cwd: op.cwd!, projectLabel: op.kind === 'scratch' ? 'Без проекта' : undefined });
        if (!binding) { save({ retryAt: Date.now() + 10_000 }); return; }
        await this.connected(binding);
        this.state.enqueue(`new-ready/${op.id}`, binding.topicId, op.kind === 'scratch' ? 'Новый разговор без проекта. Напишите вопрос или задачу.' : 'Сессия создана. Напишите первую задачу.');
        save({ status: 'ready', retryAt: 0 });
        await this.edit(op, `Сессия создана: ${binding.title}. Откройте новую тему и напишите первую задачу.`);
      }
    } catch (error) {
      if (op.status === 'uncertain' || op.status === 'starting') {
        save({ status: 'uncertain', retryAt: Date.now() + 30_000 }); await this.reportUnknown(op); return;
      }
      // A known ID survives a retry, including an uncertain name/resume result.
      if (op.threadId && this.operationAllowed(op) && (error instanceof RpcError || this.closed)) {
        save({ retryAt: Date.now() + 15_000 });
        this.state.enqueueOwnerNotice(`notice/new-retry/${op.id}`, op.topicId, `Сессия ${op.threadId} уже создана. Релей повторит подключение к ней после восстановления Codex; другая сессия вместо неё создаваться не будет.`);
        return;
      }
      save({ status: 'failed', error: 'Создание остановлено. Проверьте Codex и локальные настройки.' });
      const text = `Создание остановлено.${op.threadId ? ` Сессия ${op.threadId} сохранена; новая вместо неё не создавалась.` : ''} Проверьте Codex и настройки на компьютере.`;
      this.state.enqueueOwnerNotice(`notice/new-failed/${op.id}`, op.topicId, text); await this.edit(op, text);
    }
  }
  private async reportUnknown(op: NewSessionOperation): Promise<void> {
    const text = 'Результат создания пока не подтверждён. Релей проверяет уже созданные сессии и не повторяет запрос создания. Проверьте Codex локально.';
    this.state.enqueueOwnerNotice(`notice/new-uncertain/${op.id}`, op.topicId, text); await this.edit(op, text);
  }

  /** Load only recorded, non-archived relay-owned sessions, leaving ordinary discovery unchanged. */
  async restore(): Promise<void> {
    if (!this.codex.nonArchivedThread || this.closed) return;
    const loaded = new Set((await this.codex.list()).map(thread => thread.id));
    for (const op of this.state.newSessions(['ready']).filter(item => item.threadId &&
      !loaded.has(item.threadId) && (this.restoreAfter.get(item.threadId) ?? 0) <= Date.now()).slice(0, Math.max(0, 64 - loaded.size))) {
      if (!this.operationAllowed(op)) continue;
      this.restoreAfter.set(op.threadId!, Date.now() + 30_000);
      try {
        const saved = await this.codex.nonArchivedThread(op.threadId!);
        if (!saved) continue;
        this.verify(saved, op);
        const binding = this.state.binding(op.threadId!);
        if (binding) await this.connected(binding);
      } catch (error) {
        if (error instanceof RpcError && error.uncertain) throw error;
        this.state.enqueueOwnerNotice(`notice/new-restore/${op.id}`, op.topicId,
          `Сохранённая сессия ${op.threadId} сейчас недоступна. Проверьте её локально в Codex. Остальные сессии продолжают работать; замена не создавалась.`);
      }
    }
  }
}

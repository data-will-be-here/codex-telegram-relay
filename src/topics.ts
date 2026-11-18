import { basename } from 'node:path';
import { allowedSessionDirectory, type Config } from './config.js';
import { State } from './state.js';
import { TelegramError, isMissingTopic } from './telegram.js';
import { integer, object, type Binding, type Json, type Session, type Telegram } from './types.js';

type TopicSession = Pick<Session, 'id' | 'cwd'> & { projectLabel?: string | undefined };

export function topicTitle(session: TopicSession): string {
  const project = (session.projectLabel || basename(session.cwd)).replace(/\s+/gu, ' ').trim() || 'project';
  const suffix = ' · ' + session.id.slice(0, 8);
  let name = '';
  for (const char of project) { if (name.length + char.length + suffix.length > 128) break; name += char; }
  return name + suffix;
}

/** Owns durable topic creation and repair; native Codex policy and execution are untouched. */
export class Topics {
  private titleLocks = new Map<string, Promise<unknown>>();
  constructor(private readonly config: Config, private readonly state: State, private readonly telegram: Telegram) {}

  async ensure(session: TopicSession): Promise<Binding | undefined> {
    if (this.state.retiredSession(session.id)) return;
    session = { ...session, projectLabel: this.state.workspaceLabel(session.cwd) };
    const binding = this.state.binding(session.id);
    const previous = this.state.topicOperation(session.id);
    if (binding && !previous) return this.syncTitle(binding, session);
    const title = binding?.customTitle ?? topicTitle(session);
    const attempt = this.state.beginTopic(session.id, session.cwd, title);
    if (!attempt) { if (previous?.status === 'uncertain' || previous?.status === 'failed') this.problem(previous.threadId); return undefined; }
    let topicId: number;
    try {
      const result = object(await this.telegram.call('createForumTopic', { chat_id: this.config.ownerId, name: title }));
      const id = integer(result.message_thread_id);
      if (!id || id < 1) throw new TelegramError('Topic creation response was incomplete.', 0);
      topicId = id;
    } catch (error) {
      if (error instanceof TelegramError && error.status === 429) {
        this.state.topicResult(session.id, attempt.attempt, 'retry', Date.now() + Math.max(error.retryAfter ?? 3, 1) * 1000);
      } else if (error instanceof TelegramError && error.notSent) {
        this.state.topicResult(session.id, attempt.attempt, 'retry', Date.now() + 3000, 'Telegram could not connect. No topic request was sent; retrying.');
      } else {
        const code = error instanceof TelegramError ? /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)\b/u.exec(error.message)?.[1] : undefined;
        const summary = error instanceof TelegramError ? `Telegram topic request failed (${error.status}${code ? ', ' + code : ''}).` : 'Topic creation was not confirmed.';
        const rejected = error instanceof TelegramError && error.status >= 400 && error.status < 500 && code !== 'BOT_TOPIC_WRONG_HOME';
        this.state.topicResult(session.id, attempt.attempt, rejected ? 'failed' : 'uncertain', 0, summary);
        this.problem(session.id);
      }
      return undefined;
    }
    const installed = this.state.installTopic(session.id, topicId, session.cwd, title);
    if (binding) this.state.enqueue(`topic-restored/${attempt.attempt}`, topicId, 'Topic restored. Saved undelivered answers will follow; no Codex instructions were repeated.');
    return installed;
  }

  private async titleLock<T>(threadId: string, run: () => Promise<T>): Promise<T> {
    const pending = (this.titleLocks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.titleLocks.set(threadId, pending);
    try { return await pending; }
    finally { if (this.titleLocks.get(threadId) === pending) this.titleLocks.delete(threadId); }
  }

  private current(binding: Binding): Binding | undefined {
    const current = this.state.binding(binding.threadId);
    return current?.topicId === binding.topicId && current.cwd === binding.cwd &&
      !this.state.resettingTopic(binding.topicId) && !this.state.topicOperation(binding.threadId) &&
      !this.config.ignoredThreadIds?.includes(binding.threadId) &&
      allowedSessionDirectory(current.cwd, this.config, this.state.ownsScratch(current.cwd, current.threadId)) ? current : undefined;
  }

  private async editTitle(binding: Binding, title: string): Promise<void> {
    try {
      if (await this.telegram.call('editForumTopic', { chat_id: this.config.ownerId, message_thread_id: binding.topicId, name: title }) !== true)
        throw new TelegramError('Topic rename response was not confirmed.', 0);
    } catch (error) {
      if (!(error instanceof TelegramError && error.status === 400 && /TOPIC_NOT_MODIFIED|not modified/iu.test(error.message))) throw error;
    }
    const current = this.current(binding);
    if (!current || current.customTitle !== binding.customTitle || !this.state.confirmTopicTitle(binding.threadId, title, binding))
      throw new Error('The topic binding changed while renaming. Open the current topic and retry /rename.');
  }

  /** Null restores the generated project/id name. Uncertain writes retain a durable, idempotent intent. */
  async rename(binding: Binding, name: string | null, stillCurrent: () => boolean = () => true): Promise<{ status: 'confirmed' | 'pending'; title: string }> {
    const customTitle = name === null ? null : name.trim();
    if (customTitle !== null && (!customTitle || Array.from(customTitle).length > 128 || /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(customTitle)))
      throw new Error('Use a single-line topic name of 1–128 characters.');
    return this.titleLock(binding.threadId, async () => {
      const previous = this.current(binding);
      if (!previous) throw new Error('This topic is unavailable, being cleared, ignored or outside your selected projects.');
      if (!stillCurrent()) throw new Error('This rename prompt is closed or expired. Send /rename to open a new one.');
      if (this.state.topicTitleRetryAt(binding.threadId) > Date.now()) throw new Error('Telegram topic renaming is waiting to retry. Please try again later.');
      const title = customTitle ?? topicTitle({ id: previous.threadId, cwd: previous.cwd, projectLabel: this.state.workspaceLabel(previous.cwd) });
      if (!this.state.setCustomTopicTitle(previous, customTitle)) throw new Error('The topic binding changed. Retry /rename in its current topic.');
      const requested = this.state.binding(binding.threadId)!;
      try {
        await this.editTitle(requested, title);
        return { status: 'confirmed', title };
      } catch (error) {
        if (!this.current(requested)) throw new Error('The topic binding changed while renaming. Open the current topic and retry /rename.');
        if (error instanceof TelegramError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          this.state.setCustomTopicTitle(requested, previous.customTitle ?? null, previous.titlePending ?? 0);
          throw new Error(isMissingTopic(error) ? 'Telegram could not find this topic. No replacement was created.' : 'Telegram rejected this topic name. The saved name was not changed.');
        }
        const rateLimited = error instanceof TelegramError && error.status === 429;
        this.state.deferTopicTitle(rateLimited ? 'all' : binding.threadId, Date.now() + (rateLimited ? Math.max(error.retryAfter ?? 30, 1) : 30) * 1000);
        return { status: 'pending', title };
      }
    });
  }

  private syncTitle(binding: Binding, session: TopicSession): Promise<Binding | undefined> {
    return this.titleLock(session.id, () => this.syncTitleNow(binding, session));
  }

  async retryPendingTitles(): Promise<void> {
    for (const binding of this.state.bindings()) {
      if (binding.titlePending && this.current(binding))
        await this.syncTitle(binding, { id: binding.threadId, cwd: binding.cwd, projectLabel: this.state.workspaceLabel(binding.cwd) });
    }
  }

  private async syncTitleNow(binding: Binding, session: TopicSession): Promise<Binding | undefined> {
    // Discovery may report a new eligible directory even when the old root was revoked.
    const latest = this.state.binding(session.id);
    if (latest?.topicId !== binding.topicId || this.state.resettingTopic(binding.topicId) || this.state.topicOperation(session.id) ||
        this.config.ignoredThreadIds?.includes(session.id) || !allowedSessionDirectory(session.cwd, this.config, this.state.ownsScratch(session.cwd, session.id)))
      return latest;
    this.state.sessionDirectory(session.id, session.cwd);
    binding = this.state.binding(session.id)!;
    const title = binding.customTitle ?? topicTitle(session);
    if ((title === binding.title && !binding.titlePending) || this.state.topicTitleRetryAt(session.id) > Date.now()) return binding;
    try {
      await this.editTitle(binding, title);
    } catch (error) {
      if (!this.current(binding)) return this.state.binding(session.id);
      if (isMissingTopic(error)) {
        this.state.missingTopic(binding);
        return undefined;
      } else {
        const rateLimited = error instanceof TelegramError && error.status === 429;
        this.state.deferTopicTitle(rateLimited ? 'all' : session.id, Date.now() + (rateLimited ? Math.max(error.retryAfter ?? 30, 1) : 30) * 1000);
      }
    }
    return this.state.binding(session.id);
  }

  async retry(prefix: string): Promise<Binding | undefined> {
    const session = this.resolve(prefix);
    const operation = this.state.topicOperation(session.id);
    if (!operation) throw new Error(`This session has a saved binding to topic #${this.state.binding(session.id)!.topicId}; no topic creation is awaiting recovery. No replacement was created.`);
    if (operation.status === 'creating') throw new Error('Topic creation is still in progress. Wait for its result.');
    this.state.retryTopic(session.id);
    return this.ensure(session);
  }

  bind(prefix: string, topicId: number): Binding {
    const session = this.resolve(prefix);
    const operation = this.state.topicOperation(session.id);
    const existing = this.state.binding(session.id);
    const occupant = this.state.topic(topicId);
    if (occupant && occupant.threadId !== session.id) throw new Error('This topic is already bound to another session.');
    if (!operation) {
      if (existing?.topicId === topicId) return existing;
      throw new Error(`This session is already bound to topic #${existing!.topicId}. Open that topic and send /bind ${session.id}. Its binding was not changed.`);
    }
    if (operation?.status === 'creating') throw new Error('Topic creation is still in progress. Wait for its result.');
    return this.state.installTopic(session.id, topicId, session.cwd, operation?.title ?? existing!.title);
  }

  resolve(prefix: string): TopicSession {
    if (!/^[a-zA-Z0-9-]{6,128}$/u.test(prefix)) throw new Error('Use a session ID or unique prefix of at least six characters.');
    const sessions = new Map([...this.state.bindings(), ...this.state.topicOperations()].map(s => [s.threadId, { id: s.threadId, cwd: s.cwd }]));
    const matches = [...sessions.values()].filter(s => s.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error('Session prefix must identify exactly one saved session.');
    const session = matches[0]!;
    if (this.config.ignoredThreadIds?.includes(session.id) || !allowedSessionDirectory(session.cwd, this.config, this.state.ownsScratch(session.cwd, session.id))) throw new Error('This session is ignored or outside your selected projects.');
    return session;
  }

  recovery(threadId: string): { text: string; markup: Json } {
    const op = this.state.topicOperation(threadId)!;
    const id = threadId;
    const reason = op.status === 'uncertain' ? 'Telegram may have created its topic, but the response was not confirmed. Automatic creation is paused to avoid duplicates.' : 'Telegram returned a topic creation error. Check whether the topic appeared before retrying. The saved Codex session has not been replaced.';
    const token = op.attempt.replaceAll('-', '');
    return { text: `${op.title}\n\n${reason}${op.error ? '\n' + op.error : ''}\nChoose an action below.\nManual recovery: create/open an empty topic and send /bind ${id}; /repair ${id} retries only topic creation.`,
      markup: { inline_keyboard: [
        [{ text: 'Topic appeared — bind', callback_data: `recover:${token}:b` }],
        [{ text: 'Topic did not appear — create again', callback_data: `recover:${token}:r` }],
      ] } };
  }
  private problem(threadId: string): void {
    const op = this.state.topicOperation(threadId)!; const prompt = this.recovery(threadId);
    this.state.enqueue(`topic-problem/${op.attempt}`, null, prompt.text, prompt.markup, op.cwd, threadId);
  }
}

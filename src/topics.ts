import { basename } from 'node:path';
import { allowedDirectory, type Config } from './config.js';
import { State } from './state.js';
import { TelegramError, isMissingTopic } from './telegram.js';
import { integer, object, type Binding, type Session, type Telegram } from './types.js';

type TopicSession = Pick<Session, 'id' | 'cwd'>;

export function topicTitle(session: TopicSession): string {
  const project = basename(session.cwd).replace(/\s+/gu, ' ').trim() || 'project';
  const suffix = ' · ' + session.id.slice(0, 8);
  let name = '';
  for (const char of project) { if (name.length + char.length + suffix.length > 128) break; name += char; }
  return name + suffix;
}

/** Owns durable topic creation and repair; native Codex policy and execution are untouched. */
export class Topics {
  constructor(private readonly config: Config, private readonly state: State, private readonly telegram: Telegram) {}

  async ensure(session: TopicSession): Promise<Binding | undefined> {
    const binding = this.state.binding(session.id);
    const previous = this.state.topicOperation(session.id);
    if (binding && !previous) return this.syncTitle(binding, session);
    const title = topicTitle(session);
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
      } else {
        this.state.topicResult(session.id, attempt.attempt, error instanceof TelegramError && error.status >= 400 && error.status < 500 ? 'failed' : 'uncertain');
        this.problem(session.id);
      }
      return undefined;
    }
    const installed = this.state.installTopic(session.id, topicId, session.cwd, title);
    if (binding) this.state.enqueue(`topic-restored/${attempt.attempt}`, topicId, 'Topic restored. Saved undelivered answers will follow; no Codex instructions were repeated.');
    return installed;
  }

  private async syncTitle(binding: Binding, session: TopicSession): Promise<Binding | undefined> {
    this.state.sessionDirectory(session.id, session.cwd);
    const title = topicTitle(session);
    if (title === binding.title || this.state.topicTitleRetryAt(session.id) > Date.now()) return this.state.binding(session.id);
    try {
      const renamed = await this.telegram.call('editForumTopic', { chat_id: this.config.ownerId, message_thread_id: binding.topicId, name: title });
      if (renamed !== true) throw new TelegramError('Topic rename response was not confirmed.', 0);
      this.state.confirmTopicTitle(session.id, title);
    } catch (error) {
      if (error instanceof TelegramError && error.status === 400 && /TOPIC_NOT_MODIFIED|not modified/iu.test(error.message)) {
        this.state.confirmTopicTitle(session.id, title);
      } else if (isMissingTopic(error)) {
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
    if (!operation) throw new Error('This session already has a healthy topic; no replacement was created.');
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
    if (!operation) throw new Error('This session already has a healthy topic; its binding was not changed.');
    if (operation?.status === 'creating') throw new Error('Topic creation is still in progress. Wait for its result.');
    return this.state.installTopic(session.id, topicId, session.cwd, operation?.title ?? existing!.title);
  }

  private resolve(prefix: string): TopicSession {
    if (!/^[a-zA-Z0-9-]{6,128}$/u.test(prefix)) throw new Error('Use a session ID or unique prefix of at least six characters.');
    const sessions = new Map([...this.state.bindings(), ...this.state.topicOperations()].map(s => [s.threadId, { id: s.threadId, cwd: s.cwd }]));
    const matches = [...sessions.values()].filter(s => s.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error('Session prefix must identify exactly one saved session.');
    const session = matches[0]!;
    if (this.config.ignoredThreadIds?.includes(session.id) || !allowedDirectory(session.cwd, this.config.roots)) throw new Error('This session is ignored or outside your selected projects.');
    return session;
  }

  private problem(threadId: string): void {
    const op = this.state.topicOperation(threadId)!;
    const id = threadId;
    const reason = op.status === 'uncertain' ? 'Telegram may have created its topic, but the response was not confirmed. Automatic creation is paused to avoid duplicates.' : 'Telegram rejected topic creation. Correct the bot settings before retrying.';
    this.state.enqueue(`topic-problem/${op.attempt}`, null, `${op.title}\n\n${reason}\nIf the topic appeared, open it and send /bind ${id}.\nIf no topic appeared, send /repair ${id} to explicitly create a replacement.`, null, op.cwd);
  }
}

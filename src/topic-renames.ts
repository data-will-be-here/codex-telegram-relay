import { randomUUID } from 'node:crypto';
import { allowedSessionDirectory, type Config } from './config.js';
import { State, type TopicRenameMenu } from './state.js';
import { Topics } from './topics.js';
import { integer, object, string, type Binding, type Json, type Telegram } from './types.js';

/** Native reply prompts keep title input separate from instructions, questions and widget callbacks. */
export class TopicRenames {
  constructor(private readonly config: Config, private readonly state: State, private readonly topics: Topics, private readonly telegram: Telegram,
    private readonly active: () => boolean = () => true) {}

  private available(binding: Binding): boolean {
    const current = this.state.binding(binding.threadId);
    return this.active() && current?.topicId === binding.topicId && current.cwd === binding.cwd &&
      !this.state.resettingTopic(binding.topicId) && !this.state.topicOperation(binding.threadId) &&
      !this.config.ignoredThreadIds?.includes(binding.threadId) &&
      allowedSessionDirectory(binding.cwd, this.config, this.state.ownsScratch(binding.cwd, binding.threadId));
  }
  private valid(menu: TopicRenameMenu): boolean {
    return !menu.closed && this.state.topicRenameMenu(menu.token)?.closed === 0 && menu.expires > Date.now() && !!menu.messageId &&
      this.available({ ...menu, title: '', lastTurn: null });
  }
  private notice(topicId: number | null, text: string): void {
    this.state.enqueueOwnerNotice(`notice/topic-rename/${randomUUID()}`, topicId, text);
  }
  private async apply(binding: Binding, name: string | null, menu?: TopicRenameMenu): Promise<void> {
    try {
      const result = await this.topics.rename(binding, name, () => this.active() && (!menu || this.valid(menu)));
      this.state.closeTopicRenameMenus(binding.topicId);
      this.notice(binding.topicId, result.status === 'confirmed' ? `Topic renamed: ${result.title}` :
        `Topic rename is awaiting confirmation: ${result.title}\nThe relay will retry this name on the same topic automatically.`);
    } catch (error) {
      this.notice(binding.topicId, error instanceof Error ? error.message : 'Topic rename could not be completed. Retry /rename.');
    }
  }

  async message(message: Json, topicId: number | null): Promise<boolean> {
    const text = string(message.text).trim();
    if (/^\/rename(?:\s|$)/u.test(text)) {
      const binding = topicId === null ? undefined : this.state.topic(topicId);
      if (!binding) { this.notice(topicId, 'Open a bound session topic and send /rename or /rename NEW NAME.'); return true; }
      if (!this.available(binding)) { this.notice(topicId, 'This topic is unavailable, being cleared, ignored or outside your selected projects.'); return true; }
      const name = text.slice('/rename'.length).trim();
      if (name) { await this.apply(binding, name); return true; }
      const token = randomUUID().replaceAll('-', '');
      const deliveryKey = `notice/topic-rename-menu/${token}`;
      this.state.saveTopicRenameMenu({ token, threadId: binding.threadId, topicId: binding.topicId, cwd: binding.cwd, deliveryKey,
        expires: Date.now() + 10 * 60 * 1000, closed: 0 });
      this.state.enqueue(deliveryKey, binding.topicId, `Current topic: ${binding.title}\n\nReply to this message with a new single-line name (1–128 characters).\nOther messages continue to Codex normally. This prompt expires in 10 minutes.`,
        { inline_keyboard: [[{ text: 'Cancel', callback_data: `tr:${token}:cancel` }, { text: 'Restore default', callback_data: `tr:${token}:reset` }]] });
      return true;
    }
    const replyId = integer(object(message.reply_to_message).message_id);
    const menu = topicId !== null && replyId ? this.state.topicRenameReply(topicId, replyId) : undefined;
    if (!menu) return false;
    // Even expired or cancelled prompt replies must never become a Codex instruction.
    if (!this.valid(menu)) { this.notice(topicId, 'This rename prompt is closed or expired. Send /rename to open a new one.'); return true; }
    if (!text || message.photo || message.document || message.voice || message.audio || message.video || message.animation || message.video_note) {
      this.notice(topicId, 'Reply with a text name, or choose Cancel.'); return true;
    }
    await this.apply(this.state.binding(menu.threadId)!, text, menu);
    return true;
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<void> {
    const match = /^tr:([a-f0-9]{32}):(cancel|reset)$/u.exec(string(callback.data));
    const menu = match ? this.state.topicRenameMenu(match[1]!) : undefined;
    const valid = (): boolean => !!menu && menu.topicId === topicId && menu.messageId === integer(message.message_id) &&
      this.valid(menu);
    const accepted = valid();
    try { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id,
      ...(!accepted ? { text: 'This rename prompt is closed, expired or belongs to another topic.' } : {}) }); }
    catch { /* The acknowledgement does not authorize a stale action or change rename delivery. */ }
    if (!accepted || !valid() || !menu) return;
    if (match![2] === 'cancel') {
      this.state.closeTopicRenameMenus(menu.topicId);
      this.notice(menu.topicId, 'Topic rename cancelled.');
    } else await this.apply(this.state.binding(menu.threadId)!, null, menu);
  }
}

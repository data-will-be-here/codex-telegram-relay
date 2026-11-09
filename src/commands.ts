import { array, object, string, type Telegram } from './types.js';

const commands = [
  { command: 'help', args: '', en: 'Show available relay commands' },
  { command: 'status', args: '', en: 'Show connection, message mode and streaming status' },
  { command: 'limits', args: '', en: 'Show remaining Codex account limits and reset times' },
  { command: 'sessions', args: '', en: 'List attached Codex sessions and their IDs' },
  { command: 'new', args: '', en: 'Start a new conversation or project session' },
  { command: 'model', args: '', en: 'Choose this session’s model, reasoning and speed' },
  { command: 'permissions', args: '', en: 'Choose this session’s access and approval review mode' },
  { command: 'mode', args: 'all|compact', en: 'Choose all assistant messages or compact replies' },
  { command: 'stream', args: 'on|off', en: 'Enable or disable live answer previews' },
  { command: 'questions', args: '', en: 'Show pending questions with answer buttons' },
  { command: 'bind', args: 'SESSION_ID', en: 'Bind this topic to a session: /bind SESSION_ID', advanced: true },
  { command: 'repair', args: 'SESSION_ID', en: 'Retry topic creation: /repair SESSION_ID', advanced: true },
] as const;

export function commandHelp(): string {
  return 'Codex Telegram Relay\n\nOpen a project topic and send a message to its existing Codex session.\n' +
    commands.map(c => `/${c.command}${c.args ? ' ' + c.args : ''} — ${c.en}`).join('\n');
}

/** Sync only the owner's chat. Menu registration is optional and never changes authorization. */
export async function syncCommandMenu(telegram: Telegram, ownerId: number): Promise<boolean> {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return false;
  let synced = true;
  // Overwrite the legacy Russian scope too, so existing installations use English consistently.
  for (const language of ['', 'ru'] as const) {
    const scope = { type: 'chat', chat_id: ownerId };
    const desired = commands.filter(c => !('advanced' in c && c.advanced)).map(c => ({ command: c.command, description: c.en }));
    try {
      const current = array(await telegram.call('getMyCommands', { scope, language_code: language })).map(object);
      if (current.length === desired.length && current.every((c, i) => c.command === desired[i]!.command &&
          string(c.description) === desired[i]!.description && c.is_ephemeral !== true)) continue;
      if (await telegram.call('setMyCommands', { scope, language_code: language, commands: desired }) !== true) synced = false;
    } catch {
      // Continue with the other language; failed or uncertain idempotent settings can be retried next start.
      synced = false;
    }
  }
  return synced;
}

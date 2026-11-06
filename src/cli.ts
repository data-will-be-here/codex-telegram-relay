#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { realpathSync, existsSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from './bridge.js';
import { CodexClient } from './codex.js';
import { Drafts } from './drafts.js';
import { syncCommandMenu } from './commands.js';
import { configExists, dataDirectory, findCodex, loadConfig, readConfig, saveConfig, validateBinary, protectWindowsDirectory, allowedSessionDirectory, type Config } from './config.js';
import { Files, type FileRequest } from './files.js';
import { Outbox, TelegramClient, TelegramError } from './telegram.js';
import { array, integer, object, string, type Json } from './types.js';
import { withProjectHeader } from './format.js';

function binaryFlag(args: string[]): string | undefined {
  const index = args.indexOf('--codex-bin');
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error('--codex-bin requires an absolute native executable path.');
  return validateBinary(value);
}

async function secret(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Setup requires an interactive terminal. Do not pass a bot token as a command argument.');
  stdout.write(question);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error): void => {
      stdin.off('keypress', handler); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const handler = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === 'c') { finish(new Error('Setup cancelled.')); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(); return; }
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (text && !key.ctrl && !/[\r\n\x00-\x1f]/u.test(text) && value.length < 4096) value += text;
    };
    stdin.on('keypress', handler);
  });
}

async function verifyBot(telegram: TelegramClient): Promise<string> {
  const me = object(await telegram.call('getMe'));
  if (me.is_bot !== true || me.has_topics_enabled !== true) throw new Error('Enable private-chat topics for your bot in @BotFather, then run setup again.');
  const webhook = object(await telegram.call('getWebhookInfo'));
  if (string(webhook.url)) throw new Error('This bot has a webhook. Use a dedicated bot; the relay will not remove another application’s webhook.');
  return string(me.username);
}

async function commandMenu(telegram: TelegramClient, ownerId: number): Promise<void> {
  if (!await syncCommandMenu(telegram, ownerId)) console.error('Command menu could not be fully updated. Relay messaging is unaffected; restart to retry.');
}

async function setup(args: string[]): Promise<void> {
  const home = dataDirectory();
  if (configExists(home)) throw new Error(`Configuration already exists at ${home}. Keep its token private. Use projects add PATH to add a project.`);
  const scopeIndex = args.indexOf('--scope');
  const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : 'selected';
  if (scope !== 'all' && scope !== 'selected') throw new Error('Use setup --scope all or setup --scope selected.');
  console.log('Security: this bot is remote control of Codex. Anyone controlling your paired Telegram account can act within connected-session permissions and may access readable data.\nProtect your account, bot token and computer/server. Enable Telegram Two-Step Verification, an app passcode with auto-lock, and device screen lock; review active sessions.\nThe cloud password protects new logins, not an already unlocked session. See SECURITY.md.');
  const binary = binaryFlag(args) ?? findCodex();
  const codex = new CodexClient();
  try {
    await codex.connect(binary);
    const sessions = await codex.list();
    console.log('Existing Codex projects (terminal / IDE):');
    const paths = [...new Set(sessions.map(s => s.cwd))];
    paths.forEach((path, index) => console.log(`  ${index + 1}. ${path}`));
    let roots: string[] = [];
    if (scope === 'selected') {
      if (!paths.length) throw new Error('No loaded Codex CLI sessions found. Start Codex in your project, then run setup again.');
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        const choice = (await terminal.question('Project numbers to connect (comma-separated, or all currently listed): ')).trim();
        const selected = choice === 'all' ? paths : choice.split(',').map(x => paths[Number(x.trim()) - 1]);
        if (!selected.length || selected.some(x => !x)) throw new Error('Choose at least one valid project number.');
        roots = [...new Set(selected.map(x => realpathSync(x!)))];
      } finally { terminal.close(); }
    } else {
      console.log('Automatic discovery explicitly enabled: all interactive CLI/IDE sessions, including future projects.');
      if (!paths.length) console.log('No materialized sessions yet. New sessions become connectable after their first prompt.');
    }
    const token = await secret('Bot token from @BotFather (hidden): ');
    if (!/^\d{5,16}:[A-Za-z0-9_-]{20,200}$/u.test(token)) throw new Error('Token format is invalid.');
    const telegram = new TelegramClient(token);
    const username = await verifyBot(telegram);
    const { randomBytes } = await import('node:crypto');
    const code = randomBytes(12).toString('hex');
    console.log(`Send /start ${code} to @${username} in a PRIVATE chat within 5 minutes.`);
    let offset: number | undefined;
    let ownerId: number | undefined;
    const deadline = Date.now() + 5 * 60_000;
    while (!ownerId && Date.now() < deadline) {
      const updates = array(await telegram.call('getUpdates', { offset, timeout: 20, allowed_updates: ['message'] }));
      for (const raw of updates) {
        const update = object(raw); const message = object(update.message); const from = object(message.from); const chat = object(message.chat);
        const id = integer(update.update_id); if (id !== undefined) offset = id + 1;
        if (message.text === `/start ${code}` && chat.type === 'private' && from.is_bot === false && from.id === chat.id) ownerId = integer(from.id);
      }
    }
    if (!ownerId) throw new Error('Pairing timed out. No configuration saved.');
    const config: Config = { version: 1, ownerId, roots, codexBinary: binary, sessionScope: scope };
    saveConfig(home, config, token);
    await telegram.call('sendMessage', { chat_id: ownerId, ...withProjectHeader({ text: `Paired with your local Codex Telegram Relay. Start the relay on your computer to connect ${scope === 'all' ? 'all interactive Codex sessions, including future projects' : 'the selected projects'}.`, entities: [] }) });
    await commandMenu(telegram, ownerId);
    console.log(`Paired. Private configuration saved outside the checkout: ${home}\nRun: npm start`);
  } finally { codex.close(); }
}

async function doctor(args: string[]): Promise<void> {
  const override = binaryFlag(args);
  const configured = configExists(dataDirectory()) ? loadConfig(dataDirectory(), { recoverBinary: true, ...(override ? { codexBinary: override } : {}) }) : undefined;
  const binary = configured?.config.codexBinary ?? override ?? findCodex();
  const codex = new CodexClient();
  try {
    await codex.connect(binary);
    const sessions = await codex.list();
    console.log(`Native shared-daemon connection: OK\nLoaded interactive sessions: ${sessions.length}\nNo threads resumed, no model turns started, no settings changed.`);
    if (configured) console.log(`Session discovery: ${configured.config.sessionScope === 'all' ? 'automatic (all projects)' : 'selected projects'}`);
    for (const session of sessions) {
      const reason = !configured ? '' : configured.config.ignoredThreadIds?.includes(session.id) ? ' [ignored]' : allowedSessionDirectory(session.cwd, configured.config) ? ' [eligible]' : ' [project not selected]';
      console.log(`  ${session.id.slice(0, 8)}  ${session.status}  ${session.cwd}${reason}`);
    }
    if (configured) {
      const { config, token } = configured;
      const username = await verifyBot(new TelegramClient(token));
      console.log(`Bot: @${username}; private topics: OK; owner configured; project roots: ${config.roots.length}`);
      if (configured.binaryChanged) console.log('A replacement Codex executable was found. Doctor changed no files; start will save it after checking the shared daemon.');
    } else console.log('Bot configuration: not yet created. Run setup.');
  } finally { codex.close(); }
}

async function start(args: string[]): Promise<void> {
  const home = dataDirectory();
  if (!configExists(home)) throw new Error('No relay configuration found. Run setup to pair your bot first.');
  protectWindowsDirectory(home);
  const override = binaryFlag(args);
  const { config, token, binaryChanged } = loadConfig(home, { recoverBinary: true, ...(override ? { codexBinary: override } : {}) });
  const telegram = new TelegramClient(token);
  for (;;) {
    try { await verifyBot(telegram); break; }
    catch (error) {
      if (!(error instanceof TelegramError) || !(error.status === 0 || error.status === 429 || error.status >= 500)) throw error;
      const seconds = error.status === 429 ? Math.max(3, error.retryAfter ?? 0) : 3;
      console.error(`Telegram startup check unavailable (${error.status || 'connection'}); retrying in ${seconds} seconds. Ctrl+C stops the relay.`);
      await delay(seconds * 1000);
    }
  }
  const { State } = await import('./state.js');
  const state = new State(home);
  const outbox = new Outbox(state, telegram, config, 1100);
  const drafts = new Drafts(telegram, config.ownerId);
  const files = new Files(home);
  files.startWorker(config.ownerId);
  const uploadStop = new AbortController();
  let liveBridge: Bridge | undefined;
  let stopping = false;
  let current: CodexClient | undefined;
  let saveRecoveredBinary = binaryChanged;
  let pollFailures = 0;
  let nextPollAt = 0;
  const stop = (): void => { stopping = true; uploadStop.abort(); current?.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const output = async (): Promise<void> => {
    while (!stopping) {
      try {
        // Order settled preview calls before permanent answers; remote timeout outcomes remain uncertain.
        // Saved answers and controls always take priority over ephemeral previews.
        if (await outbox.flushOne()) continue;
        if (await liveBridge?.flushApproval()) continue;
        if (await liveBridge?.flushDraft()) continue;
        await delay(100);
      }
      catch (error) { console.error(string(object(error).message) || 'Telegram delivery failed.'); await delay(1000); }
    }
  };
  const sender = output();
  const uploads = (async (): Promise<void> => {
    while (!stopping) {
      try {
        const bridge = liveBridge;
        if (bridge && await files.flushOne(telegram, binding => bridge.allowsFile(binding), uploadStop.signal)) continue;
      } catch { console.error('File queue check failed; ordinary messaging is unaffected.'); }
      await delay(250);
    }
  })();
  // Optional UI settings must not hold up native attachment or Telegram update handling.
  const menu = commandMenu(telegram, config.ownerId);
  try {
    while (!stopping) {
      const codex = new CodexClient(); current = codex;
      let connected = true;
      let pendingEvents = Promise.resolve();
      let discovery = Promise.resolve();
      let discovering = false;
      let eventCount = 0;
      try {
        const bridge = new Bridge(config, state, codex, telegram, drafts);
        const unavailable = new Set<string>();
        codex.on('sessionUnavailable', (id: string) => {
          if (!unavailable.has(id)) { unavailable.add(id); console.error(`Skipping unavailable Codex session ${id.slice(0, 8)}; other sessions remain connected.`); }
        });
        let warnedLimit = false;
        codex.on('discoveryLimit', (limit: number) => {
          if (warnedLimit) return;
          warnedLimit = true;
          const warning = `Discovery reached the limit of ${limit} eligible interactive sessions. Some sessions are not connected. Ignore unused sessions or select fewer projects locally, then restart the relay. Subagents do not count toward this limit.`;
          console.error(warning);
          state.enqueue(`attention/discovery-limit/${limit}`, null, warning);
        });
        codex.on('disconnected', () => { connected = false; });
        // Serialize control events so completed native requests invalidate buttons in order.
        const schedule = (work: () => Promise<void>): void => {
          if (eventCount >= 256) { codex.close(); console.error('Native event backlog exceeded the limit; reconnecting to recover recent completions.'); return; }
          eventCount++;
          pendingEvents = pendingEvents.then(work).catch(error => { console.error(string(object(error).message) || 'Codex event failed.'); }).finally(() => { eventCount--; });
        };
        codex.on('notification', (method: string, params: Json) => {
          bridge.streamEvent(method, params);
          if (['item/completed', 'turn/completed', 'serverRequest/resolved', 'thread/name/updated'].includes(method) || (method === 'item/started' && object(params.item).type === 'fileChange')) schedule(() => bridge.notification(method, params));
        });
        codex.on('request', request => schedule(() => bridge.request(request)));
        await codex.connect(config.codexBinary);
        if (saveRecoveredBinary) {
          if (!Array.isArray(object(await codex.call('thread/loaded/list', {})).data)) throw new Error('Replacement Codex returned an incompatible loaded-session response. Its path was not saved.');
          saveConfig(home, config);
          saveRecoveredBinary = false;
          console.log('Codex executable path updated after a successful shared-daemon check. Bot pairing and topic bindings are preserved.');
        }
        await bridge.discover();
        liveBridge = bridge;
        console.log(`Relay connected. Discovery: ${config.sessionScope === 'all' ? 'automatic, all interactive sessions' : 'selected projects'}. Keep this process running. Ctrl+C stops the relay, not your Codex daemon.`);
        let lastDiscovery = Date.now();
        while (!stopping && connected) {
          if (!discovering && Date.now() - lastDiscovery > 5000) {
            discovering = true; lastDiscovery = Date.now();
            // Incoming replies/buttons keep moving while metadata and journals are scanned.
            discovery = bridge.discover().then(() => { state.prune(); }).catch(error => {
              console.error(string(object(error).message) || 'Discovery failed; reconnecting.');
              connected = false; codex.close();
            }).finally(() => { discovering = false; });
          }
          if (Date.now() < nextPollAt) { await delay(250); continue; }
          let updates: unknown[];
          try {
            updates = array(await telegram.call('getUpdates', { offset: state.offset(), timeout: 3, allowed_updates: ['message', 'callback_query'] }));
            if (pollFailures) console.log('Telegram polling recovered.');
            pollFailures = 0;
          } catch (error) {
            if (!(error instanceof TelegramError) || !(error.status === 0 || error.status === 429 || error.status >= 500)) throw error;
            pollFailures = Math.min(pollFailures + 1, 6);
            const seconds = error.status === 429 ? Math.max(error.retryAfter ?? 2, 1) : Math.min(2 ** (pollFailures - 1), 30);
            nextPollAt = Date.now() + seconds * 1000;
            if (pollFailures === 1) console.error(`Telegram polling unavailable (${error.status || 'connection'}); retrying without restarting Codex.`);
            continue;
          }
          for (const raw of updates) {
            if (stopping || !connected) break;
            try { await bridge.update(object(raw)); }
            catch (error) { console.error(string(object(error).message) || 'Input delivery failed.'); }
          }
        }
      } catch (error) {
        if (error instanceof TelegramError && error.status === 409) throw new Error('Another process consumes this bot. Stop it before restarting the relay.');
        if (error instanceof TelegramError && error.status >= 400 && error.status < 500 && error.status !== 429) throw error;
        console.error(string(object(error).message) || 'Relay connection failed.');
      } finally { liveBridge = undefined; drafts.clear(); codex.close(); await discovery; await pendingEvents; }
      if (!stopping) { console.log('Reconnecting in 3 seconds. Ambiguous native writes will not be replayed.'); await delay(3000); }
    }
  } finally {
    stopping = true; uploadStop.abort(); current?.close(); await uploads; files.close(); await sender; await menu; state.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

async function sendFile(args: string[]): Promise<void> {
  const request: FileRequest = { path: args[1] ?? '' };
  if (!request.path || request.path.startsWith('--')) throw new Error('Usage: send-file PATH [--session ID] [--as auto|video|document] [--caption TEXT] [--request-id ID] [--no-wait]');
  let wait = true;
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--no-wait') { wait = false; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--session') request.session = value;
    else if (flag === '--caption') request.caption = value;
    else if (flag === '--request-id') request.requestId = value;
    else if (flag === '--as' && ['auto', 'video', 'document'].includes(value)) request.as = value as 'auto' | 'video' | 'document';
    else throw new Error(`Unknown file option: ${flag}.`);
  }
  const files = new Files(dataDirectory());
  try {
    let result = files.enqueue(request);
    const deadline = Date.now() + 180_000;
    while (wait && ['preparing', 'pending', 'sending'].includes(result.status) && Date.now() < deadline) {
      await delay(250); result = files.status(result.id);
    }
    console.log(JSON.stringify(result));
    if (result.status === 'rejected' || result.status === 'uncertain') process.exitCode = 1;
    else if (wait && result.status !== 'sent') process.exitCode = 2;
  } finally { files.close(); }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] === '--codex-bin' ? 'start' : args[0] ?? 'start';
  if (command === 'setup') return setup(args);
  if (command === 'doctor') return doctor(args);
  if (command === 'start') return start(args);
  if (command === 'send-file') return sendFile(args);
  if (command === 'files') {
    const home = dataDirectory();
    if (args[1] === 'status' && args[2] && !args[3]) {
      const files = new Files(home);
      try { console.log(JSON.stringify(files.status(args[2]))); } finally { files.close(); }
      return;
    }
    if (args.length > 2 || (args[1] && !['enable', 'disable'].includes(args[1]))) throw new Error('Use files [enable|disable] or files status REQUEST_ID.');
    const config = readConfig(home);
    if (args[1]) { config.outgoingFiles = args[1] === 'enable'; saveConfig(home, config); }
    console.log(`File export: ${config.outgoingFiles === true ? 'enabled' : 'disabled'}. Local setting; only this installation\u2019s paired owner can receive exports. Requires the updated relay to be running.`);
    return;
  }
  if (command === 'sessions' && args[1] === 'scope') {
    const mode = args[2];
    if (args[3] || (mode !== undefined && mode !== 'all' && mode !== 'selected')) throw new Error('Use sessions scope all or sessions scope selected.');
    const home = dataDirectory(); const { config } = loadConfig(home);
    if (mode === 'selected' && !config.roots.length) throw new Error('No selected projects. Add roots with projects add PATH before enabling selected mode.');
    if (mode) { config.sessionScope = mode; saveConfig(home, config); }
    console.log(`Session discovery: ${config.sessionScope === 'all' ? 'automatic (all interactive sessions and future projects)' : 'selected projects'}.${mode ? ' Restart the relay to apply; ignored sessions remain ignored.' : ''}`);
    return;
  }
  if (command === 'sessions' && ['ignore', 'unignore'].includes(args[1] ?? '')) {
    const prefix = args[2];
    if (!prefix || !/^[a-zA-Z0-9-]{6,128}$/u.test(prefix)) throw new Error('Usage: sessions ignore|unignore SESSION_ID_OR_UNIQUE_PREFIX');
    const home = dataDirectory(); const { config } = loadConfig(home);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(home, 'state.sqlite'), { readOnly: true });
    let matches: string[];
    try { matches = db.prepare('SELECT threadId FROM bindings').all().map(row => string(row.threadId)).filter(id => id.startsWith(prefix)); }
    finally { db.close(); }
    if (matches.length !== 1) throw new Error('Session prefix must match exactly one existing topic. Use /sessions to see IDs.');
    const id = matches[0]!;
    config.ignoredThreadIds = args[1] === 'ignore'
      ? [...new Set([...(config.ignoredThreadIds ?? []), id])]
      : (config.ignoredThreadIds ?? []).filter(value => value !== id);
    saveConfig(home, config);
    console.log(`Session ${id.slice(0, 8)} ${args[1] === 'ignore' ? 'ignored' : 'enabled'}. Restart the relay to apply. Native Codex state is unchanged.`);
    return;
  }
  if (command === 'projects' && args[1] === 'add') {
    const path = args[2];
    if (!path || !existsSync(path)) throw new Error('Usage: projects add EXISTING_PROJECT_DIRECTORY');
    const home = dataDirectory(); const { config, token } = loadConfig(home);
    const root = realpathSync(path);
    if (!statSync(root).isDirectory()) throw new Error('Project root must be a directory.');
    config.roots = [...new Set([...config.roots, root])]; saveConfig(home, config, token);
    console.log('Project added. Restart the relay to apply.'); return;
  }
  if (command !== 'help' && command !== '--help' && command !== '-h') throw new Error('Unknown command. Run with --help.');
  console.log('Codex Telegram Relay\n\nsetup                 Pair your own bot and select existing CLI projects\nsetup --scope all     Explicitly connect all interactive sessions and future projects\nstart                 Relay events and replies through private project topics\ndoctor                Read-only shared-daemon/bot diagnostics\nprojects add PATH     Add a project to selected mode (restart afterwards)\nsessions scope        Show the local discovery mode\nsessions scope all    Automatically include new projects (restart afterwards)\nsessions scope selected  Limit discovery to selected projects (restart afterwards)\nsessions ignore ID    Stop relaying one session (restart afterwards)\nsessions unignore ID  Re-enable an existing session (restart afterwards)\n\nRequires Node.js 22.13+, Codex CLI with app-server proxy, and a running Codex session.\nSetup, doctor and start accept --codex-bin /absolute/path/to/native/codex[.exe].\nConfiguration: ' + dataDirectory());
  console.log('\nFile export (local opt-in):\nfiles enable|disable   Allow or revoke outgoing files for this installation\nfiles                 Show export setting\nsend-file PATH        Send one project file to its session topic\n  --session ID        Exact ID or unique prefix (default: CODEX_THREAD_ID, then unique project)\n  --as document       Preserve any file as a document; auto sends MP4 as video\n  --caption TEXT      Optional literal caption\n  --request-id ID     Stable caller ID; reuse it for the same attempt\n  --no-wait           Return queued receipt immediately\nfiles status ID       Inspect durable result; uncertain uploads are never auto-replayed');
}

main().catch(error => { console.error(string(object(error).message) || 'Relay failed.'); process.exitCode = 1; });

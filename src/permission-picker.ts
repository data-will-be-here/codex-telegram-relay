import { randomBytes, randomUUID } from 'node:crypto';
import { RpcError } from './codex.js';
import { withProjectHeader } from './format.js';
import { permissionMode, permissionSignature, validPermissionSettings } from './permission-settings.js';
import { type State } from './state.js';
import { type Screens } from './screens.js';
import { integer, object, string, displayName, type Binding, type Codex, type Json, type Keyboard, type PermissionAgent, type PermissionPatch, type PermissionSnapshot, type Telegram } from './types.js';

const PAGE_SIZE = 7;
const LIFETIME = 10 * 60_000;
const NAMES = new Map([[':read-only', 'Read Only'], [':workspace', 'Ask for approval'], [':danger-full-access', 'Full Access']]);
const label = (value: string): string => Array.from(value.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 100).join('');
interface Choice { patch: PermissionPatch; text: string; confirm: boolean; description: string; }
type Action = { kind: 'choice'; choice: Choice } | { kind: 'confirm' } | { kind: 'back' } | { kind: 'close' } | { kind: 'page'; page: number } | { kind: 'restart' } | { kind: 'restartConfirm' } | { kind: 'dismiss' } | { kind: 'dismissConfirm' };
interface Menu {
  binding: Binding; key: string; token: string; expires: number; busy: boolean;
  snapshot: PermissionSnapshot; signature: string; actions: Map<string, Action>; page: number;
  confirmation?: Choice;
  agents: PermissionAgent[]; agentsUnknown?: boolean;
  restart?: { agents: PermissionAgent[]; anchorTurnId: string | null };
  notice?: string;
  dismiss?: string;
}

function policyAllowed(snapshot: PermissionSnapshot, value: string): boolean {
  const permitted = snapshot.requirements.allowedApprovalPolicies;
  return permitted == null || Array.isArray(permitted) && permitted.includes(value);
}
function reviewerAllowed(snapshot: PermissionSnapshot, value: string): boolean {
  const permitted = snapshot.requirements.allowedApprovalsReviewers;
  return permitted == null || Array.isArray(permitted) && permitted.includes(value);
}
function profileChoice(profile: Json, snapshot: PermissionSnapshot): Choice | undefined {
  const id = string(profile.id);
  if (profile.allowed !== true) return;
  const policy = id === ':danger-full-access' ? 'never' : NAMES.has(id) ? 'on-request' : undefined;
  if (policy && !policyAllowed(snapshot, policy)) return;
  if (policy && !reviewerAllowed(snapshot, 'user')) return;
  return { patch: { permissions: id, ...(policy ? { approvalPolicy: policy } : {}) },
    text: NAMES.get(id) ?? label(id), confirm: id === ':danger-full-access' || !NAMES.has(id), description: label(string(profile.description)) };
}
function choices(snapshot: PermissionSnapshot): Choice[] {
  const available = snapshot.profiles.map(profile => profileChoice(profile, snapshot)).filter((item): item is Choice => !!item);
  const ordered: Choice[] = [':workspace', ':danger-full-access', ':read-only'].flatMap(id => available.filter(item => item.patch.permissions === id)
    .map(item => ({ ...item, patch: { ...item.patch, approvalsReviewer: 'user' as const } })));
  if (snapshot.profiles.some(profile => profile.id === ':workspace' && profile.allowed) && snapshot.autoReview &&
      policyAllowed(snapshot, 'on-request') && reviewerAllowed(snapshot, 'auto_review')) {
    ordered.splice(ordered[0]?.patch.permissions === ':workspace' ? 1 : 0, 0, { text: 'Approve for me', confirm: false, description: '',
      patch: { permissions: ':workspace', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } });
  }
  return [...ordered, ...available.filter(item => !NAMES.has(item.patch.permissions!))];
}

/** Only explicit, topic-scoped owner selections may change native session permissions. */
export class PermissionPicker {
  private menus = new Map<string, Menu>();
  private opening = new Set<string>();
  constructor(private readonly state: State, private readonly codex: Codex, private readonly telegram: Telegram,
    private readonly ownerId: number, private readonly allowed: (binding: Binding) => Promise<Json | undefined>, private readonly screens?: Screens,
    private readonly inspect?: (binding: Binding) => Promise<PermissionAgent[]>,
    private readonly replace?: (binding: Binding, key: string, inputId: number, signature: string, mode: string, agents: PermissionAgent[], anchorTurnId: string | null) => Promise<void>) {}

  async open(binding: Binding): Promise<void> {
    if (this.opening.has(binding.threadId)) return;
    this.opening.add(binding.threadId);
    try { await this.openMenu(binding); } finally { this.opening.delete(binding.threadId); }
  }

  private async openMenu(binding: Binding): Promise<void> {
    for (const menu of this.menus.values()) if (!menu.busy && menu.expires < Date.now()) this.retire(menu);
    const previous = this.menus.get(binding.threadId);
    if (previous?.busy) { this.notice(binding, 'A permission change is already being processed.'); return; }
    if (previous) await this.complete(previous, 'Menu replaced by a new /permissions request.');
    if (this.menus.size >= 64) { this.notice(binding, 'Close an open permission menu and retry /permissions.'); return; }
    if (!this.codex.permissionCatalog || !this.codex.updatePermissions) { this.notice(binding, 'This Codex version does not support the permission menu.'); return; }
    try {
      if (!await this.allowed(binding)) { this.notice(binding, 'The session is unavailable for this topic.'); return; }
      const snapshot = await this.catalog(binding);
      if (!await this.allowed(binding)) { this.notice(binding, 'The session is no longer available for this topic.'); return; }
      const menu: Menu = { binding, key: `prompt/permissions/${randomUUID()}`, token: '', expires: Date.now() + LIFETIME,
        busy: false, snapshot, signature: permissionSignature(snapshot.settings), actions: new Map(), page: 0, agents: [] };
      try { menu.agents = await this.inspect?.(binding) ?? []; } catch { menu.agentsUnknown = true; }
      if (!await this.allowed(binding)) return;
      this.menus.set(binding.threadId, menu);
      const screen = this.screen(menu);
      if (this.screens) this.screens.enqueue(menu.key, binding.topicId, screen.text, screen.markup as unknown as Json, { kind: 'menu', title: 'Session permissions', editable: true });
      else this.state.enqueue(menu.key, binding.topicId, screen.text, screen.markup as unknown as Json);
    } catch { this.notice(binding, 'Could not load Codex permissions. Check the connection and retry /permissions.'); }
  }

  private async catalog(binding: Binding): Promise<PermissionSnapshot> {
    const snapshot = await this.codex.permissionCatalog!(binding.threadId, binding.cwd);
    if (!validPermissionSettings(snapshot.settings) || snapshot.settings.cwd !== binding.cwd || !Array.isArray(snapshot.profiles) || snapshot.profiles.length > 512 ||
        snapshot.profiles.some(profile => !string(profile.id) || string(profile.id).length > 256 || /[\x00-\x1f\x7f]/u.test(string(profile.id)) || typeof profile.allowed !== 'boolean') ||
        new Set(snapshot.profiles.map(profile => profile.id)).size !== snapshot.profiles.length) throw new Error('Invalid native permission catalog.');
    return snapshot;
  }

  async callback(callback: Json, message: Json, topicId: number | null, inputId = 0): Promise<'done' | 'rejected' | 'uncertain'> {
    const match = /^p:([a-f0-9]{32}):([a-z0-9]+)$/u.exec(string(callback.data));
    const menu = match ? [...this.menus.values()].find(item => item.token === match[1]) : undefined;
    const action = match && menu?.actions.get(match[2]!);
    if (!menu || !action || topicId !== menu.binding.topicId || integer(message.message_id) !== this.state.promptMessage(menu.key) || menu.expires < Date.now()) {
      await this.ack(callback, 'This menu expired or belongs to another topic. Send /permissions.'); return 'done';
    }
    if (menu.busy) { await this.ack(callback, 'Your selection is already being processed.'); return 'done'; }
    menu.busy = true; let writing = false;
    try {
      await this.ack(callback);
      if (action.kind === 'close') { await this.complete(menu, 'Permission selection cancelled.'); return 'done'; }
      if (!await this.allowed(menu.binding) || !this.current(menu)) { await this.complete(menu, 'The session is unavailable for this topic.'); return 'rejected'; }
      const fresh = await this.catalog(menu.binding);
      if (permissionSignature(fresh.settings) !== menu.signature) { await this.complete(menu, 'Session settings changed in Codex. Reopen /permissions.'); return 'rejected'; }
      menu.snapshot = fresh;
      if (action.kind === 'dismiss' || action.kind === 'dismissConfirm') {
        const job = this.state.agentRestarts().find(item => item.binding.threadId === menu.binding.threadId && item.status === 'uncertain');
        if (!job) throw new RpcError('The saved request has already changed. Reopen /permissions.', false);
        if (action.kind === 'dismiss') {
          menu.dismiss = job.id; const screen = this.screen(menu); await this.edit(menu, screen.text, screen.markup); return 'done';
        }
        if (menu.dismiss !== job.id) throw new RpcError('The saved request changed.', false);
        this.retire(menu); this.state.changeAgentRestart(job, { status: 'dismissed' });
        await this.complete(menu, 'Saved uncertainty cleared. No native action was taken. Reopen /permissions to make a new selection.'); return 'done';
      }
      if (action.kind === 'restart' || action.kind === 'restartConfirm') {
        if (!this.inspect || !this.replace) throw new RpcError('Agent replacement is unavailable.', false);
        const agents = await this.inspect(menu.binding);
        const turns = await this.codex.turns(menu.binding.threadId);
        const thread = await this.allowed(menu.binding);
        if (!thread || !this.current(menu) || !agents.length) throw new RpcError('The session or agents changed. Reopen /permissions.', false);
        const anchorTurnId = string(turns[0]?.id) || null;
        if (action.kind === 'restart') {
          menu.restart = { agents, anchorTurnId };
          const screen = this.screen(menu); await this.edit(menu, screen.text, screen.markup); return 'done';
        }
        const saved = menu.restart;
        if (!saved || saved.anchorTurnId !== anchorTurnId || JSON.stringify(saved.agents.map(a => [a.threadId, a.cwd])) !== JSON.stringify(agents.map(a => [a.threadId, a.cwd]))) {
          throw new RpcError('The session or selected agents changed. Reopen /permissions.', false);
        }
        const latest = await this.catalog(menu.binding);
        if (!this.current(menu) || permissionSignature(latest.settings) !== menu.signature || !await this.allowed(menu.binding)) throw new RpcError('The session settings changed.', false);
        this.retire(menu);
        await this.edit(menu, 'Scheduling the confirmed agent replacement…', { inline_keyboard: [] });
        await this.replace(menu.binding, menu.key, inputId, menu.signature, permissionMode(fresh.settings), saved.agents, saved.anchorTurnId);
        return 'done';
      }
      if (action.kind === 'choice' || action.kind === 'confirm') {
        const requested = action.kind === 'confirm' ? menu.confirmation : action.choice;
        const choice = requested && this.currentChoice(fresh, requested);
        if (!choice || action.kind === 'confirm' && choice.description !== requested?.description) {
          await this.complete(menu, 'The selected mode is no longer available. Reopen /permissions.'); return 'rejected';
        }
        if (choice.confirm && action.kind !== 'confirm') {
          menu.confirmation = choice;
          const screen = this.screen(menu); await this.edit(menu, screen.text, screen.markup); return 'done';
        }
        if (!await this.allowed(menu.binding) || !this.current(menu)) { await this.complete(menu, 'The session is no longer available for this topic.'); return 'rejected'; }
        // Consume before writing. An uncertain native write must never be replayed by another click.
        this.retire(menu); writing = true;
        await this.codex.updatePermissions!(menu.binding.threadId, choice.patch, menu.signature);
        if (menu.agents.length && this.inspect && this.replace) {
          menu.snapshot = await this.catalog(menu.binding); menu.signature = permissionSignature(menu.snapshot.settings);
          menu.agents = await this.inspect(menu.binding); delete menu.confirmation; delete menu.restart;
          menu.notice = `Selected: ${choice.text}. Saved for following turns in this session.`;
          this.menus.set(menu.binding.threadId, menu); menu.expires = Date.now() + LIFETIME;
          const screen = this.screen(menu); await this.edit(menu, screen.text, screen.markup);
        } else await this.complete(menu, `Selected: ${choice.text}.\nSaved for following turns in this session.`);
        return 'done';
      }
      delete menu.confirmation; delete menu.restart; delete menu.dismiss;
      if (action.kind === 'back') menu.page = 0;
      else if (action.kind === 'page') menu.page = action.page;
      const screen = this.screen(menu); await this.edit(menu, screen.text, screen.markup); return 'done';
    } catch (error) {
      const uncertain = writing && (!(error instanceof RpcError) || error.uncertain);
      await this.complete(menu, uncertain ? 'The permission change could not be confirmed. Check permissions in Codex before choosing again. It will not be retried automatically.' :
        writing ? 'Codex rejected the permission change. Open /permissions to check the available modes.' :
          'Could not update the permission menu. Retry /permissions.');
      return uncertain ? 'uncertain' : 'rejected';
    } finally { menu.busy = false; }
  }

  private currentChoice(snapshot: PermissionSnapshot, choice: Choice): Choice | undefined {
    const options = choices(snapshot);
    return options.find(item => JSON.stringify(item.patch) === JSON.stringify(choice.patch));
  }
  private current(menu: Menu): boolean { return this.menus.get(menu.binding.threadId) === menu && menu.expires >= Date.now(); }
  private screen(menu: Menu): { text: string; markup: Keyboard } {
    menu.token = randomBytes(16).toString('hex'); menu.actions.clear();
    const button = (text: string, action: Action) => { const code = menu.actions.size.toString(36); menu.actions.set(code, action); return { text, callback_data: `p:${menu.token}:${code}` }; };
    if (menu.dismiss) return { text: 'Clear the saved uncertain replacement request?\n\nFirst check the root history: the previous request may already have been received. Clearing this record does not stop any running work or send a replacement request.',
      markup: { inline_keyboard: [[button('Checked history — clear record', { kind: 'dismissConfirm' })], [button('Back', { kind: 'back' }), button('Cancel', { kind: 'close' })]] } };
    if (menu.restart) return { text: `Request replacement of ${menu.restart.agents.length} existing agents?\nMode for new agents: ${permissionMode(menu.snapshot.settings)}\n\n` +
      'This pauses the current root turn if active. A NEW root turn will ask the main agent to preserve progress, interrupt the listed workers and create replacements for unfinished tasks. ' +
      'Files and conversation history are retained. Pending approvals are not accepted automatically. Replacement is carried out by the main agent; it is not a direct settings change to old workers.',
      markup: { inline_keyboard: [[button('Pause and request replacement', { kind: 'restartConfirm' })], [button('Back', { kind: 'back' }), button('Cancel', { kind: 'close' })]] } };
    if (menu.confirmation) {
      const full = menu.confirmation.patch.permissions === ':danger-full-access';
      return { text: full ? 'Enable Full Access?\n\nCodex will be able to modify files outside the project and run commands with network access without approval prompts.\nThe selection will persist for following requests in this session.' :
        `Choose profile “${menu.confirmation.text}”?\n${menu.confirmation.description || 'Access is determined by this profile in Codex.'}\nThe selection will persist for following requests in this session.`,
      markup: { inline_keyboard: [[button(full ? 'Enable Full Access' : 'Choose profile', { kind: 'confirm' })],
        [button('Back', { kind: 'back' }), button('Cancel', { kind: 'close' })]] } };
    }
    const settings = menu.snapshot.settings; const active = string(object(settings.activePermissionProfile).id);
    const legacyIds = new Map([['readOnly', ':read-only'], ['workspaceWrite', ':workspace'], ['dangerFullAccess', ':danger-full-access']]);
    const profile = active || legacyIds.get(string(object(settings.sandboxPolicy).type));
    const options = choices(menu.snapshot);
    const selected = (choice: Choice): boolean => choice.patch.permissions === profile &&
      (choice.patch.approvalPolicy === undefined || choice.patch.approvalPolicy === settings.approvalPolicy) &&
      (choice.patch.approvalsReviewer === undefined || choice.patch.approvalsReviewer === settings.approvalsReviewer);
    const name = options.find(selected)?.text ?? (profile && !NAMES.has(profile) ? label(profile) : 'Custom Codex settings');
    const pages = Math.max(1, Math.ceil(options.length / PAGE_SIZE)); menu.page = Math.max(0, Math.min(menu.page, pages - 1));
    const rows: Keyboard['inline_keyboard'] = options.slice(menu.page * PAGE_SIZE, (menu.page + 1) * PAGE_SIZE).map(choice =>
      [button((selected(choice) ? '✓ ' : '') + choice.text, { kind: 'choice', choice })]);
    const nav = []; if (menu.page) nav.push(button('←', { kind: 'page', page: menu.page - 1 }));
    if (menu.page + 1 < pages) nav.push(button('→', { kind: 'page', page: menu.page + 1 })); if (nav.length) rows.push(nav);
    const pending = this.state.agentRestarts().find(job => job.binding.threadId === menu.binding.threadId);
    if (pending?.status === 'uncertain') rows.push([button('Clear uncertain request…', { kind: 'dismiss' })]);
    else if (!pending && menu.agents.length && this.replace) rows.push([button('Replace existing agents…', { kind: 'restart' })]);
    rows.push([button('Close', { kind: 'close' })]);
    const agentText = menu.agents.length ? `\n\nExisting agents (${menu.agents.length}):\n` + menu.agents.slice(0, 5).map(agent =>
      `${label(agent.name)}: ${agent.settings ? permissionMode(agent.settings) : 'settings unavailable'}${agent.waiting ? ' · waiting for approval' : ''}`).join('\n') +
      (menu.agents.length > 5 ? `\n+ ${menu.agents.length - 5} more` : '') + '\nTheir settings are independent. Codex blocks direct changes to these workers; replacements can inherit the new root mode.' :
      menu.agentsUnknown ? '\n\nAgent settings could not be verified. Reopen the menu after connection recovery.' : '';
    return { text: `Session permissions\nCurrent: ${name}\n\nChoose a mode. Approve for me uses automatic approval review within the workspace profile.` +
      '\nChanges apply to following turns; pending approvals retain their existing controls.' + (menu.notice ? `\n${menu.notice}` : '') + agentText +
      (pending ? pending.status === 'uncertain' ? '\n\nA previous replacement request has an unknown outcome. Check the root history before another request.' : '\n\nAn agent replacement request is pending.' : '') +
      (!options.length ? '\nNo options are currently available.' : '') + (pages > 1 ? `\nPage ${menu.page + 1}/${pages}` : ''), markup: { inline_keyboard: rows } };
  }

  private async ack(callback: Json, text?: string): Promise<void> { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) }); }
  private async edit(menu: Menu, text: string, markup: Keyboard): Promise<void> {
    if (this.screens) { menu.key = await this.screens.edit(menu.key, menu.binding.topicId, text, markup as unknown as Json,
      { kind: 'menu', title: 'Session permissions', editable: true, caption: menu.confirmation || menu.restart || menu.dismiss ? text : undefined }); return; }
    const id = this.state.promptMessage(menu.key); if (!id) throw new Error('Menu delivery is not confirmed.');
    await this.telegram.call('editMessageText', { chat_id: this.ownerId, message_id: id,
      ...withProjectHeader({ text, entities: [] }, menu.binding.cwd, displayName(menu.binding), menu.binding.projectLabel), reply_markup: markup });
  }
  private notice(binding: Binding, text: string): void { this.state.enqueue(`attention/permissions/${randomUUID()}`, binding.topicId, text); }
  private retire(menu: Menu): void {
    if (this.menus.get(menu.binding.threadId) === menu) this.menus.delete(menu.binding.threadId);
    menu.token = ''; menu.actions.clear(); this.state.cancelPrompt(menu.key);
  }
  private async complete(menu: Menu, text: string): Promise<void> {
    this.retire(menu);
    try { await this.edit(menu, text, { inline_keyboard: [] }); } catch { this.notice(menu.binding, text); }
  }
}

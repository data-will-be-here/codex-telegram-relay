import { randomBytes, randomUUID } from 'node:crypto';
import { RpcError } from './codex.js';
import { withProjectHeader } from './format.js';
import { permissionSignature, validPermissionSettings } from './permission-settings.js';
import { type State } from './state.js';
import { integer, object, string, type Binding, type Codex, type Json, type Keyboard, type PermissionPatch, type PermissionSnapshot, type Telegram } from './types.js';

const PAGE_SIZE = 7;
const LIFETIME = 10 * 60_000;
const NAMES = new Map([[':read-only', 'Read-only'], [':workspace', 'Workspace'], [':danger-full-access', 'Full Access']]);
const label = (value: string): string => Array.from(value.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 100).join('');
interface Choice { patch: PermissionPatch; text: string; confirm: boolean; description: string; }
type Action = { kind: 'choice'; choice: Choice } | { kind: 'confirm' } | { kind: 'reviewers' } | { kind: 'back' } | { kind: 'close' } | { kind: 'page'; page: number };
interface Menu {
  binding: Binding; key: string; token: string; expires: number; busy: boolean;
  snapshot: PermissionSnapshot; signature: string; actions: Map<string, Action>; page: number;
  reviewers: boolean; confirmation?: Choice;
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
  return { patch: { permissions: id, ...(policy ? { approvalPolicy: policy } : {}) },
    text: NAMES.get(id) ?? label(id), confirm: id === ':danger-full-access' || !NAMES.has(id), description: label(string(profile.description)) };
}
function reviewers(snapshot: PermissionSnapshot): Choice[] {
  const policy = snapshot.settings.approvalPolicy;
  if (policy !== 'on-request' && !Object.values(object(object(policy).granular)).some(value => value === true)) return [];
  return [
    ...(reviewerAllowed(snapshot, 'user') ? [{ patch: { approvalsReviewer: 'user' as const }, text: 'Ask me', confirm: false, description: '' }] : []),
    ...(snapshot.autoReview && reviewerAllowed(snapshot, 'auto_review') ? [{ patch: { approvalsReviewer: 'auto_review' as const }, text: 'Automatic review', confirm: false, description: '' }] : []),
  ];
}

/** Only explicit, topic-scoped owner selections may change native session permissions. */
export class PermissionPicker {
  private menus = new Map<string, Menu>();
  private opening = new Set<string>();
  constructor(private readonly state: State, private readonly codex: Codex, private readonly telegram: Telegram,
    private readonly ownerId: number, private readonly allowed: (binding: Binding) => Promise<Json | undefined>) {}

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
        busy: false, snapshot, signature: permissionSignature(snapshot.settings), actions: new Map(), page: 0, reviewers: false };
      this.menus.set(binding.threadId, menu);
      const screen = this.screen(menu); this.state.enqueue(menu.key, binding.topicId, screen.text, screen.markup as unknown as Json);
    } catch { this.notice(binding, 'Could not load Codex permissions. Check the connection and retry /permissions.'); }
  }

  private async catalog(binding: Binding): Promise<PermissionSnapshot> {
    const snapshot = await this.codex.permissionCatalog!(binding.threadId, binding.cwd);
    if (!validPermissionSettings(snapshot.settings) || snapshot.settings.cwd !== binding.cwd || !Array.isArray(snapshot.profiles) || snapshot.profiles.length > 512 ||
        snapshot.profiles.some(profile => !string(profile.id) || string(profile.id).length > 256 || /[\x00-\x1f\x7f]/u.test(string(profile.id)) || typeof profile.allowed !== 'boolean') ||
        new Set(snapshot.profiles.map(profile => profile.id)).size !== snapshot.profiles.length) throw new Error('Invalid native permission catalog.');
    return snapshot;
  }

  async callback(callback: Json, message: Json, topicId: number | null): Promise<'done' | 'rejected' | 'uncertain'> {
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
        await this.complete(menu, `Selected: ${choice.text}.\nSaved for following requests in this session.`);
        return 'done';
      }
      delete menu.confirmation;
      if (action.kind === 'reviewers') menu.reviewers = true;
      else if (action.kind === 'back') { menu.reviewers = false; menu.page = 0; }
      else menu.page = action.page;
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
    const options = choice.patch.permissions === undefined ? reviewers(snapshot) : snapshot.profiles.map(profile => profileChoice(profile, snapshot)).filter((item): item is Choice => !!item);
    return options.find(item => JSON.stringify(item.patch) === JSON.stringify(choice.patch));
  }
  private current(menu: Menu): boolean { return this.menus.get(menu.binding.threadId) === menu && menu.expires >= Date.now(); }
  private screen(menu: Menu): { text: string; markup: Keyboard } {
    menu.token = randomBytes(16).toString('hex'); menu.actions.clear();
    const button = (text: string, action: Action) => { const code = menu.actions.size.toString(36); menu.actions.set(code, action); return { text, callback_data: `p:${menu.token}:${code}` }; };
    if (menu.confirmation) {
      const full = menu.confirmation.patch.permissions === ':danger-full-access';
      return { text: full ? 'Enable Full Access?\n\nCodex will be able to modify files outside the project and run commands with network access without approval prompts.\nThe selection will persist for following requests in this session.' :
        `Choose profile “${menu.confirmation.text}”?\n${menu.confirmation.description || 'Access is determined by this profile in Codex.'}\nThe selection will persist for following requests in this session.`,
      markup: { inline_keyboard: [[button(full ? 'Enable Full Access' : 'Choose profile', { kind: 'confirm' })],
        [button('Back', { kind: 'back' }), button('Cancel', { kind: 'close' })]] } };
    }
    const settings = menu.snapshot.settings; const active = string(object(settings.activePermissionProfile).id);
    const legacyNames = new Map([['readOnly', 'Read-only'], ['workspaceWrite', 'Workspace'], ['dangerFullAccess', 'Full Access']]);
    const name = NAMES.get(active) ?? (active ? label(active) : legacyNames.get(string(object(settings.sandboxPolicy).type)) ?? 'Custom Codex settings');
    const reviewer = settings.approvalPolicy === 'never' ? 'not requested' : settings.approvalsReviewer === 'user' ? 'ask me' : 'automatic review';
    const choices = menu.reviewers ? reviewers(menu.snapshot) : menu.snapshot.profiles.map(profile => profileChoice(profile, menu.snapshot)).filter((item): item is Choice => !!item);
    const pages = Math.max(1, Math.ceil(choices.length / PAGE_SIZE)); menu.page = Math.max(0, Math.min(menu.page, pages - 1));
    const rows: Keyboard['inline_keyboard'] = choices.slice(menu.page * PAGE_SIZE, (menu.page + 1) * PAGE_SIZE).map(choice => {
      const selected = choice.patch.permissions ? choice.patch.permissions === active : choice.patch.approvalsReviewer === settings.approvalsReviewer;
      return [button((selected ? '✓ ' : '') + choice.text, { kind: 'choice', choice })];
    });
    const nav = []; if (menu.page) nav.push(button('←', { kind: 'page', page: menu.page - 1 }));
    if (menu.page + 1 < pages) nav.push(button('→', { kind: 'page', page: menu.page + 1 })); if (nav.length) rows.push(nav);
    if (!menu.reviewers && reviewers(menu.snapshot).length) rows.push([button('Approval reviewer', { kind: 'reviewers' })]);
    rows.push([...(menu.reviewers ? [button('Back', { kind: 'back' })] : []), button('Close', { kind: 'close' })]);
    return { text: `Session permissions\nCurrent: ${name}\nApprovals: ${reviewer}\n\n${menu.reviewers ? 'Who reviews approval requests?' : 'Choose an access profile.'}` +
      (!choices.length ? '\nNo options are currently available.' : '') + (pages > 1 ? `\nPage ${menu.page + 1}/${pages}` : ''), markup: { inline_keyboard: rows } };
  }
  private async ack(callback: Json, text?: string): Promise<void> { await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) }); }
  private async edit(menu: Menu, text: string, markup: Keyboard): Promise<void> {
    const id = this.state.promptMessage(menu.key); if (!id) throw new Error('Menu delivery is not confirmed.');
    await this.telegram.call('editMessageText', { chat_id: this.ownerId, message_id: id,
      ...withProjectHeader({ text, entities: [] }, menu.binding.cwd, menu.binding.sessionName, menu.binding.projectLabel), reply_markup: markup });
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

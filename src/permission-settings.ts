import { object, type Json } from './types.js';

/** Bind confirmation to the actual session policy, including custom sandbox roots. */
export function permissionSignature(settings: Json): string {
  return JSON.stringify([settings.cwd, settings.activePermissionProfile ?? null, settings.sandboxPolicy,
    settings.approvalPolicy, settings.approvalsReviewer, settings.model, settings.modelProvider]);
}

export function validPermissionSettings(settings: Json): boolean {
  const policy = settings.approvalPolicy;
  return typeof settings.cwd === 'string' && !!settings.cwd && typeof object(settings.sandboxPolicy).type === 'string' &&
    (['on-request', 'never', 'untrusted'].includes(String(policy)) || !!object(policy).granular) &&
    ['user', 'auto_review', 'guardian_subagent'].includes(String(settings.approvalsReviewer));
}

export function permissionMode(settings: Json): string {
  const profile = String(object(settings.activePermissionProfile).id ?? '');
  const type = String(object(settings.sandboxPolicy).type ?? '');
  const reviewer = settings.approvalsReviewer === 'guardian_subagent' ? 'auto_review' : settings.approvalsReviewer;
  if (profile === ':read-only' || !profile && type === 'readOnly') return reviewer === 'user' && settings.approvalPolicy === 'on-request' ? 'Read Only' : 'Custom read-only';
  if ((profile === ':danger-full-access' || !profile && type === 'dangerFullAccess') && settings.approvalPolicy === 'never') return 'Full Access';
  if ((profile === ':workspace' || !profile && type === 'workspaceWrite') && settings.approvalPolicy === 'on-request') {
    if (reviewer === 'auto_review') return 'Approve for me';
    if (reviewer === 'user') return 'Ask for approval';
  }
  return 'Custom Codex settings';
}

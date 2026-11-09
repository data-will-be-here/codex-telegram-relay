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

import { isAbsolute, resolve } from 'node:path';
import { object, string, type Json } from './types.js';

/** Permanent inability to preserve the selected access policy; retry must not fence the old topic. */
export class ClearSettingsError extends Error {}

/** A durable, permission-only selection. Model and global configuration are not copied. */
export interface ClearSettingsSnapshot {
  version: 1;
  settings: Json;
  start: Json;
  fingerprint: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/u.test(path))) {
    throw new ClearSettingsError('Native permission roots are unavailable; the original session was preserved.');
  }
  return [...new Set((value as string[]).map(path => resolve(path)))].sort();
}

function approval(value: unknown): unknown {
  if (['on-request', 'never', 'untrusted'].includes(String(value))) return value;
  const granular = object(object(value).granular);
  const keys = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'];
  if (Object.keys(object(value)).length !== 1 || Object.keys(granular).length !== keys.length || keys.some(key => typeof granular[key] !== 'boolean')) {
    throw new ClearSettingsError('This native approval policy cannot be transferred safely; the original session was preserved.');
  }
  return structuredClone(value);
}

export function captureClearSettingsSnapshot(native: Json, cwd: string): ClearSettingsSnapshot {
  if (!isAbsolute(cwd) || typeof native.cwd !== 'string' || resolve(native.cwd) !== resolve(cwd)) {
    throw new ClearSettingsError('The native permission directory changed; the original session was preserved.');
  }
  const profile = object(native.activePermissionProfile);
  const id = string(profile.id);
  const sandbox = structuredClone(object(native.sandboxPolicy ?? native.sandbox));
  const allowed = new Map([[':workspace', 'workspaceWrite'], [':read-only', 'readOnly'], [':danger-full-access', 'dangerFullAccess']]);
  if (allowed.get(id) !== sandbox.type || profile.extends != null || !allowed.has(id)) {
    throw new ClearSettingsError('This custom native permission profile cannot be transferred exactly; the original session was preserved.');
  }
  if (!['user', 'auto_review'].includes(String(native.approvalsReviewer))) {
    throw new ClearSettingsError('This native approval reviewer cannot be transferred safely; the original session was preserved.');
  }
  const roots = paths(native.runtimeWorkspaceRoots);
  const policy = approval(native.approvalPolicy);
  const start: Json = { permissions: id, approvalPolicy: policy, approvalsReviewer: native.approvalsReviewer,
    runtimeWorkspaceRoots: roots };
  if (sandbox.type === 'workspaceWrite') {
    if (Object.keys(sandbox).some(key => !['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'].includes(key)) ||
        ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'].some(key => typeof sandbox[key] !== 'boolean')) {
      throw new ClearSettingsError('Native workspace permissions are incomplete; the original session was preserved.');
    }
    sandbox.writableRoots = paths(sandbox.writableRoots);
    start.config = { sandbox_workspace_write: { writable_roots: sandbox.writableRoots, network_access: sandbox.networkAccess,
      exclude_tmpdir_env_var: sandbox.excludeTmpdirEnvVar, exclude_slash_tmp: sandbox.excludeSlashTmp } };
  } else if (sandbox.type === 'readOnly') {
    if (sandbox.networkAccess !== false || Object.keys(sandbox).some(key => !['type', 'networkAccess'].includes(key))) {
      throw new ClearSettingsError('This read-only network policy cannot be transferred exactly; the original session was preserved.');
    }
  } else if (Object.keys(sandbox).some(key => key !== 'type')) {
    throw new ClearSettingsError('Native full-access permissions are not recognized; the original session was preserved.');
  }
  const settings: Json = { cwd: resolve(cwd), sandboxPolicy: sandbox, activePermissionProfile: { id, extends: null },
    approvalPolicy: policy, approvalsReviewer: native.approvalsReviewer, runtimeWorkspaceRoots: roots };
  return { version: 1, settings, start, fingerprint: canonical(settings) };
}

/** Rebuild from the saved settings so persisted request fields cannot drift independently. */
export function clearStartSettings(snapshot: ClearSettingsSnapshot, cwd: string): Json {
  if (snapshot.version !== 1) throw new ClearSettingsError('Unsupported saved permission snapshot.');
  const rebuilt = captureClearSettingsSnapshot(snapshot.settings, cwd);
  if (snapshot.fingerprint !== rebuilt.fingerprint || canonical(snapshot.start) !== canonical(rebuilt.start)) {
    throw new ClearSettingsError('The saved permission snapshot changed; the original session was preserved.');
  }
  return rebuilt.start;
}

export function equivalentClearSettings(snapshot: ClearSettingsSnapshot, settings: Json): boolean {
  clearStartSettings(snapshot, string(snapshot.settings.cwd));
  return captureClearSettingsSnapshot(settings, string(snapshot.settings.cwd)).fingerprint === snapshot.fingerprint;
}

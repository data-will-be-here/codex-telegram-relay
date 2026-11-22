import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Safe public metadata. Native paths and raw user agents stay outside this record. */
export interface RuntimeInfo {
  relayVersion: string;
  proxyVersion: string | null;
  daemonVersion: string | null;
  compatibility: 'verified' | 'unknown';
}

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?`;
const versionPattern = new RegExp(`^${VERSION}$`, 'u');
const proxyPattern = new RegExp(`^codex(?:-cli)?[ \\t]+(${VERSION})$`, 'u');
const daemonPattern = new RegExp(`^codex(?:[-_][a-z][a-z0-9_-]*)?\/(${VERSION})(?:[ \\t]|$)`, 'u');

function installedRelayVersion(): string {
  // Source uses ../package.json; compiled and published files use ../../package.json.
  for (const path of ['../package.json', '../../package.json']) {
    try {
      const value: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      if (value && typeof value === 'object' && 'name' in value && value.name === 'codex-telegram-relay' &&
          'version' in value && typeof value.version === 'string' && value.version.length <= 128 && versionPattern.test(value.version)) return value.version;
    } catch { /* Try the other supported package layout. */ }
  }
  return 'unknown';
}

export const relayVersion = installedRelayVersion();

function matchedVersion(pattern: RegExp, value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const version = pattern.exec(value)?.[1];
  return version && version.length <= 128 ? version : null;
}

export function daemonVersion(userAgent: unknown): string | null {
  return matchedVersion(daemonPattern, userAgent);
}

export function proxyVersion(output: unknown): string | null {
  return matchedVersion(proxyPattern, typeof output === 'string' ? output.trim() : output);
}

/** Version discovery is informational; it never decides native protocol compatibility. */
export async function readProxyVersion(binary: string): Promise<string | null> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/telegram.*token|bot.*token|relay.*token/iu.test(key)) delete env[key];
  return new Promise(resolve => {
    try {
      execFile(binary, ['--version'], { shell: false, windowsHide: true, timeout: 1500, maxBuffer: 4096, encoding: 'utf8', env },
        (error, stdout) => resolve(error ? null : proxyVersion(stdout)));
    } catch { resolve(null); }
  });
}

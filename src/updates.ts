import { array, object, string, type Json } from './types.js';

const REPOSITORY = 'https://github.com/data-will-be-here/codex-telegram-relay';
const RELEASES = 'https://api.github.com/repos/data-will-be-here/codex-telegram-relay/releases?per_page=20';
const CHECK_INTERVAL = 15 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
interface Release { tag: string; version: string; }
export interface UpdateCache { checkedAt: number; release: Release | null; }
export interface UpdateStore {
  updateCheck(): unknown;
  saveUpdateCheck(cache: UpdateCache): void;
  enqueueUpdateNotice(version: string, text: string, markup: Json): void;
}

function version(value: string): number[] | undefined {
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u.exec(value);
  return match ? match.slice(1).map(Number) : undefined;
}
function compare(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}
function release(value: unknown): Release | undefined {
  const candidate = object(value); const tag = string(candidate.tag); const parsed = version(tag);
  return parsed && candidate.version === parsed.join('.') ? { tag, version: parsed.join('.') } : undefined;
}
function newest(value: unknown): Release | null {
  if (!Array.isArray(value)) throw new Error('Invalid release list.');
  let latest: Release | null = null;
  for (const item of array(value).slice(0, 20).map(object)) {
    const parsed = version(string(item.tag_name));
    if (item.draft !== false || typeof item.prerelease !== 'boolean' || !Number.isFinite(Date.parse(string(item.published_at))) || !parsed) continue;
    if (!latest || compare(parsed, version(latest.tag)!) > 0) latest = { tag: string(item.tag_name), version: parsed.join('.') };
  }
  return latest;
}
async function readReleases(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Release check unavailable.');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Release response is too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Optional startup metadata only: no native writes, installation commands or arbitrary release URLs. */
export async function checkForUpdates(store: UpdateStore, installed: string, options: {
  signal?: AbortSignal; fetch?: typeof fetch; now?: () => number; log?: (message: string) => void;
} = {}): Promise<Release | undefined> {
  const current = version(installed); if (!current || options.signal?.aborted) return;
  const now = (options.now ?? Date.now)(); const saved = object(store.updateCheck());
  let latest: Release | null;
  if (typeof saved.checkedAt === 'number' && Number.isSafeInteger(saved.checkedAt) &&
      now >= saved.checkedAt && now - saved.checkedAt < CHECK_INTERVAL &&
      (saved.release === null || release(saved.release))) {
    latest = release(saved.release) ?? null;
  } else {
    latest = null;
    try {
      const timeout = AbortSignal.timeout(5000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await (options.fetch ?? fetch)(RELEASES, { signal, redirect: 'error', headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'codex-telegram-relay',
      } });
      latest = newest(await readReleases(response));
    } catch { /* Offline, rate-limited or invalid metadata never blocks normal relay operation. */ }
    if (options.signal?.aborted) return;
    store.saveUpdateCheck({ checkedAt: now, release: latest });
  }
  if (!latest || options.signal?.aborted || compare(version(latest.version)!, current) <= 0) return;
  const url = `${REPOSITORY}/releases/tag/${encodeURIComponent(latest.tag)}`;
  const installedVersion = current.join('.');
  (options.log ?? console.log)(`Relay update available: v${latest.version} (installed v${installedVersion}).\n${url}`);
  store.enqueueUpdateNotice(latest.version,
    `Codex Telegram Relay update available\nInstalled: v${installedVersion}\nAvailable: v${latest.version}\n\nOpen the release notes and follow the update instructions.`,
    { inline_keyboard: [[{ text: 'View release', url }, { text: 'How to update', url: `${REPOSITORY}#upgrade-an-existing-installation` }]] });
  return latest;
}

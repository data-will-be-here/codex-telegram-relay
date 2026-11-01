import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { object, string } from './types.js';

export interface Config {
  version: 1;
  ownerId: number;
  roots: string[];
  codexBinary: string;
  ignoredThreadIds?: string[];
}

export function dataDirectory(): string {
  return resolve(process.env.CODEX_TELEGRAM_RELAY_HOME ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'codex-telegram-relay')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'codex-telegram-relay')));
}

export function privateDirectory(path: string): void {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
    throw new Error('Relay data directory must be a real directory, not a link.');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function protectWindowsDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const identity = execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.match(/S-1-5-[0-9-]+/u)?.[0];
  if (!sid) throw new Error('Cannot identify Windows account to protect configuration.');
  execFileSync(join(system, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
}

export function privateRead(path: string, maxBytes = 64 * 1024): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid private configuration file.');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error('Private configuration must belong to the current user and have mode 0600.');
  }
  return readFileSync(path, 'utf8');
}

export function loadConfig(home: string): { config: Config; token: string } {
  const raw = object(JSON.parse(privateRead(join(home, 'config.json'))));
  if (raw.version !== 1 || !Number.isSafeInteger(raw.ownerId) || Number(raw.ownerId) <= 0 ||
      !Array.isArray(raw.roots) || raw.roots.length === 0 || !raw.roots.every(x => typeof x === 'string' && isAbsolute(x))) {
    throw new Error('Invalid configuration; run setup again.');
  }
  const config: Config = { version: 1, ownerId: Number(raw.ownerId), roots: raw.roots as string[], codexBinary: validateBinary(string(raw.codexBinary)) };
  if (raw.ignoredThreadIds !== undefined) {
    if (!Array.isArray(raw.ignoredThreadIds) || raw.ignoredThreadIds.length > 1000 || !raw.ignoredThreadIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
      throw new Error('Invalid ignored session list.');
    }
    config.ignoredThreadIds = [...new Set(raw.ignoredThreadIds as string[])];
  }
  const token = privateRead(join(home, 'bot.token'), 4096).trim();
  if (!/^\d{5,16}:[A-Za-z0-9_-]{20,200}$/u.test(token)) throw new Error('Invalid bot token file.');
  return { config, token };
}

export function saveConfig(home: string, config: Config, token?: string): void {
  privateDirectory(home);
  protectWindowsDirectory(home);
  const files = [['config.json', JSON.stringify(config, null, 2) + '\n']];
  if (token !== undefined) files.push(['bot.token', token + '\n']);
  for (const [name, value] of files) {
    const path = join(home, name!);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Refusing to write a configuration link.');
    writeFileSync(path, value!, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
}

export function allowedDirectory(cwd: string, roots: readonly string[]): boolean {
  try {
    const candidate = realpathSync(cwd);
    return roots.some(root => {
      const diff = relative(realpathSync(root), candidate);
      return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith(`..${sep}`));
    });
  } catch { return false; }
}

export function validateBinary(path: string): string {
  if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile() ||
      (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe'))) {
    throw new Error('Codex must be an absolute native executable path (.exe on Windows); batch/shell wrappers are not supported.');
  }
  return realpathSync(path);
}

export function findCodex(): string {
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    if (process.platform === 'win32') {
      for (const arch of ['x64', 'arm64']) {
        const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
        candidates.push(join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'codex', 'codex.exe'));
      }
    }
  }
  if (process.platform === 'win32') {
    candidates.push(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'packages', 'app-server-daemon', 'current', 'bin', 'codex.exe'));
  }
  for (const path of candidates) {
    try { return validateBinary(path); } catch { /* Try the next native executable. */ }
  }
  throw new Error('Native Codex executable not found. Install Codex CLI, start a normal session, then run setup with --codex-bin PATH.');
}

export function configExists(home: string): boolean {
  return existsSync(join(home, 'config.json'));
}

export function ensureParent(path: string): void { privateDirectory(dirname(path)); }

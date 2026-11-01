import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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

function packageBinaries(root: string): string[] {
  const cpu = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : '';
  const suffix = process.platform === 'win32' ? 'pc-windows-msvc' : process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'linux' ? 'unknown-linux-musl' : '';
  if (!cpu || !suffix) return [];
  const triple = `${cpu}-${suffix}`;
  const roots = [join(root, 'vendor')];
  try {
    const manifest = createRequire(join(root, 'package.json')).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    roots.unshift(join(dirname(manifest), 'vendor'));
  } catch { /* Older Codex packages bundled vendor files directly. */ }
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  return roots.flatMap(vendor => [join(vendor, triple, 'bin', binary), join(vendor, triple, 'codex', binary)]);
}

function nativeBinary(path: string): string {
  const target = realpathSync(path);
  if (!statSync(target).isFile() || (process.platform === 'win32' && !target.toLowerCase().endsWith('.exe'))) throw new Error('Not a native executable.');
  if (process.platform !== 'win32') accessSync(target, constants.X_OK);
  const descriptor = openSync(target, 'r'); const header = Buffer.alloc(4);
  try { if (readSync(descriptor, header, 0, 4, 0) !== 4) throw new Error('Missing native executable header.'); }
  finally { closeSync(descriptor); }
  const magic = header.toString('hex');
  const valid = process.platform === 'win32' ? magic.startsWith('4d5a') : process.platform === 'darwin'
    ? ['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)
    : magic === '7f454c46';
  if (!valid) throw new Error('A native executable is required; script wrappers are not supported.');
  return target;
}

export function validateBinary(path: string): string {
  if (!isAbsolute(path) || (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe'))) throw new Error('Codex must be an absolute native executable path (.exe on Windows); batch/shell wrappers are not supported.');
  try {
    const target = realpathSync(path);
    if (process.platform !== 'win32' && basename(target) === 'codex.js' && basename(dirname(target)) === 'bin') {
      const root = dirname(dirname(target));
      if (object(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).name === '@openai/codex') {
        for (const binary of packageBinaries(root)) { try { return nativeBinary(binary); } catch { /* Try the next supported package layout. */ } }
      }
    }
    return nativeBinary(target);
  } catch { throw new Error('Cannot locate a runnable native Codex executable. Check its installation or pass --codex-bin PATH.'); }
}

export function findCodex(): string {
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    candidates.push(join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    if (process.platform === 'win32') {
      candidates.push(...packageBinaries(join(dir, 'node_modules', '@openai', 'codex')));
    }
  }
  candidates.push(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'packages', 'app-server-daemon', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
  for (const path of candidates) {
    try { return validateBinary(path); } catch { /* Try the next native executable. */ }
  }
  throw new Error('Native Codex executable not found. Install Codex CLI, start a normal session, then run setup with --codex-bin PATH.');
}

export function configExists(home: string): boolean {
  return existsSync(join(home, 'config.json'));
}

export function ensureParent(path: string): void { privateDirectory(dirname(path)); }

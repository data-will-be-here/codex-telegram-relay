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
  sessionScope?: 'all' | 'selected';
  ignoredThreadIds?: string[];
  outgoingFiles?: boolean;
  newSessions?: { enabled?: boolean; autoProjects?: boolean; projects: string[]; scratchRoot?: string };
}

/** Defaults are computed for legacy installations too; reading config never creates directories. */
export function newSessionDefaults(config: Config, home: string): NonNullable<Config['newSessions']> {
  config.newSessions ??= { enabled: true, autoProjects: true, projects: config.roots.slice(0, 100) };
  if (!config.newSessions.scratchRoot) {
    let root = join(dirname(resolve(home)), 'codex-telegram-conversations');
    for (let parent = root;;) {
      if (existsSync(join(parent, '.git'))) { root = join(homedir(), 'Codex', 'Conversations'); break; }
      const next = dirname(parent); if (next === parent) break; parent = next;
    }
    config.newSessions.scratchRoot = root;
  }
  return config.newSessions;
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
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Replace access rules, preserving audit policy. /grant:r alone replaces only our own entry.
  const script = `
$ErrorActionPreference = 'Stop'
$privateStage = 'identity'
try {
$privateSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$privateRoot = $env:CODEX_RELAY_PRIVATE_DIRECTORY
$privateStage = 'inventory'
$privateTargets = @($privateRoot)
foreach ($privateName in @('config.json','bot.token','state.sqlite','state.sqlite-wal','state.sqlite-shm','relay.lock')) {
  $privateFile = Join-Path $privateRoot $privateName
  if (Test-Path -LiteralPath $privateFile) { $privateTargets += $privateFile }
}
foreach ($privateCacheName in @('attachments','outgoing')) {
$privateCache = Join-Path $privateRoot $privateCacheName
if (Test-Path -LiteralPath $privateCache) {
  $privateCacheItem = Get-Item -LiteralPath $privateCache -Force
  if (($privateCacheItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or !$privateCacheItem.PSIsContainer) { throw 'Invalid private cache' }
  $privateTargets += $privateCache
  $privateTargets += @(Get-ChildItem -LiteralPath $privateCache -Force | Where-Object { $_.Name -match '^(?:[a-f0-9-]{36}|[a-f0-9]{64})\\.[a-z0-9]{1,10}$' } | ForEach-Object { $_.FullName })
}
}
foreach ($privateTarget in $privateTargets) {
  $privateStage = 'read'
  $privateItem = Get-Item -LiteralPath $privateTarget -Force
  if ($privateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private paths must not be links' }
  $privateAcl = Get-Acl -LiteralPath $privateTarget
  $privateStage = 'rules'
  $privateAcl.SetAccessRuleProtection($true, $false)
  foreach ($privateOldRule in @($privateAcl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { $privateAcl.RemoveAccessRuleSpecific($privateOldRule) }
  if ($privateItem.PSIsContainer) {
    $privateRule = New-Object System.Security.AccessControl.FileSystemAccessRule($privateSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  } else {
    $privateRule = New-Object System.Security.AccessControl.FileSystemAccessRule($privateSid, 'FullControl', 'Allow')
  }
  $privateStage = 'owner'
  if ($privateAcl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $privateSid) { $privateAcl.SetOwner($privateSid) }
  $privateAcl.AddAccessRule($privateRule)
  $privateStage = 'write'
  if ($privateItem.PSIsContainer) { [IO.Directory]::SetAccessControl($privateTarget, $privateAcl) }
  else { [IO.File]::SetAccessControl($privateTarget, $privateAcl) }
  $privateStage = 'verify'
  $privateActual = Get-Acl -LiteralPath $privateTarget
  $privateRules = @($privateActual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (!$privateActual.AreAccessRulesProtected -or $privateRules.Count -ne 1 -or $privateRules[0].IdentityReference -ne $privateSid -or $privateRules[0].AccessControlType -ne 'Allow' -or $privateRules[0].FileSystemRights -ne 'FullControl') { throw 'Private ACL verification failed' }
}
} catch {
  $privateFailure = $_.Exception
  if ($privateFailure.InnerException) { $privateFailure = $privateFailure.InnerException }
  [Console]::Out.WriteLine('ACL_FAILURE/' + $privateStage + '/' + $privateFailure.GetType().Name + '/' + $privateFailure.HResult)
  exit 1
}
`;
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_RELAY_PRIVATE_DIRECTORY: path };
  // npm can inherit PS7 module paths that Windows PowerShell 5.1 cannot load.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  try { execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000, env }); }
  catch (error) {
    const stdout = object(error).stdout;
    const code = Buffer.isBuffer(stdout) ? /ACL_FAILURE\/[a-z]+\/[A-Za-z][A-Za-z0-9]+\/-?\d+/u.exec(stdout.toString('utf8'))?.[0] : undefined;
    throw new Error(`Cannot protect private relay files on Windows${code ? ` (${code})` : ''}. Check directory ownership and access permissions.`);
  }
}

export function privateRead(path: string, maxBytes = 64 * 1024): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid private configuration file.');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
    throw new Error('Private configuration must belong to the current user and have mode 0600.');
  }
  return readFileSync(path, 'utf8');
}

/** Non-secret preferences: local file producers never need the bot credential. */
export function readConfig(home: string): Config {
  const raw = object(JSON.parse(privateRead(join(home, 'config.json'))));
  if (raw.sessionScope !== undefined && raw.sessionScope !== 'all' && raw.sessionScope !== 'selected') throw new Error('Invalid session scope in configuration.');
  if (raw.version !== 1 || !Number.isSafeInteger(raw.ownerId) || Number(raw.ownerId) <= 0 ||
      !Array.isArray(raw.roots) || (raw.sessionScope !== 'all' && raw.roots.length === 0) || !raw.roots.every(x => typeof x === 'string' && isAbsolute(x))) {
    throw new Error('Invalid configuration; run setup again.');
  }
  if (raw.outgoingFiles !== undefined && typeof raw.outgoingFiles !== 'boolean') throw new Error('Invalid outgoing file setting.');
  const config: Config = { version: 1, ownerId: Number(raw.ownerId), roots: raw.roots as string[], codexBinary: string(raw.codexBinary) };
  if (raw.sessionScope === 'all' || raw.sessionScope === 'selected') config.sessionScope = raw.sessionScope;
  if (raw.outgoingFiles !== undefined) config.outgoingFiles = raw.outgoingFiles;
  if (raw.newSessions !== undefined) {
    const creation = object(raw.newSessions);
    if ((creation.enabled !== undefined && typeof creation.enabled !== 'boolean') ||
        (creation.autoProjects !== undefined && typeof creation.autoProjects !== 'boolean') || !Array.isArray(creation.projects) || creation.projects.length > 100 ||
        !creation.projects.every(path => typeof path === 'string' && isAbsolute(path)) ||
        (creation.scratchRoot !== undefined && (typeof creation.scratchRoot !== 'string' || !isAbsolute(creation.scratchRoot)))) {
      throw new Error('Invalid new-session configuration.');
    }
    config.newSessions = { ...(typeof creation.enabled === 'boolean' ? { enabled: creation.enabled } : {}), projects: [...new Set(creation.projects as string[])],
      ...(typeof creation.autoProjects === 'boolean' ? { autoProjects: creation.autoProjects } : {}),
      ...(typeof creation.scratchRoot === 'string' ? { scratchRoot: creation.scratchRoot } : {}) };
  }
  if (raw.ignoredThreadIds !== undefined) {
    if (!Array.isArray(raw.ignoredThreadIds) || raw.ignoredThreadIds.length > 1000 || !raw.ignoredThreadIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
      throw new Error('Invalid ignored session list.');
    }
    config.ignoredThreadIds = [...new Set(raw.ignoredThreadIds as string[])];
  }
  newSessionDefaults(config, home);
  return config;
}

export function loadConfig(home: string, options: { codexBinary?: string; recoverBinary?: boolean } = {}): { config: Config; token: string; binaryChanged: boolean } {
  const config = readConfig(home);
  const savedBinary = config.codexBinary;
  let binary: string;
  try { binary = validateBinary(options.codexBinary ?? savedBinary); }
  catch (error) {
    // An existing but invalid executable is a configuration/security error, not permission to replace it.
    if (!options.recoverBinary || options.codexBinary || !isAbsolute(savedBinary) || existsSync(savedBinary) || (process.platform === 'win32' && !savedBinary.toLowerCase().endsWith('.exe'))) throw error;
    try { binary = findCodex(); }
    catch { throw new Error('The saved Codex executable is missing and no replacement was found. Install/start Codex, or run start --codex-bin PATH. Bot pairing and topics are preserved.'); }
  }
  config.codexBinary = binary;
  const token = privateRead(join(home, 'bot.token'), 4096).trim();
  if (!/^\d{5,16}:[A-Za-z0-9_-]{20,200}$/u.test(token)) throw new Error('Invalid bot token file.');
  return { config, token, binaryChanged: binary !== savedBinary };
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

/** Automatic mode authorizes interactive session directories, without altering native execution policy. */
export function allowedSessionDirectory(cwd: string, config: Pick<Config, 'roots' | 'sessionScope' | 'newSessions'>, ownedScratch = false): boolean {
  if (config.sessionScope !== 'all') return allowedDirectory(cwd, config.roots) ||
    ownedScratch && !!config.newSessions?.scratchRoot && allowedDirectory(cwd, [config.newSessions.scratchRoot]);
  try { return isAbsolute(cwd) && statSync(realpathSync(cwd)).isDirectory(); }
  catch { return false; }
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

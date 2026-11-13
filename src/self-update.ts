import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseRelease, type Release } from './updates.js';
import { object } from './types.js';

const SOURCE = 'https://github.com/data-will-be-here/codex-telegram-relay.git';
const PACKAGE = 'codex-telegram-relay';
export type UpdateRunner = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
export class UpdateError extends Error {
  constructor(message: string, readonly recoverable = true) { super(message); }
}

export function assertNoIncompleteUpdate(root: string): void {
  const marker = join(root, '.local', 'self-update', 'active.json');
  if (existsSync(marker)) throw new UpdateError(`An interrupted update needs recovery before startup. Review ${marker}.`, false);
}

/** No shell, interactive credentials, release-provided URLs or raw child errors. */
const runCommand: UpdateRunner = (command, args, cwd, signal) => new Promise((resolveResult, reject) => {
  let output = ''; let settled = false; let failure: Error | undefined;
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', npm_config_engine_strict: 'true' }, ...(signal ? { signal } : {}) });
  const finish = (error?: Error): void => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (error) reject(error); else resolveResult(output.trim());
  };
  const timer = setTimeout(() => { failure = new UpdateError('Update command timed out.'); child.kill(); }, 5 * 60_000);
  child.stdout.on('data', (chunk: Buffer) => {
    if (output.length + chunk.length > 1024 * 1024) { failure = new UpdateError('Update command output exceeded its limit.'); child.kill(); }
    else output += chunk.toString('utf8');
  });
  // Consume without echoing: Git/npm errors can contain local credentials or private registry URLs.
  child.stderr.resume();
  child.on('error', () => {
    failure = new UpdateError(signal?.aborted ? 'Update cancelled.' : 'Update command could not be started. Check Git, Node.js and npm.');
    if (!child.pid) finish(failure);
  });
  child.on('close', code => finish(failure ?? (code === 0 ? undefined : new UpdateError(`Update command failed (exit ${code ?? 'unknown'}).`))));
});

function inside(root: string, path: string): boolean {
  const diff = relative(root, path);
  return !diff || !isAbsolute(diff) && diff !== '..' && !diff.startsWith(`..${sep}`);
}
function realDirectory(path: string): void {
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new UpdateError('Automatic update requires regular installation and data directories.');
}
function packageVersion(root: string): string {
  const pkg = object(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  if (pkg.name !== PACKAGE || typeof pkg.version !== 'string') throw new UpdateError('This is not a supported relay installation.');
  return pkg.version;
}
function npmCommand(): { command: string; prefix: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  const candidates = [process.env.npm_execpath ?? '',
    ...[dirname(process.execPath), dirname(realpathSync(process.execPath)), ...(process.env.PATH ?? '').split(delimiter)]
      .map(path => join(path, 'node_modules', 'npm', 'bin', 'npm-cli.js'))];
  const cli = candidates.find(path => basename(path) === 'npm-cli.js' && existsSync(path) && lstatSync(path).isFile());
  if (!cli) throw new UpdateError('npm could not be found. Follow the manual upgrade instructions.');
  return { command: process.execPath, prefix: [cli] };
}

/** Checks are repeated before activation; untracked files are left for Git's collision checks. */
async function checkout(root: string, home: string, run: UpdateRunner, signal?: AbortSignal): Promise<{ head: string; branch: string }> {
  realDirectory(root); realDirectory(home); packageVersion(root);
  assertNoIncompleteUpdate(root);
  if (inside(root, home) || inside(home, root)) throw new UpdateError('Automatic update requires private relay data outside the installation directory.');
  const top = await run('git', ['rev-parse', '--show-toplevel'], root, signal);
  if (realpathSync(top) !== realpathSync(root)) throw new UpdateError('Automatic update requires a standalone Git clone of the relay.');
  const origin = await run('git', ['remote', 'get-url', 'origin'], root, signal);
  if (![SOURCE, SOURCE.slice(0, -4), 'git@github.com:data-will-be-here/codex-telegram-relay.git',
    'ssh://git@github.com/data-will-be-here/codex-telegram-relay.git'].includes(origin)) {
    throw new UpdateError('Automatic update is supported only for the official relay Git repository.');
  }
  if (await run('git', ['status', '--porcelain=v1', '--untracked-files=no'], root, signal)) {
    throw new UpdateError('Local tracked changes found. Commit or save them before updating; no files were changed.');
  }
  for (const name of ['dist', 'node_modules', '.local']) if (existsSync(join(root, name))) realDirectory(join(root, name));
  return { head: await run('git', ['rev-parse', 'HEAD'], root, signal), branch: await run('git', ['branch', '--show-current'], root, signal) };
}

export async function updateSupport(root: string, home: string, run: UpdateRunner = runCommand, signal?: AbortSignal): Promise<void> {
  await checkout(root, home, run, signal);
}

function backupState(home: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const copy = (from: string, to: string): void => {
    if (lstatSync(from).isSymbolicLink()) throw new UpdateError('Private state contains a symbolic link; use a manual backup and upgrade.');
    if (lstatSync(from).isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      for (const name of readdirSync(from)) copy(join(from, name), join(to, name));
    } else if (/\.(?:sqlite|sqlite3|db)$/u.test(from)) {
      const db = new DatabaseSync(from, { readOnly: true });
      try { db.prepare('VACUUM INTO ?').run(to); } finally { db.close(); }
    } else if (!/\.(?:sqlite|sqlite3|db)-(?:wal|shm)$/u.test(from)) cpSync(from, to, { errorOnExist: true, force: false });
  };
  for (const name of readdirSync(home)) if (name !== 'relay.lock' && name !== 'update-backups') copy(join(home, name), join(destination, name));
}

/** Prepare a release without touching the working runtime, then switch with rollback before restart. */
export async function installRelease(rootInput: string, homeInput: string, requested: Release, options: {
  signal?: AbortSignal; run?: UpdateRunner; log?: (message: string) => void; beforeActivation: () => void;
}): Promise<{ version: string; stateBackup: string; recoveryDirectory: string }> {
  const release = parseRelease(requested);
  if (!release) throw new UpdateError('Invalid release tag.');
  const root = realpathSync(rootInput); const home = realpathSync(homeInput);
  const run = options.run ?? runCommand; const log = options.log ?? console.log;
  const original = await checkout(root, home, run, options.signal);
  // Keep staged code and old generated files on the same filesystem, outside tracked content.
  await run('git', ['check-ignore', '--quiet', '.local/self-update/probe'], root, options.signal);
  mkdirSync(join(root, '.local', 'self-update'), { recursive: true, mode: 0o700 });
  realDirectory(join(root, '.local', 'self-update'));
  const work = mkdtempSync(join(root, '.local', 'self-update', 'release-'));
  const stage = join(work, 'release'); const hooks = join(work, 'empty-hooks');
  const marker = join(root, '.local', 'self-update', 'active.json');
  mkdirSync(hooks);
  const git = (args: string[], cwd = root, signal: AbortSignal | null | undefined = options.signal): Promise<string> => run('git', ['-c', `core.hooksPath=${hooks}`, ...args], cwd, signal ?? undefined);
  let phase = 'Preparing release'; let activated = false;
  const moved: { from: string; to: string }[] = [];
  const move = (from: string, to: string): void => {
    if (!inside(root, resolve(from)) || !inside(root, resolve(to))) throw new UpdateError('Invalid update path.');
    realDirectory(from); renameSync(from, to); moved.push({ from, to });
  };
  try {
    log(`Preparing relay v${release.version}...`);
    await git(['clone', '--depth', '1', '--single-branch', '--branch', release.tag, SOURCE, stage]);
    if (packageVersion(stage) !== release.version || object(JSON.parse(readFileSync(join(stage, 'package-lock.json'), 'utf8'))).version !== release.version) {
      throw new UpdateError('Release package version does not match its published tag.');
    }
    const target = await git(['rev-parse', 'HEAD'], stage);
    if (await git(['ls-files', '--', 'dist', 'node_modules', '.local'], stage)) throw new UpdateError('Release tracks generated runtime directories; use a manual upgrade.');
    phase = 'Installing dependencies and building release'; log(`${phase}...`);
    const npm = npmCommand();
    await run(npm.command, [...npm.prefix, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--include=dev'], stage, options.signal);
    await run(npm.command, [...npm.prefix, 'run', 'build'], stage, options.signal);
    const smoke = async (cwd: string, signal?: AbortSignal): Promise<void> => {
      if (!(await run(process.execPath, [join(cwd, 'dist', 'src', 'cli.js'), '--help'], cwd, signal)).includes('Codex Telegram Relay')) {
        throw new UpdateError('The new relay did not pass its startup check.');
      }
    };
    await smoke(stage, options.signal);
    phase = 'Checking release history';
    await git(['fetch', '--no-tags', SOURCE, `refs/tags/${release.tag}`]);
    if (await git(['rev-parse', 'FETCH_HEAD^{commit}']) !== target) throw new UpdateError('The release tag changed while preparing the update. Retry after reviewing the release.');
    try { await git(['merge-base', '--is-ancestor', original.head, target]); }
    catch { throw new UpdateError('This release does not include the current checkout. Local or development commits will not be replaced.'); }
    const current = await checkout(root, home, run, options.signal);
    if (current.head !== original.head || current.branch !== original.branch) throw new UpdateError('The checkout changed while preparing the update. Retry when Git work is finished.');
    options.signal?.throwIfAborted();
    phase = 'Backing up private relay data'; log(`${phase}...`);
    options.beforeActivation();
    const stateBackup = join(home, 'update-backups', basename(work));
    if (existsSync(join(home, 'update-backups'))) realDirectory(join(home, 'update-backups'));
    backupState(home, stateBackup);
    writeFileSync(join(work, 'recovery.json'), JSON.stringify({ original, target, version: release.version, stateBackup }, null, 2), { mode: 0o600 });
    options.signal?.throwIfAborted();
    phase = 'Activating release'; log(`${phase}...`);
    // From this point cancellation waits for activation or rollback, never a half-switched installation.
    writeFileSync(marker, JSON.stringify({ recoveryDirectory: work, original, target, stateBackup }, null, 2), { flag: 'wx', mode: 0o600 });
    activated = true;
    await git(['checkout', '--detach', target], root, null);
    for (const name of ['dist', 'node_modules']) {
      if (existsSync(join(root, name))) move(join(root, name), join(work, `previous-${name}`));
      move(join(stage, name), join(root, name));
    }
    await smoke(root);
    unlinkSync(marker);
    log(`Updated to v${release.version}. Private backup: ${stateBackup}`);
    return { version: release.version, stateBackup, recoveryDirectory: work };
  } catch (error) {
    if (activated) {
      try {
        for (const entry of moved.reverse()) { realDirectory(entry.to); renameSync(entry.to, entry.from); }
        const status = await run('git', ['status', '--porcelain=v1', '--untracked-files=no'], root);
        if (status) throw new Error('Concurrent tracked changes prevent rollback.');
        const branchHead = original.branch ? await git(['rev-parse', `refs/heads/${original.branch}`], root, null) : '';
        await git(['checkout', ...(original.branch && branchHead === original.head ? [original.branch] : ['--detach', original.head])], root, null);
        unlinkSync(marker);
      } catch { throw new UpdateError(`Update rollback needs attention. Do not start the relay until recovered. Recovery files: ${work}`, false); }
    }
    const detail = error instanceof UpdateError ? error.message : options.signal?.aborted ? 'Update cancelled.' : 'The current installation was kept.';
    throw new UpdateError(`${phase} failed. ${detail} Recovery files: ${work}`);
  }
}

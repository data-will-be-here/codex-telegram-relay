import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { installRelease, updateSupport, assertNoIncompleteUpdate, UpdateError, type UpdateRunner } from '../src/self-update.js';
import { askToUpdate, consoleUpdate, runUpdatedRelay } from '../src/console-update.js';
import { State } from '../src/state.js';
import { temporary } from './helpers.js';

const SOURCE = 'https://github.com/data-will-be-here/codex-telegram-relay.git';
const release = { tag: 'v0.1.22', version: '0.1.22' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, '-c', `core.hooksPath=${join(cwd, '.no-test-hooks')}`, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Updater Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Updater Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim();
}
function fixture(): {
  root: string; home: string; source: string; head: string; run: UpdateRunner; close: () => void;
} {
  const temp = temporary(); const source = join(temp.dir, 'source'); const root = join(temp.dir, 'install'); const home = join(temp.dir, 'private');
  mkdirSync(source); mkdirSync(home);
  git(source, 'init', '--initial-branch=main');
  const pkg = (version: string): void => {
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'codex-telegram-relay', version }));
    writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: 'codex-telegram-relay', version }));
    writeFileSync(join(source, 'source.txt'), version);
  };
  writeFileSync(join(source, '.gitignore'), '.local/\ndist/\nnode_modules/\n'); pkg('0.1.21');
  git(source, 'add', '-f', '.gitignore'); git(source, 'add', '.'); git(source, 'commit', '-m', 'Old release'); git(source, 'tag', 'v0.1.21');
  git(source, 'clone', source, root); const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'remote', 'set-url', 'origin', SOURCE);
  pkg('0.1.22'); git(source, 'add', '.'); git(source, 'commit', '-m', 'New release'); git(source, 'tag', release.tag);
  for (const name of ['dist', 'node_modules']) { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'old.txt'), 'old'); }
  writeFileSync(join(root, 'my-notes.md'), 'preserve untracked notes');
  writeFileSync(join(home, 'config.json'), '{"ownerId":123,"roots":["project"]}');
  writeFileSync(join(home, 'token'), 'private-fixture-token', { mode: 0o600 });
  const run: UpdateRunner = async (command, args, cwd, signal) => {
    signal?.throwIfAborted();
    if (command === 'git') return git(cwd, ...args.map(arg => arg === SOURCE ? source : arg));
    // Exercise Git and filesystem operations for real; replace only network-free dependency/build preparation.
    if (args.includes('ci')) { mkdirSync(join(cwd, 'node_modules')); writeFileSync(join(cwd, 'node_modules', 'new.txt'), 'new'); return ''; }
    if (args.includes('build')) {
      mkdirSync(join(cwd, 'dist', 'src'), { recursive: true });
      writeFileSync(join(cwd, 'dist', 'src', 'cli.js'), 'console.log("Codex Telegram Relay");'); return '';
    }
    return execFileSync(command, args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
  };
  return { root, home, source, head, run, close: temp.close };
}
const silent = (): void => {};

test('console update prompt accepts default/yes/no and reprompts without treating EOF as consent', async () => {
  for (const [text, expected] of [['\n', true], ['Y\n', true], ['yes\n', true], ['N\n', false], ['no\n', false], ['maybe\ny\n', true]] as const) {
    const input = new PassThrough(); const output = new PassThrough(); let written = '';
    output.on('data', chunk => { written += String(chunk); });
    const answer = askToUpdate(input, output, new AbortController().signal); input.end(text);
    assert.equal(await answer, expected); assert.match(written, /Update now\? \[Y\/n\]/u);
    if (text.startsWith('maybe')) assert.match(written, /Please enter Y or N/u);
  }
  const input = new PassThrough(); const answer = askToUpdate(input, new PassThrough(), new AbortController().signal);
  input.end(); assert.equal(await answer, undefined);
  const stop = new AbortController(); const pending = askToUpdate(new PassThrough(), new PassThrough(), stop.signal);
  stop.abort(); assert.equal(await pending, undefined);
});

test('release installation preserves configuration, topics, untracked files and branch history; SQLite backup includes WAL', async () => {
  const f = fixture(); let state: State | undefined;
  try {
    state = new State(f.home); const store = state;
    store.bind('session', 123, 'project', 'Project session');
    const external = new DatabaseSync(join(f.home, 'state.sqlite'));
    external.exec('PRAGMA journal_mode=WAL; CREATE TABLE update_fixture(value TEXT); INSERT INTO update_fixture VALUES(\'from-wal\')');
    const result = await installRelease(f.root, f.home, release, { run: f.run, log: silent, beforeActivation: () => {
      store.close({ retainLock: true });
      assert.ok(existsSync(join(f.home, 'relay.lock')));
      assert.throws(() => new State(f.home), /already/u);
    } });
    external.close();
    assert.equal(result.version, '0.1.22'); assert.equal(git(f.root, 'branch', '--show-current'), '');
    assert.equal(git(f.root, 'rev-parse', 'main'), f.head);
    assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), '0.1.22');
    assert.equal(readFileSync(join(f.root, 'my-notes.md'), 'utf8'), 'preserve untracked notes');
    assert.ok(existsSync(join(result.recoveryDirectory, 'previous-dist', 'old.txt')));
    assert.ok(existsSync(join(f.root, 'node_modules', 'new.txt')));
    assert.equal(readFileSync(join(f.home, 'token'), 'utf8'), readFileSync(join(result.stateBackup, 'token'), 'utf8'));
    assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), readFileSync(join(result.stateBackup, 'config.json'), 'utf8'));
    const backup = new DatabaseSync(join(result.stateBackup, 'state.sqlite'), { readOnly: true });
    assert.equal(backup.prepare('SELECT value FROM update_fixture').get()?.value, 'from-wal');
    assert.equal(backup.prepare('SELECT topicId FROM bindings WHERE threadId=?').get('session')?.topicId, 123); backup.close();
    store.close(); assert.ok(!existsSync(join(f.home, 'relay.lock')));
    const reopened = new State(f.home); assert.equal(reopened.binding('session')?.topicId, 123); reopened.close();
  } finally { state?.close(); f.close(); }
});

test('tracked modifications and foreign origins are refused before preparation without exposing origin secrets', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.root, 'source.txt'), 'local work');
    await assert.rejects(updateSupport(f.root, f.home, f.run), /Local tracked changes/u);
    assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'local work');
    git(f.root, 'restore', 'source.txt'); git(f.root, 'remote', 'set-url', 'origin', 'https://secret@example.invalid/repo.git');
    await assert.rejects(updateSupport(f.root, f.home, f.run), error => error instanceof UpdateError && !error.message.includes('secret'));
    assert.ok(!existsSync(join(f.root, '.local')));
  } finally { f.close(); }
});

test('build failure leaves original runtime untouched and never closes live state', async () => {
  const f = fixture(); let quiesced = false;
  try {
    await assert.rejects(installRelease(f.root, f.home, release, { log: silent, beforeActivation: () => { quiesced = true; },
      run: async (...args) => { if (args[1].includes('build')) throw new Error('sensitive child error'); return f.run(...args); },
    }), error => error instanceof UpdateError && !error.message.includes('sensitive'));
    assert.equal(quiesced, false); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
    assert.equal(readFileSync(join(f.root, 'dist', 'old.txt'), 'utf8'), 'old');
  } finally { f.close(); }
});

test('failed activation smoke check rolls back branch and generated runtime, retaining private backup', async () => {
  const f = fixture(); try {
    await assert.rejects(installRelease(f.root, f.home, release, { log: silent, beforeActivation: silent,
      run: async (command, args, cwd, signal) => {
        if (command === process.execPath && args.includes('--help') && cwd === f.root) throw new Error('failed new CLI');
        return f.run(command, args, cwd, signal);
      },
    }), error => error instanceof UpdateError && error.recoverable);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head); assert.equal(git(f.root, 'branch', '--show-current'), 'main');
    assert.equal(readFileSync(join(f.root, 'dist', 'old.txt'), 'utf8'), 'old');
    assert.equal(readFileSync(join(f.root, 'node_modules', 'old.txt'), 'utf8'), 'old');
    assert.ok(existsSync(join(f.home, 'update-backups')));
  } finally { f.close(); }
});

test('local commits, invalid tags and cancellation cannot activate a release', async () => {
  const f = fixture(); try {
    for (const invalid of [{ tag: '--upload-pack=bad', version: '0.1.22' }, { tag: release.tag, version: '9.9.9' }]) {
      await assert.rejects(installRelease(f.root, f.home, invalid, { run: f.run, log: silent, beforeActivation: silent }), /Invalid release/u);
    }
    writeFileSync(join(f.root, 'local-commit.txt'), 'keep'); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'Local work');
    const localHead = git(f.root, 'rev-parse', 'HEAD');
    await assert.rejects(installRelease(f.root, f.home, release, { run: f.run, log: silent, beforeActivation: silent }), /does not include the current checkout/u);
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), localHead);
    const stop = new AbortController(); stop.abort();
    await assert.rejects(installRelease(f.root, f.home, release, { run: f.run, signal: stop.signal, log: silent, beforeActivation: silent }));
    assert.equal(git(f.root, 'rev-parse', 'HEAD'), localHead);
  } finally { f.close(); }
});

test('a moving release tag is refused before closing state or switching files', async () => {
  const f = fixture(); let closed = false;
  try {
    await assert.rejects(installRelease(f.root, f.home, release, { log: silent, beforeActivation: () => { closed = true; },
      run: async (command, args, cwd, signal) => {
        if (command === 'git' && args.includes('fetch')) {
          writeFileSync(join(f.source, 'extra.txt'), 'new target'); git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'Moved tag');
          git(f.source, 'tag', '-f', release.tag);
        }
        return f.run(command, args, cwd, signal);
      },
    }), /release tag changed/u);
    assert.equal(closed, false); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
  } finally { f.close(); }
});

test('untracked and ignored target collisions stop activation and retain the original file', async () => {
  for (const ignored of [false, true]) {
    const f = fixture(); try {
      writeFileSync(join(f.source, 'collision.txt'), 'release'); git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'New file'); git(f.source, 'tag', '-f', release.tag);
      writeFileSync(join(f.root, 'collision.txt'), 'user file');
      if (ignored) writeFileSync(join(f.root, '.git', 'info', 'exclude'), 'collision.txt\n');
      await assert.rejects(installRelease(f.root, f.home, release, { run: f.run, log: silent, beforeActivation: silent }), error => error instanceof UpdateError && error.recoverable);
      assert.equal(readFileSync(join(f.root, 'collision.txt'), 'utf8'), 'user file');
      assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
      assertNoIncompleteUpdate(f.root);
    } finally { f.close(); }
  }
});

test('startup consent installs a cached newer release and releases the private lock before restart; N continues old version', async () => {
  for (const accept of [false, true]) {
    const f = fixture(); let restarted = false;
    try {
      const state = new State(f.home); state.saveUpdateCheck({ checkedAt: Date.now(), release }); state.close();
      assert.equal(await consoleUpdate(f.root, f.home, [], { run: f.run, ask: async () => accept, restart: async root => {
        assert.equal(root, f.root); assert.ok(!existsSync(join(f.home, 'relay.lock'))); restarted = true;
      } }), accept);
      assert.equal(restarted, accept); assert.ok(!existsSync(join(f.home, 'relay.lock')));
      assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), accept ? '0.1.22' : '0.1.21');
    } finally { f.close(); }
  }
});

test('aborted activation completes safely, while failed rollback blocks startup with a recovery record', async () => {
  for (const fatal of [false, true]) {
    const f = fixture(); const stop = new AbortController();
    try {
      const install = installRelease(f.root, f.home, release, { log: silent, signal: stop.signal, beforeActivation: silent,
        run: async (command, args, cwd, signal) => {
          if (command === 'git' && args.includes('checkout') && args.includes('--detach')) {
            stop.abort(); assert.equal(signal, undefined);
          }
          if (fatal && command === process.execPath && args.includes('--help') && cwd === f.root) {
            writeFileSync(join(f.root, 'source.txt'), 'concurrent work'); throw new Error('CLI failure');
          }
          return f.run(command, args, cwd, signal);
        },
      });
      if (fatal) {
        await assert.rejects(install, error => error instanceof UpdateError && !error.recoverable);
        assert.throws(() => assertNoIncompleteUpdate(f.root), /interrupted update/u);
        assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'concurrent work');
      } else { await install; assertNoIncompleteUpdate(f.root); assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), '0.1.22'); }
    } finally { f.close(); }
  }
});

test('fresh-runtime handoff forwards launch options and disables recursive startup prompts', async () => {
  const temp = temporary(); const previousExit = process.exitCode;
  try {
    mkdirSync(join(temp.dir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(temp.dir, 'dist', 'src', 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(temp.dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));`);
    await runUpdatedRelay(temp.dir, ['start', '--codex-bin', 'binary with spaces']);
    assert.equal(process.exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(temp.dir, 'args.json'), 'utf8')), ['start', '--codex-bin', 'binary with spaces', '--no-update-check']);
  } finally { process.exitCode = previousExit; temp.close(); }
});

test('the real command runner finds npm and builds/activates a local release without network or shell execution', async () => {
  const f = fixture();
  try {
    git(f.root, 'remote', 'set-url', 'origin', 'git@github.com:data-will-be-here/codex-telegram-relay.git');
    const pkg = { name: 'codex-telegram-relay', version: release.version, scripts: { build: 'node build.mjs' } };
    writeFileSync(join(f.source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(f.source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3,
      packages: { '': { name: pkg.name, version: pkg.version } } }));
    writeFileSync(join(f.source, 'build.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('dist/src',{recursive:true}); mkdirSync('node_modules',{recursive:true}); writeFileSync('dist/src/cli.js','console.log("Codex Telegram Relay");');`);
    git(f.source, 'add', '.'); git(f.source, 'commit', '-m', 'Real npm build'); git(f.source, 'tag', '-f', release.tag);
    const helper = join(f.home, 'run-update.mjs');
    const module = pathToFileURL(fileURLToPath(new URL('../src/self-update.js', import.meta.url))).href;
    writeFileSync(helper, `import {installRelease} from ${JSON.stringify(module)}; await installRelease(${JSON.stringify(f.root)},${JSON.stringify(f.home)},${JSON.stringify(release)},{beforeActivation(){},log(){}});`);
    execFileSync(process.execPath, [helper], { cwd: f.root, encoding: 'utf8', windowsHide: true, timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        // Git configuration is isolated to this child; no repository/global settings or network are changed.
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`, GIT_CONFIG_VALUE_0: SOURCE,
        GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: f.root.replaceAll('\\', '/'),
      } });
    assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), '0.1.22');
    assert.match(readFileSync(join(f.root, 'dist', 'src', 'cli.js'), 'utf8'), /Codex Telegram Relay/u);
    assertNoIncompleteUpdate(f.root);
  } finally { f.close(); }
});

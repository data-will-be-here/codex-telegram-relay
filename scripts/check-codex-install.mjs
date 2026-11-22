// Install a pinned official CLI in an isolated directory; no daemon, login or model turn.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { findCodex } from '../dist/src/config.js';

const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run check:codex-install.');
const base = realpathSync(tmpdir());
const dir = mkdtempSync(join(base, 'codex-relay-install-'));
const oldPath = process.env.PATH;
const oldCodexHome = process.env.CODEX_HOME;
try {
  let requested = process.env.CODEX_INSTALL_VERSION ?? '0.166.0';
  if (requested === 'latest') {
    const latest = spawnSync(process.execPath, [npm, 'view', '@openai/codex@latest', 'version', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(latest.status, 0, 'Cannot resolve the official stable Codex version.');
    requested = JSON.parse(latest.stdout);
  }
  assert.match(requested, /^\d+\.\d+\.\d+$/u, 'Use an exact stable version or latest.');
  const installed = spawnSync(process.execPath, [npm, 'install', '--prefix', dir, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `@openai/codex@${requested}`], {
    encoding: 'utf8', windowsHide: true, timeout: 180_000,
  });
  assert.equal(installed.status, 0, 'Official CLI installation failed: ' + installed.stderr);
  // Windows uses npm's prefix layout; Unix uses its linked executable in .bin.
  process.env.PATH = process.platform === 'win32' ? dir : join(dir, 'node_modules', '.bin');
  process.env.CODEX_HOME = join(dir, 'codex-home');
  const binary = findCodex();
  const location = relative(realpathSync(dir), binary);
  assert.ok(location && !isAbsolute(location) && location !== '..' && !location.startsWith('..' + sep), 'The check must select the isolated installation, not a machine-level Codex.');
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `codex-cli ${requested}`);
  const proxy = spawnSync(binary, ['app-server', 'proxy', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(proxy.status, 0, proxy.stderr);
  console.log(`Official Codex ${requested} native installation and proxy command checked on ${process.platform}/${process.arch}; no daemon or model started.`);
} finally {
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  const target = realpathSync(dir);
  if (dirname(target) !== base || !basename(target).startsWith('codex-relay-install-')) throw new Error('Unsafe installation cleanup path.');
  rmSync(target, { recursive: true, force: true });
}

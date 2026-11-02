import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, saveConfig, validateBinary, findCodex } from '../src/config.js';
import { temporary } from './helpers.js';
import { spawnSync } from 'node:child_process';

test('saving configuration removes pre-existing broad Windows grants from both the directory and token file', { skip: process.platform !== 'win32' }, () => {
  const temp = temporary();
  try {
    const home = join(temp.dir, 'relay'); mkdirSync(home);
    const token = join(home, 'bot.token'); writeFileSync(token, 'old synthetic value');
    for (const [path, rule] of [[home, '*S-1-1-0:(OI)(CI)R'], [token, '*S-1-5-11:R']]) {
      assert.equal(spawnSync('icacls.exe', [path!, '/grant', rule!], { windowsHide: true }).status, 0);
    }
    saveConfig(home, { version: 1, ownerId: 42, roots: [temp.dir], codexBinary: process.execPath }, String(12345) + ':' + 'synthetic'.repeat(4));
    const command = '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $paths = @($env:RELAY_ACL_TEST_PATH, (Join-Path $env:RELAY_ACL_TEST_PATH "bot.token"), (Join-Path $env:RELAY_ACL_TEST_PATH "config.json")); $bad = @($paths | ForEach-Object { (Get-Acl -LiteralPath $_).Access | Where-Object { $_.AccessControlType -eq "Allow" -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid } }); if ($bad.Count) { exit 1 }';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env: { ...process.env, RELAY_ACL_TEST_PATH: home } });
    assert.equal(result.status, 0, 'Private relay files must not retain broad explicit grants.');
    assert.equal(loadConfig(home).config.ownerId, 42);
  } finally { temp.close(); }
});

test('Windows protection ignores incompatible module paths inherited through npm from PowerShell 7', { skip: process.platform !== 'win32' }, () => {
  const f = temporary(); const previous = process.env.PSModulePath;
  try {
    const modules = join(f.dir, 'modules'); const security = join(modules, 'Microsoft.PowerShell.Security');
    mkdirSync(security, { recursive: true });
    writeFileSync(join(security, 'Microsoft.PowerShell.Security.psd1'), "@{ RootModule = 'missing-runtime.dll'; ModuleVersion = '99.0.0'; GUID = '2601270a-0448-4cbe-8f49-a063638be25c' }");
    process.env.PSModulePath = modules;
    assert.doesNotThrow(() => saveConfig(join(f.dir, 'home'), { version: 1, ownerId: 42, roots: [f.dir], codexBinary: process.execPath }, String(12345) + ':' + 'synthetic'.repeat(4)));
  } finally { if (previous === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previous; f.close(); }
});

test('local session preferences persist without changing the bot token', () => {
  const temp = temporary();
  try {
    const config = { version: 1 as const, ownerId: 42, roots: [temp.dir], codexBinary: process.execPath };
    saveConfig(temp.dir, config, String(12345) + ':' + 'synthetic'.repeat(4));
    const before = readFileSync(join(temp.dir, 'bot.token'), 'utf8');
    assert.equal(loadConfig(temp.dir).config.ignoredThreadIds, undefined);
    saveConfig(temp.dir, { ...config, ignoredThreadIds: ['thread-a'] });
    assert.deepEqual(loadConfig(temp.dir).config.ignoredThreadIds, ['thread-a']);
    assert.equal(readFileSync(join(temp.dir, 'bot.token'), 'utf8'), before);
    writeFileSync(join(temp.dir, 'config.json'), JSON.stringify({ ...config, ignoredThreadIds: [42] }));
    assert.throws(() => loadConfig(temp.dir), /Invalid ignored session/u);
  } finally { temp.close(); }
});

test('automatic session scope persists with no project allowlist and invalid scopes are rejected', () => {
  const f = temporary();
  try {
    const config = { version: 1 as const, ownerId: 42, roots: [], codexBinary: process.execPath, sessionScope: 'all' as const, ignoredThreadIds: ['ignored'] };
    saveConfig(f.dir, config, String(12345) + ':' + 'synthetic'.repeat(4));
    const loaded = loadConfig(f.dir).config;
    assert.equal(loaded.sessionScope, 'all');
    assert.deepEqual(loaded.roots, []);
    assert.deepEqual(loaded.ignoredThreadIds, ['ignored']);
    writeFileSync(join(f.dir, 'config.json'), JSON.stringify({ ...config, sessionScope: 'invalid' }));
    assert.throws(() => loadConfig(f.dir), /session scope/u);
  } finally { f.close(); }
});

test('a missing saved Codex binary is rediscovered without rewriting the token or saved config before compatibility checks', () => {
  const f = temporary(); const previousPath = process.env.PATH;
  try {
    const binary = join(f.dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(binary, Buffer.from(process.platform === 'win32' ? '4d5a0000' : process.platform === 'darwin' ? 'cffaedfe' : '7f454c46', 'hex')); chmodSync(binary, 0o755);
    const home = join(f.dir, 'home');
    saveConfig(home, { version: 1, ownerId: 42, roots: [f.dir], codexBinary: join(f.dir, 'removed', process.platform === 'win32' ? 'codex.exe' : 'codex') }, String(12345) + ':' + 'synthetic'.repeat(4));
    const before = readFileSync(join(home, 'config.json'), 'utf8'); const token = readFileSync(join(home, 'bot.token'), 'utf8');
    process.env.PATH = f.dir;
    const recovered = loadConfig(home, { recoverBinary: true });
    assert.equal(recovered.config.codexBinary, realpathSync(binary));
    assert.equal(recovered.binaryChanged, true);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
    assert.equal(readFileSync(join(home, 'bot.token'), 'utf8'), token);
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; f.close(); }
});

test('an existing invalid executable is not silently replaced, but an explicit native override preserves pairing', () => {
  const f = temporary();
  try {
    const invalid = join(f.dir, 'invalid.exe'); writeFileSync(invalid, 'not an executable');
    saveConfig(f.dir, { version: 1, ownerId: 42, roots: [f.dir], codexBinary: invalid }, String(12345) + ':' + 'synthetic'.repeat(4));
    assert.throws(() => loadConfig(f.dir, { recoverBinary: true }), /native/u);
    const recovered = loadConfig(f.dir, { codexBinary: process.execPath, recoverBinary: true });
    assert.equal(recovered.config.codexBinary, realpathSync(process.execPath));
    assert.equal(recovered.config.ownerId, 42);
    assert.equal(recovered.binaryChanged, true);
  } finally { f.close(); }
});

test('Unix native executable symlinks resolve without running a shell wrapper', { skip: process.platform === 'win32' }, () => {
  const temp = temporary();
  try {
    const link = join(temp.dir, 'codex');
    symlinkSync(process.execPath, link);
    assert.equal(validateBinary(link), realpathSync(process.execPath));
    const script = join(temp.dir, 'script');
    writeFileSync(script, '#!/bin/sh\nexit 0\n'); chmodSync(script, 0o755);
    assert.throws(() => validateBinary(script), /native/u);
  } finally { temp.close(); }
});

test('Unix npm launcher resolves the hoisted native platform package without executing JavaScript', { skip: process.platform === 'win32' }, () => {
  const temp = temporary(); const oldPath = process.env.PATH;
  try {
    const root = join(temp.dir, 'lib', 'node_modules', '@openai', 'codex');
    const launcher = join(root, 'bin', 'codex.js');
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    writeFileSync(launcher, 'throw new Error("The launcher must not execute");');
    const triple = process.platform === 'darwin'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
      : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
    const platform = join(temp.dir, 'lib', 'node_modules', '@openai', `codex-${process.platform}-${process.arch}`);
    const native = join(platform, 'vendor', triple, 'bin', 'codex');
    mkdirSync(dirname(native), { recursive: true });
    writeFileSync(join(platform, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.0.0' }));
    symlinkSync(process.execPath, native);
    const bin = join(temp.dir, 'bin'); mkdirSync(bin); symlinkSync(launcher, join(bin, 'codex'));
    process.env.PATH = bin;
    assert.equal(findCodex(), realpathSync(process.execPath));
    assert.equal(validateBinary(join(bin, 'codex')), realpathSync(process.execPath));
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; temp.close(); }
});

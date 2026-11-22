import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readConfig, saveConfig } from '../src/config.js';
import { temporary } from './helpers.js';

test('editing local preferences does not persist an unverified automatic executable or change pairing', () => {
  const f = temporary();
  try {
    const home = join(f.dir, 'relay'); const codexHome = join(f.dir, 'codex'); const project = join(f.dir, 'project');
    const bin = join(codexHome, 'packages', 'app-server-daemon', 'current', 'bin'); mkdirSync(bin, { recursive: true }); mkdirSync(project);
    const managed = join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
    writeFileSync(managed, Buffer.from(process.platform === 'win32' ? '4d5a0000' : process.platform === 'darwin' ? 'cffaedfe' : '7f454c46', 'hex')); chmodSync(managed, 0o755);
    saveConfig(home, { version: 1, ownerId: 42, roots: [f.dir], codexBinary: process.execPath, codexSelection: { mode: 'auto', source: 'path' } }, '12345:' + 'synthetic'.repeat(4));
    const token = readFileSync(join(home, 'bot.token'), 'utf8');
    for (const args of [['projects', 'add', project], ['sessions', 'scope', 'all']]) {
      execFileSync(process.execPath, [resolve('dist/src/cli.js'), ...args], { windowsHide: true, timeout: 10_000,
        env: { ...process.env, CODEX_TELEGRAM_RELAY_HOME: home, CODEX_HOME: codexHome }, stdio: 'pipe' });
      const config = readConfig(home);
      assert.equal(config.codexBinary, process.execPath);
      assert.deepEqual(config.codexSelection, { mode: 'auto', source: 'path' });
      assert.equal(config.ownerId, 42);
      assert.equal(readFileSync(join(home, 'bot.token'), 'utf8'), token);
    }
  } finally { f.close(); }
});

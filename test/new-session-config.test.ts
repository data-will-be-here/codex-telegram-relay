import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readConfig, saveConfig } from '../src/config.js';
import { temporary } from './helpers.js';

test('local creation opt-in persists projects and scratch separately; disable preserves token and roots', () => {
  const temp = temporary();
  try {
    const home = join(temp.dir, 'relay'); const project = join(temp.dir, 'project'); const scratch = join(temp.dir, 'conversations');
    mkdirSync(project); const token = '12345:' + 'synthetic'.repeat(4);
    saveConfig(home, { version: 1, ownerId: 42, roots: [project], codexBinary: process.execPath }, token);
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'new', ...args], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_TELEGRAM_RELAY_HOME: home },
    });
    assert.equal(run('enable', '--scratch-root', scratch).status, 0);
    assert.equal(run('enable', '--project', project).status, 0);
    assert.deepEqual(readConfig(home).newSessions, { enabled: true, projects: [project], scratchRoot: scratch });
    assert.equal(existsSync(scratch), true);
    assert.equal(run('disable').status, 0);
    assert.equal(readConfig(home).newSessions?.enabled, false); assert.equal(readConfig(home).newSessions?.scratchRoot, scratch); assert.deepEqual(readConfig(home).roots, [project]);
    assert.equal(readFileSync(join(home, 'bot.token'), 'utf8'), token + '\n');
  } finally { temp.close(); }
});

test('local creation settings reject private, repository and project scratch roots before creating directories', () => {
  const temp = temporary();
  try {
    const home = join(temp.dir, 'relay'); const project = join(temp.dir, 'project'); mkdirSync(project);
    saveConfig(home, { version: 1, ownerId: 42, roots: [project], codexBinary: process.execPath });
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/src/cli.js'), 'new', ...args], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_TELEGRAM_RELAY_HOME: home },
    });
    assert.equal(run('enable', '--scratch-root', join(home, 'work')).status, 1);
    assert.equal(run('enable', '--scratch-root', join(project, 'work')).status, 1);
    const repo = join(temp.dir, 'repo'); mkdirSync(repo); writeFileSync(join(repo, '.git'), 'gitdir: elsewhere');
    assert.equal(run('enable', '--scratch-root', join(repo, 'work')).status, 1);
    assert.equal(existsSync(join(home, 'work')), false); assert.equal(existsSync(join(repo, 'work')), false);
    assert.equal(readConfig(home).newSessions, undefined);
  } finally { temp.close(); }
});

test('malformed creation settings cannot be silently accepted from local configuration', () => {
  const temp = temporary();
  try {
    saveConfig(temp.dir, { version: 1, ownerId: 42, roots: [temp.dir], codexBinary: process.execPath });
    const path = join(temp.dir, 'config.json'); const base = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const newSessions of [null, { projects: ['relative'] }, { projects: [], scratchRoot: 42 }, { projects: {} }]) {
      writeFileSync(path, JSON.stringify({ ...base, newSessions }), { mode: 0o600 });
      assert.throws(() => readConfig(temp.dir), /new-session/u);
    }
  } finally { temp.close(); }
});

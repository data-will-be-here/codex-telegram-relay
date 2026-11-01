import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, saveConfig, validateBinary, findCodex } from '../src/config.js';
import { temporary } from './helpers.js';

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

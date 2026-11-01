import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig } from '../src/config.js';
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

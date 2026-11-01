import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check through npm run check:package.');
const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 0, result.stderr);
const [manifest] = JSON.parse(result.stdout);
const allowed = /^(?:LICENSE|README(?:\.ru)?\.md|SECURITY\.md|package\.json|docs\/[a-z-]+\.md|dist\/src\/[a-z-]+\.js)$/u;
for (const file of manifest.files) assert.match(file.path, allowed, 'Unexpected file in distribution: ' + file.path);
assert.ok(manifest.files.some(file => file.path === 'dist/src/cli.js'), 'CLI build missing.');
assert.ok(readFileSync('dist/src/cli.js', 'utf8').startsWith('#!/usr/bin/env node\n'), 'CLI shebang must use LF on every platform.');
console.log(`Distribution checked: ${manifest.entryCount} allowed files, ${manifest.size} bytes; no local state, secrets, tests or audit copies.`);

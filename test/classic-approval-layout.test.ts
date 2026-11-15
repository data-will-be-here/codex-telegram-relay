import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, click } from './helpers.js';
import { array, object, string, type Json } from '../src/types.js';

const buttons = (markup: unknown) => array(object(markup).inline_keyboard).flatMap(row => array(row).map(object));

test('Classic file approvals show one readable review, explicit missing reason, bounded code and on-demand complete diff', async () => {
  const f = await fixture();
  try {
    const diff = '@@ -1,200 +1,200 @@\n' + Array.from({ length: 200 }, (_, i) => `+assert.equal(quote(${i}), 'synthetic-${i}');`).join('\n');
    const params: Json = { threadId: 'thread-a', turnId: 'turn', itemId: 'file', startedAtMs: 1, reason: null, grantRoot: null,
      changes: [{ path: f.projectA + '/src/cex.ts', kind: { type: 'update', move_path: null }, diff }] };
    const original = JSON.stringify(params); f.codex.pending.add('classic-file');
    await f.bridge.request({ id: 'classic-file', method: 'item/fileChange/requestApproval', params }); await f.drain();
    const primary = f.telegram.sent();
    assert.equal(primary.length, 1, 'A code-heavy file approval should fit in a single main message');
    const part = primary[0]!; const text = string(part.text);
    assert.match(text, /File change approval/u); assert.match(text, /Not provided by Codex/u);
    assert.match(text, /src[\\/]cex\.ts/u);
    assert.doesNotMatch(text, /"threadId"|"turnId"|"itemId"|"proposedChanges"|"diff"|\\n/u);
    const entities = array(part.entities).map(object);
    assert.equal(entities.some(e => ['expandable_blockquote', 'spoiler'].includes(string(e.type))), false);
    const preview = entities.find(e => e.type === 'pre' && text.slice(Number(e.offset), Number(e.offset) + Number(e.length)).includes('assert.equal'));
    assert.ok(preview, 'Diff preview must remain formatted as code');
    assert.ok(text.slice(Number(preview.offset), Number(preview.offset) + Number(preview.length)).split('\n').length <= 6);
    await f.bridge.flushApproval();
    const controls = buttons((f.telegram.calls.filter(c => c.method === 'editMessageReplyMarkup').at(-1)?.params ?? part).reply_markup);
    const details = controls.find(b => b.text === 'Details'); assert.ok(details);
    assert.ok(controls.some(b => b.text === 'Allow once')); assert.ok(controls.some(b => b.text === 'Decline'));
    const update = click(700, string(details.callback_data)); object(object(update.callback_query).message).message_id = f.telegram.message;
    await f.bridge.update(update); await f.drain();
    const shown = f.telegram.sent().slice(1).map(p => string(p.text)).join('');
    assert.ok(shown.includes('synthetic-100')); assert.ok(shown.includes('synthetic-199'));
    assert.ok(f.telegram.sent().slice(1).every(p => !buttons(p.reply_markup).some(b => b.text === 'Allow once')));
    assert.equal(JSON.stringify(params), original); assert.deepEqual(f.codex.writes, []);
    await f.bridge.update(click(701, string(controls.find(b => b.text === 'Allow once')!.callback_data)));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'classic-file', result: { decision: 'accept' } } }]);
  } finally { f.close(); }
});

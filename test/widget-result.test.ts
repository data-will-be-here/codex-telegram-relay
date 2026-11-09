import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resultParts } from '../src/widget-result.js';
import { renderMarkdown } from '../src/format.js';
import { type WidgetCard } from '../src/widget-types.js';
import { object, string, type Json } from '../src/types.js';

const card: WidgetCard = { id: 'test', token: 'test', generation: 'test', kind: 'result', view: 'widgets',
  binding: { threadId: 'thread', topicId: 101, cwd: process.cwd(), title: 'Project', sessionName: 'Task', lastTurn: '-' },
  turnId: 'done', revision: 1, createdAt: 1000,
  snapshot: { status: 'done', startedAt: 0, finishedAt: 1000, updatedAt: 1000, plan: null, activities: [] } };

export function resultPayload(html: string): Json {
  const nodes = new Map<string, Json>();
  const node = (id: string): Json => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, clientWidth: 0 });
    return nodes.get(id)!;
  };
  const context: Json = { document: { getElementById: node, createElement: () => ({ textContent: '', style: {}, appendChild() {}, setAttribute() {} }), body: {} },
    getComputedStyle: () => ({ fontSize: '20px' }), ResizeObserver: class { observe() {} }, TelegramWidget: { onEvent() {}, ready() {} } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!, context);
  assert.equal(context.pwned, undefined);
  return object(context.D);
}

test('a complete formatted answer stays in one locally paged document when it fits the payload budget', () => {
  const source = '# Heading\n\n**Bold** and *italic*.\n\n- Item one\n- Item two\n\n```ts\nconst value = "🧪";\n```\n\n' + 'Русский абзац с полным окончанием предложения. '.repeat(60) + 'FINAL_TAIL';
  const parts = resultParts(card, source, 'a'.repeat(32)); assert.equal(parts.length, 1);
  const data = parts.map(part => resultPayload(string(part.params.html)));
  assert.equal(data.map(item => item.text).join(''), renderMarkdown(source).text);
  assert.ok(data.some(item => JSON.stringify(item.entities).includes('bold')));
  assert.ok(data.some(item => JSON.stringify(item.entities).includes('pre')));
  data.forEach((item, index) => { assert.equal(item.part, index + 1); assert.equal(item.total, parts.length); });
  assert.equal(parts.filter(part => part.params.disable_notification === false).length, 1);
  assert.equal(parts.slice(0, -1).some(part => part.params.reply_markup), false);
  assert.ok(parts.at(-1)!.params.reply_markup);
});

test('untrusted text stays data in a fixed reader and every document fits server budgets', () => {
  const source = '```html\n</script><script>globalThis.pwned=1</script>\n```\n\n' + ('"\\🧪<> & text '.repeat(100));
  const parts = resultParts(card, source, 'a'.repeat(32));
  for (const part of parts) {
    const html = string(part.params.html); const data = resultPayload(html);
    assert.ok(Buffer.byteLength(html) <= 32768); assert.ok(deflateSync(html, { level: 9 }).length <= 3800);
    assert.ok(Buffer.byteLength(string(part.params.chat_data)) <= 900);
    assert.equal(part.params.allow_queries, false); assert.equal(part.params.is_shared, false);
    assert.equal(part.params.public_data, undefined); assert.ok(!string(data.text).includes('\ufffd'));
    assert.doesNotMatch(html, /innerHTML|fetch\(|WebSocket/u);
  }
  assert.equal(parts.map(part => resultPayload(string(part.params.html)).text).join(''), renderMarkdown(source).text);
});

test('unsupported or long link targets remain readable without exceeding a document limit', () => {
  const source = `[First](http://example.com/a) and [Second](mailto:a@example.com) and [Long](https://example.com/${'x'.repeat(6000)}).`;
  const parts = resultParts(card, source, 'a'.repeat(32));
  const text = parts.map(part => resultPayload(string(part.params.html)).text).join('');
  assert.ok(text.includes('http://example.com/a')); assert.ok(text.includes('mailto:a@example.com'));
  assert.ok(text.includes('https://example.com/' + 'x'.repeat(6000)));
  parts.forEach(part => assert.ok(deflateSync(string(part.params.html), { level: 9 }).length <= 3800));
});

test('only real payload limits split an oversized answer, with no missing text or repeated completion heading', () => {
  const source = Array.from({ length: 1200 }, (_, index) => `Section ${index}: ${createHash('sha256').update(String(index)).digest('hex')} 🧪.\n`).join('');
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => resultPayload(string(part.params.html)).text).join(''), renderMarkdown(source).text);
  assert.match(string(parts[0]!.params.html), /class="badge done">✓/u);
  for (const [index, part] of parts.entries()) {
    const html = string(part.params.html);
    assert.ok(Buffer.byteLength(html) <= 32768); assert.ok(deflateSync(html, { level: 9 }).length <= 3800);
    assert.equal(html.includes('<h3 id="status">'), index === 0);
    assert.equal(part.params.disable_notification, index !== 0);
  }
});

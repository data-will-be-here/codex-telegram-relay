import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessages, renderMarkdown } from '../src/format.js';

test('nested Markdown, code and literal HTML produce only Telegram-compatible entities', () => {
  const source = '# Result\n\n**bold *italic* and `a < b && c`**\n\n```ts\nconst x = "**literal**";\n```\n\n<script>alert(1)</script>';
  const result = renderMarkdown(source);
  assert.ok(result.text.startsWith('Result\n\n'));
  assert.ok(result.text.includes('a < b && c'));
  assert.ok(result.text.includes('const x = "**literal**";'));
  assert.ok(result.text.includes('<script>alert(1)</script>'));
  assert.ok(result.entities.some(e => e.type === 'italic' && result.text.slice(e.offset, e.offset + e.length) === 'italic'));
  assert.ok(result.entities.some(e => e.type === 'pre' && e.language === 'ts'));
  for (const code of result.entities.filter(e => ['code', 'pre'].includes(e.type))) {
    assert.ok(result.entities.every(e => e === code || e.offset >= code.offset + code.length || e.offset + e.length <= code.offset));
  }
});

test('links support external URLs while local paths remain visible and unsafe schemes never become entities', () => {
  const result = renderMarkdown('[web](https://example.com/a?q=1) [file](/src/app.ts:12) [run](javascript:alert) [mail](mailto:a@example.com)');
  assert.ok(result.text.includes('file (/src/app.ts:12)'));
  assert.ok(result.text.includes('run (javascript:alert)'));
  assert.deepEqual(result.entities.map(e => e.url), ['https://example.com/a?q=1', 'mailto:a@example.com']);
});

test('long styled Unicode messages preserve content, code and link entities on every chunk', () => {
  const source = '**' + '🎁'.repeat(2200) + '**\n\n```js\n' + 'a();\n'.repeat(900) + '```\n\n[' + 'link '.repeat(800) + '](https://example.com)';
  const original = renderMarkdown(source);
  const chunks = formatMessages(source, true);
  assert.equal(chunks.map(c => c.text).join(''), original.text);
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 3500);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk.text));
    assert.ok(chunk.entities.length > 0);
    for (const e of chunk.entities) {
      assert.ok(e.offset >= 0 && e.length > 0 && e.offset + e.length <= chunk.text.length);
      if (e.type === 'text_link') assert.equal(e.url, 'https://example.com/');
      if (e.type === 'pre') assert.equal(e.language, 'js');
    }
  }
});

test('malformed Markdown and approval-like plain payloads retain their exact visible characters', () => {
  assert.equal(renderMarkdown('**unclosed [link](broken').text, '**unclosed [link](broken');
  const payload = 'command: echo **value** && echo [path](example)\n<raw> _literal_';
  assert.deepEqual(formatMessages(payload, false), [{ text: payload, entities: [] }]);
  for (const source of ['---', '[x]: https://example.com', '```\n```']) assert.ok(formatMessages(source, true).length > 0);
});

test('excessive formatting is bounded without dropping text', () => {
  const source = Array.from({ length: 300 }, (_, i) => `**x${i}**`).join(' ');
  const chunks = formatMessages(source, true);
  assert.equal(chunks.map(c => c.text).join(''), renderMarkdown(source).text);
  assert.ok(chunks.every(c => c.entities.length <= 100));
});

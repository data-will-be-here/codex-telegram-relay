import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resultDocument, resultParts } from '../src/widget-result.js';
import { renderMarkdown } from '../src/format.js';
import { type WidgetCard } from '../src/widget-types.js';
import { object, string, type Json } from '../src/types.js';

const card: WidgetCard = { id: 'test', token: 'test', generation: 'test', kind: 'result', view: 'widgets',
  binding: { threadId: 'thread', topicId: 101, cwd: process.cwd(), title: 'Project', sessionName: 'Task', lastTurn: '-' },
  turnId: 'done', revision: 1, createdAt: 1000,
  snapshot: { status: 'done', startedAt: 0, finishedAt: 1000, updatedAt: 1000, plan: null, activities: [] } };

function resultRuntime(html: string) {
  const elements: Json[] = []; const actions: { method: string; url: string }[] = [];
  const nodes = new Map<string, Json>();
  const node = (id: string): Json => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, clientWidth: 0 });
    return nodes.get(id)!;
  };
  const context: Json = { document: { getElementById: node, createElement: (tag: string) => {
    const value = { tag, textContent: '', style: {}, appendChild() {}, setAttribute() {} }; elements.push(value); return value;
  }, body: {} },
    getComputedStyle: () => ({ fontSize: '20px' }), ResizeObserver: class { observe() {} }, TelegramWidget: { onEvent() {}, ready() {},
      openLink: (url: string) => actions.push({ method: 'openLink', url }), openTelegramLink: (url: string) => actions.push({ method: 'openTelegramLink', url }) } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/u)![1]!, context);
  assert.equal(context.pwned, undefined);
  return { data: object(context.D), elements, actions };
}
export function resultPayload(html: string): Json { return resultRuntime(html).data; }

test('external and Telegram anchors use explicit SDK opening once per click, never during rendering', () => {
  const message = renderMarkdown('[API](https://core.telegram.org/bots/api#editmessagereplymarkup) [Chat](https://t.me/telegram)');
  const runtime = resultRuntime(resultDocument(card, message, 1, 1, false));
  assert.deepEqual(runtime.actions, []);
  const anchors = runtime.elements.filter(node => node.tag === 'a'); assert.equal(anchors.length, 2);
  let prevented = 0;
  for (const anchor of anchors) {
    assert.equal(typeof anchor.onclick, 'function');
    (anchor.onclick as (event: { preventDefault(): void }) => void)({ preventDefault() { prevented++; } });
  }
  assert.equal(prevented, 2);
  assert.deepEqual(runtime.actions, [{ method: 'openLink', url: 'https://core.telegram.org/bots/api#editmessagereplymarkup' },
    { method: 'openTelegramLink', url: 'https://t.me/telegram' }]);
});

test('a complete formatted answer stays in one locally paged document when it fits the payload budget', () => {
  const source = '# Heading\n\n**Bold** and *italic*.\n\n- Item one\n- Item two\n\n```ts\nconst value = "🧪";\n```\n\n' + 'Русский абзац с полным окончанием предложения. '.repeat(60) + 'FINAL_TAIL';
  const parts = resultParts({ ...card, binding: { ...card.binding, projectLabel: 'Demo' } }, source, 'a'.repeat(32)); assert.equal(parts.length, 1);
  assert.equal(parts[0]!.params.caption, 'Answer ready · Demo');
  assert.equal(resultPayload(string(parts[0]!.params.html)).status, 'Ready');
  const data = parts.map(part => resultPayload(string(part.params.html)));
  assert.equal(data.map(item => item.text).join(''), renderMarkdown(source).text);
  assert.ok(data.some(item => JSON.stringify(item.entities).includes('bold')));
  assert.ok(data.some(item => JSON.stringify(item.entities).includes('pre')));
  data.forEach((item, index) => { assert.equal(item.part, index + 1); assert.equal(item.total, parts.length); });
  assert.equal(parts.filter(part => part.params.disable_notification === false).length, 1);
  assert.equal(parts.slice(0, -1).some(part => part.params.reply_markup), false);
  assert.ok(parts.at(-1)!.params.reply_markup);
  assert.match(string(parts[0]!.params.html), /id="nav"/u);
  assert.match(string(parts[0]!.params.html), /pointerup/u);
});

test('approval layout removes only outside-code blank space and preserves native fallback text', () => {
  const command = 'printf "first\\nsecond"\n\n# intentional blank line\n \t';
  const message = renderMarkdown('**Command**\n\n```\n' + command + '\n```\n\n**Scope**\nThis operation.');
  const html = resultDocument(card, message, 1, 1, true, { kind: 'approval', title: 'Command approval' });
  const compact = resultPayload(html); const text = string(compact.text);
  const code = (compact.entities as Json[]).find(entity => entity.type === 'pre')!;
  assert.equal(text.slice(Number(code.offset), Number(code.offset) + Number(code.length)), command);
  assert.equal(text[Number(code.offset) - 1], 'd');
  assert.equal(text[Number(code.offset) + Number(code.length)], 'S');
  assert.match(string(compact.text), /# intentional blank line/u); assert.match(message.text, /Command\n\n/u);
  assert.match(html, /line-height:1\.3/u);
  const ordinary = resultPayload(resultDocument(card, message, 1, 1));
  assert.equal(ordinary.text, message.text, 'Final answers retain their original paragraph spacing');
});

test('untrusted text stays data in a fixed reader and every document fits server budgets', () => {
  const source = '```html\n</script><script>globalThis.pwned=1</script>\n```\n\n' + ('"\\🧪<> & text '.repeat(100));
  const parts = resultParts(card, source, 'a'.repeat(32));
  for (const part of parts) {
    const html = string(part.params.html); const data = resultPayload(html);
    assert.ok(Buffer.byteLength(html) <= 32768); assert.ok(deflateSync(html, { level: 9 }).length <= 4096);
    assert.ok(Buffer.byteLength(string(part.params.chat_data)) <= 900);
    assert.equal(part.params.allow_queries, false); assert.equal(part.params.is_shared, false);
    assert.equal(part.params.public_data, undefined); assert.ok(!string(data.text).includes('\ufffd'));
    assert.doesNotMatch(html, /innerHTML|fetch\(|WebSocket/u);
  }
  assert.equal(parts.map(part => resultPayload(string(part.params.html)).text).join(''), renderMarkdown(source).text);
});

test('a synthetic Russian answer retains every character and its external links', () => {
  const source = readFileSync(new URL('../../test/fixtures/widget-links-answer.md', import.meta.url), 'utf8');
  const parts = resultParts(card, source, 'a'.repeat(32));
  const data = parts.map(part => resultPayload(string(part.params.html)));
  assert.equal(data.map(part => part.text).join(''), renderMarkdown(source).text);
  assert.ok(data.some(part => JSON.stringify(part.entities).includes('https://core.telegram.org/bots/api#editmessagereplymarkup')));
  assert.ok(parts.every(part => deflateSync(string(part.params.html), { level: 9 }).length <= 4000));
});

test('unsupported or long link targets remain readable without exceeding a document limit', () => {
  const source = `[First](http://example.com/a) and [Second](mailto:a@example.com) and [Long](https://example.com/${'x'.repeat(6000)}).`;
  const parts = resultParts(card, source, 'a'.repeat(32));
  const text = parts.map(part => resultPayload(string(part.params.html)).text).join('');
  assert.ok(text.includes('http://example.com/a')); assert.ok(text.includes('mailto:a@example.com'));
  assert.ok(text.includes('https://example.com/' + 'x'.repeat(6000)));
  parts.forEach(part => assert.ok(deflateSync(string(part.params.html), { level: 9 }).length <= 4096));
});

test('a representative table-free terminal answer uses at most three complete sequential parts when the full reader exceeds its byte budget', () => {
  const source = readFileSync(new URL('../../test/fixtures/widget-terminal-exit-answer.md', import.meta.url), 'utf8');
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.ok(parts.length <= 3, `Expected at most three cards, got ${parts.length}`);
  const texts = parts.map(part => string(resultPayload(string(part.params.html)).text));
  assert.equal(texts.join(''), renderMarkdown(source).text);
  for (const text of texts.slice(0, -1)) assert.match(text.trimEnd(), /[.!?][»”"')\]]*$/u, 'Prefer a complete sentence over an arbitrary word boundary');
});

test('a mixed answer keeps native tables between unpaged text widgets', () => {
  const source = 'Before the table.\n\n| Item | Damage | Effect |\n|---|---:|---|\n| **Example A** | **220** | [Details](https://example.com/details) |\n\nAfter the table.';
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.deepEqual(parts.map(part => part.method), ['sendWidget', 'sendRichMessage', 'sendWidget']);
  assert.ok(string(resultPayload(string(parts[0]!.params.html)).text).includes('Before the table.'));
  assert.ok(string(resultPayload(string(parts[2]!.params.html)).text).includes('After the table.'));
  assert.ok(JSON.stringify(parts[1]!.params.rich_message).includes('"type":"table"'));
  assert.ok(JSON.stringify(parts[1]!.params.rich_message).includes('"type":"bold"'));
  const table = JSON.stringify(parts[1]!.params.rich_message);
  assert.ok(table.includes('Attachment 1 · Table')); assert.ok(!table.includes('Item, Damage, Effect'));
  assert.doesNotMatch(table, /» |Part \d+\/\d+/u);
  for (const part of parts.filter(part => part.method === 'sendWidget')) assert.doesNotMatch(string(part.params.html), /id="nav"|pointerup/u);
  assert.equal(parts.filter(part => part.params.disable_notification === false).length, 1);
  assert.ok(parts.at(-1)!.params.reply_markup);
});

test('table parsing preserves resolved references and does not treat fenced table syntax as a real table', () => {
  const source = '[Before][ref]\n\n| Item | Link |\n|---|---|\n| Value | [Table link][ref] |\n\n[After][ref]\n\n[ref]: https://example.com/resolved';
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.deepEqual(parts.map(part => part.method), ['sendWidget', 'sendRichMessage', 'sendWidget']);
  for (const part of parts) assert.ok(JSON.stringify(part.params).includes('https://example.com/resolved'));
  const tableOnly = resultParts(card, '| Link |\n|---|\n| [Value][ref] |\n\n[ref]: https://example.com/resolved', 'a'.repeat(32));
  assert.deepEqual(tableOnly.map(part => part.method), ['sendRichMessage'], 'reference definitions must not create a trailing widget');
  const literal = resultParts(card, '```md\n| A | B |\n|---|---|\n| 1 | 2 |\n```', 'a'.repeat(32));
  assert.ok(literal.every(part => part.method === 'sendWidget'));
  assert.ok(string(resultPayload(string(literal[0]!.params.html)).text).includes('| A | B |'));
});

test('long native tables repeat headers and preserve every row without widget records', () => {
  const source = '| Row | Value |\n|---|---|\n' + Array.from({ length: 500 }, (_, index) => `| row-${index} | **value-${index}** |`).join('\n');
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.ok(parts.length > 1); assert.ok(parts.every(part => part.method === 'sendRichMessage'));
  const rows = parts.flatMap(part => {
    const blocks = object(part.params.rich_message).blocks as Json[];
    assert.ok(Buffer.byteLength(JSON.stringify(part.params.rich_message)) <= 24000);
    return blocks.filter(block => block.type === 'table').flatMap(block => {
      const cells = block.cells as Json[][]; assert.equal(cells[0]![0]!.is_header, true); return cells.slice(1).map(row => row[0]!.text);
    });
  });
  assert.deepEqual(rows, Array.from({ length: 500 }, (_, index) => `row-${index}`));
  assert.equal(parts.filter(part => part.params.disable_notification === false).length, 1);
  assert.equal(parts.filter(part => JSON.stringify(part.params.rich_message).includes('Answer ready')).length, 1);
  parts.forEach((part, index) => {
    assert.ok(JSON.stringify(part.params.rich_message).includes(`Attachment ${index + 1} · Table`));
    assert.doesNotMatch(JSON.stringify(part.params.rich_message), /» |Part \d+\/\d+/u);
  });
});

test('wide tables become complete safe HTML attachments instead of flattened labels', () => {
  const columns = Array.from({ length: 24 }, (_, index) => `Column ${index}`);
  const source = `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.map((_, index) => index === 23 ? '`<script>bad()</script>`' : `cell-${index}`).join(' | ')} |`;
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.equal(parts.length, 1); assert.equal(parts[0]!.method, 'sendDocument');
  const html = parts[0]!.document!.html;
  assert.equal((html.match(/<th>/gu) || []).length, 24); assert.equal((html.match(/<td>/gu) || []).length, 24);
  assert.doesNotMatch(html, /<script[\s>]/iu); assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/u);
  assert.ok(string(parts[0]!.params.caption).includes('Answer ready')); assert.ok(parts[0]!.params.reply_markup);
  assert.equal(string(parts[0]!.params.caption), 'Answer ready\nAttachment 1 · Table');
  assert.doesNotMatch(string(parts[0]!.params.caption), /» |Part \d+\/\d+/u);
  assert.doesNotMatch(html, /» /u);
});

test('deep quoted tables keep native cells instead of turning back into literal Markdown', () => {
  const source = ['| A | B |', '|---|---|', '| one | **two** |'].map(line => '> > > > > ' + line).join('\n');
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.equal(parts.length, 1); assert.equal(parts[0]!.method, 'sendRichMessage');
  assert.ok(JSON.stringify(parts[0]!.params.rich_message).includes('"type":"table"'));
  assert.doesNotMatch(JSON.stringify(parts[0]!.params.rich_message), /\|---\|/u);
});

test('only real payload limits split an oversized answer, with no missing text or repeated completion heading', () => {
  const source = Array.from({ length: 1200 }, (_, index) => `Section ${index}: ${createHash('sha256').update(String(index)).digest('hex')} 🧪.\n`).join('');
  const parts = resultParts(card, source, 'a'.repeat(32));
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => resultPayload(string(part.params.html)).text).join(''), renderMarkdown(source).text);
  assert.match(string(parts[0]!.params.html), /class="badge done">✓/u);
  for (const [index, part] of parts.entries()) {
    const html = string(part.params.html);
    assert.ok(Buffer.byteLength(html) <= 32768); assert.ok(deflateSync(html, { level: 9 }).length <= 4096);
    assert.equal(html.includes('<h3 id="status">'), index === 0);
    assert.doesNotMatch(html, /id="nav"|id="page"|pointerup/u, 'overflow parts must read sequentially without nested paging');
    assert.equal(part.params.disable_notification, index !== 0);
    assert.equal(part.params.caption, index === 0 ? 'Answer ready · ' + (card.binding.projectLabel || card.binding.cwd.split(/[\\/]/u).at(-1)) : undefined);
  }
});

test("the actual three-section Russian reading test stays in one document", () => {
  const source = "**Проверка текста и оформления**\n\nЭто тестовый ответ для проверки чтения внутри одной карточки. Текст должен оставаться чётким, абзацы — отделяться друг от друга, а выделенные заголовки — помогать ориентироваться. Размер текста и цвета должны соответствовать настройкам Telegram. Внизу карточки находятся стрелки и счётчик страниц.\n\n**Проверка переключения страниц**\n\nПопробуй провести пальцем влево, а затем вправо. Карточка должна переключать страницы без новых сообщений в переписке. Тот же результат должен получаться при нажатии стрелок внизу. Вертикальное движение пальца должно прокручивать переписку. При возвращении назад текст должен оставаться прежним.\n\n**Проверка завершения ответа**\n\nЭто заключительная часть тестового ответа. Проверь, что последние предложения доступны полностью, строки не обрезаются снизу, а счётчик показывает последнюю страницу. Затем вернись к началу: перед заголовком Answer ready должна находиться зелёная галочка. Последняя строка этого ответа: **тест успешно дошёл до конца**.";
  const parts = resultParts({ ...card, binding: { ...card.binding, projectLabel: 'codex-telegram-relay' } }, source, "a".repeat(32));
  assert.equal(parts.length, 1, "the full real-world sample fits below the Telegram compressed limit with the full project name");
  assert.doesNotMatch(string(parts[0]!.params.html), /[\r\n]/u, 'Template whitespace is minified; payload newlines remain JSON-escaped');
  assert.equal(resultPayload(string(parts[0]!.params.html)).text, renderMarkdown(source).text);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { WIDGET_HTML } from '../src/widget-template.js';
import { widgetPreview } from '../src/widget-template.js';

function renderer(initial: Record<string, unknown>) {
  let now = 1_000_000;
  const nodes = new Map<string, { textContent: string; style: Record<string, string>; className: string; appendChild: () => void }>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', style: {}, className: '', appendChild() {} });
    return nodes.get(id)!;
  };
  let tick: (() => void) | undefined;
  const events = new Map<string, () => void>();
  const widget = { chatData: JSON.stringify({ v: 1, r: 2, p: 'relay', t: 'Check rendering', s: 'done', b: now - 20_000, e: now - 1000, u: now - 1000, n: null, q: '', a: [], ...initial }),
    onEvent(type: string, callback: () => void) { events.set(type, callback); }, ready() {} };
  runInNewContext(WIDGET_HTML.match(/<script>([\s\S]*?)<\/script>/u)![1]!, {
    document: { getElementById: node, createElement: node, body: { className: '' } },
    TelegramWidget: widget,
    Date: { now: () => now }, getComputedStyle: () => ({ fontSize: '20px' }),
    setInterval: (callback: () => void) => { tick = callback; },
    ResizeObserver: class { observe() {} },
  });
  return { node, advance: (ms: number) => { now += ms; tick!(); },
    update: (data: Record<string, unknown>) => { widget.chatData = JSON.stringify({ ...JSON.parse(widget.chatData), ...data }); events.get('chatDataChanged')!(); } };
}

test('a finished widget freezes its footer and duration when the client clock advances', () => {
  const { node, advance } = renderer({});
  const footer = node('updated').textContent; const elapsed = node('elapsed').textContent;
  advance(1_000_000);
  assert.equal(node('elapsed').textContent, elapsed);
  assert.equal(node('updated').textContent, footer, 'a completed card must not show an ever-growing last-update timer');
  assert.doesNotMatch(footer, /Last update|ago/u);
});

test('live updates render meaningful progress even without a plan or tool rows', () => {
  const { node, update } = renderer({ s: 'working', e: null, q: 'Checking relay delivery' });
  assert.equal(node('body').style.display, 'block'); assert.equal(node('step').textContent, 'Checking relay delivery');
  update({ r: 3, q: 'Verifying terminal state', a: [['running', 'Read file · state.ts']] });
  assert.equal(node('step').textContent, 'Verifying terminal state');
  update({ r: 4, s: 'done', e: 1_000_000, a: [['done', 'Read file · state.ts']] });
  assert.equal(node('status').textContent, 'Done'); assert.doesNotMatch(node('updated').textContent, /ago/u);
});

test('previews fit their JSON budget with explicit sentence or word truncation', () => {
  const text = 'Первое предложение полностью завершено. Следующее объяснение содержит "кавычки", пути \\ и эмодзи 🧪. '.repeat(30);
  for (const budget of [16, 64, 128, 256, 512, 700]) {
    const value = widgetPreview(text, budget);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= budget); assert.ok(value.endsWith('…'));
    assert.ok(!value.includes('\ufffd')); assert.ok(!/[\uD800-\uDBFF]…$/u.test(value));
  }
});

test('a separate result card identifies the completed answer', () => {
  const { node } = renderer({ k: 'result', q: 'The work has finished.' });
  assert.equal(node('status').textContent, 'Answer ready'); assert.equal(node('updated').textContent, 'Finished');
});

test('a complete first sentence takes precedence over a long unfinished following sentence', () => {
  assert.equal(widgetPreview('Ready. ' + 'The following sentence continues with details '.repeat(10), 128), 'Ready. …');
});

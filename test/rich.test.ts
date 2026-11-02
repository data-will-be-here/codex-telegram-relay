import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, temporary, FakeTelegram } from './helpers.js';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { array, object } from '../src/types.js';
import { Outbox, TelegramError } from '../src/telegram.js';

test('a later rich-format fallback never repeats an accepted prefix and keeps controls on the last part', async () => {
  const f = await fixture(); const accepted: string[] = []; let attempts = 0;
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendRichMessage') {
        if (++attempts === 2) throw new TelegramError("Bad Request: can't parse rich message", 400);
        accepted.push(JSON.stringify(params.rich_message));
      } else if (method === 'sendMessage') accepted.push(String(params.text));
      return call(method, params);
    };
    const rows = Array.from({ length: 160 }, (_, i) => `| unique-${i}-end | ${'Описание 🎁 '.repeat(10)} |`);
    f.state.enqueue('final/thread-a/later-reject', 101, '| Name | Description |\n| --- | --- |\n' + rows.join('\n'), { inline_keyboard: [[{ text: 'Example', callback_data: 'example' }]] });
    await f.drain();
    const text = accepted.join('\n');
    for (let i = 0; i < 160; i++) assert.equal(text.split(`unique-${i}-end`).length - 1, 1);
    const sent = f.telegram.calls.filter(c => ['sendMessage', 'sendRichMessage'].includes(c.method));
    assert.ok(sent.slice(0, -1).every(c => !c.params.reply_markup));
    assert.ok(sent.at(-1)!.params.reply_markup);
    assert.equal(f.state.uncertainCount(), 0);
  } finally { f.close(); }
});

test('a rich rate-limit rejection retries the unaccepted part without switching format', async () => {
  const f = await fixture(); let attempts = 0;
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendRichMessage' && ++attempts === 1) throw new TelegramError('Too Many Requests', 429, 0);
      return call(method, params);
    };
    f.state.enqueue('final/thread-a/rate-limit', 101, '# Report\n\nReady.');
    await f.drain();
    assert.equal(attempts, 2);
    assert.equal(f.telegram.calls.filter(c => c.method === 'sendRichMessage').length, 1);
    assert.equal(f.telegram.sent().length, 0);
    assert.equal(f.state.uncertainCount(), 0);
  } finally { f.close(); }
});

test('rich rendering leaves HTML, local links and code literal without fetching media', async () => {
  const f = await fixture();
  try {
    const code = '| literal | table |\n| --- | --- |\n| keep | code |';
    f.state.enqueue('final/thread-a/safe', 101, '# Report\n\n<img src="http://127.0.0.1/private">\n\n[local](http://localhost:5173) [file](file:///private/key) [web](https://example.com/)\n\n```text\n' + code + '\n```');
    await f.drain();
    const messages = f.telegram.calls.filter(c => c.method === 'sendRichMessage');
    assert.equal(messages.length, 1);
    const message = object(messages[0]!.params.rich_message);
    const blocks = array(message.blocks).map(object);
    assert.equal(message.skip_entity_detection, true);
    assert.ok(blocks.some(b => b.type === 'paragraph' && String(b.text).includes('<img src=')));
    assert.ok(blocks.every(b => !['photo', 'video', 'audio', 'document', 'table'].includes(String(b.type))));
    assert.equal(blocks.find(b => b.type === 'pre')?.text, code);
    const urls: unknown[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const item = object(value); if (item.type === 'url') urls.push(item.url);
        Object.values(item).forEach(visit);
      }
    };
    visit(message);
    assert.deepEqual(urls, ['https://example.com/']);
    assert.ok(JSON.stringify(message).includes('http://localhost:5173'));
    assert.ok(JSON.stringify(message).includes('file:///private/key'));
  } finally { f.close(); }
});

test('wide tables and oversized cells use complete labelled paragraphs within rich limits', async () => {
  const f = await fixture();
  try {
    const headings = Array.from({ length: 21 }, (_, i) => `column-${i}`);
    const values = Array.from({ length: 21 }, (_, i) => `value-${i}`);
    f.state.enqueue('final/thread-a/wide', 101, '| ' + headings.join(' | ') + ' |\n|' + headings.map(() => '---').join('|') + '|\n| ' + values.join(' | ') + ' |');
    await f.drain();
    const wide = f.telegram.calls.filter(c => c.method === 'sendRichMessage').flatMap(c => array(object(c.params.rich_message).blocks).map(object));
    assert.ok(wide.every(b => b.type !== 'table'));
    for (let i = 0; i < 21; i++) assert.ok(wide.some(b => b.text === `column-${i}: value-${i}`));
    f.telegram.calls.length = 0;
    const value = '🎁'.repeat(7000);
    f.state.enqueue('final/thread-a/large-cell', 101, '| Value |\n| --- |\n| ' + value + ' |');
    await f.drain();
    const calls = f.telegram.calls.filter(c => c.method === 'sendRichMessage');
    assert.ok(calls.length > 1);
    const text = calls.flatMap(c => array(object(c.params.rich_message).blocks).map(object)).filter(b => typeof b.text === 'string').map(b => b.text).join('');
    assert.equal(text, 'Value: ' + value);
    assert.ok(calls.every(c => Buffer.byteLength(JSON.stringify(c.params.rich_message)) <= 24000));
  } finally { f.close(); }
});

test('unknown or unrelated send failures never trigger a different delivery method or replay', async () => {
  for (const [status, description] of [[0, 'Connection lost'], [500, 'Internal server error'], [403, 'Forbidden'], [400, 'Bad Request: chat not found']] as const) {
    const f = await fixture();
    try {
      f.telegram.call = async (method, params = {}) => { f.telegram.calls.push({ method, params }); throw new TelegramError(description, status); };
      f.state.enqueue('final/thread-a/uncertain', 101, '# Report\n\nDo not duplicate this answer.');
      await assert.rejects(f.drain());
      await f.drain();
      assert.equal(f.telegram.calls.filter(c => c.method === 'sendRichMessage').length, 1);
      assert.equal(f.telegram.sent().length, 0);
      assert.equal(f.state.uncertainCount(), 1);
    } finally { f.close(); }
  }
});

test('short replies and approval controls keep the ordinary message path', async () => {
  const f = await fixture();
  try {
    f.state.enqueue('assistant/thread-a/short', 101, '**Starting** work.');
    f.codex.pending.add('approval');
    await f.bridge.request({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command: 'echo # ordinary approval' } });
    await f.drain();
    assert.equal(f.telegram.calls.filter(c => c.method === 'sendRichMessage').length, 0);
    assert.equal(f.telegram.sent().length, 2);
    assert.ok(f.telegram.sent().at(-1)!.reply_markup);
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('topic recovery and a relay restart send only unaccepted rich parts', async () => {
  const temp = temporary(); const home = join(temp.dir, 'state'); let state = new State(home);
  const telegram = new FakeTelegram(); const accepted: unknown[] = []; let attempt = 0;
  try {
    state.bind('thread-a', 101, temp.dir, 'Project');
    const call = telegram.call.bind(telegram);
    telegram.call = async (method, params = {}) => {
      if (method === 'sendRichMessage') {
        if (++attempt === 2) throw new TelegramError('Bad Request: message thread not found', 400);
        const tables = array(object(params.rich_message).blocks).map(object).filter(b => b.type === 'table');
        accepted.push(...tables.flatMap(t => array(t.cells).slice(1).map(row => object(array(row)[0]).text)));
      }
      return call(method, params);
    };
    const rows = Array.from({ length: 160 }, (_, i) => `| item-${i} | ${'Описание 🎁 '.repeat(10)} |`);
    state.enqueue('final/thread-a/recovery', 101, '| Name | Description |\n| --- | --- |\n' + rows.join('\n'));
    await new Outbox(state, telegram, 42, 0).flushOne();
    assert.ok(state.topicOperation('thread-a'));
    state.close(); state = new State(home);
    state.installTopic('thread-a', 103, temp.dir, 'Project');
    const outbox = new Outbox(state, telegram, 42, 0);
    while (await outbox.flushOne()) { /* Only remaining parts should be delivered. */ }
    assert.deepEqual(accepted, Array.from({ length: 160 }, (_, i) => `item-${i}`));
  } finally { state.close(); temp.close(); }
});

test('a definite rich-format rejection falls back to readable row cards without raw table markup', async () => {
  const f = await fixture();
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendRichMessage') { f.telegram.calls.push({ method, params }); throw new TelegramError("Bad Request: can't parse rich message", 400); }
      return call(method, params);
    };
    f.state.enqueue('final/thread-a/fallback', 101, '| Name | Problem |\n| --- | --- |\n| HP | No current health |');
    await f.drain();
    const text = f.telegram.sent().map(s => s.text).join('\n');
    assert.ok(text.includes('Name: HP\nProblem: No current health'));
    assert.ok(!text.includes('| --- |'));
    assert.equal(f.state.uncertainCount(), 0);
  } finally { f.close(); }
});

test('long tables split into bounded native tables with repeated headers and every row preserved', async () => {
  const f = await fixture();
  try {
    const source = '| Name | Description |\n| --- | --- |\n' + Array.from({ length: 160 }, (_, i) => `| item-${i} | ${'Описание 🎁 '.repeat(10)} |`).join('\n');
    f.state.enqueue('final/thread-a/long-table', 101, source);
    await f.drain();
    const calls = f.telegram.calls.filter(c => c.method === 'sendRichMessage');
    assert.ok(calls.length > 1, 'Long tables must split at row boundaries.');
    const names: unknown[] = [];
    for (const call of calls) {
      assert.ok(Buffer.byteLength(JSON.stringify(call.params.rich_message)) <= 24000);
      const tables = array(object(call.params.rich_message).blocks).map(object).filter(b => b.type === 'table');
      for (const table of tables) {
        const rows = array(table.cells).map(row => array(row).map(object));
        assert.deepEqual(rows[0]!.map(c => c.text), ['Name', 'Description']);
        assert.ok(rows[0]!.every(c => c.is_header === true));
        names.push(...rows.slice(1).map(row => row[0]!.text));
      }
    }
    assert.deepEqual(names, Array.from({ length: 160 }, (_, i) => `item-${i}`));
  } finally { f.close(); }
});

test('assistant tables arrive as native rich tables in their saved topic with a project signature', async () => {
  const f = await fixture();
  try {
    f.state.enqueue('final/thread-a/table', 101, '# Suggestions\n\nBefore the table.\n\n| Upgrade | Problem | Proposal |\n| --- | ---: | :---: |\n| **HP** | No current health | Add current health too |\n| Heal | Full health | Show actual recovery |\n\nAfter the table.');
    await f.drain();
    const call = f.telegram.calls.find(c => c.method === 'sendRichMessage');
    assert.ok(call, 'Structured answers must use the native rich-message API.');
    assert.equal(call.params.chat_id, 42);
    assert.equal(call.params.message_thread_id, 101);
    const message = object(call.params.rich_message);
    assert.equal(message.skip_entity_detection, true);
    const blocks = array(message.blocks).map(object);
    assert.deepEqual(blocks[0], { type: 'paragraph', text: { type: 'italic', text: '» project-a' } });
    assert.ok(blocks.some(b => b.type === 'heading' && b.text === 'Suggestions'));
    assert.ok(blocks.some(b => b.text === 'Before the table.'));
    assert.ok(blocks.some(b => b.text === 'After the table.'));
    const table = blocks.find(b => b.type === 'table')!;
    assert.ok(table);
    const rows = array(table.cells).map(row => array(row).map(object));
    assert.deepEqual(rows.map(row => row.map(cell => cell.text)), [
      ['Upgrade', 'Problem', 'Proposal'], [{ type: 'bold', text: 'HP' }, 'No current health', 'Add current health too'], ['Heal', 'Full health', 'Show actual recovery'],
    ]);
    assert.ok(rows[0]!.every(cell => cell.is_header === true));
    assert.equal(rows[1]![1]!.align, 'right');
    assert.equal(rows[1]![2]!.align, 'center');
    assert.equal(table.is_compact, true);
    assert.equal(f.telegram.sent().length, 0);
  } finally { f.close(); }
});

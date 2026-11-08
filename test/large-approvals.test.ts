import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, click, approvalBody, temporary, FakeCodex, FakeTelegram } from './helpers.js';
import { array, object, string, type RpcRequest } from '../src/types.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { State } from '../src/state.js';
import { Bridge } from '../src/bridge.js';
import { Outbox, TelegramError } from '../src/telegram.js';

async function persistentReview() {
  const temp = temporary(); const project = join(temp.dir, 'project'); mkdirSync(project);
  const config = { version: 1 as const, ownerId: 42, roots: [project], codexBinary: process.execPath };
  const codex = new FakeCodex(); const telegram = new FakeTelegram();
  codex.sessions = [{ id: 'thread-a', cwd: project, name: 'Task', status: 'idle' }];
  codex.pending.add('large-request');
  let state = new State(join(temp.dir, 'state'));
  let bridge = new Bridge(config, state, codex, telegram);
  await bridge.discover();
  const command = 'echo synthetic 😀 literal-content';
  const request: RpcRequest = { id: 'large-request', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thread-a', turnId: 'large-turn', itemId: 'command', command,
    reason: 'Synthetic context for a complete review. '.repeat(1700), availableDecisions: ['accept', 'decline'],
  } };
  const tick = async () => new Outbox(state, telegram, config, 0).flushOne();
  return { telegram, codex, request, command, tick,
    get bridge() { return bridge; },
    get state() { return state; },
    parts: () => telegram.sent().filter(part => string(part.text).includes('🔐 Апрув ')),
    restart: async () => { state.close(); state = new State(join(temp.dir, 'state')); bridge = new Bridge(config, state, codex, telegram); await bridge.discover(); },
    drain: async () => { while (await tick() || await bridge.flushApproval()) {} },
    close: () => { state.close(); temp.close(); },
  };
}

test('a long approval uses collapsed numbered review blocks and receives controls only after complete delivery', async () => {
  const f = await fixture();
  try {
    const command = 'node -e "/* synthetic 😀 α <b> [text] `code` */"';
    const reason = 'Complete synthetic context 😀 α <b> [text] `code`. '.repeat(1800);
    f.codex.pending.add('large-command');
    await f.bridge.request({ id: 'large-command', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', turnId: 'large-turn', itemId: 'command', command, reason, availableDecisions: ['accept', 'decline'],
    } });
    await f.drain();
    const parts = f.telegram.sent();
    assert.ok(parts.length > 1, 'The complete approval must be delivered instead of a terminal-only notice');
    let details = '';
    for (const [index, part] of parts.entries()) {
      const text = string(part.text);
      assert.ok(text.length <= 4096);
      assert.equal(/\p{Surrogate}/u.test(text), false, 'A part must never split a Unicode surrogate pair');
      assert.ok(text.includes(`${index + 1}/${parts.length}`));
      assert.equal(part.reply_markup, undefined);
      const entities = array(part.entities).map(object);
      assert.equal(entities.some(entity => entity.type === 'code' || entity.type === 'pre' || entity.type === 'text_link'), false);
      assert.equal(entities.some(entity => entity.type === 'spoiler'), false, 'Noise masking does not collapse a tall approval');
      const review = entities.find(entity => entity.type === 'expandable_blockquote');
      assert.ok(review, 'Review text must use Telegram\'s collapsed-by-default quotation');
      details += text.slice(Number(review.offset), Number(review.offset) + Number(review.length));
    }
    assert.ok(details.includes(command), 'Every command character, including Unicode and markup literals, must survive');
    assert.ok(details.includes(reason), 'Unquoted review context must not be dropped');
    assert.doesNotMatch(details, /Message shortened/u);
    assert.equal(f.telegram.calls.some(call => call.method === 'editMessageReplyMarkup'), false);
    await f.bridge.flushApproval();
    const edit = f.telegram.calls.find(call => call.method === 'editMessageReplyMarkup')!;
    assert.ok(edit);
    assert.equal(edit.params.message_id, 1000 + parts.length);
    const data = string(object(array(array(object(edit.params.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.update(click(401, data));
    await f.bridge.update(click(402, data));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'large-command', result: { decision: 'accept' } } }]);
  } finally { f.close(); }
});

for (const kind of ['file', 'permissions'] as const) test(`large ${kind} proposals remain complete and retain their native decision payload`, async () => {
  const f = await fixture();
  try {
    const diff = '+synthetic 😀 quoted file content\n'.repeat(1800);
    const permissions = { fileSystem: { write: Array.from({ length: 2000 }, (_, index) => `/synthetic/path-${index}`) } };
    const params = kind === 'file'
      ? { threadId: 'thread-a', turnId: 'large-turn', itemId: 'file', changes: [{ path: 'synthetic.txt', diff }] }
      : { threadId: 'thread-a', turnId: 'large-turn', permissions };
    f.codex.pending.add(kind);
    await f.bridge.request({ id: kind, method: kind === 'file' ? 'item/fileChange/requestApproval' : 'item/permissions/requestApproval', params });
    await f.drain(); await f.bridge.flushApproval();
    const body = f.telegram.sent().map(approvalBody).join('');
    const proposal = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    if (kind === 'file') assert.equal(proposal.proposedChanges[0].diff, diff);
    else assert.deepEqual(proposal.permissions, permissions);
    assert.doesNotMatch(body, /Message shortened|Цитата сокращена/u);
    const edit = f.telegram.calls.find(call => call.method === 'editMessageReplyMarkup')!;
    const data = string(object(array(array(object(edit.params.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.update(click(410, data));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: kind,
      result: kind === 'file' ? { decision: 'accept' } : { permissions, scope: 'turn' } } }]);
  } finally { f.close(); }
});

test('a malformed success receipt for a later part cannot borrow an earlier message ID or enable controls', async () => {
  const f = await persistentReview();
  try {
    const call = f.telegram.call.bind(f.telegram); let sends = 0;
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      return method === 'sendMessage' && ++sends === 2 ? {} : result;
    };
    await f.bridge.request(f.request); await f.tick();
    await assert.rejects(f.tick(), /receipt was not confirmed/u);
    const parts = f.parts().length;
    await f.restart(); await f.bridge.request(f.request); await f.drain();
    assert.equal(f.parts().length, parts);
    assert.equal(f.telegram.calls.some(call => call.method === 'editMessageReplyMarkup'), false);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('confirmed approval parts survive a database reopen and replay refreshes only the final controls', async () => {
  const f = await persistentReview();
  try {
    await f.bridge.request(f.request); await f.tick();
    const first = string(f.parts()[0]!.text);
    assert.equal(f.parts().length, 1);
    await f.restart(); await f.drain();
    assert.equal(f.parts().length, 1, 'A resumed process waits for the native request');
    await f.bridge.request(f.request); await f.drain();
    assert.ok(f.parts().map(approvalBody).join('').includes(f.command));
    assert.equal(f.parts().filter(part => part.text === first).length, 1);
    const count = f.parts().length;
    await f.restart(); await f.bridge.request(f.request); await f.drain();
    assert.equal(f.parts().length, count);
    assert.ok(f.telegram.calls.filter(call => call.method === 'editMessageReplyMarkup').every(call => call.params.message_id === 1000 + count));
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('resuming an older spoiler plan collapses only its remaining parts without replaying receipts', async () => {
  const f = await persistentReview();
  try {
    await f.bridge.request(f.request); await f.tick();
    const first = string(f.parts()[0]!.text);
    const delivery = f.state.next()!;
    for (const part of delivery.richPlan!) for (const entity of array(part.params.entities).map(object)) {
      if (entity.type === 'expandable_blockquote') entity.type = 'spoiler';
    }
    // Store the old-version plan at a confirmed checkpoint, then reopen like an upgrade.
    f.state.sending(delivery.id); f.state.saveRichPlan(delivery.id, delivery.richPlan!);
    f.state.pauseApprovalPart(delivery.id, delivery.nextPart, 0);
    await f.restart(); await f.bridge.request(f.request); await f.drain();
    assert.equal(f.parts().filter(part => part.text === first).length, 1);
    for (const part of f.parts().slice(1)) {
      const entities = array(part.entities).map(object);
      assert.equal(entities.some(entity => entity.type === 'spoiler'), false);
      assert.ok(entities.some(entity => entity.type === 'expandable_blockquote'));
    }
    assert.ok(f.parts().map(approvalBody).join('').includes(f.command));
    assert.equal(f.telegram.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 1);
  } finally { f.close(); }
});

test('an unknown acknowledgement part is not replayed or given approval controls after restart', async () => {
  const f = await persistentReview();
  try {
    const call = f.telegram.call.bind(f.telegram); let sends = 0;
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'sendMessage' && ++sends === 2) throw new TelegramError('Synthetic lost part acknowledgement', 0);
      return result;
    };
    await f.bridge.request(f.request); await f.tick();
    await assert.rejects(f.tick(), /lost part acknowledgement/u);
    const parts = f.parts().length;
    await f.restart(); await f.bridge.request(f.request); await f.drain();
    assert.equal(f.parts().length, parts);
    assert.equal(f.telegram.calls.some(call => call.method === 'editMessageReplyMarkup'), false);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a receipt arriving after prompt retirement checkpoints the held part before native replay', async () => {
  const f = await fixture();
  try {
    const command = 'echo synthetic';
    const request: RpcRequest = { id: 'retired', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', command, reason: 'Synthetic review context. '.repeat(400),
    } };
    f.codex.pending.add(request.id);
    await f.bridge.request(request);
    const key = f.state.next()!.key;
    const call = f.telegram.call.bind(f.telegram); let retired = false;
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'sendMessage' && !retired) { retired = true; f.state.cancelPrompt(key); }
      return result;
    };
    await f.drain();
    assert.equal(f.state.approvalReceipt(key)?.status, 'held');
    assert.equal(f.state.approvalReceipt(key)?.messageId, 1001, 'A successful in-flight receipt must survive retirement');
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await bridge.discover(); await bridge.request(request); await f.drain(); await bridge.flushApproval();
    const parts = f.telegram.sent();
    assert.equal(parts.filter(part => part.text === parts[0]!.text).length, 1);
    assert.ok(parts.map(approvalBody).join('').includes(command));
    assert.equal(f.telegram.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 1);
  } finally { f.close(); }
});

test('resolution after the final checkpoint cannot be overwritten by delivery finalization', async t => {
  const f = await fixture();
  try {
    f.codex.pending.add('final-race');
    await f.bridge.request({ id: 'final-race', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', command: 'echo synthetic', reason: 'Synthetic review context. '.repeat(400),
    } });
    const key = f.state.next()!.key;
    const accept = f.state.acceptApprovalPart.bind(f.state);
    t.mock.method(f.state, 'acceptApprovalPart', (id: number, index: number, messageId: number) => {
      const accepted = accept(id, index, messageId);
      const delivery = f.state.next();
      if (delivery?.nextPart === delivery?.richPlan?.length) {
        f.codex.pending.delete('final-race'); f.state.resolveApproval('thread-a', 'final-race');
      }
      return accepted;
    });
    await f.drain(); await f.bridge.flushApproval();
    assert.equal(f.state.approvalReceipt(key)?.status, 'cancelled');
    assert.equal(f.telegram.calls.some(call => call.method === 'editMessageReplyMarkup'), false);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('native resolution during a part send stops the remaining review and its controls', async () => {
  const f = await persistentReview();
  try {
    const call = f.telegram.call.bind(f.telegram);
    f.telegram.call = async (method, params = {}) => {
      const result = await call(method, params);
      if (method === 'sendMessage') {
        f.codex.pending.delete(f.request.id);
        await f.bridge.notification('serverRequest/resolved', { threadId: 'thread-a', requestId: f.request.id });
      }
      return result;
    };
    await f.bridge.request(f.request); await f.drain();
    assert.equal(f.parts().length, 1);
    assert.equal(f.telegram.calls.some(call => call.method === 'editMessageReplyMarkup'), false);
    assert.deepEqual(f.codex.writes, []);
  } finally { f.close(); }
});

test('a definite collapsed-block rejection falls back for only that part without changing numbering or content', async () => {
  const f = await persistentReview();
  try {
    const call = f.telegram.call.bind(f.telegram); let rejected = false;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendMessage' && f.parts().length === 1 && params.entities && !rejected) {
        rejected = true; throw new TelegramError("Bad Request: can't parse entities", 400);
      }
      return call(method, params);
    };
    await f.bridge.request(f.request); await f.drain();
    assert.equal(rejected, true);
    assert.ok(f.parts().map(approvalBody).join('').includes(f.command));
    for (const [index, part] of f.parts().entries()) assert.ok(string(part.text).includes(`${index + 1}/${f.parts().length}`));
    assert.equal(f.parts()[1]!.entities, undefined);
    assert.equal(f.telegram.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 1);
  } finally { f.close(); }
});

test('a rate-limit pause survives restart and retries only the still-unaccepted part', async t => {
  const f = await persistentReview();
  try {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const call = f.telegram.call.bind(f.telegram); let limited = false;
    f.telegram.call = async (method, params = {}) => {
      if (method === 'sendMessage' && f.parts().length === 1 && !limited) {
        limited = true; throw new TelegramError('Synthetic flood control', 429, 2);
      }
      return call(method, params);
    };
    await f.bridge.request(f.request); await f.tick(); await f.tick();
    assert.equal(f.parts().length, 1, 'A rate limit must be persisted before another send attempt');
    await f.restart(); await f.bridge.request(f.request);
    assert.equal(await f.tick(), false);
    now += 2001;
    await f.drain();
    assert.ok(f.parts().map(approvalBody).join('').includes(f.command));
    assert.equal(f.telegram.calls.filter(call => call.method === 'editMessageReplyMarkup').length, 1);
  } finally { f.close(); }
});

test('only explicit auxiliary source quotes are shortened, while short commands with large parsed metadata stay usable', async () => {
  const f = await fixture();
  try {
    const reason = 'Quoted source:\n```ts\n' + Array.from({ length: 400 }, (_, index) => `source line ${index}`).join('\n') + '\n```\nReason after the quote.';
    const params = { threadId: 'thread-a', command: 'echo short', reason,
      commandActions: [{ type: 'unknown', command: 'echo short', details: 'metadata'.repeat(5000) }] };
    const before = JSON.stringify(params);
    f.codex.pending.add('quote');
    await f.bridge.request({ id: 'quote', method: 'item/commandExecution/requestApproval', params }); await f.drain();
    const text = f.telegram.sent().map(approvalBody).join('');
    assert.match(text, /Код сокращён: пропущено/u);
    assert.match(text, /source line 0/u); assert.match(text, /source line 399/u);
    assert.doesNotMatch(text, /source line 200\n/u);
    assert.match(text, /Reason after the quote/u); assert.match(text, /echo short/u);
    assert.equal(JSON.stringify(params), before, 'Presentation must not mutate native request identity or parameters');
    assert.equal(f.telegram.sent().length, 1);
    const part = f.telegram.sent()[0]!;
    const entities = array(part.entities).map(object);
    assert.equal(entities.some(entity => entity.type === 'expandable_blockquote' || entity.type === 'spoiler'), false);
    const code = entities.find(entity => entity.type === 'pre' && string(part.text).slice(Number(entity.offset), Number(entity.offset) + Number(entity.length)).includes('source line 0'));
    assert.ok(code, 'Quoted source is rendered as code rather than literal Markdown fences or a quotation');
    assert.ok(string(part.text).slice(Number(code.offset), Number(code.offset) + Number(code.length)).split('\n').length <= 6);
    assert.ok(f.telegram.sent()[0]!.reply_markup, 'A short review keeps its existing command card and controls');
  } finally { f.close(); }
});

test('inline command code and its execution-policy copy use labelled previews without changing the approved request', async () => {
  const f = await fixture();
  try {
    const script = Array.from({ length: 400 }, (_, index) => `console.log('synthetic line ${index} 😀');`).join('\n');
    const params = { threadId: 'thread-a', command: `node -e "${script}"`, proposedExecpolicyAmendment: ['node', '-e', script] };
    const original = JSON.stringify(params);
    f.codex.pending.add('code-preview');
    await f.bridge.request({ id: 'code-preview', method: 'item/commandExecution/requestApproval', params });
    await f.drain(); await f.bridge.flushApproval();
    assert.equal(f.telegram.sent().length, 1, 'A code-heavy approval must fit in one readable card');
    const body = f.telegram.sent().map(approvalBody).join('');
    assert.match(body, /Сокращённое превью/u);
    assert.match(body, /одобряет полную команду/u);
    assert.match(body, /Команда сокращена/u);
    assert.match(body, /Код в правиле разрешений сокращён/u);
    assert.match(body, /synthetic line 0/u); assert.match(body, /synthetic line 399/u);
    assert.doesNotMatch(body, /synthetic line 200/u);
    assert.ok(body.length < 6000, 'Command code must not be repeated in full in permission context');
    for (const part of f.telegram.sent()) {
      const entities = array(part.entities).map(object);
      assert.equal(entities.some(entity => entity.type === 'expandable_blockquote' || entity.type === 'spoiler'), false);
      const code = entities.find(entity => entity.type === 'pre' && string(part.text).slice(Number(entity.offset), Number(entity.offset) + Number(entity.length)).includes('node -e'));
      assert.ok(code, 'The preview must be a code block');
      const source = string(part.text).slice(Number(code.offset), Number(code.offset) + Number(code.length));
      assert.ok(source.split('\n').length <= 6, 'Show only a few lines of code');
      assert.ok(string(part.text).length <= 4096);
      assert.ok(string(part.text).slice(0, Number(code.offset)).includes('одобряет полную команду'));
    }
    assert.equal(JSON.stringify(params), original);
    const control = f.telegram.calls.find(call => call.method === 'editMessageReplyMarkup')?.params ?? f.telegram.sent().at(-1)!;
    const data = string(object(array(array(object(control.reply_markup).inline_keyboard)[0])[0]).callback_data);
    await f.bridge.update(click(430, data));
    assert.deepEqual(f.codex.writes, [{ method: 'respond', params: { id: 'code-preview', result: { decision: 'accept' } } }]);
  } finally { f.close(); }
});

test('Windows source excerpts use compact code blocks without changing original line endings', async () => {
  const f = await fixture();
  try {
    for (const [index, newline] of ['\r\n', '\r'].entries()) {
      const previous = f.telegram.sent().length;
      const reason = ['Source:', '```ts', ...Array.from({ length: 400 }, (_, i) => `source line ${i}`), '```', 'Reason after the source.'].join(newline);
      const params = { threadId: 'thread-a', command: 'echo synthetic', reason };
      const original = JSON.stringify(params); const id = `windows-source-${index}`; f.codex.pending.add(id);
      await f.bridge.request({ id, method: 'item/commandExecution/requestApproval', params }); await f.drain();
      const parts = f.telegram.sent().slice(previous);
      assert.equal(parts.length, 1);
      const part = parts[0]!; const entities = array(part.entities).map(object);
      const source = entities.filter(entity => entity.type === 'pre').map(entity => string(part.text).slice(Number(entity.offset), Number(entity.offset) + Number(entity.length))).find(text => text.includes('source line 0'));
      assert.ok(source); assert.ok(source.split('\n').length <= 6);
      assert.ok(source.includes('source line 399')); assert.equal(source.includes('source line 200\n'), false);
      assert.equal(source.includes('Reason after'), false);
      assert.ok(string(part.text).includes('Reason after the source.'));
      assert.equal(JSON.stringify(params), original);
    }
  } finally { f.close(); }
});

test('multiple large code examples share one compact message without reverting to split quotes', async () => {
  const f = await fixture();
  try {
    const reason = Array.from({ length: 8 }, (_, index) => `Example ${index}:\n\n\`\`\`js\n` +
      Array.from({ length: 400 }, (_, line) => `synthetic source line ${line}: ` + 'x'.repeat(90)).join('\n') + '\n```\n\n').join('');
    const params = { threadId: 'thread-a', command: 'echo synthetic', reason }; const original = JSON.stringify(params);
    f.codex.pending.add('many-code');
    await f.bridge.request({ id: 'many-code', method: 'item/commandExecution/requestApproval', params }); await f.drain();
    assert.equal(f.telegram.sent().length, 1);
    const part = f.telegram.sent()[0]!; const entities = array(part.entities).map(object);
    assert.ok(string(part.text).length <= 4096);
    assert.equal(entities.some(entity => entity.type === 'expandable_blockquote' || entity.type === 'spoiler'), false);
    assert.ok(entities.some(entity => entity.type === 'pre'));
    assert.ok(string(part.text).includes('Example 0:')); assert.ok(string(part.text).includes('Example 7:'));
    assert.match(string(part.text), /Фрагменты кода сокращены/u);
    assert.equal(JSON.stringify(params), original);
  } finally { f.close(); }
});

test('long operational arguments stay complete while single-line interpreter code uses a preview', async () => {
  const f = await fixture();
  try {
    const data = 'synthetic-payload'.repeat(400);
    const curl = `curl --data '${data}' https://example.com --max-time 30`;
    f.codex.pending.add('arguments');
    await f.bridge.request({ id: 'arguments', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-a', command: curl, proposedExecpolicyAmendment: ['curl', '--data', data],
    } });
    await f.drain();
    const body = f.telegram.sent().map(approvalBody).join('');
    assert.ok(body.includes(curl), 'Long arguments are not an inline code fragment');
    assert.ok(body.includes(data));
    assert.equal(body.includes('Сокращённое превью'), false);
    let previous = f.telegram.sent().length;
    for (const [index, command] of [
      `node script.js --data '${data} -e user-data'`, `curl --data 'line1\n${data}\nlineN' https://example.com`,
    ].entries()) {
      const id = `ordinary-${index}`; f.codex.pending.add(id);
      await f.bridge.request({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command } });
      await f.drain();
      const ordinary = f.telegram.sent().slice(previous).map(approvalBody).join('');
      assert.ok(ordinary.includes(command), 'Quoted data and script arguments are not interpreter flags');
      assert.equal(ordinary.includes('Сокращённое превью'), false);
      previous = f.telegram.sent().length;
    }
    for (const [index, command] of [
      `node --input-type=module -e '${data}'`, `python3 -c '${data}'`, `pwsh -NoProfile -Command '${data}'`,
      `node <<'SCRIPT'\n${data}\nSCRIPT`,
    ].entries()) {
      const id = `interpreter-${index}`; f.codex.pending.add(id);
      await f.bridge.request({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-a', command } });
    }
    await f.drain();
    const previews = f.telegram.sent().slice(previous).map(approvalBody).join('');
    assert.equal(previews.includes(data), false);
    assert.equal(previews.match(/Команда сокращена/gu)?.length, 4);
    assert.equal(f.telegram.sent().slice(previous).length, 4, 'Each abbreviated code approval fits in one message');
    for (const part of f.telegram.sent().slice(previous)) {
      const entities = array(part.entities).map(object);
      assert.equal(entities.some(entity => entity.type === 'expandable_blockquote' || entity.type === 'spoiler'), false);
      assert.ok(entities.some(entity => entity.type === 'pre'));
    }
  } finally { f.close(); }
});

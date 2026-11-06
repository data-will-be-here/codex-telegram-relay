import { test } from 'node:test';
import assert from 'node:assert/strict';
import { array, object, string, type Json } from '../src/types.js';
import { Bridge } from '../src/bridge.js';
import { RpcError } from '../src/codex.js';
import { fixture, message, click } from './helpers.js';

function model(id = 'dynamic-model', efforts = ['high', 'xhigh']): Json {
  return { id, model: id, displayName: id, defaultReasoningEffort: efforts[0],
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
    serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Increased usage' }] };
}
function buttons(markup: unknown): Json[] { return array(object(markup).inline_keyboard).flatMap(row => array(row).map(object)); }
type Fixture = Awaited<ReturnType<typeof fixture>>;
function menuClick(f: Fixture, id: number, data: string): Json {
  const update = click(id, data);
  object(object(update.callback_query).message).message_id = f.telegram.message;
  return update;
}
async function open(f: Fixture, updateId = 1): Promise<Json[]> {
  await f.bridge.update(message(updateId, 101, '/model')); await f.drain();
  return buttons(f.telegram.sent().at(-1)!.reply_markup);
}
async function select(f: Fixture, updateId = 2, name = 'dynamic-model'): Promise<Json[]> {
  const first = await open(f, updateId - 1);
  const modelButton = first.find(b => string(b.text).includes(name))!;
  await f.bridge.update(menuClick(f, updateId, string(modelButton.callback_data)));
  return buttons(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.reply_markup);
}

test('/model loads the current native catalog each time and never starts a model turn', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model('model-before-update')];
    await f.bridge.update(message(1, 101, '/model')); await f.drain();
    assert.equal(f.codex.modelReads, 1);
    assert.ok(buttons(f.telegram.sent().at(-1)!.reply_markup).some(b => string(b.text).includes('model-before-update')));
    f.codex.modelCatalog = [model('new-model-from-daemon')];
    await f.bridge.update(message(2, 101, '/model')); await f.drain();
    const names = buttons(f.telegram.sent().at(-1)!.reply_markup).map(b => string(b.text));
    assert.equal(f.codex.modelReads, 2);
    assert.ok(names.some(name => name.includes('new-model-from-daemon')));
    assert.ok(names.every(name => !name.includes('model-before-update') && !/Обновить|Применить/u.test(name)));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('new reasoning levels and speed IDs appear without relay changes; a model without Fast never advertises it', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [{ ...model('future-model', ['future-depth']), serviceTiers: [{ id: 'future-speed', name: 'Future Speed' }] }];
    let options = await select(f, 2, 'future-model');
    const choice = options.find(b => b.text === 'future-depth · Future Speed')!;
    assert.ok(choice);
    await f.bridge.update(click(3, string(choice.callback_data)));
    assert.deepEqual(f.codex.writes[0]!.params, { threadId: 'thread-a', model: 'future-model', effort: 'future-depth', serviceTier: 'future-speed' });
    f.codex.modelCatalog = [{ ...model('standard-only', ['medium']), serviceTiers: [] }];
    options = await select(f, 5, 'standard-only');
    assert.deepEqual(options.map(b => b.text), ['Medium', 'Назад', 'Отмена']);
    await f.bridge.update(menuClick(f, 6, string(options[0]!.callback_data)));
    assert.equal(f.codex.writes[1]!.params.serviceTier, 'default', 'Ordinary speed must explicitly replace a previously selected Fast tier');
  } finally { f.close(); }
});

test('foreign senders, wrong topics, wrong messages and stale screen controls cannot change session settings', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model()];
    const options = await select(f);
    const choice = string(options[0]!.callback_data);
    await f.bridge.update(click(3, choice, 101, 99));
    await f.bridge.update(click(4, choice, 102));
    const wrongMessage = click(5, choice); object(object(wrongMessage.callback_query).message).message_id = 3000;
    await f.bridge.update(wrongMessage);
    const group = click(6, choice); object(object(object(group.callback_query).message).chat).type = 'group';
    await f.bridge.update(group);
    assert.equal(f.codex.writes.length, 0);
    const back = options.find(b => b.text === 'Назад')!;
    await f.bridge.update(click(7, string(back.callback_data)));
    await f.bridge.update(click(8, choice));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

for (const change of ['ignored', 'moved', 'detached', 'rebound', 'reconnected']) test(`a ${change} session cannot apply an old model menu`, async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model()];
    const choice = string((await select(f))[0]!.callback_data);
    if (change === 'ignored') f.bridge.config.ignoredThreadIds = ['thread-a'];
    if (change === 'moved') f.codex.sessions[0]!.cwd = f.dir;
    if (change === 'detached') { f.codex.sessions = f.codex.sessions.slice(1); await f.bridge.discover(); }
    if (change === 'rebound') { f.state.missingTopic(f.state.binding('thread-a')!); await f.bridge.discover(); }
    const bridge = change === 'reconnected' ? new Bridge(f.bridge.config, f.state, f.codex, f.telegram) : f.bridge;
    await bridge.update(click(3, choice));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('a removed reasoning level is rechecked before the write and never substituted silently', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model()];
    const choice = (await select(f)).find(b => b.text === 'Extra High')!;
    f.codex.modelCatalog = [model('dynamic-model', ['high'])];
    await f.bridge.update(click(3, string(choice.callback_data)));
    assert.equal(f.codex.writes.length, 0);
    assert.match(string(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.text), /больше не доступны/u);
  } finally { f.close(); }
});

test('an uncertain native settings write is never retried by a second click or a new Bridge', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model()];
    f.codex.updateSettings = async (threadId, settings) => {
      f.codex.writes.push({ method: 'settings', params: { threadId, ...settings } });
      throw new RpcError('Synthetic lost native acknowledgement', true);
    };
    const choice = string((await select(f))[0]!.callback_data);
    await f.bridge.update(click(3, choice)); await f.bridge.update(click(4, choice));
    const bridge = new Bridge(f.bridge.config, f.state, f.codex, f.telegram);
    await bridge.discover(); await bridge.update(click(5, choice));
    assert.equal(f.codex.writes.length, 1);
    assert.match(string(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.text), /Не удалось подтвердить/u);
  } finally { f.close(); }
});

test('changing an active session configures following requests without steering or interrupting its current turn', async () => {
  const f = await fixture();
  try {
    f.codex.sessions[0]!.status = 'active'; f.codex.modelCatalog = [model()];
    await f.bridge.update(click(3, string((await select(f))[0]!.callback_data)));
    assert.deepEqual(f.codex.writes.map(w => w.method), ['settings']);
    assert.match(string(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.text), /Текущий ответ завершится с прежними настройками/u);
  } finally { f.close(); }
});

test('model and settings pages remain navigable and expired or cancelled menus never write settings', async () => {
  const f = await fixture(); const now = Date.now;
  try {
    f.codex.modelCatalog = Array.from({ length: 10 }, (_, i) => model(`dynamic-${i}`, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'future-depth']));
    let first = await open(f);
    assert.ok(!first.some(b => b.text === 'dynamic-9'));
    await f.bridge.update(menuClick(f, 2, string(first.find(b => b.text === '→')!.callback_data)));
    first = buttons(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.reply_markup);
    await f.bridge.update(menuClick(f, 3, string(first.find(b => b.text === 'dynamic-9')!.callback_data)));
    let second = buttons(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.reply_markup);
    assert.ok(!second.some(b => b.text === 'future-depth'));
    await f.bridge.update(menuClick(f, 4, string(second.find(b => b.text === '→')!.callback_data)));
    second = buttons(f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!.params.reply_markup);
    assert.ok(second.some(b => b.text === 'future-depth'));
    const oldChoice = string(second[0]!.callback_data);
    await f.bridge.update(menuClick(f, 5, string(second.find(b => b.text === 'Отмена')!.callback_data)));
    await f.bridge.update(menuClick(f, 6, oldChoice));
    const options = await select(f, 8, 'dynamic-0');
    Date.now = () => now() + 11 * 60 * 1000;
    await f.bridge.update(menuClick(f, 9, string(options[0]!.callback_data)));
    assert.equal(f.codex.writes.length, 0);
  } finally { Date.now = now; f.close(); }
});

test('parallel clicks consume only one selection even while a Telegram acknowledgement is waiting', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    f.codex.modelCatalog = [model()];
    const choice = string((await select(f))[0]!.callback_data);
    const call = f.telegram.call.bind(f.telegram); let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.telegram.call = async (method, params) => {
      if (method === 'answerCallbackQuery' && params?.callback_query_id === '3') { started(); await held; }
      return call(method, params);
    };
    const applying = f.bridge.update(click(3, choice)); await waiting;
    await f.bridge.update(click(4, choice)); release(); await applying;
    assert.equal(f.codex.writes.length, 1);
  } finally { release?.(); f.close(); }
});

test('a failed catalog read retires previous controls without showing stale models as current', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model()];
    const choice = string((await select(f))[0]!.callback_data);
    f.codex.models = async () => { throw new RpcError('Synthetic unavailable catalog', true); };
    await f.bridge.update(message(3, 101, '/model')); await f.drain();
    await f.bridge.update(menuClick(f, 4, choice));
    assert.equal(f.codex.writes.length, 0);
    assert.match(string(f.telegram.sent().at(-1)!.text), /Не удалось загрузить/u);
  } finally { f.close(); }
});

test('legacy speed names without native tier IDs are not guessed into settings writes', async () => {
  const f = await fixture();
  try {
    const legacy = model(); delete legacy.serviceTiers;
    legacy.additionalSpeedTiers = ['fast', 'future-speed-name']; f.codex.modelCatalog = [legacy];
    const options = await select(f);
    assert.ok(options.every(button => !/fast|future-speed-name/iu.test(string(button.text))));
    await f.bridge.update(click(3, string(options[0]!.callback_data)));
    assert.equal(f.codex.writes[0]!.params.serviceTier, 'default');
  } finally { f.close(); }
});

test('a session that becomes ineligible while the catalog loads gets a visible explanation', async () => {
  const f = await fixture();
  try {
    f.codex.models = async () => { f.codex.sessions[0]!.cwd = f.dir; return [model()]; };
    await f.bridge.update(message(1, 101, '/model')); await f.drain();
    assert.ok(f.telegram.sent().some(message => /Сессия недоступна/u.test(string(message.text))));
    assert.equal(f.codex.writes.length, 0);
  } finally { f.close(); }
});

test('choosing a model opens dynamic settings and a single choice applies that exact model, effort and speed', async () => {
  const f = await fixture();
  try {
    f.codex.modelCatalog = [model()];
    await f.bridge.update(message(1, 101, '/model')); await f.drain();
    const chooseModel = buttons(f.telegram.sent()[0]!.reply_markup).find(b => string(b.text).includes('dynamic-model'))!;
    await f.bridge.update(click(2, string(chooseModel.callback_data)));
    const screen = f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!;
    assert.ok(screen, 'Selecting a model must open the second screen in the same message');
    const options = buttons(screen.params.reply_markup);
    assert.ok(options.some(b => b.text === 'High'));
    assert.ok(options.some(b => b.text === 'Extra High'));
    assert.ok(options.every(b => !/Обновить|Применить/u.test(string(b.text))));
    assert.equal(f.codex.writes.length, 0, 'Opening either screen is read-only');
    const choice = options.find(b => b.text === 'Extra High · Fast')!;
    assert.ok(choice);
    await f.bridge.update(click(3, string(choice.callback_data)));
    await f.bridge.update(click(4, string(choice.callback_data)));
    assert.deepEqual(f.codex.writes, [{ method: 'settings', params: { threadId: 'thread-a', model: 'dynamic-model', effort: 'xhigh', serviceTier: 'priority' } }]);
    const result = f.telegram.calls.filter(c => c.method === 'editMessageText').at(-1)!;
    assert.match(string(result.params.text), /Сохранено для всех следующих запросов/u);
    assert.equal(buttons(result.params.reply_markup).length, 0);
  } finally { f.close(); }
});

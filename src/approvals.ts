import { createHash } from 'node:crypto';
import { Lexer } from 'marked';
import { string, type AgentOrigin, type Binding, type Json, type RpcRequest } from './types.js';
import { formatMessages, projectHeader, withProjectHeader, type FormattedText } from './format.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** A replay of one daemon request keeps its ID. Different requests or review context must not merge. */
export function approvalIdentity(request: RpcRequest): string {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}

export function approvalCardIdentity(identity: string, binding: Binding, card: string): string {
  return createHash('sha256').update(JSON.stringify([identity, binding.threadId, binding.topicId, binding.cwd, card])).digest('hex');
}

/** Long review text is literal inside spoilers; Telegram forbids nesting pre/code there. */
export function approvalParts(card: string, reference: string, cwd?: string | null, sessionName?: string | null): FormattedText[] | undefined {
  const limit = 3500 - projectHeader(cwd, sessionName).length - 2;
  if (formatMessages(card, true, limit).length <= 1) return undefined;
  // Reserve space for a stable request reference and counters even for very large plans.
  const chunks = formatMessages(card, true, limit - 100);
  return chunks.map((chunk, index) => {
    const prefix = `🔐 Апрув ${reference.slice(0, 8)} · ${index + 1}/${chunks.length}\n\n`;
    return withProjectHeader({ text: prefix + chunk.text,
      entities: [{ type: 'spoiler', offset: prefix.length, length: chunk.text.length }] }, cwd, sessionName);
  });
}

function shortenAuxiliaryQuotes(reason: string): string {
  let result = ''; let offset = 0; let cursor = 0;
  for (const token of Lexer.lex(reason)) {
    const start = reason.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;
    if (token.type !== 'code' && token.type !== 'blockquote') continue;
    const lines = token.raw.split('\n');
    if (token.raw.length <= 2000 && lines.length <= 40) continue;
    const head = lines.slice(0, 20).join('\n').slice(0, 1200).replace(/[\ud800-\udbff]$/u, '');
    const tail = lines.slice(-10).join('\n').slice(-600).replace(/^[\udc00-\udfff]/u, '');
    const omitted = Math.max(0, lines.length - head.split('\n').length - tail.split('\n').length);
    const note = `[Цитата сокращена: пропущено ${omitted} строк, ${token.raw.length - head.length - tail.length} символов]`;
    result += reason.slice(offset, start) + head + '\n' + note + '\n' + tail;
    offset = cursor;
  }
  return result + reason.slice(offset);
}

/** Only explicitly quoted context in the reason is abbreviated, never the proposed operation. */
export function approvalDisplayMessage(method: string, params: Json, agent?: AgentOrigin): string {
  const reason = string(params.reason);
  return approvalMessage(method, reason ? { ...params, reason: shortenAuxiliaryQuotes(reason) } : params, agent);
}

function literal(text: string): string {
  // Escaping URL/email markers also prevents GFM autolinks consuming later escapes.
  return text.replace(/[\\`*_{}\[\]()#+.!|>~<:@\-]/gu, '\\$&');
}

function code(text: string): string {
  // CommonMark normalizes carriage returns, and Telegram may discard invisible controls.
  // A labelled JSON string preserves their exact meaning without changing native input.
  const escaped = /[\x00-\x08\x0b-\x1f\x7f]/u.test(text);
  const shown = escaped ? JSON.stringify(text).replace(/\x7f/gu, '\\u007f') : text;
  let longest = 2;
  for (const run of shown.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(longest + 1);
  const note = escaped ? 'Control characters are shown as JSON escapes; the block is a JSON string.\n\n' : '';
  return `${note}${fence}\n${shown}\n${fence}`;
}

/** Only presentation changes: display the exact command, retaining unfamiliar security context. */
export function approvalMessage(method: string, params: Json, agent?: AgentOrigin): string {
  const origin = agent ? '**Agent**\n' + code(`${agent.name}\n${agent.threadId}`) + '\n\n' : '';
  if (method !== 'item/commandExecution/requestApproval' || !string(params.command)) {
    return origin + '🔐 Approval required\n\n' + code(JSON.stringify(params, null, 2));
  }
  const sections = ['🔐 Command approval'];
  if (string(params.reason)) sections.push('**Reason**\n' + literal(string(params.reason)));
  if (string(params.cwd)) sections.push('**Working directory**\n' + code(string(params.cwd)));
  sections.push('**Command**\n' + code(string(params.command)));
  if (string(params.environmentId) && params.environmentId !== 'local') {
    sections.push('**Environment**\n' + literal(string(params.environmentId)));
  }
  // Parsed actions describe the already displayed command; they are not the operation being approved.
  const displayed = new Set(['command', 'commandActions', 'availableDecisions']);
  for (const key of ['reason', 'cwd', 'environmentId']) {
    if (params[key] === null || typeof params[key] === 'string') displayed.add(key);
  }
  const transport = new Set(['kind', 'threadId', 'turnId', 'itemId', 'startedAtMs']);
  const extra = Object.fromEntries(Object.entries(params).filter(([key]) => !displayed.has(key) && !transport.has(key)));
  if (Object.keys(extra).length) sections.push('**Additional context**\n' + code(JSON.stringify(extra, null, 2)));
  // Keep a prose tail so the Markdown renderer cannot trim whitespace belonging to the command block.
  sections.push('Choose a decision below.');
  return origin + sections.join('\n\n');
}

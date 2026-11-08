import { createHash } from 'node:crypto';
import { Lexer } from 'marked';
import { string, type AgentOrigin, type Binding, type Json, type RpcRequest } from './types.js';
import { formatMessages, projectHeader, withProjectHeader, type FormattedText } from './format.js';

const PREVIEW_NOTICE = '⚠️ Сокращённое превью. Кнопка одобряет полную команду, включая пропущенный код. Полный текст доступен в Codex.\n\n';

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

/** Collapsed review blocks reduce message height; literal bodies avoid incompatible nested entities. */
export function approvalParts(card: string, reference: string, cwd?: string | null, sessionName?: string | null): FormattedText[] | undefined {
  const limit = 3500 - projectHeader(cwd, sessionName).length - 2;
  if (formatMessages(card, true, limit).length <= 1) return undefined;
  // Reserve space for a stable request reference and counters even for very large plans.
  const chunks = formatMessages(card, true, limit - 200);
  return chunks.map((chunk, index) => {
    const prefix = `🔐 Апрув ${reference.slice(0, 8)} · ${index + 1}/${chunks.length}\n\n` +
      (card.startsWith(PREVIEW_NOTICE) ? '⚠️ Превью: кнопка одобряет полную команду в Codex.\n\n' : '');
    return withProjectHeader({ text: prefix + chunk.text,
      entities: [{ type: 'expandable_blockquote', offset: prefix.length, length: chunk.text.length }] }, cwd, sessionName);
  });
}

function shortenReviewText(text: string, label: string): string {
  const lines = text.split('\n');
  if (text.length <= 2000 && lines.length <= 40) return text;
  const head = lines.slice(0, 20).join('\n').slice(0, 1200).replace(/[\ud800-\udbff]$/u, '');
  const tail = lines.slice(-10).join('\n').slice(-600).replace(/^[\udc00-\udfff]/u, '');
  const omitted = Math.max(0, lines.length - head.split('\n').length - tail.split('\n').length);
  return head + `\n[${label}: пропущено ${omitted} строк, ${text.length - head.length - tail.length} символов]\n` + tail;
}

function shortenAuxiliaryQuotes(reason: string): string {
  let result = ''; let offset = 0; let cursor = 0;
  for (const token of Lexer.lex(reason)) {
    const start = reason.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;
    if (token.type !== 'code' && token.type !== 'blockquote') continue;
    result += reason.slice(offset, start) + shortenReviewText(token.raw, 'Цитата сокращена');
    offset = cursor;
  }
  return result + reason.slice(offset);
}

function hasEmbeddedCode(command: string): boolean {
  // Only a simple unquoted heredoc header with a matching terminator is unambiguous here.
  if (/^\s*(?:[^\s"'<>]+[ \t]+)*<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[ \t]*\r?\n[\s\S]*\r?\n\2[ \t]*(?:\r?\n|$)/u.test(command)) return true;
  // Recognize common inline interpreters conservatively; ordinary arguments stay complete.
  const invocation = /^\s*(?:&\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/u.exec(command);
  if (!invocation) return false;
  const program = (invocation[1] ?? invocation[2] ?? invocation[3]!).split(/[\\/]/u).at(-1)!.replace(/\.exe$/iu, '').toLowerCase();
  const inline: [RegExp, RegExp][] = [
    [/^(?:node|nodejs|bun)$/u, /^(?:(?:--input-type=\S+|--no-warnings|--enable-source-maps)\s+)*(?:-e|--eval|-p|--print)(?:\s|=)/u],
    [/^(?:python(?:\d+(?:\.\d+)*)?|py)$/u, /^(?:(?:-[uBEsSIO]+|-3(?:\.\d+)?)\s+)*-c(?:\s|$)/u],
    [/^(?:bash|sh|zsh)$/u, /^(?:--(?:noprofile|norc)\s+)*-c(?:\s|$)/u],
    [/^(?:pwsh|powershell)$/u, /^(?:(?:-(?:NoProfile|NoLogo|NonInteractive)|-ExecutionPolicy\s+\w+)\s+)*-(?:Command|EncodedCommand)(?:\s|$)/iu],
    [/^(?:ruby|perl)$/u, /^-e(?:\s|$)/u],
    [/^php$/u, /^-r(?:\s|$)/u],
    [/^deno$/u, /^eval(?:\s|$)/u],
  ];
  return inline.some(([name, flag]) => name.test(program) && flag.test(invocation[4]!));
}

/** Display previews never mutate the request used for identity, callbacks or native decisions. */
export function approvalDisplayMessage(method: string, params: Json, agent?: AgentOrigin): string {
  const display = { ...params };
  const reason = string(params.reason);
  if (reason) display.reason = shortenAuxiliaryQuotes(reason);
  let preview = false;
  if (method === 'item/commandExecution/requestApproval' && hasEmbeddedCode(string(params.command))) {
    const command = string(params.command);
    if (command) {
      display.command = shortenReviewText(command, 'Команда сокращена');
      preview = display.command !== command;
    }
    if (Array.isArray(params.proposedExecpolicyAmendment)) {
      display.proposedExecpolicyAmendment = params.proposedExecpolicyAmendment.map(value => {
        if (typeof value !== 'string') return value;
        const shown = shortenReviewText(value, 'Код в правиле разрешений сокращён');
        if (shown !== value) preview = true;
        return shown;
      });
    }
  }
  return (preview ? PREVIEW_NOTICE : '') + approvalMessage(method, display, agent);
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

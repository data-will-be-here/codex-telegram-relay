import { createHash } from 'node:crypto';
import { Lexer } from 'marked';
import { posix, win32 } from 'node:path';
import { array, object, string, type AgentOrigin, type Binding, type Json, type RpcRequest } from './types.js';
import { formatMessages, projectHeader, withProjectHeader, type FormattedText } from './format.js';

const PREVIEW_NOTICE = '⚠️ Abbreviated preview. The button approves the complete command, including omitted code. The full text is available in Codex.\n\n';

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
export function approvalParts(card: string, reference: string, cwd?: string | null, sessionName?: string | null, projectLabel?: string): FormattedText[] | undefined {
  const limit = 3500 - projectHeader(cwd, sessionName, projectLabel).length - 2;
  const preview = card.startsWith(PREVIEW_NOTICE);
  if (formatMessages(card, true, limit).length <= 1) return undefined;
  // Reserve space for a stable request reference and counters even for very large plans.
  const chunks = formatMessages(card, true, limit - 200);
  return chunks.map((chunk, index) => {
    const prefix = `🔐 Approval ${reference.slice(0, 8)} · ${index + 1}/${chunks.length}\n\n` +
      (preview ? '⚠️ Preview: the button approves the complete command in Codex.\n\n' : '');
    return withProjectHeader({ text: prefix + chunk.text,
      entities: [{ type: 'expandable_blockquote', offset: prefix.length, length: chunk.text.length }] }, cwd, sessionName, projectLabel);
  });
}

function shortenReviewText(text: string, label: string, limit = 600): string {
  const lines = text.split('\n');
  if (text.length <= limit && lines.length <= 6) return text;
  const head = lines.slice(0, 4).join('\n').slice(0, Math.floor(limit * 0.58)).replace(/[\ud800-\udbff]$/u, '');
  const tail = lines.slice(-1).join('\n').slice(-Math.floor(limit * 0.2)).replace(/^[\udc00-\udfff]/u, '');
  const omitted = Math.max(0, lines.length - head.split('\n').length - tail.split('\n').length);
  return head + `\n[${label}: omitted ${omitted} lines, ${text.length - head.length - tail.length} characters]\n` + tail;
}

function shortenAuxiliaryQuotes(reason: string): string {
  const tokens = Lexer.lex(reason);
  const sources = tokens.filter(token => token.type === 'code');
  const selected = new Set(sources.length <= 3 ? sources : [sources[0], sources[1], sources.at(-1)]);
  const omitted = sources.filter(token => !selected.has(token));
  const budget = Math.min(600, Math.floor(1000 / Math.max(1, selected.size)));
  let omittedNotice = false;
  let result = ''; let offset = 0; let cursor = 0;
  for (const token of tokens) {
    const start = reason.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;
    if (token.type !== 'code' && token.type !== 'blockquote') continue;
    let shown: string;
    if (token.type === 'code' && !selected.has(token)) {
      shown = omittedNotice ? '' : `[Code excerpts abbreviated: omitted ${omitted.length} blocks, ${omitted.reduce((sum, block) => sum + block.raw.length, 0)} characters. Full text in Codex.]\n\n`;
      omittedNotice = true;
    } else shown = token.type === 'code' ? code(shortenReviewText(token.text, 'Code abbreviated', budget)) + '\n\n' : shortenReviewText(token.raw, 'Quote abbreviated');
    result += reason.slice(offset, start) + shown;
    offset = cursor;
  }
  return result + reason.slice(offset);
}

function reasonMarkdown(reason: string): string {
  let result = ''; let offset = 0; let cursor = 0;
  for (const token of Lexer.lex(reason)) {
    const start = reason.indexOf(token.raw, cursor);
    if (start < 0) continue;
    cursor = start + token.raw.length;
    if (token.type !== 'code') continue;
    result += literal(reason.slice(offset, start)) + code(token.text) + '\n\n';
    offset = cursor;
  }
  return result + literal(reason.slice(offset));
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
  if (reason) display.reason = shortenAuxiliaryQuotes(reason.replace(/\r\n?/gu, '\n'));
  let preview = false;
  if (method === 'item/commandExecution/requestApproval' && hasEmbeddedCode(string(params.command))) {
    const command = string(params.command);
    if (command) {
      display.command = shortenReviewText(command, 'Command abbreviated');
      preview = display.command !== command;
    }
    if (Array.isArray(params.proposedExecpolicyAmendment)) {
      display.proposedExecpolicyAmendment = params.proposedExecpolicyAmendment.map(value => {
        if (typeof value !== 'string') return value;
        const shown = shortenReviewText(value, 'Permission-rule code abbreviated');
        if (shown !== value) {
          preview = true;
          if (command.includes(value)) return `[Permission-rule code abbreviated: ${value.length} characters; see the command preview above; full text in Codex]`;
        }
        return shown;
      });
    }
  }
  return (preview ? PREVIEW_NOTICE : '') + approvalMessage(method, display, agent, reason ? reasonMarkdown(string(display.reason)) : undefined);
}

/** A summary is opt-in by recognized schema; unfamiliar access context retains the full review. */
export function approvalOverview(method: string, params: Json, project: string, agent?: AgentOrigin): string | undefined {
  const command = method === 'item/commandExecution/requestApproval';
  const files = method === 'item/fileChange/requestApproval';
  const permissions = method === 'item/permissions/requestApproval';
  if (!command && !files && !permissions) return;
  const known = new Set(['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'environmentId', 'cwd',
    ...(command ? ['kind', 'approvalId', 'command', 'commandActions', 'availableDecisions', 'additionalPermissions', 'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments'] :
      files ? ['changes', 'proposedChanges', 'grantRoot', 'availableDecisions'] : ['permissions'])]);
  if (Object.keys(params).some(key => !known.has(key))) return;
  for (const key of ['reason', 'environmentId', 'cwd']) if (params[key] != null && typeof params[key] !== 'string') return;
  if (command && params.kind != null && !['command', 'humanCommand', 'writeStdin'].includes(string(params.kind))) return;
  const title = command ? params.kind === 'writeStdin' ? 'Terminal input approval' : 'Command approval' : files ? 'File change approval' : 'Permission approval';
  const sections = [title];
  if (agent) sections.push('**Agent**\n' + code(`${agent.name} · ${agent.threadId.slice(0, 8)}`));
  const reason = string(params.reason).replace(/\r\n?/gu, '\n');
  if (reason) {
    if (reason.length <= 500) sections.push('**Reason**\n' + reasonMarkdown(shortenAuxiliaryQuotes(reason)));
    else {
      const prefix = reason.slice(0, 400);
      const sentence = [...prefix.matchAll(/[.!?](?=\s|$)/gu)].at(-1);
      const end = sentence && sentence.index > 180 ? sentence.index + 1 : Math.max(prefix.lastIndexOf(' '), 1);
      sections.push('**Reason**\n' + literal(prefix.slice(0, end)) + '\nReason shortened; full reason in Details.');
    }
  }
  if (command) {
    if (params.command != null && typeof params.command !== 'string') return;
    const original = string(params.command);
    if (!original && !params.networkApprovalContext) return;
    if (original) {
      const shown = hasEmbeddedCode(original) ? shortenReviewText(original, 'Command abbreviated') : original;
      sections.push('**' + (params.kind === 'writeStdin' ? 'Terminal input' : 'Command') + '**\n' + code(shown));
      if (shown !== original) sections.splice(1, 0, '⚠️ Abbreviated preview. Allow once approves the complete command, including omitted code. Open Details for the full command.');
    }
  }
  if (string(params.cwd)) sections.push('**Working directory**\n' + code(reviewPath(string(params.cwd), project)));
  if (params.environmentId && params.environmentId !== 'local') sections.push('**Environment**\n' + literal(string(params.environmentId)));
  if (command && params.networkApprovalContext != null) {
    const network = object(params.networkApprovalContext);
    if (!string(network.host) || !string(network.protocol) || Object.keys(network).some(key => !['host', 'protocol', 'port'].includes(key))) return;
    sections.push('**Network access**\n' + code(JSON.stringify(network)));
  }
  const access = permissions ? params.permissions : params.additionalPermissions;
  if (access != null) {
    const shown = permissionOverview(access);
    if (shown === undefined) return;
    sections.push('**Requested permissions**\n' + (shown || 'No additional permissions.'));
  } else if (permissions) return;
  if (files) {
    const changes = array(params.proposedChanges);
    if (!changes.length) return;
    const entries: string[] = [];
    for (const raw of changes) {
      const change = object(raw); const kind = object(change.kind);
      if (!string(change.path) || typeof change.diff !== 'string' || Object.keys(change).some(key => !['path', 'kind', 'diff'].includes(key)) ||
          change.kind != null && (!['add', 'delete', 'update'].includes(string(kind.type)) || Object.keys(kind).some(key => !['type', 'move_path'].includes(key)) ||
            kind.move_path != null && typeof kind.move_path !== 'string')) return;
      const action = kind.type === 'delete' ? 'DELETE' : kind.type === 'add' ? 'Add' : 'Update';
      entries.push(action + ': ' + reviewPath(string(change.path), project) + (string(kind.move_path) ? '\nMove to: ' + reviewPath(string(kind.move_path), project) : ''));
    }
    sections.push('**Files (' + changes.length + ')**\n' + code(entries.join('\n')) + '\nFull diff in Details.');
    if (params.grantRoot != null) {
      if (!string(params.grantRoot)) return;
      sections.push('**Requested write root**\n' + code(string(params.grantRoot)) + '\nCodex requests this root for the session; actual duration depends on native support.');
    }
  }
  sections.push(permissions ? 'Scope: this turn.' : files && params.grantRoot != null ?
    'This approval includes the requested write-root grant; Codex controls its duration.' : 'Allow once applies to this operation; no persistent policy rule is selected.');
  return sections.join('\n\n');
}

/** Expand recognized file proposals as actual diff blocks, rather than JSON-escaped source lines. */
export function approvalDetailsMessage(method: string, params: Json, agent?: AgentOrigin): string {
  if (method !== 'item/fileChange/requestApproval') return approvalMessage(method, params, agent);
  const origin = agent ? '**Agent**\n' + code(`${agent.name}\n${agent.threadId}`) + '\n\n' : '';
  const sections = ['File change approval'];
  if (string(params.reason)) sections.push('**Reason**\n' + literal(string(params.reason)));
  for (const raw of array(params.proposedChanges)) {
    const change = object(raw);
    sections.push('**File**\n' + code(string(change.path)), '**Change**\n' + code(JSON.stringify(change.kind ?? { type: 'unspecified' })), '**Diff**\n' + code(string(change.diff)));
  }
  const remaining = { ...params }; delete remaining.proposedChanges; delete remaining.reason;
  if (JSON.stringify(params.changes) === JSON.stringify(params.proposedChanges)) delete remaining.changes;
  if (Object.keys(remaining).length) sections.push('**Additional context**\n' + code(JSON.stringify(remaining, null, 2)));
  return origin + sections.join('\n\n');
}

function reviewPath(path: string, project: string): string {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/u.test(project) ? win32 : posix;
  if (!project) return path;
  const target = paths.resolve(project, path); const relative = paths.relative(project, target);
  return relative === '' ? 'Project root' : relative === '..' || relative.startsWith('..' + paths.sep) || paths.isAbsolute(relative) ?
    target + ' (outside project)' : '.' + paths.sep + relative;
}

function permissionOverview(value: unknown): string | undefined {
  const access = object(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(access).some(key => !['network', 'fileSystem'].includes(key))) return;
  const lines: string[] = [];
  if (access.network != null) {
    const network = object(access.network);
    if (typeof access.network !== 'object' || Array.isArray(access.network) || Object.keys(network).some(key => key !== 'enabled') || network.enabled != null && typeof network.enabled !== 'boolean') return;
    if (network.enabled != null) lines.push('Network: ' + (network.enabled ? 'enabled' : 'disabled'));
  }
  if (access.fileSystem != null) {
    const fs = object(access.fileSystem);
    // New entry/glob schemas remain fully visible until they have an explicit renderer.
    if (typeof access.fileSystem !== 'object' || Array.isArray(access.fileSystem) || Object.keys(fs).some(key => !['read', 'write'].includes(key))) return;
    for (const [key, label] of [['read', 'Read'], ['write', 'Write']] as const) {
      if (fs[key] == null) continue;
      if (!Array.isArray(fs[key]) || fs[key].some(path => typeof path !== 'string' || !path)) return;
      if (fs[key].length) lines.push(label + ':\n' + code(fs[key].join('\n')));
    }
  }
  return lines.join('\n');
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
export function approvalMessage(method: string, params: Json, agent?: AgentOrigin, renderedReason?: string): string {
  const origin = agent ? '**Agent**\n' + code(`${agent.name}\n${agent.threadId}`) + '\n\n' : '';
  if (method !== 'item/commandExecution/requestApproval' || !string(params.command)) {
    return origin + '🔐 Approval required\n\n' + code(JSON.stringify(params, null, 2));
  }
  const sections = ['🔐 Command approval'];
  if (string(params.reason)) sections.push('**Reason**\n' + (renderedReason ?? literal(string(params.reason))));
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

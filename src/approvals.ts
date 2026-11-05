import { string, type AgentOrigin, type Json } from './types.js';

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

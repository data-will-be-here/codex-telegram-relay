import { Lexer, type MarkedToken, type Token } from 'marked';
import { isIP } from 'node:net';

export interface Entity {
  type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'pre' | 'text_link' | 'spoiler';
  offset: number;
  length: number;
  url?: string;
  language?: string;
}
export interface FormattedText { text: string; entities: Entity[]; }

export function projectHeader(cwd?: string | null, sessionName?: string | null): string {
  const name = (cwd?.split(/[\\/]/u).filter(Boolean).at(-1) || 'codex-telegram-relay').replace(/[\x00-\x1f\x7f]/gu, ' ');
  const chars = Array.from(name);
  const task = Array.from((sessionName ?? '').replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim());
  return '» ' + (chars.length > 80 ? chars.slice(0, 79).join('') + '…' : name) +
    (task.length ? ' • ' + (task.length > 80 ? task.slice(0, 79).join('') + '…' : task.join('')) : '');
}

export function withProjectHeader(message: FormattedText, cwd?: string | null, sessionName?: string | null): FormattedText {
  const header = projectHeader(cwd, sessionName); const prefix = header + '\n\n';
  return { text: prefix + message.text, entities: [
    { type: 'italic', offset: 0, length: header.length },
    ...message.entities.slice(0, 99).map(e => ({ ...e, offset: e.offset + prefix.length })),
  ] };
}

export function linkable(url: URL): boolean {
  if (url.protocol === 'mailto:') return true;
  if (!['https:', 'http:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  const ip = isIP(host);
  if (host === 'localhost' || /\.(?:localhost|local|lan|internal)$/u.test(host) || (!host.includes('.') && !ip)) return false;
  if (ip === 4) {
    const [a = -1, b = -1] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return ip !== 6 || !/^(?:::|f[cd]|fe[89ab])/u.test(host);
}

/** Parse CommonMark/GFM into text and Telegram entities; never interpret raw HTML. */
export function renderMarkdown(source: string): FormattedText {
  let text = '';
  const spans: Entity[] = [];
  const add = (type: Entity['type'], write: () => void, extra: Pick<Entity, 'url' | 'language'> = {}): void => {
    const offset = text.length;
    write();
    if (text.length > offset) spans.push({ type, offset, length: text.length - offset, ...extra });
  };
  const newline = (): void => { if (text && !text.endsWith('\n')) text += '\n'; };
  const visit = (tokens: Token[], depth = 0): void => {
    for (const raw of tokens) {
      // No extensions are installed: the built-in lexer only emits MarkedToken.
      const token = raw as MarkedToken;
      if (depth > 32) { text += token.raw; continue; }
      const children = (items: Token[]): void => visit(items, depth + 1);
      switch (token.type) {
        case 'strong': add('bold', () => children(token.tokens)); break;
        case 'em': add('italic', () => children(token.tokens)); break;
        case 'del': add('strikethrough', () => children(token.tokens)); break;
        case 'codespan': add('code', () => { text += token.text; }); break;
        case 'code': {
          newline();
          const language = token.lang?.split(/\s/u)[0];
          add('pre', () => { text += token.text; }, language && /^[\w+-]{1,32}$/u.test(language) ? { language } : {});
          newline(); break;
        }
        case 'link':
        case 'image': {
          // Local paths cannot open the owner's computer from Telegram. Keep the target visible.
          const href = token.href;
          let url: URL | undefined;
          try { url = new URL(href); } catch { /* Relative/local links remain readable text. */ }
          if (url && linkable(url)) {
            add('text_link', () => children(token.tokens), { url: url.href });
          } else {
            children(token.tokens);
            if (href && href !== token.text) text += ` (${href})`;
          }
          break;
        }
        case 'heading': newline(); add('bold', () => children(token.tokens)); newline(); break;
        case 'paragraph': children(token.tokens); newline(); break;
        case 'blockquote': newline(); children(token.tokens); newline(); break;
        case 'list': {
          newline();
          for (const [index, item] of token.items.entries()) {
            text += token.ordered ? `${Number(token.start) + index}. ` : '• ';
            children(item.tokens); newline();
          }
          break;
        }
        case 'list_item': children(token.tokens); break;
        case 'table': newline(); add('pre', () => { text += token.raw.trimEnd(); }); newline(); break;
        case 'space': if (text && !text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n'; break;
        case 'br': text += '\n'; break;
        case 'hr': newline(); text += '────────\n'; break;
        case 'checkbox': text += token.checked ? '☑ ' : '☐ '; break;
        case 'def': break;
        case 'text': if (token.tokens) children(token.tokens); else text += token.text; break;
        case 'escape': text += token.text; break;
        case 'html': text += token.raw; break;
        default: text += raw.raw;
      }
    }
  };
  try { visit(Lexer.lex(source, { gfm: true })); }
  catch { return { text: source, entities: [] }; }
  text = text.trimEnd();
  if (!text.trim()) return { text: source, entities: [] };

  // Telegram forbids formatting or links enclosing code/pre. Split those spans around code.
  const code = spans.filter(e => e.type === 'code' || e.type === 'pre');
  const entities: Entity[] = [];
  for (const span of spans) {
    let pieces = [{ start: span.offset, end: Math.min(span.offset + span.length, text.length) }];
    if (span.type !== 'code' && span.type !== 'pre') {
      for (const excluded of code) pieces = pieces.flatMap(p => {
        const start = Math.max(p.start, excluded.offset);
        const end = Math.min(p.end, excluded.offset + excluded.length);
        return start < end ? [{ start: p.start, end: start }, { start: end, end: p.end }] : [p];
      });
    }
    for (const p of pieces) if (p.end > p.start) entities.push({ ...span, offset: p.start, length: p.end - p.start });
  }
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text, entities };
}

export function withoutFormatting(message: FormattedText): string {
  let text = message.text;
  const links = message.entities.filter(e => e.type === 'text_link' && e.url).sort((a, b) => b.offset - a.offset);
  for (const link of links) {
    if (text.slice(link.offset, link.offset + link.length) === link.url) continue;
    const end = link.offset + link.length;
    text = text.slice(0, end) + ` (${link.url})` + text.slice(end);
  }
  return text;
}

export function splitMessage(text: string, limit = 3500): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Message limit must be at least two UTF-16 code units.');
  const chunks: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (chunk.length + char.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function formatMessages(source: string, markdown: boolean, limit = 3500): FormattedText[] {
  const rendered = markdown ? renderMarkdown(source) : { text: source, entities: [] };
  let offset = 0;
  return splitMessage(rendered.text, limit).map(text => {
    const start = offset; offset += text.length;
    const entities = rendered.entities.flatMap(e => {
      const from = Math.max(start, e.offset); const to = Math.min(offset, e.offset + e.length);
      return to > from ? [{ ...e, offset: from - start, length: to - from }] : [];
    });
    // Keep every character even if a pathological answer contains excessive formatting.
    return { text, entities: entities.slice(0, 100) };
  });
}

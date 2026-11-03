import { Lexer, type MarkedToken, type Token } from 'marked';
import { linkable, projectHeader } from './format.js';

type RichText = string | RichText[] | { type: 'bold' | 'italic' | 'strikethrough' | 'code' | 'url'; text: RichText; url?: string };
type Cell = { text: RichText; is_header?: true; align: 'left' | 'center' | 'right'; valign: 'top' };
type RichBlock =
  | { type: 'paragraph' | 'heading' | 'pre'; text: RichText; size?: number; language?: string }
  | { type: 'divider' }
  | { type: 'blockquote'; blocks: RichBlock[] }
  | { type: 'table'; cells: Cell[][]; is_compact: true; is_bordered: true; is_striped: true };
export interface RichPart { richMessage: { blocks: RichBlock[]; skip_entity_detection: true }; fallback: string; }

function inline(tokens: Token[], depth = 0): RichText {
  const result: RichText[] = tokens.map(raw => {
    const token = raw as MarkedToken;
    if (depth >= 8) return token.raw;
    const children = (items: Token[]): RichText => inline(items, depth + 1);
    switch (token.type) {
      case 'strong': return { type: 'bold', text: children(token.tokens) };
      case 'em': return { type: 'italic', text: children(token.tokens) };
      case 'del': return { type: 'strikethrough', text: children(token.tokens) };
      case 'codespan': return { type: 'code', text: token.text };
      case 'text': return token.tokens ? children(token.tokens) : token.text;
      case 'escape': return token.text;
      case 'br': return '\n';
      case 'link': case 'image': {
        const label = children(token.tokens);
        try {
          const url = new URL(token.href);
          if (linkable(url)) return { type: 'url', text: label, url: url.href };
        } catch { /* Local paths remain literal text. */ }
        return [label, token.href && token.href !== token.text ? ` (${token.href})` : ''];
      }
      default: return token.raw;
    }
  });
  return result.length === 1 ? result[0]! : result;
}

function blocks(tokens: Token[], depth = 0): RichBlock[] {
  return tokens.flatMap((raw): RichBlock[] => {
    const token = raw as MarkedToken;
    if (depth >= 4) return [{ type: 'paragraph', text: token.raw }];
    switch (token.type) {
      case 'space': case 'def': return [];
      case 'heading': return [{ type: 'heading', size: token.depth, text: inline(token.tokens) }];
      case 'paragraph': case 'text': return [{ type: 'paragraph', text: token.tokens ? inline(token.tokens) : token.text }];
      case 'code': return [{ type: 'pre', text: token.text, ...(token.lang && /^[\w+-]{1,32}$/u.test(token.lang) ? { language: token.lang } : {}) }];
      case 'hr': return [{ type: 'divider' }];
      case 'blockquote': return [{ type: 'blockquote', blocks: blocks(token.tokens, depth + 1) }];
      case 'list': return token.items.flatMap((item, index) => [
        ...listItem(item.tokens, `${token.ordered ? `${Number(token.start) + index}.` : '•'}${item.task ? item.checked ? ' ☑' : ' ☐' : ''}`, depth + 1),
      ]);
      case 'table': {
        const row = (cells: typeof token.header, header = false): Cell[] => cells.map((cell, index) => ({
          text: inline(cell.tokens), ...(header ? { is_header: true as const } : {}), align: token.align[index] ?? 'left', valign: 'top',
        }));
        return [{ type: 'table', cells: [row(token.header, true), ...token.rows.map(cells => row(cells))], is_compact: true, is_bordered: true, is_striped: true }];
      }
      default: return [{ type: 'paragraph', text: token.raw }];
    }
  });
}

function listItem(tokens: Token[], label: string, depth: number): RichBlock[] {
  const items = blocks(tokens, depth);
  const first = items[0];
  if (first?.type === 'paragraph') return [{ ...first, text: [label + ' ', first.text] }, ...items.slice(1)];
  return [{ type: 'paragraph', text: label }, ...items];
}

function plain(text: RichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(plain).join('');
  const label = plain(text.text);
  return text.type === 'url' && text.url && label !== text.url ? `${label} (${text.url})` : label;
}

function plainBlocks(items: RichBlock[]): string {
  return items.map(block => {
    if (block.type === 'divider') return '────────';
    if (block.type === 'blockquote') return plainBlocks(block.blocks);
    if (block.type === 'table') {
      const header = block.cells[0] ?? [];
      if (block.cells.length === 1) return header.map(cell => plain(cell.text)).join('\n');
      return block.cells.slice(1).map(row => row.map((cell, index) => `${plain(header[index]?.text ?? `Column ${index + 1}`)}: ${plain(cell.text)}`).join('\n')).join('\n\n');
    }
    return plain(block.text);
  }).join('\n\n');
}

function countObjects(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countObjects(item), 0);
  if (value !== null && typeof value === 'object') return 1 + Object.values(value).reduce<number>((sum, item) => sum + countObjects(item), 0);
  return 0;
}

function validColumns(items: RichBlock[]): boolean {
  return items.every(block => block.type === 'table' ? block.cells.every(row => row.length <= 20) : block.type !== 'blockquote' || validColumns(block.blocks));
}

function textChunks(text: string): string[] {
  const result: string[] = []; let current = ''; let bytes = 0;
  for (const char of text) {
    const cost = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + cost > 8000) { result.push(current); current = ''; bytes = 0; }
    current += char; bytes += cost;
  }
  if (current || !result.length) result.push(current);
  return result;
}

function structured(tokens: Token[], depth = 0): boolean {
  if (depth >= 4) return false;
  return tokens.some(raw => {
    const token = raw as MarkedToken;
    return token.type === 'table' || token.type === 'heading' ||
      (token.type === 'blockquote' && structured(token.tokens, depth + 1)) ||
      (token.type === 'list' && token.items.some(item => structured(item.tokens, depth + 1)));
  });
}

/** Convert only known Markdown constructs; raw HTML/media never become active Telegram blocks. */
export function richMessages(source: string, cwd?: string | null): RichPart[] | undefined {
  let tokens: Token[];
  try { tokens = Lexer.lex(source, { gfm: true }); } catch { return undefined; }
  if (!structured(tokens)) return undefined;
  const content = blocks(tokens);
  const header: RichBlock = { type: 'paragraph', text: { type: 'italic', text: projectHeader(cwd) } };
  // Count serialized UTF-8 bytes and all objects conservatively, below Telegram's text/block ceilings.
  const fits = (items: RichBlock[]): boolean => validColumns(items) && countObjects([header, ...items]) <= 300 &&
    Buffer.byteLength(JSON.stringify({ blocks: [header, ...items], skip_entity_detection: true })) <= 24000;
  const fragments = (block: RichBlock): RichBlock[] => {
    if (fits([block])) return [block];
    if (block.type === 'table') {
      const [head = [], ...rows] = block.cells;
      const cards = (body: Cell[][]): RichBlock[] => body.flatMap(row => row.map((cell, index) => ({
        type: 'paragraph' as const, text: `${plain(head[index]?.text ?? `Column ${index + 1}`)}: ${plain(cell.text)}`,
      }))).flatMap(item => fragments(item));
      if (head.length > 20 || !fits([{ ...block, cells: [head] }])) return cards(rows.length ? rows : [head]);
      const result: RichBlock[] = []; let batch = [head];
      for (const row of rows) {
        if (!fits([{ ...block, cells: [head, row] }])) {
          if (batch.length > 1) result.push({ ...block, cells: batch });
          batch = [head]; result.push(...cards([row])); continue;
        }
        if (!fits([{ ...block, cells: [...batch, row] }])) { result.push({ ...block, cells: batch }); batch = [head]; }
        batch.push(row);
      }
      if (batch.length > 1 || !result.length) result.push({ ...block, cells: batch });
      return result;
    }
    if (block.type === 'blockquote') return block.blocks.flatMap(fragments);
    if (block.type === 'divider') return [block];
    return textChunks(plain(block.text)).map(text => block.type === 'pre' ? { ...block, text } : { type: 'paragraph', text });
  };
  const result: RichPart[] = []; let batch: RichBlock[] = [];
  const flush = (): void => {
    if (batch.length) result.push({ richMessage: { blocks: [header, ...batch], skip_entity_detection: true }, fallback: plainBlocks(batch) });
    batch = [];
  };
  for (const item of content.flatMap(fragments)) {
    if (!fits([...batch, item])) flush();
    batch.push(item);
  }
  flush();
  return result;
}

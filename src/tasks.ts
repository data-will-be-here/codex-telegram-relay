import { renderMarkdown } from './format.js';
import { array, object, string } from './types.js';

/** A local excerpt of the first user request, never a model-generated session rename. */
export function taskTitle(items: unknown[]): string | undefined {
  const input = items.slice(0, 512).map(object).find(item => item.type === 'userMessage');
  if (!input) return;
  const content = array(input.content).slice(0, 64).map(object);
  const source = content.filter(part => part.type === 'text').map(part => string(part.text).slice(0, 4096)).join('\n');
  const first = renderMarkdown(source.slice(0, 4096)).text.split(/\r?\n/u).find(line => line.trim()) ?? '';
  const text = first.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  if (chars.length <= 80) return text || (content.length ? 'Review attachment' : undefined);
  const prefix = chars.slice(0, 79).join('');
  const space = prefix.lastIndexOf(' ');
  return (space >= prefix.length / 2 ? prefix.slice(0, space) : prefix).trimEnd() + '…';
}

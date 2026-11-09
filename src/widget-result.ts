import { deflateSync } from 'node:zlib';
import { renderMarkdown, projectHeader, type FormattedText } from './format.js';
import { widgetData } from './widget-template.js';
import { type WidgetCard } from './widget-types.js';
import { type RichDeliveryPart } from './state.js';

const MAX_TEXT = 400;
const payload = (value: unknown): string => JSON.stringify(value).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')
  .replace(/&/gu, '\\u0026').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

function clip(message: FormattedText, start: number, end: number): FormattedText {
  return { text: message.text.slice(start, end), entities: message.entities.flatMap(entity => {
    const from = Math.max(start, entity.offset); const to = Math.min(end, entity.offset + entity.length);
    return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
  }) };
}

function cut(text: string, limit: number): number {
  let lines = 1; let column = 0; let offset = 0;
  for (const char of text.slice(0, limit)) {
    const cost = /[\u2e80-\u9fff\uac00-\ud7af]/u.test(char) || char.length > 1 ? 2 : 1;
    if (char === '\n') { lines++; column = 0; }
    else if ((column += cost) > 30) { lines++; column = cost; }
    if (lines > 12) { limit = offset; break; }
    offset += char.length;
  }
  if (text.length <= limit) return text.length;
  const prefix = text.slice(0, limit);
  const paragraph = prefix.lastIndexOf('\n\n');
  const sentence = [...prefix.matchAll(/[.!?](?:[»”"')\]]*)?(?=\s)/gu)].at(-1);
  let end = paragraph >= limit / 2 ? paragraph + 2 : sentence && sentence.index + sentence[0].length >= limit / 2 ?
    sentence.index + sentence[0].length : Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '));
  if (end < limit / 2) end = limit;
  if (/[\uD800-\uDBFF]$/u.test(text.slice(0, end))) end--;
  return Math.max(1, end);
}

function formatted(source: string): FormattedText {
  const message = renderMarkdown(source);
  // The widget SDK opens HTTPS links up to 256 normalized characters. Keep other targets readable.
  const unsupported = message.entities.filter(entity => entity.type === 'text_link' &&
    (!entity.url?.startsWith('https://') || encodeURI(entity.url).length > 256)).sort((a, b) => b.offset - a.offset);
  for (const link of unsupported) {
    if (!link.url) continue;
    const at = link.offset + link.length; const suffix = ` (${link.url})`;
    message.text = message.text.slice(0, at) + suffix + message.text.slice(at);
    message.entities = message.entities.filter(entity => !(entity.type === 'text_link' && entity.offset === link.offset && entity.length === link.length && entity.url === link.url)).map(entity => ({ ...entity,
      offset: entity.offset >= at ? entity.offset + suffix.length : entity.offset,
      length: entity.offset < at && entity.offset + entity.length > at ? entity.length + suffix.length : entity.length,
    }));
  }
  return message;
}

/** Fixed reader code; model text is a safely serialized data literal and enters DOM through textContent. */
const READER = String.raw`var points=[0],at=0;Array.from(D.text).forEach(function(c){at+=c.length;points.push(at)});var start=0,end=0,trail=[],width=0;
function el(id){return document.getElementById(id)}
el('context').textContent=D.context;if(D.part===1)el('status').textContent=D.status;el('part').textContent=D.total>1?D.part+'/'+D.total:'';
function draw(a,b){var body=el('content');body.textContent='';var head=(D.text.match(/^\n+/)||[''])[0].length,tail=D.text.length-(D.text.match(/\n+$/)||[''])[0].length;var marks=[a,b];if(head>a&&head<b)marks.push(head);if(tail>a&&tail<b)marks.push(tail);D.entities.forEach(function(e){var l=Math.max(a,e.offset),r=Math.min(b,e.offset+e.length);if(r>l){marks.push(l);marks.push(r)}});marks=Array.from(new Set(marks)).sort(function(x,y){return x-y});for(var i=0;i<marks.length-1;i++){var l=marks[i],r=marks[i+1],active=D.entities.filter(function(e){return e.offset<=l&&e.offset+e.length>=r});var node=document.createElement('span');node.textContent=D.text.slice(l,r);active.forEach(function(e){var tag={bold:'strong',italic:'em',strikethrough:'del',code:'code',pre:'code',text_link:'a'}[e.type];if(!tag)return;var wrap=document.createElement(tag);if(e.type==='pre')wrap.className='pre';if(e.type==='text_link'&&e.url&&e.url.indexOf('https://')===0)wrap.setAttribute('href',e.url);wrap.appendChild(node);node=wrap});if(r<=head||l>=tail)node.style.display='none';body.appendChild(node)}}
function fit(){var body=el('content'),nav=el('nav');body.setAttribute('aria-busy','true');body.style.visibility='hidden';body.style.maxHeight='';nav.style.display='flex';el('back').disabled=!trail.length;el('next').disabled=false;el('page').textContent='Page '+(trail.length+1);var font=parseFloat(getComputedStyle(document.body).fontSize)||15;document.body.className=font>=40?'large':'';draw(points[start],points[points.length-1]);width=body.clientWidth;if(!width)return;var room=Math.max(48,560-el('card').getBoundingClientRect().height+body.clientHeight);body.style.maxHeight=room+'px';var low=start+1,high=points.length-1,best=start;while(low<=high){var mid=Math.floor((low+high)/2);draw(points[start],points[mid]);if(body.scrollHeight<=body.clientHeight+1){best=mid;low=mid+1}else high=mid-1}end=Math.max(start+1,best);if(end<points.length-1){var a=points[start],b=points[end],text=D.text.slice(a,b),boundary=Math.max(text.lastIndexOf('\n\n')+1,text.lastIndexOf(' '));if(boundary>text.length/2){var target=a+boundary;while(end>start+1&&points[end]>target)end--}}draw(points[start],points[end]);while(end>start+1&&body.scrollHeight>body.clientHeight+1){end=start+Math.floor((end-start)/2);draw(points[start],points[end])}el('next').disabled=end>=points.length-1;if(!trail.length&&end>=points.length-1)nav.style.display='none';body.style.visibility='visible';body.setAttribute('aria-busy','false')}
el('back').onclick=function(){if(trail.length){start=trail.pop();fit()}};el('next').onclick=function(){if(end<points.length-1){trail.push(start);start=end;fit()}};
TelegramWidget.onEvent('themeChanged',fit);TelegramWidget.onEvent('contentSafeAreaChanged',fit);new ResizeObserver(function(){if(el('content').clientWidth!==width)fit()}).observe(document.body);fit();TelegramWidget.ready();`;

export function resultDocument(card: WidgetCard, message: FormattedText, part: number, total: number): string {
  const data = { context: projectHeader(card.binding.cwd, card.binding.sessionName, card.binding.projectLabel).replace(/^» /u, ''),
    status: card.snapshot.status === 'done' ? 'Answer ready' : card.snapshot.status === 'failed' ? 'Turn failed' : 'Turn interrupted',
    part, total, text: message.text, entities: message.entities };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:var(--tg-text-font-size)/var(--tg-text-line-height) system-ui;color:var(--tg-theme-text-color)}
main{padding:var(--tg-text-padding);padding-bottom:max(12px,env(safe-area-inset-bottom))}.context{color:var(--tg-theme-hint-color);font-size:.8em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
header{display:flex;align-items:center;gap:.6em;margin:.65em 0}h3{margin:0;font-size:1.05em;min-width:0;overflow-wrap:anywhere}#part{margin-left:auto;white-space:nowrap;color:var(--tg-theme-hint-color);font-size:.85em}
#content{white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;line-height:1.4;font-size:.95em;user-select:text}strong{font-weight:600}code{font-family:ui-monospace,monospace;font-size:.9em;background:var(--tg-theme-secondary-bg-color);border-radius:.25em}.pre{display:block;padding:.5em;white-space:pre-wrap;overflow-wrap:anywhere}a{color:var(--tg-theme-link-color)}
nav{display:flex;align-items:center;justify-content:space-between;gap:.2em;margin-top:.65em}button{font-size:.85em}#page{font-size:.75em;color:var(--tg-theme-hint-color)}.large .context{display:none}.large header{display:block;margin:.3em 0}.large h3{font-size:.7em}.large #part{font-size:.45em}.large nav{margin-top:.3em}.large button{font-size:.55em;padding:.1em .3em}.large #page{font-size:.3em}
</style></head><body><main id="card"><div id="context" class="context"></div><header>${part === 1 ? '<h3 id="status"></h3>' : ''}<span id="part"></span></header><section id="content"></section><nav id="nav"><button id="back" aria-label="Previous page">‹</button><span id="page"></span><button id="next" aria-label="Next page">›</button></nav></main><script>var D=${payload(data)};${READER}</script></body></html>`;
}

/** Every rendered character is preserved; fixed document/code and independent local paging survive relay shutdown. */
export function resultParts(card: WidgetCard, source: string, token: string): RichDeliveryPart[] {
  const message = formatted(source); const chunks: FormattedText[] = [];
  for (let offset = 0; offset < message.text.length;) {
    const end = offset + cut(message.text.slice(offset), MAX_TEXT);
    chunks.push(clip(message, offset, end)); offset = end;
  }
  if (!chunks.length) chunks.push({ text: '', entities: [] });
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]!; const html = resultDocument(card, chunk, index + 1, chunks.length);
    if (Buffer.byteLength(html) <= 32_768 && deflateSync(html, { level: 9 }).length <= 3800) continue;
    if (chunk.text.length < 2) throw new Error('A result widget exceeded its safe document budget.');
    const middle = cut(chunk.text, Math.floor(chunk.text.length / 2));
    chunks.splice(index, 1, clip(chunk, 0, middle), clip(chunk, middle, chunk.text.length)); index = -1;
  }
  return chunks.map((chunk, index) => ({ method: 'sendWidget', params: { html: resultDocument(card, chunk, index + 1, chunks.length),
    chat_data: widgetData(card), allow_queries: false, is_shared: false, disable_notification: index !== 0,
    ...(index === chunks.length - 1 ? { reply_markup: { inline_keyboard: [[{ text: 'Text version', callback_data: `a:${token}` }]] } } : {}) },
    fallback: chunk.text, fallbackText: chunk }));
}

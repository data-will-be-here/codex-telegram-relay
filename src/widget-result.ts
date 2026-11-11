import { deflateSync } from 'node:zlib';
import { Lexer, type MarkedToken, type Token } from 'marked';
import { renderMarkdown, renderMarkdownTokens, projectHeader, type FormattedText } from './format.js';
import { richTokenMessages, richDocument, richTokenDocument, RichTableTooLarge, type RichPart } from './rich.js';
import { widgetData, widgetCaption } from './widget-template.js';
import { type WidgetCard } from './widget-types.js';
import { type RichDeliveryPart } from './state.js';
import { type ScreenOptions } from './screen-types.js';

// The complete measured document includes the reader, styles and escaped model data.
// Keep 96 bytes below Telegram's 4096-byte zlib limit without splitting fitting answers at 3800.
const MAX_COMPRESSED_BYTES = 4000;

/** Bound flow cards by visual density, then fit the complete part to the client's actual font. */
function flowLimit(text: string): number {
  let lines = 1; let column = 0; let offset = 0;
  for (const char of text) {
    const cost = /[\u2e80-\u9fff\uac00-\ud7af]/u.test(char) || char.length > 1 ? 2 : 1;
    if (char === '\n') { lines++; column = 0; }
    else if ((column += cost) > 30) { lines++; column = cost; }
    if (lines > 27) break;
    offset += char.length;
  }
  return cut(text, offset);
}

const payload = (value: unknown): string => JSON.stringify(value).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')
  .replace(/&/gu, '\\u0026').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

function clip(message: FormattedText, start: number, end: number): FormattedText {
  return { text: message.text.slice(start, end), entities: message.entities.flatMap(entity => {
    const from = Math.max(start, entity.offset); const to = Math.min(end, entity.offset + entity.length);
    return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
  }) };
}

function cut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const prefix = text.slice(0, limit);
  const paragraph = prefix.lastIndexOf('\n\n');
  const sentence = [...prefix.matchAll(/[.!?](?:[»”"')\]]*)?(?=\s|$)/gu)].at(-1);
  const boundary = Math.max(paragraph >= 0 ? paragraph + 2 : 0, sentence ? sentence.index + sentence[0].length : 0);
  let end = boundary >= limit * .25 ? boundary : Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '));
  if (end < limit * .25) end = limit;
  if (/[\uD800-\uDBFF]$/u.test(text.slice(0, end))) end--;
  return end || (text.codePointAt(0)! > 0xffff ? 2 : 1);
}

function formatted(source: string | Token[]): FormattedText {
  const message = typeof source === 'string' ? renderMarkdown(source) : renderMarkdownTokens(source);
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

/** Fixed reader code; model text is a safely serialized data literal and enters DOM through textContent.
 * Future pages are measured offscreen, one per frame, without replacing the visible page. */
const RENDER = String.raw`function el(id){return document.getElementById(id)}
el('context').textContent=D.context;if(D.part===1)el('status').textContent=D.status;el('part').textContent=D.total>1?'Part '+D.part+'/'+D.total:'';
function draw(a,b,body){body=body||el('content');body.textContent='';var head=(D.text.match(/^\n+/)||[''])[0].length,tail=D.text.length-(D.text.match(/\n+$/)||[''])[0].length;var marks=[a,b];if(head>a&&head<b)marks.push(head);if(tail>a&&tail<b)marks.push(tail);D.entities.forEach(function(e){var l=Math.max(a,e.offset),r=Math.min(b,e.offset+e.length);if(r>l){marks.push(l);marks.push(r)}});marks=Array.from(new Set(marks)).sort(function(x,y){return x-y});for(var i=0;i<marks.length-1;i++){var l=marks[i],r=marks[i+1],active=D.entities.filter(function(e){return e.offset<=l&&e.offset+e.length>=r});var node=document.createElement('span');node.textContent=D.text.slice(l,r);active.forEach(function(e){var tag={bold:'strong',italic:'em',strikethrough:'del',code:'code',pre:'code',text_link:'a'}[e.type];if(!tag)return;var wrap=document.createElement(tag);if(e.type==='pre')wrap.className='pre';if(e.type==='text_link'&&e.url&&e.url.indexOf('https://')===0){wrap.setAttribute('href',e.url);wrap.onclick=function(event){var method=/^https:\/\/(?:[a-z0-9-]+\.)*(?:t\.me|telegram\.me|telegram\.dog)(?=[:/?#]|$)/i.test(e.url)?'openTelegramLink':'openLink';if(typeof TelegramWidget[method]==='function'){event.preventDefault();TelegramWidget[method](e.url)}}}wrap.appendChild(node);node=wrap});if(r<=head||l>=tail)node.style.display='none';body.appendChild(node)}}
`;

const READER = String.raw`var points=[0],at=0;Array.from(D.text).forEach(function(c){at+=c.length;points.push(at)});var pages=[0],page=0,done=false,width=0,epoch=0,target=-1;
` + RENDER + String.raw`function append(){var body=el('measure'),start=pages[pages.length-1],low=start+1,high=points.length-1,best=start;if(start>=points.length-1){pages.push(start);done=true;return}while(low<=high){var mid=Math.floor((low+high)/2);draw(points[start],points[mid],body);if(body.scrollHeight<=body.clientHeight+1){best=mid;low=mid+1}else high=mid-1}var end=Math.max(start+1,best);if(end<points.length-1){var text=D.text.slice(points[start],points[end]),matches=Array.from(text.matchAll(/[.!?](?:[»”"')\]]*)?(?=\s)/g)),sentence=matches.length?matches[matches.length-1]:null,boundary=text.lastIndexOf('\n\n')+2;if(boundary<text.length*.7)boundary=sentence?sentence.index+sentence[0].length:0;if(boundary<text.length*.7)boundary=Math.max(text.lastIndexOf('\n')+1,text.lastIndexOf(' ')+1);if(boundary>text.length*.7){var offset=points[start]+boundary;while(end>start+1&&points[end]>offset)end--}}draw(points[start],points[end],body);while(end>start+1&&body.scrollHeight>body.clientHeight+1){end=start+Math.floor((end-start)/2);draw(points[start],points[end],body)}pages.push(end);done=end>=points.length-1;if(target>=start&&target<end){page=pages.length-2;target=-1}}
function paint(){draw(points[pages[page]],points[pages[page+1]]);el('content').style.height=done&&pages.length===2?'':el('content').style.maxHeight;el('back').disabled=page===0;el('next').disabled=done&&page===pages.length-2;el('page').textContent=(page+1)+'/'+(done?pages.length-1:'…');el('nav').style.display=done&&pages.length===2?'none':'flex';el('content').setAttribute('aria-busy','false')}
function build(ticket){if(ticket!==epoch||done)return;append();paint();if(!done)requestAnimationFrame(function(){build(ticket)})}
function fit(){var body=el('content');width=body.clientWidth;if(!width)return;var ticket=++epoch;target=pages[page]||0;pages=[0];page=0;done=false;body.style.height='';body.style.maxHeight='';el('nav').style.display='flex';el('page').textContent='1/…';var font=parseFloat(getComputedStyle(document.body).fontSize)||15;document.body.className=font>=40?'large':'';draw(0,0);body.style.maxHeight=Math.max(48,580-el('card').getBoundingClientRect().height)+'px';el('measure').style.width=width+'px';el('measure').style.maxHeight=body.style.maxHeight;append();paint();if(!done)requestAnimationFrame(function(){build(ticket)})}
function move(step){if(step<0&&page>0)page--;else if(step>0){if(page===pages.length-2&&!done)append();if(page<pages.length-2)page++}target=-1;paint()}
el('back').onclick=function(){move(-1)};el('next').onclick=function(){move(1)};
var drag=null,swiped=false;el('content').addEventListener('pointerdown',function(e){swiped=false;drag=e.button===0?{id:e.pointerId,x:e.clientX,y:e.clientY,time:Date.now()}:null});el('content').addEventListener('pointercancel',function(){drag=null});el('content').addEventListener('pointerup',function(e){var d=drag;drag=null;if(!d||d.id!==e.pointerId)return;var x=e.clientX-d.x,y=e.clientY-d.y;if(Math.abs(x)>=40&&Math.abs(x)>Math.abs(y)*1.3&&Date.now()-d.time<1500){swiped=true;move(x<0?1:-1);e.preventDefault()}});el('content').addEventListener('click',function(e){if(swiped){e.preventDefault();e.stopPropagation();swiped=false}},true);
TelegramWidget.onEvent('themeChanged',fit);TelegramWidget.onEvent('contentSafeAreaChanged',fit);new ResizeObserver(function(){if(el('content').clientWidth!==width)fit()}).observe(document.body);fit();TelegramWidget.ready();`;

/** Flow parts have no page controls or horizontal gesture claim; all their text remains visible. */
const FLOW = RENDER + String.raw`draw(0,D.text.length);var width=0;
function fit(){var body=el('content');width=body.clientWidth;if(!width)return;var font=parseFloat(getComputedStyle(document.body).fontSize)||15;document.body.className='flow'+(font>=40?' large':'');body.style.fontSize='';body.style.lineHeight='';var max=parseFloat(getComputedStyle(body).fontSize)||font*.95;if(el('card').getBoundingClientRect().height>580){var low=12,high=max;for(var i=0;i<9;i++){var mid=(low+high)/2;body.style.fontSize=mid+'px';if(el('card').getBoundingClientRect().height<=580)low=mid;else high=mid}body.style.fontSize=low+'px';if(el('card').getBoundingClientRect().height>580)body.style.lineHeight='1.2'}body.setAttribute('aria-busy','false')}
TelegramWidget.onEvent('themeChanged',fit);TelegramWidget.onEvent('contentSafeAreaChanged',fit);new ResizeObserver(function(){if(el('content').clientWidth!==width)fit()}).observe(document.body);fit();TelegramWidget.ready();`;

export function fitsDocument(html: string): boolean {
  return Buffer.byteLength(html) <= 32_768 && deflateSync(html, { level: 9 }).length <= MAX_COMPRESSED_BYTES;
}

export function resultDocument(card: WidgetCard, message: FormattedText, part: number, total: number, paged = true, screen?: ScreenOptions): string {
  const data = { context: projectHeader(card.binding.cwd, card.binding.sessionName, card.binding.projectLabel).replace(/^» /u, ''),
    status: screen?.title ?? (card.kind === 'status' ? 'Current status' : card.snapshot.status === 'done' ? 'Answer ready' : card.snapshot.status === 'failed' ? 'Turn failed' : 'Turn interrupted'),
    part, total, text: message.text, entities: message.entities, ...(screen?.meters?.length ? { meters: screen.meters.slice(0, 2) } : {}) };
  const live = screen ? String.raw`TelegramWidget.onEvent('chatDataChanged',function(){try{var p=JSON.parse(TelegramWidget.chatData||'null');if(!p||p.v!==1)return;if(p.title){D.status=p.title;if(D.part===1)el('status').textContent=p.title}` +
    (screen.editable ? String.raw`if(typeof p.text==='string'){D.text=p.text;D.entities=[];points=[0];at=0;Array.from(D.text).forEach(function(c){at+=c.length;points.push(at)})}` : '') + String.raw`fit()}catch(e){}});` : '';
  const meters = screen?.meters?.length ? String.raw`D.meters.forEach(function(m){var row=document.createElement('div');row.textContent=m.label+' · '+m.remaining+'%';var track=document.createElement('div'),fill=document.createElement('div');track.className='meter';fill.style.width=m.remaining+'%';track.appendChild(fill);el('meters').appendChild(row);el('meters').appendChild(track)});` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:var(--tg-text-font-size)/var(--tg-text-line-height) system-ui;color:var(--tg-theme-text-color)}
main{padding:var(--tg-text-padding);padding-bottom:max(12px,env(safe-area-inset-bottom))}.topline{display:flex;align-items:flex-start;gap:8px;margin-bottom:.65em}.context{flex:1;min-width:0;color:var(--tg-theme-hint-color);font-size:min(.8em,16px);overflow-wrap:anywhere}
header{display:flex;align-items:center;gap:.6em;margin:.65em 0}.badge{width:2em;height:2em;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color);flex-shrink:0}.done{color:#22a35a}@media(prefers-color-scheme:dark){.done{color:#65d991}}.status{color:var(--tg-theme-link-color)}.failed{color:var(--tg-theme-destructive-text-color)}h3{margin:0;font-size:1.05em;min-width:0;overflow-wrap:anywhere}#part{margin-left:auto;flex-shrink:0;white-space:nowrap;color:var(--tg-theme-hint-color);font-size:min(.8em,16px)}
#content,#measure{white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;line-height:1.4;font-size:.95em;user-select:text;touch-action:pan-y}#measure{position:absolute;left:0;top:0;visibility:hidden;pointer-events:none}strong{font-weight:600}code{font-family:ui-monospace,monospace;font-size:.9em;background:var(--tg-theme-secondary-bg-color);border-radius:.25em}.pre{display:block;padding:.5em;white-space:pre-wrap;overflow-wrap:anywhere}a{color:var(--tg-theme-link-color)}
nav{display:flex;align-items:center;justify-content:space-between;gap:.2em;margin-top:.65em}button{font-size:.85em}#page{font-size:.75em;color:var(--tg-theme-hint-color)}.large header{flex-wrap:wrap;margin:.3em 0}.large .badge{width:1.5em;height:1.5em;font-size:.55em}.large h3{font-size:.7em}.large nav{margin-top:.3em}.large button{font-size:.55em;padding:.1em .3em}.large #page{font-size:.3em}
${paged ? '' : '.flow header{font-size:min(1em,24px);flex-wrap:wrap}.flow h3{flex:1;font-size:min(1.05em,20px)}.flow .badge{width:1.6em;height:1.6em}.flow #content{overflow:visible;touch-action:auto}'}
${screen?.meters?.length ? '#meters{font-size:min(.8em,16px);overflow-wrap:anywhere}.meter{height:4px;background:var(--tg-theme-secondary-bg-color);margin:.3em 0 .6em;border-radius:3px}.meter div{height:100%;background:var(--tg-theme-link-color);border-radius:3px}.large #meters{display:none}' : ''}
</style></head><body><main id="card"><div class="topline"><div id="context" class="context"></div><span id="part"></span></div>${part === 1 ? `<header><span class="badge ${screen || card.kind === 'status' ? 'status' : card.snapshot.status}">${screen ? screen.kind === 'approval' ? '!' : screen.kind === 'question' ? '?' : '●' : card.kind === 'status' ? '●' : card.snapshot.status === 'done' ? '✓' : card.snapshot.status === 'failed' ? '!' : '■'}</span><h3 id="status"></h3></header>` : ''}${screen?.meters?.length ? '<section id="meters"></section>' : ''}<section id="content"></section>${paged ? '<nav id="nav"><button id="back" aria-label="Previous page">‹</button><span id="page"></span><button id="next" aria-label="Next page">›</button></nav>' : ''}</main>${paged ? '<section id="measure" aria-hidden="true"></section>' : ''}<script>var D=${payload(data)};${meters}${paged ? READER : FLOW}${live}</script></body></html>`;
}

type ResultDraft = { kind: 'widget'; message: FormattedText } | { kind: 'rich'; part: RichPart } | { kind: 'document'; html: string; fallback: string };

function containsTable(raw: Token, depth = 0): boolean {
  const token = raw as MarkedToken;
  if (depth > 32) return false;
  return token.type === 'table' || token.type === 'blockquote' && token.tokens.some(child => containsTable(child, depth + 1)) ||
    token.type === 'list' && token.items.some(item => item.tokens.some(child => containsTable(child, depth + 1)));
}

function flowDrafts(message: FormattedText): ResultDraft[] {
  const parts: ResultDraft[] = [];
  for (let start = 0; start < message.text.length;) {
    const end = start + flowLimit(message.text.slice(start));
    parts.push({ kind: 'widget', message: clip(message, start, end) }); start = end;
  }
  return parts;
}

export function screenDocuments(card: WidgetCard, message: FormattedText, screen: ScreenOptions): { html: string; message: FormattedText }[] | undefined {
  const html = resultDocument(card, message, 1, 1, true, screen);
  if (fitsDocument(html)) return [{ html, message }];
  if (screen.editable) return;
  const drafts = flowDrafts(message).filter((draft): draft is Extract<ResultDraft, { kind: 'widget' }> => draft.kind === 'widget');
  const parts = drafts.map((draft, index) => ({ message: draft.message,
    html: resultDocument(card, draft.message, index + 1, drafts.length, false, { ...screen, meters: index ? [] : screen.meters }) }));
  return parts.every(part => fitsDocument(part.html)) ? parts : undefined;
}

/** Partition the resolved Markdown tree, keeping real tables separate from literal code and reference definitions. */
export function resultParts(card: WidgetCard, source: string, token: string): RichDeliveryPart[] {
  let tokens: Token[] | undefined;
  try { tokens = Lexer.lex(source, { gfm: true }); } catch { /* Fixed text rendering remains the safe fallback. */ }
  const mixed = tokens?.some(item => containsTable(item)) ?? false;
  const drafts: ResultDraft[] = [];
  let paged = false;
  if (!mixed) {
    const message = formatted(tokens ?? source);
    paged = fitsDocument(resultDocument(card, message, 1, 1));
    drafts.push(...(paged ? [{ kind: 'widget' as const, message }] : flowDrafts(message)));
    if (!drafts.length) drafts.push({ kind: 'widget', message });
  } else {
    let text: Token[] = [];
    const flush = (): void => {
      if (!text.some(item => !['space', 'def'].includes(item.type))) { text = []; return; }
      const message = formatted(text);
      if (message.text.trim()) drafts.push(...flowDrafts(message));
      text = [];
    };
    for (const item of tokens!) {
      if (!containsTable(item)) { text.push(item); continue; }
      flush();
      try {
        drafts.push(...richTokenMessages([item], card.binding.cwd, card.binding.sessionName, card.binding.projectLabel, true).map(part => ({ kind: 'rich' as const, part })));
      } catch (error) {
        if (!(error instanceof RichTableTooLarge)) throw error;
        drafts.push({ kind: 'document', html: richTokenDocument([item]), fallback: item.raw });
      }
    }
    flush();
  }
  const completion = card.kind === 'status' ? 'Current status' : card.snapshot.status === 'done' ? '✅ Answer ready' : card.snapshot.status === 'failed' ? '❌ Turn failed' : '⏹ Turn interrupted';
  const materialize = (draft: ResultDraft, index: number): RichDeliveryPart => {
    const part = index + 1; const total = drafts.length;
    const resultMeta = { part, total, ...(index === 0 ? { completion } : {}) };
    const common = { disable_notification: index !== 0,
      ...(index === total - 1 ? { reply_markup: { inline_keyboard: [[{ text: 'Text version', callback_data: `a:${token}` }]] } } : {}) };
    if (draft.kind === 'widget') return { method: 'sendWidget', resultMeta, params: { ...common, html: resultDocument(card, draft.message, part, total, paged),
      caption: widgetCaption(index ? `Part ${part}/${total}` : completion, card.binding.title),
      chat_data: widgetData(card), allow_queries: false, is_shared: false }, fallback: draft.message.text, fallbackText: draft.message };
    const attachment = drafts.slice(0, index + 1).filter(item => item.kind !== 'widget').length;
    const title = `Attachment ${attachment} · Table`;
    const tableCaption = [index === 0 ? completion : '', title].filter(Boolean).join('\n');
    if (draft.kind === 'document') return { method: 'sendDocument', resultMeta, params: { ...common, caption: tableCaption },
      document: { name: `table-${attachment}.html`, html: draft.html }, fallback: draft.fallback };
    const body = draft.part.richMessage.blocks.slice(1);
    const richMessage: RichPart['richMessage'] = { ...draft.part.richMessage, blocks: [
      ...(index === 0 ? [{ type: 'paragraph' as const, text: { type: 'bold' as const, text: completion } }] : []),
      { type: 'paragraph', text: { type: 'bold', text: title } },
      ...body,
    ] };
    return { method: 'sendRichMessage', resultMeta, params: { ...common, rich_message: richMessage }, fallback: draft.part.fallback,
      tableDocument: richDocument(richMessage.blocks), tableCaption };
  };
  // Global part numbers are included before measuring; splitting never changes an accepted delivery.
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]!;
    if (draft.kind !== 'widget' || fitsDocument(String(materialize(draft, index).params.html))) continue;
    const middle = cut(draft.message.text, Math.floor(draft.message.text.length / 2));
    if (!middle || middle >= draft.message.text.length) throw new Error('A result widget exceeded its safe document budget.');
    drafts.splice(index, 1, { kind: 'widget', message: clip(draft.message, 0, middle) }, { kind: 'widget', message: clip(draft.message, middle, draft.message.text.length) }); index = -1;
  }
  return drafts.map(materialize);
}

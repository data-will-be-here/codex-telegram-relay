import { basename } from 'node:path';
import { type WidgetCard } from './widget-types.js';
import { renderMarkdown } from './format.js';

const normalized = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();

export function widgetLabel(value: string, bytes: number): string {
  let result = '';
  for (const char of normalized(value)) {
    if (Buffer.byteLength(result + char) > bytes) break;
    result += char;
  }
  return result;
}

/** JSON-string budget includes escaping and an explicit ellipsis for omitted text. */
export function widgetPreview(value: string, budget: number): string {
  const text = normalized(value);
  if (Buffer.byteLength(JSON.stringify(text)) <= budget) return text;
  const chars = Array.from(text);
  let low = 0; let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(chars.slice(0, mid).join('') + ' …')) <= budget) low = mid;
    else high = mid - 1;
  }
  const prefix = chars.slice(0, low).join('');
  const sentence = [...prefix.matchAll(/[.!?…](?:[»”"')\]]*)?(?=\s|$)/gu)].at(-1);
  if (sentence) return prefix.slice(0, sentence.index + sentence[0].length) + ' …';
  const space = prefix.lastIndexOf(' ');
  return (space >= prefix.length / 2 ? prefix.slice(0, space) : prefix).trimEnd() + '…';
}

type PreviewStyle = [number, number, number];

/** Map Markdown entity offsets through the same whitespace normalization as the live preview. */
function formattedPreview(source: string): { text: string; styles: PreviewStyle[] } {
  const message = renderMarkdown(source);
  const offsets = new Uint32Array(message.text.length + 1);
  let text = '';
  for (let index = 0; index < message.text.length; index++) {
    const char = message.text[index]!;
    if (/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(char)) {
      if (text && !text.endsWith(' ')) text += ' ';
    } else text += char;
    offsets[index + 1] = text.length;
  }
  text = text.trimEnd();
  const kinds: Record<string, number> = { bold: 0, italic: 1, strikethrough: 2, code: 3, pre: 3 };
  const styles = message.entities.flatMap((entity): PreviewStyle[] => {
    const kind = kinds[entity.type];
    const start = Math.min(text.length, offsets[entity.offset]!);
    const end = Math.min(text.length, offsets[entity.offset + entity.length]!);
    return kind !== undefined && end > start ? [[kind, start, end - start]] : [];
  }).sort((a, b) => a[1] - b[1] || b[2] - a[2]).slice(0, 24);
  return { text, styles };
}

export function widgetData(card: WidgetCard): string {
  const s = card.snapshot;
  const data = { v: 1, r: card.revision, k: card.kind, p: widgetLabel(card.binding.projectLabel || basename(card.binding.cwd), 24),
    t: widgetLabel(card.binding.sessionName || card.binding.threadId.slice(0, 8), 48), s: s.status,
    b: s.startedAt, e: s.finishedAt, u: s.updatedAt, n: s.plan ? [s.plan.done, s.plan.total] : null, q: '', f: undefined as PreviewStyle[] | undefined,
    a: s.activities.slice(-3).map(item => [item.status, widgetLabel(item.label, 48)]) };
  const available = 900 - Buffer.byteLength(JSON.stringify(data)) + 2;
  const content = s.progressText || s.summary || s.plan?.current || '';
  const preview = formattedPreview(content);
  for (let budget = available; budget >= 2;) {
    data.q = widgetPreview(preview.text, budget);
    let prefix = 0;
    while (prefix < data.q.length && data.q[prefix] === preview.text[prefix]) prefix++;
    const styles = preview.styles.flatMap(([kind, start, length]): PreviewStyle[] =>
      start < prefix ? [[kind, start, Math.min(length, prefix - start)]] : []);
    data.f = styles.length ? styles : undefined;
    const result = JSON.stringify(data); const excess = Buffer.byteLength(result) - 900;
    if (excess <= 0) return result;
    budget -= excess;
  }
  throw new Error('Widget state exceeded its bounded preview budget.');
}

/** Fixed code only. Native/user strings enter through chatData and textContent. */
export const WIDGET_HTML = String.raw`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:0;font-family:system-ui;font-size:var(--tg-text-font-size);line-height:var(--tg-text-line-height);color:var(--tg-theme-text-color)}
main{padding:var(--tg-text-padding);padding-bottom:max(12px,env(safe-area-inset-bottom))}
.muted{color:var(--tg-theme-hint-color)}.context{font-size:.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
header{display:flex;align-items:center;gap:.65em;margin:.8em 0}.badge{width:2em;height:2em;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-accent-text-color,var(--tg-theme-link-color));flex-shrink:0}
h3{margin:0;font-size:1.1em;line-height:1.3;min-width:0;overflow-wrap:anywhere}.time{margin-left:auto;font-size:.85em;white-space:nowrap;color:var(--tg-theme-hint-color)}
section{padding:.75em;border-radius:.8em;background:var(--tg-theme-secondary-bg-color)}
.line{display:flex;align-items:center;gap:.65em;margin:.55em 0}.line span:last-child{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.icon{width:1.15em;flex-shrink:0;color:var(--tg-theme-accent-text-color,var(--tg-theme-link-color))}
.error{color:var(--tg-theme-destructive-text-color,var(--tg-theme-text-color))}.track{height:.3em;border-radius:.3em;overflow:hidden;margin:.6em 0;background:var(--tg-theme-bg-color)}.fill{height:100%;background:var(--tg-theme-accent-text-color,var(--tg-theme-button-color))}
footer{font-size:.75em;color:var(--tg-theme-hint-color);margin-top:.7em;padding-left:var(--tg-content-safe-area-corner-left,0px);padding-right:var(--tg-content-safe-area-corner-right,0px)}
.large #step{max-height:4.2em}.large header{gap:.4em}.large .badge{width:1.6em;height:1.6em}.large .line{margin:.35em 0}.huge .context,.huge footer,.huge .badge,.huge #rows,.huge #plan,.huge .track{display:none}.huge header{display:block;margin:.4em 0}.huge .time{margin-top:.5em}.huge section{padding:.4em}.huge #step{max-height:1.4em}#step{white-space:normal;overflow-wrap:anywhere;overflow:hidden;max-height:7em;line-height:1.4;font-size:.9em}
#step strong{font-weight:600}#step code{font-family:ui-monospace,monospace;font-size:.95em}
#expand{display:none;font:inherit;font-size:.8em;color:var(--tg-theme-link-color);background:transparent;border:0;padding:.2em 0;margin:.2em 0}
</style></head><body><main><div class="context muted" id="context">Codex</div><header><div class="badge" id="badge">●</div><h3 id="status">Working</h3><div class="time" id="elapsed"></div></header><section id="body"><div class="muted" id="plan"></div><div class="track" id="track"><div class="fill" id="fill"></div></div><div id="step"></div><button id="expand" type="button">More</button><div id="rows"></div></section><footer id="updated"></footer></main><script>
var current=null;var names={working:'Working',approval:'Waiting for approval',answer:'Waiting for answer',done:'Done',interrupted:'Interrupted',failed:'Failed',disconnected:'Connection lost',unavailable:'Status unavailable'};
function el(id){return document.getElementById(id)}
function clock(){if(!current)return;var terminal=['done','failed','interrupted'].indexOf(current.s)>=0;var live=['working','approval','answer'].indexOf(current.s)>=0;var end=current.e||(live?Date.now():current.u);var age=current.b?Math.max(0,Math.floor((end-current.b)/1000)):null;el('elapsed').textContent=age===null?'':Math.floor(age/60)+':'+('0'+age%60).slice(-2);var since=Math.max(0,Math.floor((Date.now()-current.u)/1000));el('updated').textContent=terminal?'Finished':!live?'Waiting for Codex status':since>90?'No recent update · '+since+'s':'Updated '+since+'s ago'}
var fittedWidth=0;
var expanded=false;
function drawStep(value){var step=el('step'),tags=['strong','em','del','code'],spans=Array.isArray(current.f)?current.f.filter(function(e){return Array.isArray(e)&&e.length===3&&e.every(Number.isSafeInteger)&&e[0]>=0&&e[0]<4&&e[1]>=0&&e[2]>0&&e[1]+e[2]<=(current.q||'').length}):[];if(!spans.length){step.textContent=value;return}step.textContent='';var prefix=0;while(prefix<value.length&&value.charAt(prefix)===(current.q||'').charAt(prefix))prefix++;var points=[0,value.length];spans.forEach(function(e){var a=Math.min(prefix,e[1]),b=Math.min(prefix,e[1]+e[2]);if(b>a){points.push(a);points.push(b)}});points=Array.from(new Set(points)).sort(function(a,b){return a-b});for(var i=1;i<points.length;i++){var a=points[i-1],b=points[i],node=document.createElement('span');node.textContent=value.slice(a,b);spans.forEach(function(e){if(e[1]<=a&&e[1]+e[2]>=b&&b<=prefix){var wrap=document.createElement(tags[e[0]]);wrap.appendChild(node);node=wrap}});step.appendChild(node)}}
function fitStep(){if(!current)return;var step=el('step'),button=el('expand');button.style.display='none';el('rows').style.display=expanded?'none':'';step.style.maxHeight=expanded?'1000px':'';drawStep(current.q||'');var width=step.clientWidth;if(!width)return;fittedWidth=width;var style=getComputedStyle(step);var line=parseFloat(style.lineHeight)||28;var main=el('context').parentNode;function budget(){var room=Math.floor((500-main.getBoundingClientRect().height+step.clientHeight)/line)*line;if(room>0&&room<step.clientHeight)step.style.maxHeight=room+'px'}budget();if(!expanded&&step.scrollHeight<=step.clientHeight+1)return;if(parseFloat(getComputedStyle(document.body).fontSize)<40){button.style.display='inline-block';button.textContent=expanded?'Less':'More';budget()}if(step.scrollHeight<=step.clientHeight+1)return;var words=step.textContent.trim().split(/\s+/);var low=0,high=words.length,best='…';while(low<=high){var mid=Math.floor((low+high)/2);var candidate=words.slice(0,mid).join(' ').replace(/…$/,'').trimEnd()+'…';drawStep(candidate);if(step.scrollHeight<=step.clientHeight+1){best=candidate;low=mid+1}else high=mid-1}var plain=best.replace(/…$/,'');var ends=Array.from(plain.matchAll(/[.!?](?:[»”"')\]]*)?(?=\s|$)/g));var end=ends.length?ends[ends.length-1]:null;if(end&&end.index+end[0].length>=12){drawStep(plain.slice(0,end.index+end[0].length)+' …');if(step.scrollHeight<=step.clientHeight+1)best=step.textContent}drawStep(best)}
el('expand').onclick=function(){expanded=!expanded;fitStep()};
function render(){try{var d=JSON.parse(TelegramWidget.chatData||'null');if(!d||d.v!==1||!names[d.s]||!Array.isArray(d.a))return;if(current&&d.r<current.r)return;current=d;var font=parseFloat(getComputedStyle(document.body).fontSize)||15;document.body.className=font>=40?'huge':font>=24?'large':'';el('context').textContent=d.p+' • '+d.t;el('status').textContent=d.k==='result'&&d.s==='done'?'Answer ready':names[d.s];el('badge').textContent=d.s==='done'?'✓':d.s==='failed'?'!':d.s==='interrupted'?'■':'●';el('badge').className='badge'+(d.s==='failed'?' error':'');el('plan').textContent=d.n?'Plan: '+d.n[0]+' of '+d.n[1]+' steps completed':'';el('track').style.display=d.n?'block':'none';el('fill').style.width=d.n?Math.min(100,100*d.n[0]/Math.max(1,d.n[1]))+'%':'0%';var rows=el('rows');rows.textContent='';d.a.slice(font>=24?-1:-3).forEach(function(a){var row=document.createElement('div');row.className='line';var icon=document.createElement('span');icon.className='icon'+(a[0]==='failed'?' error':'');icon.textContent=a[0]==='done'?'✓':a[0]==='failed'?'×':a[0]==='stopped'?'–':'●';var text=document.createElement('span');text.textContent=a[1];row.appendChild(icon);row.appendChild(text);rows.appendChild(row)});el('body').style.display=(font<40&&(d.q||d.n||d.a.length)||font>=40&&(d.s==='working'||d.k==='result')&&d.q)?'block':'none';clock();fitStep()}catch(e){el('status').textContent='Status unavailable'}}
new ResizeObserver(function(){var width=el('step').clientWidth;if(width&&width!==fittedWidth)fitStep()}).observe(document.body);TelegramWidget.onEvent('chatDataChanged',render);TelegramWidget.onEvent('themeChanged',render);render();setInterval(clock,1000);TelegramWidget.ready();
</script></body></html>`;

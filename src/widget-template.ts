import { basename } from 'node:path';
import { type WidgetCard } from './widget-types.js';

export function widgetLabel(value: string, bytes: number): string {
  let result = '';
  for (const char of value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim()) {
    if (Buffer.byteLength(result + char) > bytes) break;
    result += char;
  }
  return result;
}

export function widgetData(card: WidgetCard): string {
  const s = card.snapshot;
  const result = JSON.stringify({ v: 1, r: card.revision, p: widgetLabel(card.binding.projectLabel || basename(card.binding.cwd), 32),
    t: widgetLabel(card.binding.sessionName || card.binding.threadId.slice(0, 8), 64), s: s.status,
    b: s.startedAt, e: s.finishedAt, u: s.updatedAt, n: s.plan ? [s.plan.done, s.plan.total] : null, q: widgetLabel(s.plan?.current || '', 64),
    a: s.activities.slice(-3).map(item => [item.status, widgetLabel(item.label, 40)]) });
  if (Buffer.byteLength(result) > 900) throw new Error('Widget state exceeded its bounded preview budget.');
  return result;
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
.large header{gap:.4em}.large .badge{width:1.6em;height:1.6em}.large .line{margin:.35em 0}.huge .context,.huge footer,.huge .badge{display:none}.huge header{display:block;margin:.4em 0}.huge .time{margin-top:.5em}#step{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.9em}
</style></head><body><main><div class="context muted" id="context">Codex</div><header><div class="badge" id="badge">●</div><h3 id="status">Working</h3><div class="time" id="elapsed"></div></header><section id="body"><div class="muted" id="plan"></div><div class="track" id="track"><div class="fill" id="fill"></div></div><div id="step"></div><div id="rows"></div></section><footer id="updated"></footer></main><script>
var current=null;var names={working:'Working',approval:'Waiting for approval',answer:'Waiting for answer',done:'Done',interrupted:'Interrupted',failed:'Failed',disconnected:'Connection lost',unavailable:'Status unavailable'};
function el(id){return document.getElementById(id)}
function clock(){if(!current)return;var end=current.e||Date.now();var age=current.b?Math.max(0,Math.floor((end-current.b)/1000)):null;el('elapsed').textContent=age===null?'':Math.floor(age/60)+':'+('0'+age%60).slice(-2);el('updated').textContent='Last update: '+Math.max(0,Math.floor((Date.now()-current.u)/1000))+'s ago'}
function render(){try{var d=JSON.parse(TelegramWidget.chatData||'null');if(!d||d.v!==1||!names[d.s]||!Array.isArray(d.a))return;if(current&&d.r<current.r)return;current=d;var font=parseFloat(getComputedStyle(document.body).fontSize)||15;document.body.className=font>=40?'huge':font>=24?'large':'';el('context').textContent=d.p+' • '+d.t;el('status').textContent=names[d.s];el('badge').textContent=d.s==='done'?'✓':d.s==='failed'?'!':d.s==='interrupted'?'■':'●';el('badge').className='badge'+(d.s==='failed'?' error':'');el('plan').textContent=d.n?'Plan: '+d.n[0]+' of '+d.n[1]+' steps completed':'';el('track').style.display=d.n?'block':'none';el('fill').style.width=d.n?Math.min(100,100*d.n[0]/Math.max(1,d.n[1]))+'%':'0%';var rows=el('rows');rows.textContent='';d.a.slice(font>=24?-1:-3).forEach(function(a){var row=document.createElement('div');row.className='line';var icon=document.createElement('span');icon.className='icon'+(a[0]==='failed'?' error':'');icon.textContent=a[0]==='done'?'✓':a[0]==='failed'?'×':'●';var text=document.createElement('span');text.textContent=a[1];row.appendChild(icon);row.appendChild(text);rows.appendChild(row)});el('step').textContent=d.q||'';el('body').style.display=font<40&&(d.n||d.a.length)?'block':'none';clock()}catch(e){el('status').textContent='Status unavailable'}}
TelegramWidget.onEvent('chatDataChanged',render);TelegramWidget.onEvent('themeChanged',render);render();setInterval(clock,1000);TelegramWidget.ready();
</script></body></html>`;

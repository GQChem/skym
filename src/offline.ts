import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dagre from "@dagrejs/dagre";
import { layoutGraph } from "./layout.js";
import { esc, renderSvg } from "./render.js";
import type { Graph } from "./store.js";
import { DEFAULT_THEME, paletteFor, resolveTheme, type Theme } from "./theme.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function figuresAsDataUrls(graph: Graph, assetsDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of graph.nodes) {
    for (const figure of node.figures) {
      try {
        const bytes = fs.readFileSync(path.join(assetsDir, path.basename(figure.file)));
        out[figure.file] = `data:${figure.mime || "application/octet-stream"};base64,${bytes.toString("base64")}`;
      } catch {
        // A missing figure must not prevent the rest of the chart exporting.
      }
    }
  }
  return out;
}

const LINE_SEP = new RegExp(String.fromCharCode(0x2028), "g");
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), "g");

/** These are legal in JSON but terminate a line inside a script block. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\u003c")
    .replace(LINE_SEP, "\u2028")
    .replace(PARA_SEP, "\u2029");
}

/**
 * Both modes are rendered ahead of time and toggled in the page, so the export
 * needs no layout engine at runtime — it is markup, not an application.
 */
export function offlineHtml(graph: Graph, assetsDir: string, theme: Theme = DEFAULT_THEME): string {
  const figures = figuresAsDataUrls(graph, assetsDir);
  const src = (file: string) => figures[file] ?? "";

  const svg: Record<string, string> = {};
  for (const mode of ["light", "dark"] as const) {
    const layout = layoutGraph(graph, theme, dagre, true);
    svg[mode] = renderSvg(layout, { theme, palette: paletteFor(theme, mode), figureSrc: src });
  }

  const light = paletteFor(theme, "light");
  const dark = paletteFor(theme, "dark");
  const nodes = safeJson(
    graph.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      state: n.state,
      bullets: n.bullets,
      group: n.group,
      figures: n.figures.map((f) => ({ src: figures[f.file] ?? "", caption: f.caption })),
      artifacts: (n.artifacts ?? []).map((a) => ({ ...a, src: `assets/${encodeURIComponent(a.file)}` })),
      badge: n.badge,
    })),
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(graph.title)}</title><style>
:root{color-scheme:light;--bg:${light.surface};--panel:${light.card};--fg:${light.ink};--muted:${light.inkMuted};--border:${light.hairline};--accent:${light.focus}}
:root[data-theme=dark]{color-scheme:dark;--bg:${dark.surface};--panel:${dark.card};--fg:${dark.ink};--muted:${dark.inkMuted};--border:${dark.hairline};--accent:${dark.focus}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;grid-template-rows:auto 1fr;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--panel)}
h1{font-size:15px;font-weight:650;margin:0}.muted{color:var(--muted)}.actions{display:flex;gap:6px;margin-left:auto}
button{padding:5px 11px;font:inherit;font-size:13px;color:var(--fg);background:transparent;border:1px solid var(--border);border-radius:7px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}button.active{color:#fff;background:var(--accent);border-color:var(--accent)}
main{display:grid;grid-template-columns:minmax(0,1fr) 330px;min-height:0}
.stage{position:relative;overflow:hidden;cursor:grab}.stage.dragging{cursor:grabbing}
.chart{position:absolute;top:0;left:0;transform-origin:0 0;padding:12px}.chart svg{display:block}
.skym-node{cursor:pointer}.skym-figure{cursor:zoom-in}
aside{overflow-y:auto;padding:14px 16px 24px;border-left:1px solid var(--border);background:var(--panel)}
aside h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.detail-title{font-weight:650;font-size:15px;margin-bottom:4px;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.chip{font-size:11px;border:1px solid var(--border);border-radius:999px;padding:2px 9px;color:var(--muted)}
ul{margin:10px 0;padding-left:18px}li{margin:3px 0;overflow-wrap:anywhere}
figure{margin:12px 0}figure img{width:100%;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;display:block}
figcaption{color:var(--muted);font-size:12px;margin-top:5px}
.files{display:grid;gap:6px;margin-top:14px}.file{padding:8px 10px;border:1px solid var(--border);border-radius:8px;color:var(--fg);text-decoration:none}.file small{display:block;color:var(--muted)}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:40px;z-index:50;cursor:zoom-out}
.lightbox img{max-width:100%;max-height:100%;border-radius:10px}[hidden]{display:none!important}
@media(max-width:820px){main{grid-template-columns:1fr;grid-template-rows:minmax(55%,1fr) auto}aside{border-left:0;border-top:1px solid var(--border);max-height:42vh}}
</style></head><body>
<header><h1>${esc(graph.title)}</h1><span class="muted">rev ${graph.revision} · offline snapshot</span>
<div class="actions"><button id="fit">Fit</button><button id="theme">Theme</button></div></header>
<main><section class="stage" id="stage"><div class="chart" id="chart"></div></section>
<aside><h2>Selected</h2><div id="detail" class="muted">Click a node in the chart.</div></aside></main>
<div class="lightbox" id="lightbox" hidden><img id="lightbox-img" alt=""></div>
<script id="skym-svg-light" type="text/plain">${svg.light.replace(/<\/script>/gi, "<\\/script>")}</script>
<script id="skym-svg-dark" type="text/plain">${svg.dark.replace(/<\/script>/gi, "<\\/script>")}</script>
<script id="skym-nodes" type="application/json">${nodes}</script>
<script>
(()=>{
const nodes=JSON.parse(document.getElementById("skym-nodes").textContent);
const chart=document.getElementById("chart"),stage=document.getElementById("stage"),detail=document.getElementById("detail");
const lightbox=document.getElementById("lightbox"),lightboxImg=document.getElementById("lightbox-img");
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let mode=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light",view={x:0,y:0,k:1},drag=null,moved=false;
const apply=()=>chart.style.transform="translate("+view.x+"px,"+view.y+"px) scale("+view.k+")";
const paint=()=>{document.documentElement.setAttribute("data-theme",mode);
chart.innerHTML=document.getElementById("skym-svg-"+mode).textContent;bind();};
const fit=()=>{const svg=chart.querySelector("svg");if(!svg)return;
const w=+svg.getAttribute("width"),h=+svg.getAttribute("height");if(!w||!h)return;
view.k=Math.max(.05,Math.min((stage.clientWidth-56)/w,(stage.clientHeight-56)/h,1.4));
view.x=(stage.clientWidth-w*view.k)/2;view.y=(stage.clientHeight-h*view.k)/2;apply();};
function show(n){let h='<div class="detail-title">'+esc(n.title)+'</div><div class="chips"><span class="chip">'+esc(n.state)+'</span><span class="chip">'+esc(n.kind)+'</span>'+(n.badge?'<span class="chip">'+esc(n.badge)+'</span>':'')+(n.group?'<span class="chip">'+esc(n.group)+'</span>':'')+'</div>';
if(n.bullets&&n.bullets.length)h+='<ul>'+n.bullets.map(b=>'<li>'+esc(b)+'</li>').join("")+'</ul>';
for(const f of n.figures||[])h+='<figure>'+(f.src?'<img src="'+f.src+'" alt="'+esc(f.caption||n.title)+'">':'<div class="muted">figure unavailable</div>')+(f.caption?'<figcaption>'+esc(f.caption)+'</figcaption>':'')+'</figure>';
if(n.artifacts&&n.artifacts.length)h+='<div class="files">'+n.artifacts.map(a=>'<a class="file" href="'+a.src+'" download="'+esc(a.name)+'">↧ '+esc(a.name)+(a.label?'<small>'+esc(a.label)+'</small>':'')+'</a>').join('')+'</div>';
detail.className="";detail.innerHTML=h;
detail.querySelectorAll("img").forEach(i=>i.onclick=()=>{lightboxImg.src=i.src;lightbox.hidden=false});}
function bind(){chart.querySelectorAll(".skym-node").forEach(el=>{const n=nodes.find(n=>n.id===el.dataset.id);
if(n)el.onclick=e=>{e.stopPropagation();if(!moved)show(n)};});
chart.querySelectorAll(".skym-figure").forEach(im=>im.onclick=e=>{e.stopPropagation();lightboxImg.src=im.getAttribute("href");lightbox.hidden=false});}
stage.onpointerdown=e=>{if(e.button!==0)return;drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};moved=false;stage.setPointerCapture(e.pointerId);stage.classList.add("dragging")};
stage.onpointermove=e=>{if(!drag)return;view.x=drag.vx+e.clientX-drag.x;view.y=drag.vy+e.clientY-drag.y;
if(Math.abs(e.clientX-drag.x)+Math.abs(e.clientY-drag.y)>3)moved=true;apply()};
stage.onpointerup=stage.onpointercancel=()=>{drag=null;stage.classList.remove("dragging")};
stage.onwheel=e=>{e.preventDefault();const r=stage.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
const k=Math.min(Math.max(view.k*Math.exp(-e.deltaY*.0015),.05),5);
view.x=mx-(mx-view.x)*k/view.k;view.y=my-(my-view.y)*k/view.k;view.k=k;apply()};
document.getElementById("fit").onclick=fit;
document.getElementById("theme").onclick=()=>{mode=mode==="light"?"dark":"light";paint();apply()};
lightbox.onclick=()=>{lightbox.hidden=true;lightboxImg.src=""};
addEventListener("keydown",e=>{if(e.key==="Escape"){lightbox.hidden=true;lightboxImg.src=""}if(e.key==="f")fit()});
addEventListener("resize",fit);
paint();requestAnimationFrame(fit);
})();
</script></body></html>`;
}

export function writeOfflineHtml(
  graph: Graph,
  chartDir: string,
  assetsDir: string,
  overrides?: Parameters<typeof resolveTheme>[1],
): void {
  const theme = overrides ? resolveTheme(DEFAULT_THEME, overrides) : DEFAULT_THEME;
  const target = path.join(chartDir, "flow.html");
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, offlineHtml(graph, assetsDir, theme), "utf8");
  fs.renameSync(tmp, target);
}

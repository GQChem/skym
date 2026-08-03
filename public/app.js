import dagre from "./vendor/dagre.js";
import { detailForZoom, layoutGraph } from "./vendor/layout.js";
import { renderSvg } from "./vendor/render.js";
import { DEFAULT_THEME, KIND_LABEL, STATE_GLYPH, paletteFor, resolveTheme } from "./vendor/theme.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const stage = $("stage");
const empty = $("empty");
const panel = $("panel");
const detail = $("detail");
const eventsEl = $("events");
const dot = $("live-dot");
const lightbox = $("lightbox");
const lightboxImg = $("lightbox-img");
const menu = $("node-menu");

let state = null;
let selectedId = null;
let chartParam = new URLSearchParams(location.search).get("chart");
let ownChartId = null;
let theme = DEFAULT_THEME;
let lastLayout = null;

const store = {
  get: (k, fallback) => {
    const v = localStorage.getItem(`skym-${k}`);
    return v === null ? fallback : v;
  },
  set: (k, v) => localStorage.setItem(`skym-${k}`, String(v)),
};

let showFigures = store.get("inline-figs", "1") === "1";
let mode = store.get("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
let view = { x: 0, y: 0, k: 1 };
let userMovedView = false;
/** Detail currently drawn; re-layout only when the zoom crosses a threshold. */
let detailLevel = "full";
/** "auto" follows zoom; the other values pin a level from the toolbar. */
let detailMode = store.get("detail", "auto");

document.documentElement.setAttribute("data-theme", mode);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const assetUrl = (file) =>
  `/assets/${encodeURIComponent(file)}${chartParam ? `?chart=${encodeURIComponent(chartParam)}` : ""}`;

/** Project config may restyle cards; user settings win over neither yet. */
const applyThemeOverrides = (overrides) => {
  theme = resolveTheme(DEFAULT_THEME, overrides?.user, overrides?.project);
};

// --- view transform ---

const applyView = () => {
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
};

const fitOnce = () => {
  if (!lastLayout || !lastLayout.width) return;
  const pad = 56;
  const k = Math.min(
    (stage.clientWidth - pad) / lastLayout.width,
    (stage.clientHeight - pad) / lastLayout.height,
    1.4,
  );
  view.k = Math.max(k, 0.05);
  view.x = (stage.clientWidth - lastLayout.width * view.k) / 2;
  view.y = (stage.clientHeight - lastLayout.height * view.k) / 2;
  applyView();
};

/**
 * Fitting sets a zoom, which may change the detail level, which changes the
 * layout — so fit again against the new geometry. The guard bounds this to one
 * extra pass: draw() calls fit(), and without it the two would recurse.
 */
let refitting = false;

const fit = () => {
  fitOnce();
  if (refitting || detailMode !== "auto" || !state) return;
  if (detailForZoom(view.k) !== detailLevel) {
    refitting = true;
    try {
      draw();
      fitOnce();
    } finally {
      refitting = false;
    }
  }
};

// --- rendering ---

const draw = () => {
  if (!state) return;
  const graph = state.graph;
  $("project").textContent = graph.title || "skym";
  $("rev").textContent = `rev ${graph.revision}`;

  const has = graph.nodes.length > 0;
  empty.hidden = has;
  if (!has) {
    canvas.innerHTML = "";
    lastLayout = null;
    renderDetail();
    renderEvents();
    return;
  }

  detailLevel = detailMode === "auto" ? detailForZoom(view.k) : detailMode;
  lastLayout = layoutGraph(graph, theme, dagre, showFigures, detailLevel);
  canvas.innerHTML = renderSvg(lastLayout, {
    theme,
    palette: paletteFor(theme, mode),
    figureSrc: assetUrl,
    selectedId,
    interactive: true,
  });

  bindNodes();
  if (!userMovedView) fit();
  else applyView();
  renderDetail();
  renderEvents();
};

const bindNodes = () => {
  for (const el of canvas.querySelectorAll(".skym-node")) {
    const id = el.dataset.id;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      select(id);
    });
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(id, ev.clientX, ev.clientY);
    });
  }
  for (const img of canvas.querySelectorAll(".skym-figure")) {
    img.addEventListener("click", (ev) => {
      ev.stopPropagation();
      zoom(img.getAttribute("href"));
    });
  }
};

const select = (id) => {
  selectedId = id;
  // Repaint only the selection ring rather than re-laying-out the whole graph.
  for (const el of canvas.querySelectorAll(".skym-node")) {
    const rect = el.querySelector(".skym-card");
    if (!rect) continue;
    const on = el.dataset.id === id;
    const ink = paletteFor(theme, mode).states[el.dataset.state];
    rect.setAttribute("stroke", on ? paletteFor(theme, mode).focus : ink.border);
    rect.setAttribute("stroke-width", on ? theme.card.selectedWidth : theme.card.borderWidth);
    el.classList.toggle("is-selected", on);
  }
  renderDetail();
};

const zoom = (src) => {
  lightboxImg.src = src;
  lightbox.hidden = false;
};

const renderDetail = () => {
  if (!state) return;
  const node = state.graph.nodes.find((n) => n.id === selectedId);
  if (!node) {
    detail.className = "muted";
    detail.textContent = "Click a node in the chart.";
    return;
  }
  detail.className = "";
  const parts = [
    `<div class="detail-title"></div>`,
    `<div class="chips"><span class="chip state-${node.state}">${escapeHtml(node.state)}</span>` +
      `<span class="chip">${escapeHtml(node.kind)}</span>` +
      (node.group ? `<span class="chip">${escapeHtml(node.group)}</span>` : "") +
      `</div>`,
  ];
  if (node.bullets?.length) {
    parts.push(`<ul class="bullets">${node.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`);
  }
  for (const f of node.figures) {
    parts.push(
      `<figure><img src="${escapeHtml(assetUrl(f.file))}" alt="${escapeHtml(f.caption || node.title)}" />` +
        (f.caption ? `<figcaption>${escapeHtml(f.caption)}</figcaption>` : "") +
        `</figure>`,
    );
  }
  if (node.kind === "result" && !node.figures.length) {
    parts.push(`<p class="muted nudge">No figure attached — results read best with a plot or screenshot.</p>`);
  }
  detail.innerHTML = parts.join("");
  detail.querySelector(".detail-title").textContent = node.title;
  for (const img of detail.querySelectorAll("img")) {
    img.addEventListener("click", () => zoom(img.src));
  }
};

const renderEvents = () => {
  if (!state) return;
  eventsEl.innerHTML = state.graph.events
    .slice(-40)
    .reverse()
    .map((e) => {
      const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return `<li><time>${t}</time><span class="what">${escapeHtml(e.kind)} · ${escapeHtml(e.detail)}</span></li>`;
    })
    .join("");
};

// Grouped by kind: the vocabulary is three kinds each with its own states, and
// a flat list of twelve hides that structure.
const LEGEND_GROUPS = [
  {
    kind: "action",
    blurb: "something done or to be done",
    states: [
      ["planned", "not started"],
      ["exploring", "working now"],
      ["waiting", "blocked on a wait"],
      ["done", "finished"],
      ["blocked", "stuck"],
      ["abandoned", "dead end"],
    ],
  },
  {
    kind: "result",
    blurb: "what an action produced",
    states: [
      ["good", "it worked"],
      ["bad", "it did not"],
      ["mixed", "tradeoffs"],
      ["inconclusive", "needs more"],
    ],
  },
  {
    kind: "options",
    blurb: "a fork in the work",
    states: [
      ["open", "undecided"],
      ["resolved", "decided"],
    ],
  },
];

const renderLegend = () => {
  const palette = paletteFor(theme, mode);
  $("legend").innerHTML = LEGEND_GROUPS.map(
    (g) =>
      `<div class="leg-group">` +
      `<div class="leg-kind">${escapeHtml(KIND_LABEL[g.kind] ?? g.kind)}<span>${escapeHtml(g.blurb)}</span></div>` +
      g.states
        .map(([st, what]) => {
          const ink = palette.states[st];
          // A miniature of the real card, so the legend teaches the chart.
          return (
            `<div class="leg" data-state="${st}">` +
            `<span class="leg-chip" style="background:${ink.fill};border-color:${ink.border}">` +
            `<span class="leg-stripe" style="background:${ink.accent}"></span>` +
            `<span class="leg-glyph" style="color:${ink.accent}">${escapeHtml(STATE_GLYPH[st] ?? "•")}</span>` +
            `</span>` +
            `<b>${escapeHtml(st)}</b><span class="muted">${escapeHtml(what)}</span></div>`
          );
        })
        .join("") +
      `</div>`,
  ).join("");
};

// --- node action menu ---

let menuNode = null;

const MENU_ITEMS = [
  { label: "Work on this", run: (n) => copy(promptFor(n)) },
  { label: "Copy node id", run: (n) => copy(n.id) },
  { label: "Copy node", run: (n) => copy(nodeAsText(n)) },
];

const promptFor = (n) => {
  const lines = [`Work on node "${n.id}" from the chart: ${n.title}`];
  if (n.bullets?.length) lines.push(...n.bullets.map((b) => `- ${b}`));
  lines.push(`(currently ${n.kind}/${n.state})`);
  return lines.join("\n");
};

const nodeAsText = (n) =>
  [`${n.title} [${n.kind}/${n.state}]`, ...(n.bullets ?? []).map((b) => `- ${b}`)].join("\n");

const copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back to a temp textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
};

const openMenu = (id, x, y) => {
  const node = state?.graph.nodes.find((n) => n.id === id);
  if (!node || state.readOnly) return;
  menuNode = node;
  menu.innerHTML = MENU_ITEMS.map((m, i) => `<button data-i="${i}">${escapeHtml(m.label)}</button>`).join("");
  menu.hidden = false;
  // Measure before placing, so the menu never hangs off the viewport.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  for (const btn of menu.querySelectorAll("button")) {
    btn.addEventListener("click", async () => {
      await MENU_ITEMS[Number(btn.dataset.i)].run(menuNode);
      btn.textContent = "Copied";
      setTimeout(closeMenu, 550);
    });
  }
};

const closeMenu = () => {
  menu.hidden = true;
  menuNode = null;
};

// --- pan / zoom ---

let drag = null;

stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  closeMenu();
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("dragging");
});

stage.addEventListener("pointermove", (e) => {
  if (!drag) return;
  view.x = drag.vx + e.clientX - drag.x;
  view.y = drag.vy + e.clientY - drag.y;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) {
    drag.moved = true;
    userMovedView = true;
  }
  applyView();
});

const endDrag = () => {
  drag = null;
  stage.classList.remove("dragging");
};

stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);

stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.min(Math.max(view.k * Math.exp(-e.deltaY * 0.0015), 0.05), 5);
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
    userMovedView = true;
    applyView();
    maybeRelayout();
  },
  { passive: false },
);

/**
 * Cards shed bullets and figures as the view zooms out, which changes their
 * size — so crossing a threshold is a re-layout, not just a repaint. The graph
 * is re-centred on whatever the viewport was looking at, or the whole thing
 * appears to jump when the geometry changes underneath.
 */
const maybeRelayout = () => {
  if (detailMode !== "auto" || !state || !lastLayout) return;
  const next = detailForZoom(view.k);
  if (next === detailLevel) return;

  const cx = (stage.clientWidth / 2 - view.x) / view.k / lastLayout.width;
  const cy = (stage.clientHeight / 2 - view.y) / view.k / lastLayout.height;
  draw();
  if (lastLayout) {
    view.x = stage.clientWidth / 2 - cx * lastLayout.width * view.k;
    view.y = stage.clientHeight / 2 - cy * lastLayout.height * view.k;
    applyView();
  }
};

// --- chrome ---

$("fit").addEventListener("click", () => {
  userMovedView = false;
  fit();
});

const widthEl = $("node-width");
widthEl.value = String(theme.card.width);

widthEl.addEventListener("input", () => {
  const width = Number(widthEl.value);
  theme = resolveTheme(theme, { card: { width } });
  widthEl.title = `Card width: ${width}px`;
  store.set("node-width", width);
  draw();
});

const detailEl = $("detail-level");
detailEl.value = detailMode;

detailEl.addEventListener("change", () => {
  detailMode = detailEl.value;
  store.set("detail", detailMode);
  draw();
});

const figBtn = $("inline-figs");
const syncFigBtn = () => figBtn.classList.toggle("active", showFigures);

figBtn.addEventListener("click", () => {
  showFigures = !showFigures;
  store.set("inline-figs", showFigures ? "1" : "0");
  syncFigBtn();
  draw();
});

$("panel-toggle").addEventListener("click", () => {
  panel.classList.toggle("hidden");
  if (!userMovedView) fit();
});

$("theme").addEventListener("click", () => {
  mode = mode === "light" ? "dark" : "light";
  store.set("theme", mode);
  document.documentElement.setAttribute("data-theme", mode);
  // Layout is client-side now, so a theme flip is a repaint — no refetch.
  renderLegend();
  draw();
});

$("export").addEventListener("click", () => {
  const svg = canvas.querySelector("svg");
  if (!svg) return;
  const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(state?.graph.title || "chart").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.svg`;
  a.click();
  URL.revokeObjectURL(a.href);
});

lightbox.addEventListener("click", () => {
  lightbox.hidden = true;
  lightboxImg.src = "";
});

stage.addEventListener("click", () => closeMenu());

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    lightbox.hidden = true;
    lightboxImg.src = "";
    closeMenu();
  }
  if (e.key === "f" && !e.metaKey && !e.ctrlKey) {
    userMovedView = false;
    fit();
  }
});

window.addEventListener("resize", () => {
  if (!userMovedView) fit();
});

// --- live connection ---

let es = null;

const connect = () => {
  if (es) es.close();
  es = new EventSource("/events");
  es.onopen = () => {
    dot.classList.add("live");
    dot.title = "live";
  };
  es.onmessage = (ev) => {
    try {
      state = JSON.parse(ev.data);
      draw();
    } catch {
      /* ignore malformed frame */
    }
  };
  es.onerror = () => {
    dot.classList.remove("live");
    dot.title = "reconnecting…";
  };
};

const chartsEl = $("charts");

const refreshCharts = async () => {
  try {
    const list = await fetch("/charts").then((r) => r.json());
    if (!list.length) {
      chartsEl.hidden = true;
      return;
    }
    chartsEl.hidden = list.length < 2;
    const cur = chartParam || list.find((c) => c.active)?.chartId;
    chartsEl.innerHTML = list
      .map(
        (c) =>
          `<option value="${escapeHtml(c.chartId)}"${c.chartId === cur ? " selected" : ""}>` +
          `${escapeHtml(c.title)} (${c.nodes})${c.active ? " ● live" : ""}</option>`,
      )
      .join("");
  } catch {
    chartsEl.hidden = true;
  }
};

chartsEl.addEventListener("change", async () => {
  const pick = chartsEl.value;
  chartParam = pick === ownChartId ? null : pick;
  const url = chartParam ? `/graph?chart=${encodeURIComponent(chartParam)}` : "/graph";
  state = await fetch(url).then((r) => r.json());
  selectedId = null;
  userMovedView = false;
  draw();
  // Only the live chart streams; a historical one is a static snapshot.
  if (!chartParam) connect();
  else if (es) es.close();
  dot.classList.toggle("live", !chartParam);
  dot.title = chartParam ? "read-only snapshot" : "live";
});

const boot = async () => {
  const savedWidth = Number(store.get("node-width", 0));
  const config = await fetch("/config")
    .then((r) => r.json())
    .catch(() => ({}));
  applyThemeOverrides(config);
  if (savedWidth) theme = resolveTheme(theme, { card: { width: savedWidth } });
  widthEl.value = String(theme.card.width);

  fetch("/whoami")
    .then((r) => r.json())
    .then((w) => {
      const el = $("proj-name");
      el.textContent = w.project;
      el.title = `${w.projectDir}\nport ${w.port}`;
      el.hidden = false;
      ownChartId = w.chartId;
      document.title = `${w.project} · skym`;
    })
    .catch(() => {});

  syncFigBtn();
  renderLegend();
  refreshCharts();
  setInterval(refreshCharts, 5000);
  connect();
};

boot();

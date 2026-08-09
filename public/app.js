import dagre from "./vendor/dagre.js";
import { detailForZoom, layoutGraph } from "./vendor/layout.js";
import { renderSvg } from "./vendor/render.js";
import { DEFAULT_THEME, KIND_LABEL, STATE_GLYPH, paletteFor, resolveTheme } from "./vendor/theme.js";
import { DEFAULT_VOCAB, glyphs, kindLabels, kindPresentations, pulseStates, resolveVocab } from "./vendor/vocab.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const stage = $("stage");
const empty = $("empty");
const panel = $("panel");
const detail = $("detail");
const eventsEl = $("events");
const commandsSection = $("commands-section");
const commandsList = $("commands-list");
const dot = $("live-dot");
const lightbox = $("lightbox");
const lightboxImg = $("lightbox-img");
const menu = $("node-menu");
const requestDialog = $("request-dialog");
const requestForm = $("request-form");
const requestBody = $("request-body");
const requestContext = $("request-context");

let state = null;
let selectedId = null;
let chartParam = new URLSearchParams(location.search).get("chart");
let ownChartId = null;
let hosted = false;
let theme = DEFAULT_THEME;
let vocab = DEFAULT_VOCAB;
/** Derived from vocab so the renderer labels custom kinds correctly. */
let vocabGlyphs = glyphs(DEFAULT_VOCAB);
let vocabLabels = kindLabels(DEFAULT_VOCAB);
let vocabPulse = pulseStates(DEFAULT_VOCAB);
let vocabPresentation = kindPresentations(DEFAULT_VOCAB);
let serviceVocab = DEFAULT_VOCAB;
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
let positiveOnly = store.get("positive-only", "0") === "1";
let workingOnly = store.get("working-only", "0") === "1";

document.documentElement.setAttribute("data-theme", mode);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const assetUrl = (file) =>
  `/assets/${encodeURIComponent(file)}${chartParam ? `?chart=${encodeURIComponent(chartParam)}` : ""}`;

/** The server resolves user→project layering, so this just takes the result. */
const applyConfig = (config) => {
  if (config?.theme) theme = config.theme;
  if (config?.vocab?.kinds?.length) {
    serviceVocab = {
      ...config.vocab,
      kinds: config.vocab.kinds.map((kind) => {
        const fallback = DEFAULT_VOCAB.kinds.find((item) => item.slug === kind.slug);
        return fallback ? {
          ...fallback, ...kind,
          content: { ...fallback.content, ...kind.content },
          presentation: { ...fallback.presentation, ...kind.presentation },
        } : kind;
      }),
    };
  }
  applyDesignLayers();
};

const designKey = (scope) => scope === "global" ? "design-global" : `design-project-${chartParam || ownChartId || "local"}`;
const readDesign = (scope) => {
  try { return JSON.parse(store.get(designKey(scope), "{}")); } catch { return {}; }
};
const applyDesignLayers = () => {
  vocab = resolveVocab(serviceVocab, readDesign("global"), readDesign("project"));
  vocabGlyphs = glyphs(vocab);
  vocabLabels = kindLabels(vocab);
  vocabPulse = pulseStates(vocab);
  vocabPresentation = kindPresentations(vocab);
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

const fetchGraph = async (url) => {
  try {
    const r = await fetch(url);
    const body = await r.json();
    return r.ok ? body : { error: body?.error || `HTTP ${r.status}` };
  } catch (err) {
    return { error: String(err) };
  }
};

const draw = () => {
  if (!state) return;
  // An error body still parses as JSON, so check the shape before dereferencing.
  if (!state.graph?.nodes) {
    canvas.innerHTML = "";
    lastLayout = null;
    empty.hidden = false;
    empty.querySelector("p").textContent = state.error
      ? `Cannot load chart: ${state.error}`
      : "No flowchart yet.";
    return;
  }
  let graph = positiveOnly ? positiveTree(state.graph) : state.graph;
  if (workingOnly) graph = workingTree(graph);
  $("project").textContent = graph.title || "skym";
  $("rev").textContent = `rev ${graph.revision}`;

  const has = graph.nodes.length > 0;
  empty.hidden = has;
  if (!has) {
    canvas.innerHTML = "";
    lastLayout = null;
    empty.querySelector("p").textContent = workingOnly
      ? "Nothing is being worked on right now."
      : (positiveOnly ? "No successful paths yet." : "No flowchart yet.");
    renderDetail();
    renderEvents();
    maybeOpenFirstChartDesign(graph);
    return;
  }

  detailLevel = detailMode === "auto" ? detailForZoom(view.k) : detailMode;
  lastLayout = layoutGraph(graph, theme, dagre, showFigures, detailLevel, vocabLabels, vocabPresentation);
  canvas.innerHTML = renderSvg(lastLayout, {
    glyphs: vocabGlyphs,
    kindLabels: vocabLabels,
    pulseStates: vocabPulse,
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
  void renderCommands();
  maybeOpenFirstChartDesign(graph);
};

/** Keep successful results and every ancestor needed to explain how they were reached. */
const positiveTree = (graph) => {
  const keep = new Set(graph.nodes.filter((node) => node.state === "good").map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (keep.has(edge.to) && !keep.has(edge.from)) {
        keep.add(edge.from);
        changed = true;
      }
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
};

/** Active work plus its causal ancestors, so a focused view keeps its meaning. */
const workingTree = (graph) => {
  const activeNames = new Set(["exploring", "running", "working", "in-progress", "in_progress"]);
  const keep = new Set(graph.nodes.filter((node) => activeNames.has(node.state)).map((node) => node.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) if (keep.has(edge.to) && !keep.has(edge.from)) {
      keep.add(edge.from);
      changed = true;
    }
  }
  return { ...graph, nodes: graph.nodes.filter((node) => keep.has(node.id)), edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)) };
};

const renderCommands = async () => {
  if (!state?.commandsEnabled) {
    commandsSection.hidden = true;
    return;
  }
  const chartId = state.chartId || chartParam;
  if (!chartId) return;
  const out = await fetch(`/api/charts/${encodeURIComponent(chartId)}/commands`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  commandsSection.hidden = false;
  const commands = out?.commands ?? [];
  commandsList.innerHTML = commands.length
    ? commands.slice(0, 10).map((command) =>
        `<li><strong>${escapeHtml(command.verb)}</strong> · ${escapeHtml(command.status)}` +
        (command.nodeId ? `<br /><span class="muted">${escapeHtml(command.nodeId)}</span>` : "") + `</li>`
      ).join("")
    : `<li class="muted">No requests yet.</li>`;
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
    const palette = paletteFor(theme, mode);
    const ink = palette.states[el.dataset.state] ?? palette.neutral;
    rect.setAttribute("stroke", on ? palette.focus : ink.border);
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
  const palette = paletteFor(theme, mode);
  const stateInk = palette.states[node.state] ?? palette.neutral;
  const parts = [
    `<div class="detail-title"></div>`,
    `<div class="chips">` +
      `<span class="chip state-${escapeHtml(node.state)}" style="color:${stateInk.accent}">${escapeHtml(node.state)}</span>` +
      `<span class="chip">${escapeHtml(vocabLabels[node.kind] ?? node.kind)}</span>` +
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

// Grouped by kind: a flat list of every state hides which kind each belongs to.
const renderLegend = () => {
  const palette = paletteFor(theme, mode);
  $("legend").innerHTML = vocab.kinds
    .map(
      (k) =>
        `<div class="leg-group">` +
        `<div class="leg-kind" title="${escapeHtml(k.blurb)}">${escapeHtml(k.label)}</div>` +
        k.states
          .map((s) => {
            const ink = palette.states[s.slug] ?? palette.neutral;
            // A miniature of the real card, so the legend teaches the chart.
            return (
              `<div class="leg" data-state="${escapeHtml(s.slug)}">` +
              `<span class="leg-chip" style="background:${ink.fill};border-color:${ink.border}">` +
              `<span class="leg-stripe" style="background:${ink.accent}"></span>` +
              `<span class="leg-glyph" style="color:${ink.accent}">${escapeHtml(s.glyph)}</span>` +
              `</span>` +
              `<b title="${escapeHtml(s.blurb)}">${escapeHtml(s.label)}</b></div>`
            );
          })
          .join("") +
        `</div>`,
    )
    .join("");
};

// --- node action menu ---

let menuNode = null;

const MENU_ITEMS = [
  { label: "Work on this", run: (n) => requestWork(n) },
  { label: "Copy node id", run: (n) => copy(n.id) },
  { label: "Copy node", run: (n) => copy(nodeAsText(n)) },
];

const composeRequest = (node) => new Promise((resolve) => {
  requestContext.textContent = `${node.title} (${node.id})`;
  requestBody.value = "";
  requestDialog.showModal();
  requestBody.focus();

  const finish = (value) => {
    requestForm.removeEventListener("submit", submit);
    requestDialog.removeEventListener("cancel", cancel);
    $("request-cancel").removeEventListener("click", cancel);
    if (requestDialog.open) requestDialog.close();
    resolve(value);
  };
  const submit = (event) => {
    event.preventDefault();
    const value = requestBody.value.trim();
    if (value) finish(value);
  };
  const cancel = (event) => {
    event?.preventDefault();
    finish(null);
  };
  requestForm.addEventListener("submit", submit);
  requestDialog.addEventListener("cancel", cancel);
  $("request-cancel").addEventListener("click", cancel);
});

const requestWork = async (node) => {
  if (!state?.commandsEnabled) return copy(promptFor(node));
  const instruction = await composeRequest(node);
  if (!instruction) return false;
  const chartId = state.chartId || chartParam;
  if (!chartId) throw new Error("No hosted chart selected");
  const r = await fetch(`/api/charts/${encodeURIComponent(chartId)}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: node.id,
      verb: "work_on",
      body: `${instruction}\n\nContext:\n${promptFor(node)}`,
      idempotency_key: crypto.randomUUID(),
    }),
  });
  if (!r.ok) throw new Error(`Could not queue command (${r.status})`);
  return true;
};

// --- node design system ---

const designDialog = $("design-dialog");
const designScope = $("design-scope");
const designKind = $("design-kind");
let editingSlug = "";

const maybeOpenFirstChartDesign = () => {
  const graph = state?.graph;
  if (!graph || graph.revision > 2 || graph.nodes.length > 1 || designDialog.open) return;
  const key = `design-welcome-${graph.chartId || chartParam || ownChartId || graph.title}`;
  if (store.get(key, "0") === "1") return;
  store.set(key, "1");
  setTimeout(() => {
    populateKindPicker(editingSlug);
    if (!designDialog.open) designDialog.showModal();
  }, 250);
};

const kindBySlug = (slug) => vocab.kinds.find((k) => k.slug === slug);
const setField = (id, value) => { $(id).value = value ?? ""; };

const populateKindPicker = (preferred) => {
  designKind.innerHTML = vocab.kinds.map((k) => `<option value="${escapeHtml(k.slug)}">${escapeHtml(k.label)}</option>`).join("");
  editingSlug = preferred && kindBySlug(preferred) ? preferred : (vocab.kinds[0]?.slug ?? "");
  designKind.value = editingSlug;
  loadKindEditor();
};

const loadKindEditor = () => {
  editingSlug = designKind.value;
  const scoped = designScope.value === "global"
    ? resolveVocab(serviceVocab, readDesign("global"))
    : resolveVocab(serviceVocab, readDesign("global"), readDesign("project"));
  const kind = scoped.kinds.find((k) => k.slug === editingSlug) ?? kindBySlug(editingSlug);
  if (!kind) return;
  setField("kind-label", kind.label);
  setField("kind-label-position", kind.presentation?.typeLabel ?? "top");
  setField("state-label-position", kind.presentation?.stateLabel ?? "top");
  $("kind-bullets").checked = kind.presentation?.bullets !== false;
  setField("kind-figures", kind.presentation?.figures ?? "inherit");
  setField("kind-template", kind.content?.template);
  setField("kind-title-rule", kind.content?.title);
  setField("kind-bullet-rule", kind.content?.bullets);
  setField("kind-figure-rule", kind.content?.figure);
  renderDesignPreview();
};

const editorPatch = () => ({
  slug: editingSlug,
  label: $("kind-label").value.trim() || editingSlug,
  presentation: {
    typeLabel: $("kind-label-position").value,
    stateLabel: $("state-label-position").value,
    bullets: $("kind-bullets").checked,
    figures: $("kind-figures").value,
  },
  content: {
    template: $("kind-template").value.trim(),
    title: $("kind-title-rule").value.trim(),
    bullets: $("kind-bullet-rule").value.trim(),
    figure: $("kind-figure-rule").value.trim(),
  },
});

const renderDesignPreview = () => {
  if (!editingSlug || !$("kind-label")) return;
  const scoped = designScope.value === "global"
    ? resolveVocab(serviceVocab, readDesign("global"))
    : resolveVocab(serviceVocab, readDesign("global"), readDesign("project"));
  const previewVocab = resolveVocab(scoped, { kinds: [editorPatch()] });
  const kind = previewVocab.kinds.find((k) => k.slug === editingSlug);
  if (!kind) return;
  $("state-guide").innerHTML = kind.states.map((state) =>
    `<div><b>${escapeHtml(state.glyph)} ${escapeHtml(state.label)}</b><span>${escapeHtml(state.blurb)}</span></div>`
  ).join("");
  const previewGraph = {
    chartId: "preview", title: "Preview", direction: "TD", revision: 1, createdAt: 1, updatedAt: 1,
    edges: [], events: [], nodes: [{
      id: "preview-node", title: `${kind.label} example`,
      kind: kind.slug, state: kind.defaultState, bullets: ["Concrete evidence or property", "One useful trade-off"],
      figures: [], createdAt: 1, updatedAt: 1,
    }],
  };
  const labels = kindLabels(previewVocab);
  const layout = layoutGraph(previewGraph, theme, dagre, showFigures, "full", labels, kindPresentations(previewVocab));
  $("design-preview").innerHTML = renderSvg(layout, {
    theme, palette: paletteFor(theme, mode), figureSrc: () => "", glyphs: glyphs(previewVocab),
    kindLabels: labels, pulseStates: pulseStates(previewVocab), interactive: false,
  });
};

const saveKindDesign = () => {
  if (!editingSlug) return;
  const scope = designScope.value;
  const layer = readDesign(scope);
  const kinds = [...(layer.kinds ?? [])];
  const index = kinds.findIndex((k) => k.slug === editingSlug);
  const patch = editorPatch();
  if (index >= 0) kinds[index] = { ...kinds[index], ...patch };
  else kinds.push(patch);
  const next = { ...layer, kinds };
  store.set(designKey(scope), JSON.stringify(next));
  applyDesignLayers();
  renderLegend();
  draw();
  $("design-status").textContent = `${scope === "global" ? "Global" : "Project"} preview saved in this browser.`;
};

$("customize").addEventListener("click", () => {
  populateKindPicker(editingSlug);
  designDialog.showModal();
});
$("design-close").addEventListener("click", () => designDialog.close());
designKind.addEventListener("change", loadKindEditor);
designScope.addEventListener("change", () => populateKindPicker(editingSlug));
$("design-save").addEventListener("click", saveKindDesign);
for (const id of ["kind-label", "kind-label-position", "state-label-position", "kind-bullets", "kind-figures", "kind-template", "kind-title-rule", "kind-bullet-rule", "kind-figure-rule"]) {
  $(id).addEventListener("input", renderDesignPreview);
}
$("design-copy").addEventListener("click", async () => {
  saveKindDesign();
  const scope = designScope.value;
  await copy(JSON.stringify({ vocab: readDesign(scope) }, null, 2));
  $("design-status").textContent = `Copied. Save as ${scope === "global" ? "~/.skym/config.json" : ".skym/config.json"}; restart the agent.`;
});
$("design-add").addEventListener("click", () => {
  const label = prompt("Name the new node type");
  if (!label?.trim()) return;
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug || kindBySlug(slug)) return;
  const seed = vocab.kinds.find((k) => k.slug === "action") ?? vocab.kinds[0];
  const scope = designScope.value;
  const layer = readDesign(scope);
  const created = {
    slug, label: label.trim(), blurb: `A ${label.trim()} node.`,
    states: structuredClone(seed.states), defaultState: seed.defaultState,
    presentation: { typeLabel: "top", stateLabel: "top", bullets: true, figures: "inherit" },
    content: { template: `Use this node for ${label.trim().toLowerCase()} information.` },
  };
  store.set(designKey(scope), JSON.stringify({ ...layer, kinds: [...(layer.kinds ?? []), created] }));
  applyDesignLayers();
  renderLegend();
  draw();
  populateKindPicker(slug);
});

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
  if (!node) return;
  menuNode = node;
  menu.innerHTML = MENU_ITEMS.map((m, i) => `<button data-i="${i}">${escapeHtml(m.label)}</button>`).join("");
  menu.hidden = false;
  // Measure before placing, so the menu never hangs off the viewport.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  for (const btn of menu.querySelectorAll("button")) {
    btn.addEventListener("click", async () => {
      const index = Number(btn.dataset.i);
      try {
        const completed = await MENU_ITEMS[index].run(menuNode);
        btn.textContent = index === 0 && state.commandsEnabled
          ? (completed === false ? "Cancelled" : "Queued")
          : "Copied";
      } catch {
        btn.textContent = "Failed";
      }
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
const syncFigBtn = () => { figBtn.checked = showFigures; };

figBtn.addEventListener("click", () => {
  showFigures = !showFigures;
  store.set("inline-figs", showFigures ? "1" : "0");
  syncFigBtn();
  draw();
});

const positiveBtn = $("positive-only");
const syncPositiveBtn = () => { positiveBtn.checked = positiveOnly; };
positiveBtn.addEventListener("click", () => {
  positiveOnly = !positiveOnly;
  store.set("positive-only", positiveOnly ? "1" : "0");
  syncPositiveBtn();
  selectedId = null;
  userMovedView = false;
  draw();
});

const workingBtn = $("working-only");
const syncWorkingBtn = () => { workingBtn.checked = workingOnly; };
workingBtn.addEventListener("change", () => {
  workingOnly = workingBtn.checked;
  store.set("working-only", workingOnly ? "1" : "0");
  selectedId = null;
  userMovedView = false;
  draw();
});

$("panel-toggle").addEventListener("click", () => {
  panel.classList.toggle("hidden");
  if (!userMovedView) fit();
});

const syncThemeButton = () => { $("theme").textContent = mode === "dark" ? "Dark" : "Light"; };
$("theme").addEventListener("click", () => {
  mode = mode === "light" ? "dark" : "light";
  store.set("theme", mode);
  document.documentElement.setAttribute("data-theme", mode);
  syncThemeButton();
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
  es = new EventSource(chartParam ? `/events?chart=${encodeURIComponent(chartParam)}` : "/events");
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
  state = await fetchGraph(url);
  selectedId = null;
  userMovedView = false;
  draw();
  // Only the live chart streams; a historical one is a static snapshot.
  if (!chartParam || hosted) connect();
  else if (es) es.close();
  dot.classList.toggle("live", !chartParam);
  dot.title = chartParam ? "read-only snapshot" : "live";
});

const boot = async () => {
  const savedWidth = Number(store.get("node-width", 0));
  const config = await fetch("/config")
    .then((r) => r.json())
    .catch(() => ({}));
  applyConfig(config);
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
      hosted = Boolean(w.hosted);
      document.title = `${w.project} · skym`;
    })
    .catch(() => {});

  syncFigBtn();
  syncPositiveBtn();
  syncWorkingBtn();
  syncThemeButton();
  renderLegend();
  refreshCharts();
  setInterval(refreshCharts, 5000);
  connect();
};

boot();

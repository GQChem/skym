(() => {
  const canvas = document.getElementById("canvas");
  const stage = document.getElementById("stage");
  const empty = document.getElementById("empty");
  const panel = document.getElementById("panel");
  const detail = document.getElementById("detail");
  const eventsEl = document.getElementById("events");
  const dot = document.getElementById("live-dot");
  const lightbox = document.getElementById("lightbox");
  const lightboxImg = document.getElementById("lightbox-img");

  let state = null;
  let selectedId = null;
  // Viewing another chat's chart is read-only — no live stream for it.
  let chartParam = new URLSearchParams(location.search).get("chart");
  let ownChartId = null;
  let inlineFigs = localStorage.getItem("skym-inline-figs") === "1";
  let view = { x: 0, y: 0, k: 1 };
  let userMovedView = false;
  let renderToken = 0;

  const theme = () => document.documentElement.getAttribute("data-theme") || "light";

  // "base" + explicit vars, so the status classDefs drive node colour rather than
  // fighting the built-in dark theme's near-black fills.
  const initMermaid = () => {
    const dark = theme() !== "light";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "base",
      themeVariables: {
        darkMode: dark,
        background: dark ? "#1a2030" : "#f7f8fb",
        primaryColor: dark ? "#2b3446" : "#eef2f9",
        primaryTextColor: dark ? "#ffffff" : "#161c26",
        primaryBorderColor: dark ? "#7b8aa8" : "#c2cbdb",
        lineColor: dark ? "#9dabc6" : "#7a869c",
        textColor: dark ? "#f2f5fa" : "#161c26",
        clusterBkg: dark ? "#232b3d" : "#eef1f7",
        clusterBorder: dark ? "#46516b" : "#d3dae6",
        edgeLabelBackground: dark ? "#232b3d" : "#ffffff",
        fontSize: "15px",
      },
      // padding is measured into the node box, so it widens without clipping.
      flowchart: { curve: "basis", htmlLabels: true, useMaxWidth: false, padding: 40, nodeSpacing: 60, rankSpacing: 60 },
    });
  };

  const applyView = () => {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  };

  const fit = () => {
    const svg = canvas.querySelector("svg");
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const w = box.width / view.k;
    const h = box.height / view.k;
    if (!w || !h) return;
    const pad = 48;
    const k = Math.min((stage.clientWidth - pad) / w, (stage.clientHeight - pad) / h, 1.6);
    view.k = Math.max(k, 0.08);
    view.x = (stage.clientWidth - w * view.k) / 2;
    view.y = (stage.clientHeight - h * view.k) / 2;
    applyView();
  };

  // Mermaid regenerates the SVG wholesale, so selection is re-applied after each render.
  const highlight = () => {
    canvas.querySelectorAll(".node").forEach((n) => {
      const on = selectedId && idMatches(n.id, selectedId);
      n.style.filter = on ? "drop-shadow(0 0 7px var(--accent))" : "";
    });
  };

  const cssSafe = (id) => id.replace(/[^a-zA-Z0-9_]/g, "_");

  // Mermaid ids look like "flowchart-n_foo-12"; a substring test would let
  // n_trigram match n_trigram_out, so compare the delimited segment exactly.
  const idMatches = (elId, nodeId) =>
    typeof elId === "string" && elId.split("-").includes(`n_${cssSafe(nodeId)}`);

  const renderDetail = () => {
    if (!state) return;
    const node = state.graph.nodes.find((n) => n.id === selectedId);
    if (!node) {
      detail.className = "muted";
      detail.textContent = "Click a node in the chart.";
      return;
    }
    detail.className = "";
    const parts = [];
    parts.push(`<div class="detail-title"></div>`);
    parts.push(
      `<div class="chips"><span class="chip state-${node.state}">${node.state}</span>` +
        `<span class="chip">${node.kind}</span>` +
        (node.group ? `<span class="chip">${escapeHtml(node.group)}</span>` : "") +
        `</div>`,
    );
    if (node.bullets && node.bullets.length) {
      parts.push(`<ul class="bullets">${node.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`);
    }
    const q = chartParam ? `?chart=${encodeURIComponent(chartParam)}` : "";
    for (const f of node.figures) {
      parts.push(
        `<figure><img src="/assets/${encodeURIComponent(f.file)}${q}" alt="${escapeHtml(f.caption || node.title)}" />` +
          (f.caption ? `<figcaption>${escapeHtml(f.caption)}</figcaption>` : "") +
          `</figure>`,
      );
    }
    if (node.kind === "result" && node.figures.length === 0) {
      parts.push(`<p class="muted nudge">No figure attached — results read best with a plot or screenshot.</p>`);
    }
    detail.innerHTML = parts.join("");
    detail.querySelector(".detail-title").textContent = node.title;
    detail.querySelectorAll("img").forEach((img) => {
      img.addEventListener("click", () => {
        lightboxImg.src = img.src;
        lightbox.hidden = false;
      });
    });
  };

  // The viewer has no channel back to Claude, so the button copies a prompt.
  const workOnBtn = document.getElementById("workon");
  let workOnNode = null;
  let hideTimer = null;

  const promptFor = (n) => {
    const lines = [`Work on node "${n.id}" from the chart: ${n.title}`];
    if (n.bullets?.length) lines.push(...n.bullets.map((b) => `- ${b}`));
    lines.push(`(currently ${n.kind}/${n.state})`);
    return lines.join("\n");
  };

  const showWorkOn = (el, node) => {
    clearTimeout(hideTimer);
    workOnNode = node;
    const r = el.getBoundingClientRect();
    workOnBtn.hidden = false;
    workOnBtn.classList.remove("copied");
    workOnBtn.textContent = "⚙ Work on this";
    workOnBtn.style.left = `${Math.max(8, r.left + r.width / 2 - 60)}px`;
    workOnBtn.style.top = `${Math.max(8, r.top - 34)}px`;
  };

  const scheduleHide = () => {
    hideTimer = setTimeout(() => {
      workOnBtn.hidden = true;
      workOnNode = null;
    }, 400);
  };

  stage.addEventListener("mouseleave", scheduleHide);
  canvas.addEventListener("mouseleave", scheduleHide);
  workOnBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  workOnBtn.addEventListener("mouseleave", scheduleHide);

  workOnBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!workOnNode) return;
    const promptText = promptFor(workOnNode);
    try {
      await navigator.clipboard.writeText(promptText);
    } catch {
      // Clipboard API needs a secure context; fall back to a temp textarea.
      const ta = document.createElement("textarea");
      ta.value = promptText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    workOnBtn.classList.add("copied");
    workOnBtn.textContent = "✓ Copied — paste to Claude";
  });

  const LEGEND = [
    ["action", "planned", "candidate step"],
    ["action", "exploring", "working now ⚙"],
    ["action", "waiting", "blocked on a wait ⏳"],
    ["action", "done", "finished"],
    ["action", "abandoned", "dead end"],
    ["action", "blocked", "stuck"],
    ["result", "good", "it worked"],
    ["result", "bad", "it did not"],
    ["result", "mixed", "tradeoffs"],
    ["result", "inconclusive", "needs more"],
    ["options", "open", "undecided fork"],
  ];

  const renderLegend = () => {
    document.getElementById("legend").innerHTML = LEGEND.map(
      ([kind, st, what]) =>
        `<div class="leg"><span class="sw sw-${st}"></span><b>${st}</b><span class="muted">${kind} · ${what}</span></div>`,
    ).join("");
  };

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const renderEvents = () => {
    if (!state) return;
    const items = state.graph.events.slice(-40).reverse();
    eventsEl.innerHTML = items
      .map((e) => {
        const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return `<li><time>${t}</time><span class="what">${escapeHtml(e.kind)} · ${escapeHtml(e.detail)}</span></li>`;
      })
      .join("");
  };

  const render = async (next) => {
    state = next;
    document.getElementById("project").textContent = state.graph.title || "skym";
    document.getElementById("rev").textContent = `rev ${state.graph.revision}`;

    if (state.graph.chartId) ownChartId = ownChartId ?? state.graph.chartId;
    const has = state.graph.nodes.length > 0;
    empty.hidden = has;
    if (!has) {
      canvas.innerHTML = "";
      renderDetail();
      renderEvents();
      return;
    }

    const token = ++renderToken;
    try {
      const { svg } = await mermaid.render(`skym-${token}`, state.mermaid);
      if (token !== renderToken) return; // A newer update landed mid-render.
      canvas.innerHTML = svg;
    } catch (err) {
      canvas.innerHTML = `<pre style="color:#ff6b7d;white-space:pre-wrap">${escapeHtml(String(err))}</pre>`;
      return;
    }

    canvas.querySelectorAll(".node").forEach((el) => {
      const match = state.graph.nodes.find((n) => idMatches(el.id, n.id));
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (match) {
          selectedId = match.id;
          renderDetail();
          highlight();
        }
      });
      if (match && !chartParam) {
        el.addEventListener("mouseenter", () => showWorkOn(el, match));
      }
    });

    renderInlineFigures();
    if (!userMovedView) fit();
    else applyView();
    highlight();
    renderDetail();
    renderEvents();
  };

  // Figures are overlaid on the SVG rather than injected into mermaid labels,
  // which keeps layout measurement (and therefore node sizing) intact.
  const renderInlineFigures = () => {
    canvas.querySelectorAll(".skym-inline-fig").forEach((e) => e.remove());
    if (!inlineFigs || !state) return;
    const svg = canvas.querySelector("svg");
    if (!svg) return;
    const q = chartParam ? `?chart=${encodeURIComponent(chartParam)}` : "";

    for (const node of state.graph.nodes) {
      if (!node.figures?.length) continue;
      const el = [...canvas.querySelectorAll(".node")].find((e) => idMatches(e.id, node.id));
      if (!el) continue;
      // Draw into the reserved slot, positioned via screen rects so the node's
      // own transform and the canvas zoom are both accounted for.
      const slot = el.querySelector(".skym-fig-slot");
      if (!slot) continue;
      const sr = slot.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      const vb = svg.viewBox.baseVal;
      const sx = (vb?.width || svgRect.width) / svgRect.width;
      const sy = (vb?.height || svgRect.height) / svgRect.height;
      const x = (sr.left - svgRect.left) * sx + (vb?.x ?? 0);
      const y = (sr.top - svgRect.top) * sy + (vb?.y ?? 0);

      const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
      img.setAttribute("href", `/assets/${encodeURIComponent(node.figures[0].file)}${q}`);
      img.setAttribute("x", x);
      img.setAttribute("y", y);
      img.setAttribute("width", sr.width * sx);
      img.setAttribute("height", sr.height * sy);
      img.setAttribute("preserveAspectRatio", "xMidYMid meet");
      img.setAttribute("class", "skym-inline-fig skym-inline-img");
      img.addEventListener("click", (ev) => {
        ev.stopPropagation();
        lightboxImg.src = img.getAttribute("href");
        lightbox.hidden = false;
      });
      svg.appendChild(img);
    }
  };

  // --- pan / zoom ---
  let dragging = false;
  let last = { x: 0, y: 0 };

  stage.addEventListener("mousedown", (e) => {
    dragging = true;
    last = { x: e.clientX, y: e.clientY };
    stage.classList.add("dragging");
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    view.x += e.clientX - last.x;
    view.y += e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    userMovedView = true;
    applyView();
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
    stage.classList.remove("dragging");
  });

  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const k = Math.min(Math.max(view.k * factor, 0.08), 6);
      // Zoom about the cursor rather than the origin.
      view.x = mx - ((mx - view.x) * k) / view.k;
      view.y = my - ((my - view.y) * k) / view.k;
      view.k = k;
      userMovedView = true;
      applyView();
    },
    { passive: false },
  );

  document.getElementById("fit").addEventListener("click", () => {
    userMovedView = false;
    fit();
  });

  const inlineBtn = document.getElementById("inline-figs");
  const syncInlineBtn = () => {
    inlineBtn.classList.toggle("active", inlineFigs);
    document.body.classList.toggle("inline-figs", inlineFigs);
  };

  inlineBtn.addEventListener("click", async () => {
    inlineFigs = !inlineFigs;
    localStorage.setItem("skym-inline-figs", inlineFigs ? "1" : "0");
    syncInlineBtn();
    // The slot changes height, so mermaid must re-measure and re-lay out.
    if (state) await render(state);
  });

  document.getElementById("panel-toggle").addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!userMovedView) fit();
  });

  document.getElementById("theme").addEventListener("click", async () => {
    const next = theme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("skym-theme", next);
    initMermaid();
    // The classDefs are baked server-side, so refetch and reconnect on the new theme.
    const fresh = await fetch(`/graph?theme=${next}`).then((r) => r.json());
    await render(fresh);
    reconnect();
  });

  document.getElementById("export").addEventListener("click", () => {
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

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      lightbox.hidden = true;
      lightboxImg.src = "";
    }
    if (e.key === "f") {
      userMovedView = false;
      fit();
    }
  });

  window.addEventListener("resize", () => {
    if (!userMovedView) fit();
  });

  // --- live connection ---
  let es = null;

  const reconnect = () => {
    if (es) es.close();
    connect();
  };

  const connect = () => {
    es = new EventSource(`/events?theme=${theme()}`);
    es.onopen = () => {
      dot.classList.add("live");
      dot.title = "live";
    };
    es.onmessage = (ev) => {
      try {
        render(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      dot.classList.remove("live");
      dot.title = "reconnecting…";
      // EventSource retries on its own; no manual reconnect needed.
    };
  };

  const chartsEl = document.getElementById("charts");

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
            `<option value="${c.chartId}"${c.chartId === cur ? " selected" : ""}>` +
            `${c.title} (${c.nodes})${c.active ? " ● live" : ""}</option>`,
        )
        .join("");
    } catch {
      chartsEl.hidden = true;
    }
  };

  chartsEl.addEventListener("change", async () => {
    const pick = chartsEl.value;
    chartParam = pick === ownChartId ? null : pick;
    const url = chartParam ? `/graph?chart=${encodeURIComponent(chartParam)}&theme=${theme()}` : `/graph?theme=${theme()}`;
    const fresh = await fetch(url).then((r) => r.json());
    selectedId = null;
    userMovedView = false;
    await render(fresh);
    // Only the live chart streams; a historical one is a static snapshot.
    if (!chartParam) reconnect();
    else if (es) es.close();
    document.getElementById("live-dot").classList.toggle("live", !chartParam);
    document.getElementById("live-dot").title = chartParam ? "read-only snapshot" : "live";
  });

  const saved = localStorage.getItem("skym-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  initMermaid();
  syncInlineBtn();
  renderLegend();
  refreshCharts();
  setInterval(refreshCharts, 5000);
  connect();
})();

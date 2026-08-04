import type { FlowNode, Graph } from "./store.js";
import { STATE_GLYPH, DEFAULT_THEME } from "./theme.js";

export type Theme = "light" | "dark";

function safeId(id: string): string {
  return `n_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function escapeLabel(text: string): string {
  return text
    .replace(/"/g, "&quot;")
    .replace(/[[\]{}()]/g, (c) => `#${c.charCodeAt(0)};`);
}

/**
 * Mermaid's marks predate the SVG renderer's glyphs and are tuned for a text
 * export, so they stay distinct; an unlisted state falls back to the
 * vocabulary's glyph rather than rendering as undefined.
 */
const STATE_MARK: Record<string, string> = {
  planned: "○",
  exploring: "⚙",
  waiting: "⏳",
  done: "●",
  abandoned: "✕",
  blocked: "⊘",
  good: "✓",
  bad: "✗",
  mixed: "≈",
  inconclusive: "?",
  open: "⋔",
  resolved: "⌄",
  active: "※",
  retired: "·",
};

const markFor = (state: string): string => STATE_MARK[state] ?? STATE_GLYPH[state] ?? "•";

/** Wrapped so CSS can animate the mark without touching the rest of the label. */
const ANIMATED: Record<string, string> = {
  exploring: "skym-gear",
  waiting: "skym-hourglass",
};

const MAX_BULLETS = 6;
const MAX_BULLET_CHARS = 102; // 50% wider boxes fit proportionally more text

/** All three kinds are rounded rects; state and kind are carried by fill/border. */
function nodeLabel(n: FlowNode): string {
  const anim = ANIMATED[n.state];
  const mark = anim ? `<span class='${anim}'>${markFor(n.state)}</span>` : markFor(n.state);
  const head = `<b>${mark} ${escapeLabel(n.title)}</b>`;
  const shown = n.bullets.slice(0, MAX_BULLETS);
  const bullets = shown.map((b) => {
    const t = b.length > MAX_BULLET_CHARS ? `${b.slice(0, MAX_BULLET_CHARS - 1)}…` : b;
    return `• ${escapeLabel(t)}`;
  });
  const more = n.bullets.length > shown.length ? [`<i>+${n.bullets.length - shown.length} more</i>`] : [];
  // A tall transparent spacer reserves room the viewer draws the figure into
  // when inline mode is on; the emoji line is the fallback when it is off.
  const figs = n.figures.length
    ? [
        `<span class='skym-fig-slot'></span>`,
        `<span class='skym-fig-count'>🖼 ${n.figures.length} figure${n.figures.length > 1 ? "s" : ""}</span>`,
      ]
    : [];
  // A zero-ink spacer sets the measured width; the viewer overrides its width
  // via CSS so the node-width slider works without re-rendering server-side.
  const spacer = "<span class='skym-width-spacer'></span>";
  return [head, ...bullets, ...more, ...figs, spacer].join("<br/>");
}

export function toMermaid(graph: Graph, theme: Theme = "light"): string {
  const lines: string[] = [`flowchart ${graph.direction}`];

  const grouped = new Map<string, FlowNode[]>();
  const ungrouped: FlowNode[] = [];
  for (const n of graph.nodes) {
    if (n.group) {
      const list = grouped.get(n.group) ?? [];
      list.push(n);
      grouped.set(n.group, list);
    } else ungrouped.push(n);
  }

  const emit = (n: FlowNode, indent: string) =>
    lines.push(`${indent}${safeId(n.id)}("${nodeLabel(n)}")`);

  for (const n of ungrouped) emit(n, "  ");

  let g = 0;
  for (const [group, nodes] of grouped) {
    lines.push(`  subgraph sg_${g++}["${escapeLabel(group)}"]`);
    for (const n of nodes) emit(n, "    ");
    lines.push("  end");
  }

  for (const e of graph.edges) {
    const arrow = e.dashed ? "-.->" : "-->";
    const from = safeId(e.from);
    const to = safeId(e.to);
    lines.push(
      e.label ? `  ${from} ${arrow}|"${escapeLabel(e.label)}"| ${to}` : `  ${from} ${arrow} ${to}`,
    );
  }

  for (const n of graph.nodes) lines.push(`  class ${safeId(n.id)} st_${n.state};`);
  const base = theme === "light" ? LIGHT : DARK;
  lines.push(...base, ...extraClassDefs(graph, base, theme));

  return lines.join("\n");
}

/**
 * A state the hand-tuned lists never covered — a custom one, or `active`/
 * `retired`, which they omit — would render unstyled. Derive it from the
 * palette so every node on the chart carries its state's colour.
 */
function extraClassDefs(graph: Graph, base: string[], theme: Theme): string[] {
  const palette = theme === "light" ? DEFAULT_THEME.light : DEFAULT_THEME.dark;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.state) || base.some((l) => l.includes(`classDef st_${n.state} `))) continue;
    seen.add(n.state);
    const ink = palette.states[n.state] ?? palette.neutral;
    out.push(
      `  classDef st_${n.state} fill:${ink.fill},stroke:${ink.accent},stroke-width:2px,color:${palette.ink},text-align:left;`,
    );
  }
  return out;
}

// Actions: solid border. Results: thick border, saturated fill. Options: dashed.
const LIGHT = [
  "  classDef st_planned fill:#f4f6fa,stroke:#94a1b8,stroke-width:1.5px,color:#1e2536,text-align:left;",
  "  classDef st_exploring fill:#e0edff,stroke:#2f7fc4,stroke-width:2.5px,color:#0d3355,text-align:left;",
  "  classDef st_waiting fill:#fdf0d5,stroke:#c9861a,stroke-width:2.5px,color:#573a06,text-align:left;",
  "  classDef st_done fill:#e8eefb,stroke:#4a6ea8,stroke-width:1.5px,color:#1b2740,text-align:left;",
  "  classDef st_abandoned fill:#eeeef1,stroke:#a0a0ad,stroke-width:1.5px,color:#6b6b78,stroke-dasharray:4 3,text-align:left;",
  "  classDef st_blocked fill:#fff2e0,stroke:#d98324,stroke-width:2px,color:#5c3a0d,text-align:left;",
  "  classDef st_good fill:#d2f2e4,stroke:#1e8a63,stroke-width:3px,color:#0c3d2c,text-align:left;",
  "  classDef st_bad fill:#ffdde1,stroke:#c0394a,stroke-width:3px,color:#4d121a,text-align:left;",
  "  classDef st_mixed fill:#fdf0cd,stroke:#b8860b,stroke-width:3px,color:#4a3606,text-align:left;",
  "  classDef st_inconclusive fill:#eceef2,stroke:#7d8798,stroke-width:3px,color:#2b3444,text-align:left;",
  "  classDef st_open fill:#f7f2ff,stroke:#8257c4,stroke-width:2px,color:#33206b,stroke-dasharray:6 4,text-align:left;",
  "  classDef st_resolved fill:#efe9fb,stroke:#8257c4,stroke-width:1.5px,color:#33206b,text-align:left;",
];

const DARK = [
  "  classDef st_planned fill:#333d54,stroke:#8d9ab4,stroke-width:1.5px,color:#e8edf7,text-align:left;",
  "  classDef st_exploring fill:#1e5a8f,stroke:#7cc4ff,stroke-width:2.5px,color:#ffffff,text-align:left;",
  "  classDef st_waiting fill:#6b5115,stroke:#f0c260,stroke-width:2.5px,color:#fff4dc,text-align:left;",
  "  classDef st_done fill:#2c3a5c,stroke:#7b8db5,stroke-width:1.5px,color:#e8edf7,text-align:left;",
  "  classDef st_abandoned fill:#33333c,stroke:#7a7a88,stroke-width:1.5px,color:#9a9aa8,stroke-dasharray:4 3,text-align:left;",
  "  classDef st_blocked fill:#6b4715,stroke:#e5a93f,stroke-width:2px,color:#ffe9c9,text-align:left;",
  "  classDef st_good fill:#1f6f52,stroke:#5fd6a4,stroke-width:3px,color:#ffffff,text-align:left;",
  "  classDef st_bad fill:#8c2f3c,stroke:#ff8a99,stroke-width:3px,color:#ffffff,text-align:left;",
  "  classDef st_mixed fill:#7a5c14,stroke:#e8c35c,stroke-width:3px,color:#fff6dd,text-align:left;",
  "  classDef st_inconclusive fill:#3a4356,stroke:#93a1bd,stroke-width:3px,color:#e8edf7,text-align:left;",
  "  classDef st_open fill:#3d2f66,stroke:#b291f0,stroke-width:2px,color:#efe6ff,stroke-dasharray:6 4,text-align:left;",
  "  classDef st_resolved fill:#332a52,stroke:#9d7fe0,stroke-width:1.5px,color:#efe6ff,text-align:left;",
];

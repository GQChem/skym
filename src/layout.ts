import type { FlowNode, Graph } from "./store.js";
import type { Theme } from "./theme.js";
import { KIND_LABEL } from "./theme.js";
import type { KindPresentation } from "./vocab.js";

export interface Line {
  text: string;
  /** Bullets that wrapped keep their marker only on the first line. */
  first: boolean;
}

export interface LaidOutNode {
  id: string;
  node: FlowNode;
  x: number;
  y: number;
  w: number;
  h: number;
  titleLines: string[];
  bulletLines: Line[];
  /** Reserved figure box in card-local coordinates, when the node has one. */
  figure?: { x: number; y: number; w: number; h: number };
  hiddenBullets: number;
  presentation: KindPresentation;
  sideRail: number;
  metaHeight: number;
  badgeHeight: number;
  /** Titles become the primary visual signal when compact mode removes body copy. */
  titleSize: number;
  titleLeading: number;
}

export interface LaidOutEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  path: string;
  labelPos?: { x: number; y: number };
}

export interface LaidOutCluster {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  clusters: LaidOutCluster[];
  width: number;
  height: number;
}

/**
 * Average glyph widths as a fraction of font size. Cheap, deterministic, and
 * identical on server and client — a canvas measure would differ between the
 * two and desync the offline file.
 *
 * Calibrated against canvas measureText for the UI sans at the sizes we render
 * (see scripts/calibrate-text.mjs). Estimating high is not a safe default: it
 * wraps text that would have fit and stops cards from reaching their ceiling.
 */
// Two tiers: "i" and "l" really are hairline, but t/f/r sit nearer half width.
const HAIRLINE = new Set("ilI!.,;:'|`");
const NARROW = new Set("jtfr()[]{}/\\-\"");
const WIDE = new Set("mwMW@%");

export function textWidth(text: string, size: number, weight = 400): number {
  let units = 0;
  for (const ch of text) {
    if (HAIRLINE.has(ch)) units += 0.2;
    else if (NARROW.has(ch)) units += 0.465;
    else if (WIDE.has(ch)) units += 0.861;
    else if (ch === " ") units += 0.274;
    else if (ch >= "A" && ch <= "Z") units += 0.6125;
    else if (ch >= "0" && ch <= "9") units += 0.539;
    else units += 0.49;
  }
  // Semibold text sets slightly wider than regular at the same size.
  const weighting = weight >= 600 ? 1.03 : 1;
  return units * size * weighting;
}

export function wrap(text: string, size: number, maxWidth: number, weight = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, weight) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const MAX_TITLE_LINES = 3;
const MAX_BULLET_LINES = 8;

/** Bullets hang from a marker, so wrapped lines indent to clear it. */
const MARKER_INDENT = 11;


/** Always ends in an ellipsis: the caller uses it to signal dropped text. */
function truncateToWidth(text: string, size: number, maxWidth: number, weight = 400): string {
  let out = text;
  while (out.length > 1 && textWidth(`${out}…`, size, weight) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}…`;
}

/**
 * How much of a card is worth drawing. Bullets are the small print: they go
 * illegible well before the title does, and they carry most of a card's height,
 * so dropping them is what actually buys screen space.
 *
 * There is no title-only level. Zoomed out far enough for a figure to be worth
 * hiding, the title is already too small to read, so the level bought nothing —
 * and the Figures toggle already covers hiding figures deliberately.
 */
export type Detail = "full" | "compact";

/** Zoom threshold for automatic detail selection. */
export function detailForZoom(k: number): Detail {
  return k < 0.62 ? "compact" : "full";
}

/**
 * Measures a card so dagre can lay out real boxes rather than guesses.
 *
 * `card.width` is a ceiling, not a fixed size: text wraps at it, then the card
 * shrinks back to whatever the longest line actually needs. A narrow setting
 * therefore yields compact cards rather than tall ones padded with dead space.
 */
export function measureNode(
  node: FlowNode,
  theme: Theme,
  showFigures: boolean,
  detail: Detail = "full",
  kindLabels: Record<string, string> = KIND_LABEL,
  kindPresentation: Record<string, KindPresentation> = {},
): LaidOutNode {
  const { card, type } = theme;
  const titleSize = detail === "compact" ? type.titleSize * 1.25 : type.titleSize;
  const titleLeading = detail === "compact" ? type.titleLeading + 4 : type.titleLeading;
  const presentation = kindPresentation[node.kind] ?? {};
  const sideRail = presentation.typeLabel === "left" || presentation.stateLabel === "left" ? 30 : card.stripe;
  const chrome = card.padX * 2 + sideRail;
  const inner = card.width - chrome;

  const rawTitle = wrap(node.title, titleSize, inner, type.titleWeight);
  const titleLines = rawTitle.slice(0, MAX_TITLE_LINES);
  if (rawTitle.length > MAX_TITLE_LINES) {
    titleLines[MAX_TITLE_LINES - 1] = truncateToWidth(
      titleLines[MAX_TITLE_LINES - 1],
      titleSize,
      inner,
      type.titleWeight,
    );
  }

  // Bullets are the first thing to go: they carry the most ink for the least
  // legibility once the view is zoomed out.
  const bulletLines: Line[] = [];
  let hiddenBullets = 0;
  if (detail === "full" && presentation.bullets !== false) {
    for (const bullet of node.bullets) {
      if (bulletLines.length >= MAX_BULLET_LINES) {
        hiddenBullets++;
        continue;
      }
      const wrapped = wrap(bullet, type.bulletSize, inner - MARKER_INDENT);
      for (let i = 0; i < wrapped.length; i++) {
        if (bulletLines.length >= MAX_BULLET_LINES) break;
        bulletLines.push({ text: wrapped[i], first: i === 0 });
      }
    }
  }

  // Figures survive every detail level: a chart still reads as a shape when its
  // labels do not, and the Figures toggle is how they get hidden on purpose.
  const wantFigure = presentation.figures === "show" ||
    (presentation.figures !== "hide" && showFigures);

  // Widest real line, so the card can give back space nothing is using. The
  // meta row is included — it is often the widest thing on a short card.
  // Must match the string render.ts draws, or the card is measured wrong.
  const typeLabel = presentation.typeLabel ?? "top";
  const stateLabel = presentation.stateLabel ?? "top";
  const kindText = (kindLabels[node.kind] ?? node.kind).toUpperCase();
  const topMeta = [typeLabel === "top" ? kindText : "", stateLabel === "top" ? node.state.toUpperCase() : ""].filter(Boolean);
  const metaText = topMeta.join(" · ");
  const sideMeta = [typeLabel === "left" ? kindText : "", stateLabel === "left" ? node.state.toUpperCase() : ""].filter(Boolean).join(" · ");
  const metaH = topMeta.length ? type.metaSize + 7 : 0;
  const badgeH = node.badge ? 25 : 0;
  const titleH = titleLines.length * titleLeading;
  const bulletsH = bulletLines.length ? card.gap + bulletLines.length * type.bulletLeading : 0;
  const artifactH = node.artifacts?.length ? card.gap + type.metaSize + 4 : 0;
  const metaW =
    type.metaSize + 5 + textWidth(metaText, type.metaSize, type.metaWeight);
  const contentW = Math.max(
    metaW,
    node.badge ? textWidth(node.badge, 10, 700) + 18 : 0,
    ...titleLines.map((t) => textWidth(t, titleSize, type.titleWeight)),
    ...bulletLines.map((b) => MARKER_INDENT + textWidth(b.text, type.bulletSize)),
    // A figure is laid out against the ceiling, so it pins the card open.
    wantFigure && node.figures.length ? inner : 0,
  );
  const width = Math.min(card.width, Math.ceil(contentW) + chrome);
  const innerFinal = width - chrome;

  let figure: LaidOutNode["figure"];
  let figureH = 0;
  if (wantFigure && node.figures.length) {
    const w = innerFinal;
    const h = Math.round(w * card.figureRatio);
    figureH = card.gap + h;
    figure = { x: sideRail + card.padX, y: 0, w, h };
  } else if (node.figures.length && detail === "full") {
    // The "N figures" note is itself small print; drop it with the bullets.
    figureH = card.gap + type.metaSize + 4;
  }

  const compactMinHeight = metaH ? card.minHeight : Math.max(44, card.minHeight - (type.metaSize + 7));
  const h = Math.max(
    compactMinHeight,
    sideMeta ? textWidth(sideMeta, type.metaSize, 700) + 24 : 0,
    card.padY * 2 + badgeH + metaH + titleH + bulletsH + figureH + artifactH,
  );

  if (figure) {
    figure.y = card.padY + badgeH + metaH + titleH + bulletsH + card.gap;
  }

  return {
    id: node.id,
    node,
    x: 0,
    y: 0,
    w: width,
    h,
    titleLines,
    bulletLines,
    figure,
    hiddenBullets,
    presentation,
    sideRail,
    metaHeight: metaH,
    badgeHeight: badgeH,
    titleSize,
    titleLeading,
  };
}

/**
 * Structural view of the dagre entry point. Kept loose so the browser copy and
 * the node import satisfy it identically.
 */
export type DagreLike = {
  graphlib: { Graph: new (opts?: any) => any };
  layout: (g: any) => void;
};

/**
 * Rounded orthogonal routing: dagre gives a polyline through rank channels,
 * which we square off and fillet so edges read as circuitry rather than noodles.
 */
function orthogonalPath(points: { x: number; y: number }[], radius: number, vertical: boolean, sharedMid?: number): string {
  if (points.length < 2) return "";
  const start = points[0];
  const end = points[points.length - 1];

  // A straight shot needs no elbow.
  if (Math.abs(start.x - end.x) < 1 || Math.abs(start.y - end.y) < 1) {
    return `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`;
  }

  // Single elbow at the midpoint of the travel axis.
  const mid = sharedMid ?? (vertical ? (start.y + end.y) / 2 : (start.x + end.x) / 2);
  const r = Math.min(
    radius,
    Math.abs(vertical ? end.x - start.x : end.y - start.y) / 2,
    Math.abs(vertical ? mid - start.y : mid - start.x),
    Math.abs(vertical ? end.y - mid : end.x - mid),
  );

  if (vertical) {
    const dirX = end.x > start.x ? 1 : -1;
    const dirY = end.y > mid ? 1 : -1;
    return [
      `M${start.x.toFixed(1)},${start.y.toFixed(1)}`,
      `L${start.x.toFixed(1)},${(mid - r * dirY).toFixed(1)}`,
      `Q${start.x.toFixed(1)},${mid.toFixed(1)} ${(start.x + r * dirX).toFixed(1)},${mid.toFixed(1)}`,
      `L${(end.x - r * dirX).toFixed(1)},${mid.toFixed(1)}`,
      `Q${end.x.toFixed(1)},${mid.toFixed(1)} ${end.x.toFixed(1)},${(mid + r * dirY).toFixed(1)}`,
      `L${end.x.toFixed(1)},${end.y.toFixed(1)}`,
    ].join(" ");
  }
  const dirY = end.y > start.y ? 1 : -1;
  const dirX = end.x > mid ? 1 : -1;
  return [
    `M${start.x.toFixed(1)},${start.y.toFixed(1)}`,
    `L${(mid - r * dirX).toFixed(1)},${start.y.toFixed(1)}`,
    `Q${mid.toFixed(1)},${start.y.toFixed(1)} ${mid.toFixed(1)},${(start.y + r * dirY).toFixed(1)}`,
    `L${mid.toFixed(1)},${(end.y - r * dirY).toFixed(1)}`,
    `Q${mid.toFixed(1)},${end.y.toFixed(1)} ${(mid + r * dirX).toFixed(1)},${end.y.toFixed(1)}`,
    `L${end.x.toFixed(1)},${end.y.toFixed(1)}`,
  ].join(" ");
}

const CLUSTER_PAD = 12;
const CLUSTER_HEAD = 16;
const CANVAS_MARGIN = 10;

export function layoutGraph(
  graph: Graph,
  theme: Theme,
  dagre: DagreLike,
  showFigures: boolean,
  detail: Detail = "full",
  kindLabels: Record<string, string> = KIND_LABEL,
  kindPresentation: Record<string, KindPresentation> = {},
): LayoutResult {
  const measured = graph.nodes.map((n) => measureNode(n, theme, showFigures, detail, kindLabels, kindPresentation));
  const byId = new Map(measured.map((m) => [m.id, m]));
  const vertical = graph.direction === "TD" || graph.direction === "BT";

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  // Grouped charts need a wider rank gap: the cluster's frame and its title sit
  // in that channel, and edges must clear both.
  const hasGroups = graph.nodes.some((n) => n.group);
  g.setGraph({
    rankdir: graph.direction,
    ranksep: theme.layout.rankGap + (hasGroups ? CLUSTER_PAD + CLUSTER_HEAD : 0),
    nodesep: theme.layout.nodeGap,
    marginx: CANVAS_MARGIN,
    marginy: CANVAS_MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const clusters = new Set<string>();
  for (const m of measured) {
    g.setNode(m.id, { width: m.w, height: m.h });
    if (m.node.group) {
      const cid = `cluster:${m.node.group}`;
      if (!clusters.has(cid)) {
        clusters.add(cid);
        g.setNode(cid, {});
      }
      (g as unknown as { setParent: (a: string, b: string) => void }).setParent(m.id, cid);
    }
  }

  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    // Dagre is a DAG layouter; a back edge would throw off ranking, so keep
    // only the first direction seen for any pair.
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    g.setEdge(e.from, e.to, { width: e.label ? textWidth(e.label, 11) + 12 : 0, height: e.label ? 16 : 0 }, e.id);
  }

  dagre.layout(g);

  // Keep Dagre's compact placement for unrelated branches. Only direct
  // siblings in the same generation share a leading edge; chart-wide rank
  // alignment wastes space by making independent subtrees obey each other.
  const nodeRanks = new Map<string, number>();
  for (const m of measured) {
    const pos = g.node(m.id);
    if (!pos) continue;
    m.x = pos.x - m.w / 2;
    m.y = pos.y - m.h / 2;
    nodeRanks.set(m.id, Math.round(vertical ? pos.y : pos.x));
  }

  // Align disconnected trees by translating whole components, never just
  // their roots. Packing them into disjoint cross-axis lanes prevents a moved
  // tree (and every edge inside it) from passing through another tree.
  const neighbours = new Map<string, Set<string>>(measured.map((node) => [node.id, new Set()]));
  const childIds = new Set<string>();
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    neighbours.get(edge.from)!.add(edge.to);
    neighbours.get(edge.to)!.add(edge.from);
    childIds.add(edge.to);
  }
  const components: LaidOutNode[][] = [];
  const visited = new Set<string>();
  for (const start of measured) {
    if (visited.has(start.id)) continue;
    const component: LaidOutNode[] = [];
    const queue = [start.id];
    visited.add(start.id);
    while (queue.length) {
      const id = queue.shift()!;
      component.push(byId.get(id)!);
      for (const next of neighbours.get(id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    components.push(component);
  }
  const starts = components.map((component) => {
    const roots = component.filter((node) => !childIds.has(node.id));
    const candidates = roots.length ? roots : component;
    return Math.min(...candidates.map((node) => vertical ? node.y : node.x));
  });
  const sharedStart = starts.length ? Math.min(...starts) : 0;
  for (let i = 0; i < components.length; i++) {
    const delta = sharedStart - starts[i];
    for (const node of components[i]) {
      if (vertical) node.y += delta;
      else node.x += delta;
    }
  }
  const childrenByParent = new Map<string, LaidOutNode[]>();
  const parentsByChild = new Map<string, LaidOutNode[]>();
  for (const edge of graph.edges) {
    const child = byId.get(edge.to);
    const parent = byId.get(edge.from);
    if (!child || !parent) continue;
    const children = childrenByParent.get(edge.from) ?? [];
    if (!children.includes(child)) children.push(child);
    childrenByParent.set(edge.from, children);
    const parents = parentsByChild.get(edge.to) ?? [];
    if (!parents.includes(parent)) parents.push(parent);
    parentsByChild.set(edge.to, parents);
  }

  // Union peer sets so alignment works in both directions: one parent with
  // several children, and several parents converging on one child.
  const leaders = new Map<string, string>();
  const find = (id: string): string => {
    const leader = leaders.get(id) ?? id;
    if (leader === id) return id;
    const root = find(leader);
    leaders.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) leaders.set(rb, ra);
  };
  for (const peers of [...childrenByParent.values(), ...parentsByChild.values()]) {
    const byGeneration = new Map<number, LaidOutNode[]>();
    for (const peer of peers) {
      const rank = nodeRanks.get(peer.id);
      if (rank === undefined) continue;
      const generation = byGeneration.get(rank) ?? [];
      generation.push(peer);
      byGeneration.set(rank, generation);
    }
    for (const generation of byGeneration.values()) {
      for (let i = 1; i < generation.length; i++) union(generation[0].id, generation[i].id);
    }
  }
  const alignmentGroups = new Map<string, LaidOutNode[]>();
  for (const m of measured) {
    const root = find(m.id);
    const peers = alignmentGroups.get(root) ?? [];
    peers.push(m);
    alignmentGroups.set(root, peers);
  }
  for (const peers of alignmentGroups.values()) {
    if (peers.length < 2) continue;
    if (vertical) {
      const top = Math.min(...peers.map((m) => m.y));
      for (const peer of peers) peer.y = top;
    } else {
      const left = Math.min(...peers.map((m) => m.x));
      for (const peer of peers) peer.x = left;
    }
  }

  // Dagre lays disconnected components out together, which can leave uneven
  // whitespace between them. Pack whole trees after every alignment adjustment
  // so their bounding boxes have one predictable gap and cannot overlap.
  const crossStart = (component: LaidOutNode[]) => Math.min(...component.map((node) => vertical ? node.x : node.y));
  const crossEnd = (component: LaidOutNode[]) => Math.max(...component.map((node) => vertical ? node.x + node.w : node.y + node.h));
  components.sort((a, b) => crossStart(a) - crossStart(b));
  let crossCursor: number | undefined;
  for (const component of components) {
    const shift = crossCursor === undefined ? 0 : crossCursor + theme.layout.nodeGap - crossStart(component);
    for (const node of component) {
      if (vertical) node.x += shift;
      else node.y += shift;
    }
    crossCursor = crossEnd(component);
  }

  const laidOutEdges: LaidOutEdge[] = [];
  for (const e of graph.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const outgoing = childrenByParent.get(e.from) ?? [];
    const incoming = parentsByChild.get(e.to) ?? [];
    const fanOut = outgoing.filter((n) => nodeRanks.get(n.id) === nodeRanks.get(b.id)).length > 1;
    const fanIn = incoming.filter((n) => nodeRanks.get(n.id) === nodeRanks.get(a.id)).length > 1;
    const points = anchorPoints(a, b, vertical, fanOut || fanIn);
    let bus: number | undefined;
    if (fanOut) {
      const target = anchorPoints(a, outgoing.find((n) => nodeRanks.get(n.id) === nodeRanks.get(b.id))!, vertical, true)[1];
      bus = vertical ? (points[0].y + target.y) / 2 : (points[0].x + target.x) / 2;
    } else if (fanIn) {
      const sourceFaces = incoming
        .filter((n) => nodeRanks.get(n.id) === nodeRanks.get(a.id))
        .map((n) => anchorPoints(n, b, vertical, true)[0]);
      if (vertical) {
        const towardDown = points[1].y >= points[0].y;
        const boundary = towardDown ? Math.max(...sourceFaces.map((p) => p.y)) : Math.min(...sourceFaces.map((p) => p.y));
        bus = (boundary + points[1].y) / 2;
      } else {
        const towardRight = points[1].x >= points[0].x;
        const boundary = towardRight ? Math.max(...sourceFaces.map((p) => p.x)) : Math.min(...sourceFaces.map((p) => p.x));
        bus = (boundary + points[1].x) / 2;
      }
    }
    // The label belongs on the run the elbow actually travels, offset off the
    // stroke so it never sits on top of a neighbouring edge.
    const mid = vertical
      ? { x: points[1].x, y: (bus ?? (points[0].y + points[1].y) / 2) + theme.layout.edgeRadius }
      : { x: (bus ?? (points[0].x + points[1].x) / 2) + theme.layout.edgeRadius, y: points[1].y };
    laidOutEdges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      dashed: e.dashed,
      path: orthogonalPath(points, theme.layout.edgeRadius, vertical, bus),
      labelPos: e.label ? mid : undefined,
    });
  }

  const laidOutClusters: LaidOutCluster[] = [];
  const groups = new Map<string, LaidOutNode[]>();
  for (const m of measured) {
    if (!m.node.group) continue;
    const list = groups.get(m.node.group) ?? [];
    list.push(m);
    groups.set(m.node.group, list);
  }
  for (const [name, members] of groups) {
    const x = Math.min(...members.map((m) => m.x)) - CLUSTER_PAD;
    const y = Math.min(...members.map((m) => m.y)) - CLUSTER_PAD - CLUSTER_HEAD;
    const right = Math.max(...members.map((m) => m.x + m.w)) + CLUSTER_PAD;
    const bottom = Math.max(...members.map((m) => m.y + m.h)) + CLUSTER_PAD;
    laidOutClusters.push({ name, x, y, w: right - x, h: bottom - y });
  }

  const all = [
    ...measured.map((m) => ({ x1: m.x, y1: m.y, x2: m.x + m.w, y2: m.y + m.h })),
    ...laidOutClusters.map((c) => ({ x1: c.x, y1: c.y, x2: c.x + c.w, y2: c.y + c.h })),
  ];
  const pad = 28;
  const width = all.length ? Math.max(...all.map((b) => b.x2)) + pad : 0;
  const height = all.length ? Math.max(...all.map((b) => b.y2)) + pad : 0;

  return { nodes: measured, edges: laidOutEdges, clusters: laidOutClusters, width, height };
}

/**
 * Edges leave and enter on the face pointing at the other card. When the two
 * cards barely overlap on the cross axis, the exit slides along the face toward
 * the target so the elbow stays short instead of doubling back.
 */
function anchorPoints(
  a: LaidOutNode,
  b: LaidOutNode,
  vertical: boolean,
  centered = false,
): { x: number; y: number }[] {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };

  if (vertical) {
    const down = bc.y >= ac.y;
    // Keep the exit inside the card's own width, biased toward the target.
    const inset = Math.min(a.w / 2 - 12, Math.abs(bc.x - ac.x) / 2);
    const exitX = centered ? ac.x : ac.x + Math.sign(bc.x - ac.x) * Math.max(0, inset);
    return [
      { x: exitX, y: down ? a.y + a.h : a.y },
      { x: bc.x, y: down ? b.y : b.y + b.h },
    ];
  }

  const right = bc.x >= ac.x;
  const inset = Math.min(a.h / 2 - 10, Math.abs(bc.y - ac.y) / 2);
  const exitY = centered ? ac.y : ac.y + Math.sign(bc.y - ac.y) * Math.max(0, inset);
  return [
    { x: right ? a.x + a.w : a.x, y: exitY },
    { x: right ? b.x : b.x + b.w, y: bc.y },
  ];
}

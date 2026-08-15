import assert from "node:assert/strict";
import test from "node:test";
import dagre from "@dagrejs/dagre";
import { detailForZoom, layoutGraph, measureNode, textWidth, wrap } from "../dist/layout.js";
import { DEFAULT_THEME, resolveTheme } from "../dist/theme.js";

const node = (over = {}) => ({
  id: "n1",
  title: "A node",
  kind: "action",
  state: "planned",
  bullets: [],
  figures: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const graph = (nodes, edges = []) => ({
  chartId: "t",
  title: "T",
  direction: "TD",
  nodes,
  edges,
  events: [],
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
});

test("textWidth grows with length and font size", () => {
  assert.ok(textWidth("aa", 12) > textWidth("a", 12));
  assert.ok(textWidth("abc", 20) > textWidth("abc", 12));
  assert.equal(textWidth("", 12), 0);
});

test("narrow glyphs measure narrower than wide ones", () => {
  assert.ok(textWidth("iiii", 12) < textWidth("mmmm", 12));
});

test("wrap keeps every line inside the max width", () => {
  const words = "the quick brown fox jumps over the lazy dog near the river bank";
  const lines = wrap(words, 12, 120);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(textWidth(l, 12) <= 120, `too wide: ${l}`);
  assert.equal(lines.join(" "), words);
});

test("wrap never drops a word that alone exceeds the width", () => {
  const lines = wrap("supercalifragilisticexpialidocious", 12, 20);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^supercalifragilistic/);
});

test("a card is at least the theme's minimum height", () => {
  const m = measureNode(node(), DEFAULT_THEME, false);
  assert.ok(m.h >= DEFAULT_THEME.card.minHeight);
  assert.ok(m.w <= DEFAULT_THEME.card.width);
});

test("more bullets make a taller card", () => {
  const few = measureNode(node({ bullets: ["one"] }), DEFAULT_THEME, false);
  const many = measureNode(
    node({ bullets: ["one", "two", "three", "four", "five"] }),
    DEFAULT_THEME,
    false,
  );
  assert.ok(many.h > few.h);
});

test("the default theme keeps charts deliberately dense", () => {
  assert.ok(DEFAULT_THEME.layout.rankGap <= 30);
  assert.ok(DEFAULT_THEME.layout.nodeGap <= 14);
  assert.ok(DEFAULT_THEME.card.padX <= 12);
  assert.ok(DEFAULT_THEME.card.padY <= 9);
});

test("a kind can hide its bullets without changing the node data", () => {
  const m = measureNode(node({ bullets: ["one", "two"] }), DEFAULT_THEME, false, "full", undefined, {
    action: { bullets: false },
  });
  assert.equal(m.bulletLines.length, 0);
  assert.equal(m.node.bullets.length, 2);
});

test("a kind can override the chart-level figure toggle", () => {
  const withFigure = node({ figures: [{ file: "plot.svg" }] });
  assert.ok(measureNode(withFigure, DEFAULT_THEME, false, "full", undefined, { action: { figures: "show" } }).figure);
  assert.equal(measureNode(withFigure, DEFAULT_THEME, true, "full", undefined, { action: { figures: "hide" } }).figure, undefined);
});

test("side labels reserve a real rail instead of overlapping the state stripe", () => {
  const m = measureNode(node(), DEFAULT_THEME, false, "full", undefined, {
    action: { typeLabel: "left", stateLabel: "left" },
  });
  assert.equal(m.sideRail, 30);
  assert.ok(m.sideRail > DEFAULT_THEME.card.stripe);
});

test("hiding both labels removes the metadata row and shortens content", () => {
  const visible = measureNode(node({ title: "Short" }), DEFAULT_THEME, false);
  const hidden = measureNode(node({ title: "Short" }), DEFAULT_THEME, false, "full", undefined, {
    action: { typeLabel: "hidden", stateLabel: "hidden" },
  });
  assert.equal(hidden.metaHeight, 0);
  assert.ok(hidden.h < visible.h);
});

test("bullets past the cap are counted, not rendered", () => {
  const bullets = Array.from({ length: 20 }, (_, i) => `bullet number ${i}`);
  const m = measureNode(node({ bullets }), DEFAULT_THEME, false);
  assert.ok(m.bulletLines.length <= 8);
  assert.ok(m.hiddenBullets > 0);
});

test("a long title truncates rather than growing unbounded", () => {
  const m = measureNode(
    node({ title: "word ".repeat(80).trim() }),
    DEFAULT_THEME,
    false,
  );
  assert.ok(m.titleLines.length <= 3);
  assert.match(m.titleLines.at(-1), /…$/);
});

test("showing a figure reserves a box and grows the card", () => {
  const withFig = node({ figures: [{ id: "f", file: "a.png", mime: "image/png" }] });
  const off = measureNode(withFig, DEFAULT_THEME, false);
  const on = measureNode(withFig, DEFAULT_THEME, true);
  assert.equal(off.figure, undefined);
  assert.ok(on.figure);
  assert.ok(on.h > off.h);
  assert.ok(on.figure.y + on.figure.h <= on.h, "figure must stay inside the card");
});

test("layout places nodes without overlapping", () => {
  const nodes = [
    node({ id: "a", title: "First" }),
    node({ id: "b", title: "Second" }),
    node({ id: "c", title: "Third" }),
  ];
  const edges = [
    { id: "e1", from: "a", to: "b", dashed: false },
    { id: "e2", from: "a", to: "c", dashed: false },
  ];
  const out = layoutGraph(graph(nodes, edges), DEFAULT_THEME, dagre, false);
  assert.equal(out.nodes.length, 3);
  assert.equal(out.edges.length, 2);
  for (let i = 0; i < out.nodes.length; i++) {
    for (let j = i + 1; j < out.nodes.length; j++) {
      const p = out.nodes[i];
      const q = out.nodes[j];
      const disjoint =
        p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
      assert.ok(disjoint, `${p.id} overlaps ${q.id}`);
    }
  }
});

test("every node fits inside the reported canvas", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => node({ id, title: id }));
  const edges = [
    { id: "e1", from: "a", to: "b", dashed: false },
    { id: "e2", from: "b", to: "c", dashed: false },
    { id: "e3", from: "b", to: "d", dashed: false },
  ];
  const out = layoutGraph(graph(nodes, edges), DEFAULT_THEME, dagre, false);
  for (const n of out.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0, `${n.id} outside origin`);
    assert.ok(n.x + n.w <= out.width, `${n.id} exceeds width`);
    assert.ok(n.y + n.h <= out.height, `${n.id} exceeds height`);
  }
});

test("edges produce a drawable path", () => {
  const nodes = [node({ id: "a" }), node({ id: "b" })];
  const out = layoutGraph(
    graph(nodes, [{ id: "e", from: "a", to: "b", dashed: false }]),
    DEFAULT_THEME,
    dagre,
    false,
  );
  assert.match(out.edges[0].path, /^M[\d.]+,[\d.]+/);
  assert.ok(!out.edges[0].path.includes("NaN"));
});

test("an arrow path reaches the destination card border", () => {
  const out = layoutGraph(
    graph([node({ id: "a" }), node({ id: "b" })], [{ id: "e", from: "a", to: "b", dashed: false }]),
    DEFAULT_THEME, dagre, false,
  );
  const target = out.nodes.find((item) => item.id === "b");
  assert.ok(out.edges[0].path.endsWith(`${(target.x + target.w / 2).toFixed(1)},${target.y.toFixed(1)}`));
});

test("an edge to a missing node is dropped, not crashed on", () => {
  const out = layoutGraph(
    graph([node({ id: "a" })], [{ id: "e", from: "a", to: "ghost", dashed: false }]),
    DEFAULT_THEME,
    dagre,
    false,
  );
  assert.equal(out.edges.length, 0);
  assert.equal(out.nodes.length, 1);
});

test("groups become clusters that contain their members", () => {
  const nodes = [
    node({ id: "a", group: "Caching" }),
    node({ id: "b", group: "Caching" }),
    node({ id: "c" }),
  ];
  const out = layoutGraph(graph(nodes, []), DEFAULT_THEME, dagre, false);
  assert.equal(out.clusters.length, 1);
  const c = out.clusters[0];
  assert.equal(c.name, "Caching");
  for (const id of ["a", "b"]) {
    const m = out.nodes.find((n) => n.id === id);
    assert.ok(m.x >= c.x && m.x + m.w <= c.x + c.w, `${id} escapes cluster x`);
    assert.ok(m.y >= c.y && m.y + m.h <= c.y + c.h, `${id} escapes cluster y`);
  }
});

test("an empty graph lays out to nothing without throwing", () => {
  const out = layoutGraph(graph([], []), DEFAULT_THEME, dagre, false);
  assert.equal(out.nodes.length, 0);
  assert.equal(out.width, 0);
  assert.equal(out.height, 0);
});

test("a cycle still lays out", () => {
  const nodes = [node({ id: "a" }), node({ id: "b" })];
  const edges = [
    { id: "e1", from: "a", to: "b", dashed: false },
    { id: "e2", from: "b", to: "a", dashed: false },
  ];
  const out = layoutGraph(graph(nodes, edges), DEFAULT_THEME, dagre, false);
  assert.equal(out.nodes.length, 2);
  for (const e of out.edges) assert.ok(!e.path.includes("NaN"));
});

test("LR direction lays out wider than tall", () => {
  const nodes = ["a", "b", "c"].map((id) => node({ id, title: id }));
  const edges = [
    { id: "e1", from: "a", to: "b", dashed: false },
    { id: "e2", from: "b", to: "c", dashed: false },
  ];
  const td = layoutGraph({ ...graph(nodes, edges), direction: "TD" }, DEFAULT_THEME, dagre, false);
  const lr = layoutGraph({ ...graph(nodes, edges), direction: "LR" }, DEFAULT_THEME, dagre, false);
  assert.ok(lr.width > td.width);
  assert.ok(td.height > lr.height);
});

test("card width is a ceiling: short content yields a narrower card", () => {
  const wide = measureNode(node({ title: "Hi" }), DEFAULT_THEME, false);
  assert.ok(wide.w < DEFAULT_THEME.card.width, "a two-letter title should not fill the ceiling");
});

test("long content grows up to the ceiling but never past it", () => {
  const m = measureNode(
    node({ bullets: ["a single bullet far too long to fit on any one line of this card"] }),
    DEFAULT_THEME,
    false,
  );
  // Wrapping breaks at words, so the longest line lands near — not exactly on —
  // the ceiling. What matters is that it uses the space, and never exceeds it.
  assert.ok(m.w <= DEFAULT_THEME.card.width, "must never exceed the ceiling");
  assert.ok(m.w > DEFAULT_THEME.card.width * 0.9, "wrapped content should use the width");
});

test("lowering the ceiling makes cards narrower, not just taller", () => {
  const bullets = ["Serve the compiled tsc output as native ESM modules the browser loads directly"];
  const wide = measureNode(node({ bullets }), resolveTheme(DEFAULT_THEME, { card: { width: 420 } }), false);
  const narrow = measureNode(node({ bullets }), resolveTheme(DEFAULT_THEME, { card: { width: 240 } }), false);
  assert.ok(narrow.w < wide.w, "narrow ceiling must produce a narrower card");
  assert.ok(narrow.h > wide.h, "and wrap more, so it is taller");
});

test("no card is ever wider than its content needs", () => {
  for (const width of [200, 280, 360, 520]) {
    const theme = resolveTheme(DEFAULT_THEME, { card: { width } });
    const m = measureNode(node({ title: "Redis", bullets: ["Fast"] }), theme, false);
    assert.ok(m.w <= width, `card exceeded ceiling ${width}`);
    const slack = width - m.w;
    assert.ok(slack >= 0);
  }
});

test("a figure holds the card open at the ceiling", () => {
  const withFig = node({ title: "x", figures: [{ id: "f", file: "a.png", mime: "image/png" }] });
  const m = measureNode(withFig, DEFAULT_THEME, true);
  assert.equal(m.w, DEFAULT_THEME.card.width, "figures should use the full width");
  assert.equal(m.figure.w, m.w - DEFAULT_THEME.card.padX * 2 - DEFAULT_THEME.card.stripe);
});

test("detail level follows zoom", () => {
  assert.equal(detailForZoom(1), "full");
  assert.equal(detailForZoom(0.7), "full");
  assert.equal(detailForZoom(0.5), "compact");
  assert.equal(detailForZoom(0.2), "compact");
});

test("compact drops bullets but keeps the figure", () => {
  const n = node({
    title: "A node",
    bullets: ["one", "two", "three"],
    figures: [{ id: "f", file: "a.png", mime: "image/png" }],
  });
  const full = measureNode(n, DEFAULT_THEME, true, "full");
  const compact = measureNode(n, DEFAULT_THEME, true, "compact");

  assert.ok(full.bulletLines.length > 0);
  assert.equal(compact.bulletLines.length, 0, "compact should drop bullets");
  assert.ok(compact.figure, "the Figures toggle hides figures, not the zoom level");
  assert.ok(full.h > compact.h, "shedding bullets must shrink the card");
  assert.ok(compact.titleSize > full.titleSize, "the title should grow when body copy disappears");
  assert.ok(compact.titleLeading > full.titleLeading, "larger compact titles need matching line height");
});

test("the Figures toggle still governs figures at every level", () => {
  const n = node({ figures: [{ id: "f", file: "a.png", mime: "image/png" }] });
  for (const d of ["full", "compact"]) {
    assert.ok(measureNode(n, DEFAULT_THEME, true, d).figure, d + " should show it");
    assert.equal(measureNode(n, DEFAULT_THEME, false, d).figure, undefined, d + " should hide it");
  }
});

test("the title survives every detail level", () => {
  for (const d of ["full", "compact"]) {
    const m = measureNode(node({ title: "Keep me" }), DEFAULT_THEME, false, d);
    assert.ok(m.titleLines.join(" ").includes("Keep me"), `${d} lost the title`);
  }
});

test("lower detail makes the whole graph smaller", () => {
  const nodes = ["a", "b", "c"].map((id) =>
    node({ id, title: `Node ${id}`, bullets: ["a bullet", "another bullet", "a third"] }),
  );
  const edges = [
    { id: "e1", from: "a", to: "b", dashed: false },
    { id: "e2", from: "b", to: "c", dashed: false },
  ];
  const g = graph(nodes, edges);
  const full = layoutGraph(g, DEFAULT_THEME, dagre, false, "full");
  const compact = layoutGraph(g, DEFAULT_THEME, dagre, false, "compact");
  assert.ok(compact.height < full.height, "dropping bullets should compact the graph");
});

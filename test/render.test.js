import assert from "node:assert/strict";
import test from "node:test";
import dagre from "@dagrejs/dagre";
import { layoutGraph } from "../dist/layout.js";
import { renderSvg } from "../dist/render.js";
import { DEFAULT_THEME, STATE_GLYPH, paletteFor, resolveTheme } from "../dist/theme.js";

const ALL_STATES = [
  "planned", "exploring", "waiting", "done", "abandoned", "blocked",
  "good", "bad", "mixed", "inconclusive", "open", "resolved",
];

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
  chartId: "t", title: "T", direction: "TD",
  nodes, edges, events: [], revision: 1, createdAt: 1, updatedAt: 1,
});

const draw = (g, over = {}) => {
  const layout = layoutGraph(g, DEFAULT_THEME, dagre, over.showFigures ?? false);
  return renderSvg(layout, {
    theme: DEFAULT_THEME,
    palette: paletteFor(DEFAULT_THEME, over.mode ?? "light"),
    figureSrc: (f) => `/assets/${f}`,
    selectedId: over.selectedId ?? null,
  });
};

test("renders a well-formed svg root", () => {
  const svg = draw(graph([node()]));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!svg.includes("NaN"), "no NaN in output");
  assert.ok(!svg.includes("undefined"), "no undefined in output");
});

test("every state renders with its glyph and label", () => {
  for (const state of ALL_STATES) {
    const kind = ["good", "bad", "mixed", "inconclusive"].includes(state)
      ? "result"
      : ["open", "resolved"].includes(state)
        ? "options"
        : "action";
    const svg = draw(graph([node({ state, kind })]));
    assert.ok(svg.includes(STATE_GLYPH[state]), `${state} missing glyph`);
    assert.ok(svg.includes(state.toUpperCase()), `${state} missing text label`);
  }
});

test("state colour never carries meaning alone", () => {
  // The CVD warn band is only legal because glyph + label ride along.
  for (const state of ALL_STATES) {
    const svg = draw(graph([node({ state, kind: "action" })]));
    const hasGlyph = svg.includes(STATE_GLYPH[state]);
    const hasLabel = svg.includes(state.toUpperCase());
    assert.ok(hasGlyph && hasLabel, `${state} relies on colour alone`);
  }
});

test("type and state labels can share a high-contrast side rail", () => {
  const g = graph([node()]);
  const layout = layoutGraph(g, DEFAULT_THEME, dagre, false, "full", undefined, {
    action: { typeLabel: "left", stateLabel: "left" },
  });
  const svg = renderSvg(layout, { theme: DEFAULT_THEME, palette: paletteFor(DEFAULT_THEME, "light"), figureSrc: (f) => f });
  assert.equal((svg.match(/skym-side-label/g) ?? []).length, 1);
  assert.ok(svg.includes("ACTION"));
  assert.ok(svg.includes("PLANNED"));
});

test("a hidden state removes both its label and glyph from the title row", () => {
  const g = graph([node()]);
  const layout = layoutGraph(g, DEFAULT_THEME, dagre, false, "full", undefined, {
    action: { typeLabel: "top", stateLabel: "hidden" },
  });
  const svg = renderSvg(layout, { theme: DEFAULT_THEME, palette: paletteFor(DEFAULT_THEME, "light"), figureSrc: (f) => f });
  assert.ok(svg.includes("ACTION"));
  assert.ok(!svg.includes(STATE_GLYPH.planned));
  assert.ok(!svg.includes("PLANNED"));
});

test("a left type with a hidden state leaves no metadata in the title row", () => {
  const layout = layoutGraph(graph([node()]), DEFAULT_THEME, dagre, false, "full", undefined, {
    action: { typeLabel: "left", stateLabel: "hidden" },
  });
  const svg = renderSvg(layout, { theme: DEFAULT_THEME, palette: paletteFor(DEFAULT_THEME, "light"), figureSrc: (f) => f });
  assert.equal(layout.nodes[0].metaHeight, 0);
  assert.ok(svg.includes("ACTION"));
  assert.ok(!svg.includes('class="skym-glyph"'));
  assert.ok(!svg.includes('class="skym-meta"'));
});

test("titles and bullets reach the output", () => {
  const svg = draw(graph([node({ title: "Swap cache to Redis", bullets: ["TTL 60s"] })]));
  assert.ok(svg.includes("Swap cache to Redis"));
  assert.ok(svg.includes("TTL 60s"));
});

test("compact mode renders a larger title", () => {
  const n = node({ title: "Primary signal", bullets: ["supporting detail"] });
  const fullLayout = layoutGraph(graph([n]), DEFAULT_THEME, dagre, false, "full");
  const compactLayout = layoutGraph(graph([n]), DEFAULT_THEME, dagre, false, "compact");
  const options = { theme: DEFAULT_THEME, palette: paletteFor(DEFAULT_THEME, "light"), figureSrc: (f) => f };
  const full = renderSvg(fullLayout, options);
  const compact = renderSvg(compactLayout, options);
  assert.match(full, /class="skym-title"[^>]+font-size="14"/);
  assert.match(compact, /class="skym-title"[^>]+font-size="17\.5"/);
});

test("a node badge and attached-file count render on the card", () => {
  const svg = draw(graph([node({ badge: "27 / 600", artifacts: [{ id: "a", file: "run.py", name: "run.py", mime: "text/x-python", bytes: 12 }] })]));
  assert.ok(svg.includes("27 / 600"));
  assert.ok(svg.includes("1 FILE"));
});

test("markup in content is escaped", () => {
  const svg = draw(graph([node({ title: '<script>alert("x")</script>', bullets: ["a & b"] })]));
  assert.ok(!svg.includes("<script>"), "raw script tag leaked");
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(svg.includes("a &amp; b"));
});

test("a quote in a title cannot break out of an attribute", () => {
  const svg = draw(graph([node({ id: 'a"onload="evil', title: "x" })]));
  assert.ok(!svg.includes('onload="evil'), "attribute injection");
});

test("figures render as images only when enabled", () => {
  const g = graph([node({ figures: [{ id: "f", file: "plot.png", mime: "image/png" }] })]);
  const off = draw(g, { showFigures: false });
  const on = draw(g, { showFigures: true });
  assert.ok(!off.includes("<image"), "figure drawn while disabled");
  assert.ok(off.includes("1 FIGURE"), "no figure count fallback");
  assert.ok(on.includes("<image"));
  assert.ok(on.includes("/assets/plot.png"));
});

test("extra figures are summarised with a badge", () => {
  const figures = [1, 2, 3].map((i) => ({ id: `f${i}`, file: `p${i}.png`, mime: "image/png" }));
  const svg = draw(graph([node({ figures })]), { showFigures: true });
  assert.ok(svg.includes("+2"), "missing overflow badge");
});

test("selection is drawn with the focus colour", () => {
  const g = graph([node({ id: "pick" })]);
  const plain = draw(g);
  const picked = draw(g, { selectedId: "pick" });
  assert.notEqual(plain, picked);
  assert.ok(picked.includes(paletteFor(DEFAULT_THEME, "light").focus));
});

test("dark mode uses the dark palette, not the light one", () => {
  const g = graph([node({ state: "good", kind: "result" })]);
  const light = draw(g, { mode: "light" });
  const dark = draw(g, { mode: "dark" });
  assert.notEqual(light, dark);
  assert.ok(dark.includes(paletteFor(DEFAULT_THEME, "dark").states.good.accent));
  assert.ok(!dark.includes(paletteFor(DEFAULT_THEME, "light").surface));
});

test("dashed edges are visibly dashed", () => {
  const g = graph(
    [node({ id: "a" }), node({ id: "b" })],
    [{ id: "e", from: "a", to: "b", dashed: true }],
  );
  assert.ok(draw(g).includes("stroke-dasharray"));
});

test("edge labels render inside a plate", () => {
  const g = graph(
    [node({ id: "a" }), node({ id: "b" })],
    [{ id: "e", from: "a", to: "b", dashed: false, label: "if slow" }],
  );
  const svg = draw(g);
  assert.ok(svg.includes("if slow"));
  assert.ok(svg.includes('marker-end="url(#skym-arrow)"'));
});

test("groups render a titled cluster behind their nodes", () => {
  const svg = draw(graph([node({ id: "a", group: "Caching" })]));
  assert.ok(svg.includes("CACHING"));
  assert.ok(svg.includes("skym-cluster"));
  // The cluster must be painted before the cards, or it covers them.
  assert.ok(svg.indexOf("skym-cluster") < svg.indexOf("skym-node"));
});

test("nodes carry ids so the viewer can bind interaction", () => {
  const svg = draw(graph([node({ id: "my-node" })]));
  assert.ok(svg.includes('data-id="my-node"'));
  assert.ok(svg.includes('data-state="planned"'));
});

test("an empty graph renders an empty but valid svg", () => {
  const svg = draw(graph([]));
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes("skym-node"));
});

test("theme overrides flow through to the output", () => {
  const custom = resolveTheme(DEFAULT_THEME, {
    card: { width: 400 },
    light: { states: { planned: { accent: "#ff00ff" } } },
  });
  // Long enough to reach the ceiling, since width is a maximum not a fixed size.
  const long = node({ bullets: ["a bullet long enough that it needs most of the available card width"] });
  const layout = layoutGraph(graph([long]), custom, dagre, false);
  const svg = renderSvg(layout, {
    theme: custom,
    palette: paletteFor(custom, "light"),
    figureSrc: (f) => f,
  });
  assert.ok(svg.includes("#ff00ff"), "palette override ignored");
  assert.ok(layout.nodes[0].w > DEFAULT_THEME.card.width, "raised ceiling was ignored");
  assert.ok(layout.nodes[0].w <= 400, "card exceeded the raised ceiling");
});

test("overrides do not mutate the default theme", () => {
  const before = DEFAULT_THEME.card.width;
  resolveTheme(DEFAULT_THEME, { card: { width: 999 } });
  assert.equal(DEFAULT_THEME.card.width, before);
});

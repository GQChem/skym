import test from "node:test";
import assert from "node:assert/strict";
import { toMermaid } from "../dist/mermaid.js";

const graph = (nodes = [], edges = [], extra = {}) => ({
  chartId: "c",
  title: "T",
  direction: "TD",
  nodes: nodes.map((n) => ({
    kind: "action",
    state: "planned",
    bullets: [],
    figures: [],
    title: n.id,
    ...n,
  })),
  edges: edges.map((e) => ({ dashed: false, ...e })),
  events: [],
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

test("emits a flowchart with the requested direction", () => {
  assert.match(toMermaid(graph(), [], {}), /^flowchart TD/);
  assert.match(toMermaid({ ...graph(), direction: "LR" }), /^flowchart LR/);
});

test("every kind renders as a rounded rect", () => {
  const src = toMermaid(
    graph([
      { id: "a", kind: "action" },
      { id: "b", kind: "result", state: "good" },
      { id: "c", kind: "options", state: "open" },
    ]),
  );
  for (const id of ["n_a", "n_b", "n_c"]) {
    assert.ok(src.includes(`${id}("`), `${id} should use ("...") rounded syntax`);
  }
});

test("ids unsafe for mermaid are sanitised", () => {
  const src = toMermaid(graph([{ id: "a-b.c d" }]));
  assert.ok(src.includes("n_a_b_c_d"));
});

test("quotes and brackets in titles are escaped", () => {
  const src = toMermaid(graph([{ id: "a", title: 'He said "hi" [really]' }]));
  assert.ok(!src.includes('"hi"'), "raw quotes would break the label");
  assert.ok(src.includes("&quot;"));
  assert.ok(!/\[really\]/.test(src));
});

test("bullets render with markers and are capped", () => {
  const many = Array.from({ length: 9 }, (_, i) => `b${i}`);
  const src = toMermaid(graph([{ id: "a", bullets: many }]));
  assert.ok(src.includes("• b0"));
  assert.ok(src.includes("+3 more"), "should summarise the overflow");
  assert.ok(!src.includes("• b6"));
});

test("long bullets are truncated", () => {
  const long = "x".repeat(200);
  const src = toMermaid(graph([{ id: "a", bullets: [long] }]));
  assert.ok(src.includes("…"), "truncation marker expected");
  assert.ok(!src.includes(long), "the full bullet must not survive");
  const run = src.match(/x+/)[0].length;
  assert.ok(run < 110, `truncated run should be ~102, got ${run}`);
});

test("figure count is surfaced on the node", () => {
  const src = toMermaid(
    graph([{ id: "a", figures: [{ id: "f", file: "f.png", mime: "image/png" }] }]),
  );
  assert.ok(src.includes("🖼 1 figure"));
});

test("state drives the class assignment", () => {
  const src = toMermaid(graph([{ id: "a", state: "abandoned" }]));
  assert.ok(src.includes("class n_a st_abandoned;"));
});

test("dashed and labelled edges use the right arrows", () => {
  const src = toMermaid(
    graph(
      [{ id: "a" }, { id: "b" }],
      [{ from: "a", to: "b", label: "why", dashed: true }],
    ),
  );
  assert.ok(src.includes('-.->|"why"|'));
});

test("groups become subgraphs", () => {
  const src = toMermaid(graph([{ id: "a", group: "Lane One" }]));
  assert.ok(src.includes('subgraph sg_0["Lane One"]'));
  assert.ok(src.includes("end"));
});

test("light and dark emit different palettes", () => {
  const g = graph([{ id: "a", state: "good" }]);
  const light = toMermaid(g, "light");
  const dark = toMermaid(g, "dark");
  assert.notEqual(light, dark);
  assert.ok(light.includes("classDef st_good"));
  assert.ok(dark.includes("classDef st_good"));
});

test("exploring and waiting carry animated marks", () => {
  const src = toMermaid(
    graph([
      { id: "a", state: "exploring" },
      { id: "b", state: "waiting" },
      { id: "c", state: "done" },
    ]),
  );
  assert.ok(src.includes("class='skym-gear'"), "exploring needs a gear span");
  assert.ok(src.includes("class='skym-hourglass'"), "waiting needs an hourglass span");
  // Static states must not be wrapped, or they would animate too.
  const doneLine = src.split("\n").find((l) => l.startsWith("  n_c("));
  assert.ok(!doneLine.includes("skym-"), "done should carry no animation span");
});

test("every state has a classDef in both themes", () => {
  const states = [
    "planned", "exploring", "waiting", "done", "abandoned", "blocked",
    "good", "bad", "mixed", "inconclusive", "open", "resolved",
  ];
  for (const theme of ["light", "dark"]) {
    const src = toMermaid(graph(), theme);
    for (const s of states) {
      assert.ok(src.includes(`classDef st_${s} `), `${theme} missing st_${s}`);
    }
  }
});

test("all colour values are well formed", () => {
  for (const theme of ["light", "dark"]) {
    for (const hex of toMermaid(graph(), theme).match(/#[0-9a-zA-Z]+/g) ?? []) {
      assert.match(hex, /^#[0-9a-f]{6}$/i, `malformed colour ${hex} in ${theme}`);
    }
  }
});

test("an empty graph still produces valid source", () => {
  const src = toMermaid(graph());
  assert.match(src, /^flowchart TD/);
  assert.ok(src.includes("classDef"));
});

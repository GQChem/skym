import assert from "node:assert/strict";
import test from "node:test";
import dagre from "@dagrejs/dagre";
import {
  BUILTIN_TEMPLATES,
  DEFAULT_VOCAB,
  allStates,
  defaultStates,
  glyphs,
  inksFor,
  kindLabels,
  openStates,
  pulseStates,
  resolveVocab,
  statesFor,
} from "../dist/vocab.js";
import { DEFAULT_THEME, paletteFor, themeForVocab } from "../dist/theme.js";
import { layoutGraph } from "../dist/layout.js";
import { renderSvg } from "../dist/render.js";
import { toMermaid } from "../dist/mermaid.js";

const graphOf = (nodes) => ({
  chartId: "t",
  title: "T",
  direction: "TD",
  nodes: nodes.map((n) => ({ bullets: [], figures: [], ...n })),
  edges: [],
  events: [],
  revision: 1,
  updatedAt: 0,
});

// The nine duplicated copies of the vocabulary used to drift apart silently;
// these assert the derived tables stay complete for every template.
for (const [name, vocab] of Object.entries(BUILTIN_TEMPLATES)) {
  test(`${name}: every state has ink, a glyph, and a label`, () => {
    const light = inksFor(vocab, "light");
    const dark = inksFor(vocab, "dark");
    const marks = glyphs(vocab);
    for (const s of allStates(vocab)) {
      for (const [mode, table] of [["light", light], ["dark", dark]]) {
        const ink = table[s.slug];
        assert.ok(ink, `${name}/${s.slug} has no ${mode} ink`);
        for (const key of ["accent", "fill", "border"]) {
          assert.match(ink[key], /^#[0-9a-f]{3,8}$/i, `${name}/${s.slug} ${mode}.${key}`);
        }
      }
      assert.ok(marks[s.slug], `${name}/${s.slug} has no glyph`);
      assert.ok(s.label, `${name}/${s.slug} has no label`);
      assert.ok(s.blurb, `${name}/${s.slug} has no blurb`);
    }
  });

  test(`${name}: every kind's default state is one of its own`, () => {
    const byKind = statesFor(vocab);
    for (const [kind, dflt] of Object.entries(defaultStates(vocab))) {
      assert.ok(byKind[kind].includes(dflt), `${name}/${kind} defaults to ${dflt}, not in ${byKind[kind]}`);
    }
  });

  test(`${name}: every kind has a label and at least one state`, () => {
    const labels = kindLabels(vocab);
    for (const k of vocab.kinds) {
      assert.ok(labels[k.slug], `${name}/${k.slug} has no label`);
      assert.ok(k.states.length > 0, `${name}/${k.slug} has no states`);
      assert.ok(k.blurb, `${name}/${k.slug} has no blurb — the tool description needs it`);
    }
  });
}

test("the default template still names the original four kinds", () => {
  assert.deepEqual(
    DEFAULT_VOCAB.kinds.map((k) => k.slug),
    ["action", "result", "options", "note"],
  );
});

test("open and pulse states are the ones the viewer used to hardcode", () => {
  assert.deepEqual(openStates(DEFAULT_VOCAB).sort(), ["blocked", "exploring", "open", "planned", "waiting"]);
  assert.deepEqual(pulseStates(DEFAULT_VOCAB).sort(), ["exploring", "waiting"]);
});

test("a custom kind renders with its own label and glyph", () => {
  const vocab = resolveVocab(DEFAULT_VOCAB, undefined, {
    kinds: [
      {
        slug: "risk",
        label: "Risk",
        blurb: "Something that could go wrong.",
        defaultState: "watch",
        states: [
          {
            slug: "watch",
            label: "watch",
            glyph: "⚠",
            blurb: "keep an eye on it",
            light: { accent: "#b45309", fill: "#fffbeb", border: "#fcd34d" },
            dark: { accent: "#fbbf24", fill: "#292524", border: "#78350f" },
          },
        ],
      },
    ],
  });
  const theme = themeForVocab(DEFAULT_THEME, vocab);
  const graph = graphOf([{ id: "r", title: "Disk may fill", kind: "risk", state: "watch" }]);
  const layout = layoutGraph(graph, theme, dagre, false, "full", kindLabels(vocab));
  const svg = renderSvg(layout, {
    theme,
    palette: paletteFor(theme, "light"),
    figureSrc: (f) => f,
    glyphs: glyphs(vocab),
    kindLabels: kindLabels(vocab),
    pulseStates: pulseStates(vocab),
  });
  assert.match(svg, /RISK · WATCH/, "the custom kind's label should be drawn");
  assert.match(svg, /⚠/, "the custom state's glyph should be drawn");
  assert.match(svg, /#b45309/, "the custom state's accent should be used");
});

test("an unknown state falls back to neutral ink rather than crashing", () => {
  const graph = graphOf([{ id: "x", title: "From another template", kind: "invented", state: "nonesuch" }]);
  const layout = layoutGraph(graph, DEFAULT_THEME, dagre, false, "full");
  const palette = paletteFor(DEFAULT_THEME, "light");
  const svg = renderSvg(layout, { theme: DEFAULT_THEME, palette, figureSrc: (f) => f });
  assert.match(svg, /INVENTED · NONESUCH/, "the raw slugs should still be drawn");
  assert.match(svg, new RegExp(palette.neutral.accent), "neutral ink should be used");
});

test("mermaid export styles every state on the chart", () => {
  // active/retired had no classDef before the vocabulary drove this.
  const graph = graphOf([
    { id: "a", title: "note", kind: "note", state: "active" },
    { id: "b", title: "retired note", kind: "note", state: "retired" },
    { id: "c", title: "custom", kind: "risk", state: "watch" },
  ]);
  for (const theme of ["light", "dark"]) {
    const src = toMermaid(graph, theme);
    for (const state of ["active", "retired", "watch"]) {
      assert.ok(
        src.includes(`classDef st_${state} `),
        `${theme}: no classDef for st_${state}`,
      );
    }
  }
});

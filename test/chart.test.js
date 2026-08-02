import assert from "node:assert/strict";
import test from "node:test";
import { formatValue, renderChart, validateChart } from "../dist/chart.js";
import { DEFAULT_THEME, paletteFor } from "../dist/theme.js";

const palette = paletteFor(DEFAULT_THEME, "light");
const box = { width: 320, height: 170 };
const draw = (spec, b = box) => renderChart(spec, b, DEFAULT_THEME, palette);

test("formats values compactly with units", () => {
  assert.equal(formatValue(42), "42");
  assert.equal(formatValue(190, "ms"), "190ms");
  assert.equal(formatValue(1284), "1.3k");
  assert.equal(formatValue(12_840), "13k");
  assert.equal(formatValue(4_200_000), "4.2M");
  assert.equal(formatValue(0), "0");
  assert.equal(formatValue(-15, "%"), "-15%");
});

test("a bar chart renders one mark per point", () => {
  const svg = draw({
    kind: "bar",
    points: [
      { label: "before", value: 840 },
      { label: "after", value: 190 },
    ],
    unit: "ms",
  });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<path /g) || []).length, 2);
  assert.ok(svg.includes("840ms"));
  assert.ok(svg.includes("190ms"));
  assert.ok(svg.includes("before"));
});

test("emphasis makes the other bars recede", () => {
  const plain = draw({ kind: "bar", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] });
  const marked = draw({
    kind: "bar",
    points: [{ label: "a", value: 1 }, { label: "b", value: 2, emphasis: true }],
  });
  assert.notEqual(plain, marked);
  assert.ok(marked.includes(palette.inkMuted), "un-emphasised bars should use muted ink");
});

test("a line chart labels only its endpoint", () => {
  const svg = draw({
    kind: "line",
    points: [
      { label: "mon", value: 10 },
      { label: "tue", value: 30 },
      { label: "wed", value: 20 },
    ],
  });
  // One polyline, one end marker.
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.equal((svg.match(/<circle /g) || []).length, 1);
  // Endpoint value present, intermediate values absent.
  assert.ok(svg.includes(">20<"));
  assert.ok(!svg.includes(">30<"), "intermediate points must not be labelled");
});

test("a stat renders one large number", () => {
  const svg = draw({ kind: "stat", points: [{ label: "p99", value: 190 }], unit: "ms", delta: "-77%" }, { width: 320, height: 120 });
  assert.ok(svg.includes("190ms"));
  assert.ok(svg.includes("p99"));
  assert.ok(svg.includes("-77%"));
});

test("charts escape hostile labels", () => {
  const svg = draw({ kind: "bar", points: [{ label: '<script>x</script>', value: 1 }], title: '"&<' });
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;"));
});

test("output never contains NaN", () => {
  for (const kind of ["bar", "line"]) {
    const svg = draw({ kind, points: [{ label: "only", value: 5 }] });
    assert.ok(!svg.includes("NaN"), `${kind} produced NaN`);
  }
});

test("identical values do not divide by zero", () => {
  const svg = draw({
    kind: "bar",
    points: [{ label: "a", value: 7 }, { label: "b", value: 7 }],
  });
  assert.ok(!svg.includes("NaN"));
  assert.ok(!svg.includes("Infinity"));
});

test("negative values render below the baseline", () => {
  const svg = draw({
    kind: "bar",
    points: [{ label: "up", value: 10 }, { label: "down", value: -10 }],
  });
  assert.ok(!svg.includes("NaN"));
  assert.equal((svg.match(/<path /g) || []).length, 2);
});

test("an empty chart is rejected", () => {
  assert.throws(() => validateChart({ kind: "bar", points: [] }), /at least one point/);
});

test("a stat with several points is rejected", () => {
  assert.throws(
    () => validateChart({ kind: "stat", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }),
    /one number/,
  );
});

test("too many points is rejected with a useful message", () => {
  const points = Array.from({ length: 13 }, (_, i) => ({ label: `p${i}`, value: i }));
  assert.throws(() => validateChart({ kind: "bar", points }), /Summarise/);
});

test("a non-numeric value is rejected", () => {
  assert.throws(
    () => validateChart({ kind: "bar", points: [{ label: "bad", value: Number.NaN }] }),
    /non-numeric/,
  );
});

test("charts draw in the theme's palette, not hardcoded colour", () => {
  const dark = paletteFor(DEFAULT_THEME, "dark");
  const spec = { kind: "bar", points: [{ label: "a", value: 1 }] };
  const lightSvg = renderChart(spec, box, DEFAULT_THEME, palette);
  const darkSvg = renderChart(spec, box, DEFAULT_THEME, dark);
  assert.notEqual(lightSvg, darkSvg);
  assert.ok(darkSvg.includes(dark.focus));
});

test("an accent override wins, so a chart can match its node's state", () => {
  const svg = renderChart(
    { kind: "bar", points: [{ label: "a", value: 1 }] },
    box,
    DEFAULT_THEME,
    palette,
    "#ff00ff",
  );
  assert.ok(svg.includes("#ff00ff"));
});

test("an extreme ratio still draws the small bar", () => {
  // 50:1 rounds the small bar to under a pixel; it must stay visible as a mark.
  const svg = draw({ kind: "bar", points: [{ label: "big", value: 3565 }, { label: "small", value: 71 }] });
  const paths = svg.match(/<path d="([^"]+)"/g) || [];
  assert.equal(paths.length, 2, "both bars must be drawn");
  assert.ok(svg.includes("71"), "the value label carries the true magnitude");
});

test("a zero value draws no bar, unlike a small one", () => {
  const svg = draw({ kind: "bar", points: [{ label: "none", value: 0 }, { label: "some", value: 100 }] });
  assert.ok(!svg.includes("NaN"));
});

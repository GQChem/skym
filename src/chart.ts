import type { Palette, Theme } from "./theme.js";
import { textWidth } from "./layout.js";

/**
 * Charts drawn from data rather than an uploaded image: the agent points at
 * numbers and skym renders them in the chart's own palette, so a figure costs
 * no image generation and never clashes with the cards around it.
 *
 * Forms follow the data's job (see the dataviz method): magnitude -> bar,
 * change over time -> line, one headline number -> stat.
 */
export type ChartKind = "bar" | "line" | "stat";

export interface ChartPoint {
  label: string;
  value: number;
  /** Marks the one point the reader should look at first. */
  emphasis?: boolean;
}

export interface ChartSpec {
  kind: ChartKind;
  title?: string;
  points: ChartPoint[];
  /** Appended to values in labels, e.g. "ms" or "%". */
  unit?: string;
  /** Stat only: the change against a named baseline, e.g. "-77% vs before". */
  delta?: string;
  /** Bars/lines start at zero unless the data is genuinely an index. */
  baseline?: number;
}

export interface ChartBox {
  width: number;
  height: number;
}

const esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Values carry units and stay readable; 1284 -> "1.3k". */
export function formatValue(v: number, unit = ""): string {
  const abs = Math.abs(v);
  let out: string;
  if (abs >= 1_000_000) out = `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  else if (abs >= 1000) out = `${(v / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  else if (Number.isInteger(v)) out = String(v);
  else out = v.toFixed(abs < 10 ? 1 : 0);
  return unit ? `${out}${unit}` : out;
}

export function validateChart(spec: ChartSpec): void {
  if (!spec.points?.length) throw new Error("A chart needs at least one point.");
  if (spec.kind === "stat" && spec.points.length > 1) {
    throw new Error("A stat shows one number. Use kind:'bar' to compare several.");
  }
  if (spec.points.length > 12) {
    throw new Error(
      `${spec.points.length} points is past what a card-sized chart can label. Summarise, or attach a full figure instead.`,
    );
  }
  for (const p of spec.points) {
    if (!Number.isFinite(p.value)) throw new Error(`Point "${p.label}" has a non-numeric value.`);
  }
}

const PAD = { top: 22, right: 10, bottom: 20, left: 10 };
const BAR_MAX = 24;
const BAR_GAP = 2;

/** Room for the value label that sits on a bar's cap or a line's endpoint. */
const LABEL_HEAD = 13;

/**
 * One hue for magnitude, with the emphasis point in the accent and the rest
 * receding — never a different hue per bar, which would spend the identity
 * channel re-encoding what bar length already shows.
 */
function barChart(spec: ChartSpec, box: ChartBox, p: Palette, t: Theme, accent: string): string {
  const out: string[] = [];
  const values = spec.points.map((d) => d.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;

  // Value labels ride outside the bar, so the plot has to give up that room at
  // whichever ends actually carry one — otherwise a tall bar's label collides
  // with the title, and a negative bar's with the category row.
  const plotTop = (spec.title ? PAD.top : 8) + (max > 0 ? LABEL_HEAD : 0);
  const bottomPad = PAD.bottom + (min < 0 ? LABEL_HEAD : 0);
  const plotH = box.height - plotTop - bottomPad;
  const plotW = box.width - PAD.left - PAD.right;
  const n = spec.points.length;
  const zeroY = plotTop + plotH * (max / span);

  const slot = plotW / n;
  const barW = Math.min(BAR_MAX, slot - BAR_GAP * 2);
  const anyEmphasis = spec.points.some((d) => d.emphasis);

  // Baseline: one hairline, no grid — the values are labelled directly.
  out.push(
    `<line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${(PAD.left + plotW).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="${p.hairline}" stroke-width="1"/>`,
  );

  spec.points.forEach((d, i) => {
    const cx = PAD.left + slot * i + slot / 2;
    // A floor, so an outlier ratio (3565 vs 71) still leaves the small bar
    // visible as a mark. The value label carries the real magnitude; a bar
    // rounded to nothing would just look like missing data.
    const h = d.value === 0 ? 0 : Math.max(2, (Math.abs(d.value) / span) * plotH);
    const y = d.value >= 0 ? zeroY - h : zeroY;
    const on = !anyEmphasis || d.emphasis;
    const fill = on ? accent : p.inkMuted;
    const r = Math.min(4, barW / 2);
    // Rounded at the data end, square at the baseline.
    const path =
      d.value >= 0
        ? `M${(cx - barW / 2).toFixed(1)},${(y + h).toFixed(1)} L${(cx - barW / 2).toFixed(1)},${(y + r).toFixed(1)} Q${(cx - barW / 2).toFixed(1)},${y.toFixed(1)} ${(cx - barW / 2 + r).toFixed(1)},${y.toFixed(1)} L${(cx + barW / 2 - r).toFixed(1)},${y.toFixed(1)} Q${(cx + barW / 2).toFixed(1)},${y.toFixed(1)} ${(cx + barW / 2).toFixed(1)},${(y + r).toFixed(1)} L${(cx + barW / 2).toFixed(1)},${(y + h).toFixed(1)} Z`
        : `M${(cx - barW / 2).toFixed(1)},${y.toFixed(1)} L${(cx + barW / 2).toFixed(1)},${y.toFixed(1)} L${(cx + barW / 2).toFixed(1)},${(y + h - r).toFixed(1)} Q${(cx + barW / 2).toFixed(1)},${(y + h).toFixed(1)} ${(cx + barW / 2 - r).toFixed(1)},${(y + h).toFixed(1)} L${(cx - barW / 2 + r).toFixed(1)},${(y + h).toFixed(1)} Q${(cx - barW / 2).toFixed(1)},${(y + h).toFixed(1)} ${(cx - barW / 2).toFixed(1)},${(y + h - r).toFixed(1)} Z`;
    out.push(`<path d="${path}" fill="${fill}" opacity="${on ? 1 : 0.5}"/>`);

    // Value on the cap, category beneath — no axis needed at this size.
    const label = formatValue(d.value, spec.unit);
    if (textWidth(label, 9) <= slot) {
      // Above the cap going up, below the foot going down — always outside the
      // bar, and always clear of the category row at the bottom.
      const ly = d.value >= 0 ? y - 4 : Math.min(y + h + 10, box.height - PAD.bottom - 2);
      out.push(
        `<text x="${cx.toFixed(1)}" y="${ly.toFixed(1)}" fill="${p.inkSecondary}" ` +
          `font-size="9" font-weight="600" text-anchor="middle">${esc(label)}</text>`,
      );
    }
    const cat = d.label;
    if (textWidth(cat, 9) <= slot) {
      out.push(
        `<text x="${cx.toFixed(1)}" y="${(box.height - 6).toFixed(1)}" fill="${p.inkMuted}" font-size="9" ` +
          `text-anchor="middle">${esc(cat)}</text>`,
      );
    }
  });

  return out.join("");
}

function lineChart(spec: ChartSpec, box: ChartBox, p: Palette, t: Theme, accent: string): string {
  const out: string[] = [];
  // The endpoint label sits above the last point, so reserve room for it.
  const plotTop = (spec.title ? PAD.top : 8) + LABEL_HEAD;
  const plotH = box.height - plotTop - PAD.bottom;
  const plotW = box.width - PAD.left - PAD.right;
  const n = spec.points.length;

  const values = spec.points.map((d) => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values, spec.baseline ?? Math.min(...values));
  const span = max - min || 1;
  const x = (i: number) => PAD.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v: number) => plotTop + plotH * (1 - (v - min) / span);

  const d = spec.points.map((pt, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pt.value).toFixed(1)}`).join(" ");
  out.push(`<path d="${d}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

  // Only the endpoint gets a marker and a label — a value on every point is noise.
  const last = spec.points[n - 1];
  out.push(
    `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4" fill="${accent}" stroke="${p.figurePlate}" stroke-width="2"/>`,
  );
  const label = formatValue(last.value, spec.unit);
  const lx = x(n - 1);
  const anchor = lx > PAD.left + plotW * 0.75 ? "end" : "middle";
  out.push(
    `<text x="${lx.toFixed(1)}" y="${(y(last.value) - 9).toFixed(1)}" fill="${p.inkSecondary}" font-size="9" ` +
      `font-weight="600" text-anchor="${anchor}">${esc(label)}</text>`,
  );

  // First and last category only; intermediate ticks do not fit on a card.
  out.push(
    `<text x="${PAD.left}" y="${(box.height - 6).toFixed(1)}" fill="${p.inkMuted}" font-size="9">${esc(spec.points[0].label)}</text>`,
  );
  if (n > 1) {
    out.push(
      `<text x="${(PAD.left + plotW).toFixed(1)}" y="${(box.height - 6).toFixed(1)}" fill="${p.inkMuted}" font-size="9" ` +
        `text-anchor="end">${esc(last.label)}</text>`,
    );
  }
  return out.join("");
}

/** One number, large, in the same sans as everything else. */
function statTile(spec: ChartSpec, box: ChartBox, p: Palette, t: Theme, accent: string): string {
  const d = spec.points[0];
  const value = formatValue(d.value, spec.unit);
  const cx = box.width / 2;
  const size = Math.min(38, (box.width * 0.9) / Math.max(1, value.length * 0.58));
  const out: string[] = [];

  // Stacked label -> value -> delta, centred as a block so the tile stays
  // balanced whether or not a delta is present.
  const blockH = 13 + size + (spec.delta ? 15 : 0);
  let y = (box.height - blockH) / 2 + (spec.title ? 6 : 0);

  y += 11;
  out.push(
    `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" fill="${p.inkMuted}" font-size="10.5" ` +
      `text-anchor="middle">${esc(d.label)}</text>`,
  );

  y += size * 0.82;
  out.push(
    `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" fill="${p.ink}" ` +
      `font-size="${size.toFixed(1)}" font-weight="650" text-anchor="middle">${esc(value)}</text>`,
  );

  if (spec.delta) {
    y += 16;
    out.push(
      `<text x="${cx.toFixed(1)}" y="${y.toFixed(1)}" fill="${accent}" font-size="10.5" ` +
        `font-weight="600" text-anchor="middle">${esc(spec.delta)}</text>`,
    );
  }
  return out.join("");
}

/**
 * Renders a chart as a standalone SVG string, styled from the same palette as
 * the cards so a figure never looks pasted in from elsewhere.
 */
export function renderChart(
  spec: ChartSpec,
  box: ChartBox,
  theme: Theme,
  palette: Palette,
  accentOverride?: string,
): string {
  validateChart(spec);
  const accent = accentOverride ?? palette.focus;
  const body =
    spec.kind === "bar"
      ? barChart(spec, box, palette, theme, accent)
      : spec.kind === "line"
        ? lineChart(spec, box, palette, theme, accent)
        : statTile(spec, box, palette, theme, accent);

  const title = spec.title
    ? `<text x="${PAD.left}" y="13" fill="${palette.inkMuted}" font-size="10" font-weight="600" ` +
      `letter-spacing="0.05em">${esc(spec.title.toUpperCase())}</text>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}" ` +
    `viewBox="0 0 ${box.width} ${box.height}" font-family="${esc(theme.type.family)}">` +
    `<rect width="${box.width}" height="${box.height}" fill="none"/>${title}${body}</svg>`
  );
}

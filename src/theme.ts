import type { NodeKind, NodeState } from "./store.js";

/**
 * Card geometry, type scale, and palette are data — user and project configs
 * override these, so nothing here may be hardcoded in the renderer.
 */
export interface Theme {
  name: string;
  card: CardMetrics;
  type: TypeScale;
  layout: LayoutMetrics;
  light: Palette;
  dark: Palette;
}

export interface CardMetrics {
  width: number;
  minHeight: number;
  radius: number;
  padX: number;
  padY: number;
  /** Left accent stripe carrying the state colour. */
  stripe: number;
  gap: number;
  figureRatio: number;
  borderWidth: number;
  selectedWidth: number;
}

export interface TypeScale {
  family: string;
  mono: string;
  titleSize: number;
  titleWeight: number;
  titleLeading: number;
  bulletSize: number;
  bulletLeading: number;
  metaSize: number;
  metaWeight: number;
  metaTracking: number;
}

export interface LayoutMetrics {
  rankGap: number;
  nodeGap: number;
  edgeRadius: number;
  edgeWidth: number;
  arrow: number;
}

export interface StateInk {
  /** Stripe, glyph, and border colour. */
  accent: string;
  /** Card fill — a wash of the accent, never a saturated block. */
  fill: string;
  border: string;
}

export interface Palette {
  surface: string;
  plane: string;
  card: string;
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  hairline: string;
  edge: string;
  edgeLabel: string;
  focus: string;
  /** Plate behind figures; light in both modes — see render.ts. */
  figurePlate: string;
  states: Record<NodeState, StateInk>;
}

/**
 * Four hues carry meaning; `options` and the neutral action states ride on ink
 * so the hue count stays inside the all-pairs CVD gate.
 *
 * Validated with dataviz `validate_palette.js --pairs all` in both modes:
 * light `#2a78d6,#eda100,#0d8a63,#d03b3b` (worst CVD ΔE 7.6, normal 20.2),
 * dark `#3987e5,#c98500,#26ab8b,#d84559` (worst CVD ΔE 7.5, normal 17.1).
 * Both sit in the 6–8 CVD band, which is legal only because every state also
 * carries a glyph and a written label — never colour alone.
 */
const LIGHT_STATES: Record<NodeState, StateInk> = {
  planned: { accent: "#6b7789", fill: "#ffffff", border: "#d3dae6" },
  exploring: { accent: "#2a78d6", fill: "#f2f7fe", border: "#a9cbf2" },
  waiting: { accent: "#eda100", fill: "#fdf8ec", border: "#e8cf9a" },
  done: { accent: "#4a6ea8", fill: "#f7f9fc", border: "#c6d3e6" },
  abandoned: { accent: "#9aa3b2", fill: "#fafbfc", border: "#dde2ea" },
  blocked: { accent: "#d03b3b", fill: "#fdf4f4", border: "#eec3c3" },
  good: { accent: "#0d8a63", fill: "#f0faf6", border: "#a5ddc7" },
  bad: { accent: "#d03b3b", fill: "#fdf3f4", border: "#efc0c4" },
  mixed: { accent: "#eda100", fill: "#fdf8eb", border: "#e9cd93" },
  inconclusive: { accent: "#6b7789", fill: "#f8f9fb", border: "#d5dbe4" },
  open: { accent: "#4a3aa7", fill: "#f6f5fd", border: "#c3bce8" },
  resolved: { accent: "#5d6f96", fill: "#f7f8fc", border: "#ccd5e6" },
  active: { accent: "#6b7789", fill: "#fbfbfc", border: "#dfe3ea" },
  retired: { accent: "#9aa3b2", fill: "#fafbfc", border: "#e6e9ee" },
};

const DARK_STATES: Record<NodeState, StateInk> = {
  planned: { accent: "#8b97ab", fill: "#1d2331", border: "#333c4e" },
  exploring: { accent: "#3987e5", fill: "#16233a", border: "#2c4a72" },
  waiting: { accent: "#c98500", fill: "#241f12", border: "#4a3d1c" },
  done: { accent: "#7b8db5", fill: "#1c2231", border: "#333d52" },
  abandoned: { accent: "#6b7484", fill: "#191d28", border: "#2b323f" },
  blocked: { accent: "#d84559", fill: "#2a1c23", border: "#57303c" },
  good: { accent: "#26ab8b", fill: "#172c26", border: "#265448" },
  bad: { accent: "#d84559", fill: "#2b1c22", border: "#573039" },
  mixed: { accent: "#c98500", fill: "#241f12", border: "#4a3d1c" },
  inconclusive: { accent: "#8b97ab", fill: "#1c2130", border: "#323a4a" },
  open: { accent: "#9085e9", fill: "#1d1b33", border: "#3a3560" },
  resolved: { accent: "#7d87a8", fill: "#1b1f2e", border: "#333a4c" },
  active: { accent: "#8b97ab", fill: "#1b1f2b", border: "#333b49" },
  retired: { accent: "#6b7484", fill: "#181c25", border: "#2a303b" },
};

export const DEFAULT_THEME: Theme = {
  name: "skym",
  card: {
    width: 268,
    minHeight: 64,
    radius: 10,
    padX: 16,
    padY: 13,
    stripe: 3,
    gap: 7,
    figureRatio: 0.58,
    borderWidth: 1,
    selectedWidth: 2,
  },
  type: {
    family: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    titleSize: 14,
    titleWeight: 600,
    titleLeading: 19,
    bulletSize: 12.5,
    bulletLeading: 17,
    metaSize: 10,
    metaWeight: 600,
    metaTracking: 0.07,
  },
  layout: {
    rankGap: 62,
    nodeGap: 30,
    edgeRadius: 14,
    edgeWidth: 1.5,
    arrow: 7,
  },
  light: {
    surface: "#f4f6fa",
    plane: "#eef1f7",
    card: "#ffffff",
    ink: "#141a24",
    inkSecondary: "#485365",
    inkMuted: "#6b7789",
    hairline: "#dde3ec",
    edge: "#9aa6b8",
    edgeLabel: "#5b6679",
    focus: "#2a78d6",
    figurePlate: "#ffffff",
    states: LIGHT_STATES,
  },
  dark: {
    surface: "#161b26",
    plane: "#11151e",
    card: "#1c2230",
    ink: "#f2f5fa",
    inkSecondary: "#c3cad6",
    inkMuted: "#8b97ab",
    hairline: "#2c3444",
    edge: "#5a6678",
    edgeLabel: "#a9b4c8",
    focus: "#5aa3e8",
    figurePlate: "#f2f4f8",
    states: DARK_STATES,
  },
};

/** Glyphs are the secondary encoding the CVD warn band requires. */
export const STATE_GLYPH: Record<NodeState, string> = {
  planned: "○",
  exploring: "◐",
  waiting: "◔",
  done: "●",
  abandoned: "⊘",
  blocked: "▲",
  good: "✓",
  bad: "✕",
  mixed: "~",
  inconclusive: "?",
  open: "⋔",
  resolved: "◆",
  active: "※",
  retired: "·",
};

export const KIND_LABEL: Record<NodeKind, string> = {
  action: "Action",
  result: "Result",
  options: "Decision",
  note: "Note",
};

export function paletteFor(theme: Theme, mode: "light" | "dark"): Palette {
  return mode === "dark" ? theme.dark : theme.light;
}

/** Config layers merge shallowly per section: defaults → user → project. */
export type ThemeOverride = {
  name?: string;
  card?: Partial<CardMetrics>;
  type?: Partial<TypeScale>;
  layout?: Partial<LayoutMetrics>;
  light?: Partial<Omit<Palette, "states">> & { states?: Partial<Record<NodeState, Partial<StateInk>>> };
  dark?: Partial<Omit<Palette, "states">> & { states?: Partial<Record<NodeState, Partial<StateInk>>> };
};

export function resolveTheme(base: Theme, ...overrides: (ThemeOverride | undefined)[]): Theme {
  let out: Theme = base;
  for (const o of overrides) {
    if (!o) continue;
    out = {
      ...out,
      name: o.name ?? out.name,
      card: { ...out.card, ...o.card },
      type: { ...out.type, ...o.type },
      layout: { ...out.layout, ...o.layout },
      light: mergePalette(out.light, o.light),
      dark: mergePalette(out.dark, o.dark),
    };
  }
  return out;
}

function mergePalette(base: Palette, o: ThemeOverride["light"]): Palette {
  if (!o) return base;
  const { states, ...rest } = o;
  const merged: Palette = { ...base, ...rest };
  if (states) {
    merged.states = { ...base.states };
    for (const [k, v] of Object.entries(states)) {
      if (v) merged.states[k as NodeState] = { ...base.states[k as NodeState], ...v };
    }
  }
  return merged;
}

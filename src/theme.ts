import { DEFAULT_VOCAB, NEUTRAL_INK, glyphs, inksFor, kindLabels, type Vocabulary } from "./vocab.js";
import type { StateInk } from "./vocab.js";

export type { StateInk };

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
  /** Keyed by state slug; unknown states fall back to `neutral`. */
  states: Record<string, StateInk>;
  /** Ink for a state the current vocabulary does not define. */
  neutral: StateInk;
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
const LIGHT_STATES = inksFor(DEFAULT_VOCAB, "light");
const DARK_STATES = inksFor(DEFAULT_VOCAB, "dark");

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
    neutral: NEUTRAL_INK.light,
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
    neutral: NEUTRAL_INK.dark,
  },
};

/** Glyphs are the secondary encoding the CVD warn band requires. */
export const STATE_GLYPH: Record<string, string> = glyphs(DEFAULT_VOCAB);

export const KIND_LABEL: Record<string, string> = kindLabels(DEFAULT_VOCAB);

export function paletteFor(theme: Theme, mode: "light" | "dark"): Palette {
  return mode === "dark" ? theme.dark : theme.light;
}

/** Ink for a state, falling back to neutral rather than a literal state name. */
export function inkFor(palette: Palette, state: string): StateInk {
  return palette.states[state] ?? palette.neutral;
}

/**
 * Folds a project's vocabulary into the theme, so a custom kind's states get
 * their colours without the caller threading two objects everywhere.
 */
export function themeForVocab(theme: Theme, vocab: Vocabulary): Theme {
  return {
    ...theme,
    light: { ...theme.light, states: { ...theme.light.states, ...inksFor(vocab, "light") } },
    dark: { ...theme.dark, states: { ...theme.dark.states, ...inksFor(vocab, "dark") } },
  };
}

/** Config layers merge shallowly per section: defaults → user → project. */
export type ThemeOverride = {
  name?: string;
  card?: Partial<CardMetrics>;
  type?: Partial<TypeScale>;
  layout?: Partial<LayoutMetrics>;
  light?: Partial<Omit<Palette, "states">> & { states?: Record<string, Partial<StateInk>> };
  dark?: Partial<Omit<Palette, "states">> & { states?: Record<string, Partial<StateInk>> };
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
      // A state the base has never seen has no ink to spread, so start from neutral.
      if (v) merged.states[k] = { ...(base.states[k] ?? base.neutral), ...v };
    }
  }
  return merged;
}

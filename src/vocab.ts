/**
 * The node vocabulary — which kinds a chart may contain and which states each
 * kind carries. Everything that used to hardcode "action"/"planned" reads this
 * instead, so a project can define its own kinds without the nine copies of the
 * list drifting apart.
 *
 * Persistence is free-string (see store.ts), so changing a template never needs
 * a migration; a chart written under one vocabulary still loads under another,
 * with unknown states falling back to neutral ink.
 */

export interface StateInk {
  accent: string;
  fill: string;
  border: string;
}

export interface StateDef {
  slug: string;
  /** Shown in the legend and the detail chip. */
  label: string;
  /** The secondary encoding the CVD gate requires — never colour alone. */
  glyph: string;
  /** One-line meaning, shown in the legend and fed to the MCP tool description. */
  blurb: string;
  light: StateInk;
  dark: StateInk;
  /** Marks work still running, so the viewer can animate it. */
  pulse?: boolean;
  /** Still needs attention — what `flow_find({unresolved:true})` returns. */
  open?: boolean;
}

export interface KindDef {
  slug: string;
  /** Drawn on the card's meta row, e.g. "DECISION" for the options kind. */
  label: string;
  /** Teaches the model when to reach for this kind; becomes the tool description. */
  blurb: string;
  states: StateDef[];
  defaultState: string;
  /** Nudged, not enforced: a result with no figure gets a hint. */
  wantsFigure?: boolean;
  /** Seeds one node per candidate, so unexplored branches stay on the chart. */
  fork?: boolean;
  /**
   * Attaches to a node it constrains rather than following one: the edge runs
   * from this node outward, dashed, and the parameter is `about` not `after`.
   */
  attaches?: boolean;
  /** Instructions applied to this kind's generated content and exposed to the agent. */
  content?: KindContentTemplate;
  /** Card-level display choices, shared by local and hosted viewers. */
  presentation?: KindPresentation;
}

export interface KindContentTemplate {
  template?: string;
  title?: string;
  bullets?: string;
  figure?: string;
}

export interface KindPresentation {
  typeLabel?: "top" | "left" | "hidden";
  stateLabel?: "top" | "left" | "hidden";
  bullets?: boolean;
  figures?: "inherit" | "show" | "hide";
}

export interface Vocabulary {
  name: string;
  kinds: KindDef[];
}

/** Unknown states land here rather than crashing a lookup. */
export const NEUTRAL_INK: { light: StateInk; dark: StateInk } = {
  light: { accent: "#6b7789", fill: "#f8f9fb", border: "#d5dbe4" },
  dark: { accent: "#8b97ab", fill: "#1c2130", border: "#323a4a" },
};

const ACTION: KindDef = {
  slug: "action",
  label: "Action",
  blurb:
    "An action is something done or to be done — a step you are taking or considering. Every action that produces an outcome should be followed by a result node.",
  defaultState: "planned",
  content: {
    template: "Record one concrete step being considered, attempted, or completed. Keep it distinct from the outcome it produces.",
    title: "Name the action with a short verb-led phrase.",
    bullets: "Add only the method, constraints, or implementation details needed to understand the step.",
    figure: "Actions normally do not need a figure; attach one only when the procedure itself is visual.",
  },
  states: [
    {
      slug: "planned",
      label: "planned",
      glyph: "○",
      blurb: "candidate step, not started",
      open: true,
      light: { accent: "#6b7789", fill: "#ffffff", border: "#d3dae6" },
      dark: { accent: "#8b97ab", fill: "#1d2331", border: "#333c4e" },
    },
    {
      slug: "exploring",
      label: "exploring",
      glyph: "◐",
      blurb: "the agent is actively doing this work now",
      pulse: true,
      open: true,
      light: { accent: "#2a78d6", fill: "#f2f7fe", border: "#a9cbf2" },
      dark: { accent: "#3987e5", fill: "#16233a", border: "#2c4a72" },
    },
    {
      slug: "waiting",
      label: "waiting",
      glyph: "◔",
      blurb: "paused until an external event, person, monitor, or scheduled wakeup; no active work is happening",
      pulse: true,
      open: true,
      light: { accent: "#eda100", fill: "#fdf8ec", border: "#e8cf9a" },
      dark: { accent: "#c98500", fill: "#241f12", border: "#4a3d1c" },
    },
    {
      slug: "done",
      label: "done",
      glyph: "●",
      blurb: "finished",
      light: { accent: "#4a6ea8", fill: "#f7f9fc", border: "#c6d3e6" },
      dark: { accent: "#7b8db5", fill: "#1c2231", border: "#333d52" },
    },
    {
      slug: "abandoned",
      label: "abandoned",
      glyph: "⊘",
      blurb: "dead end",
      light: { accent: "#9aa3b2", fill: "#fafbfc", border: "#dde2ea" },
      dark: { accent: "#6b7484", fill: "#191d28", border: "#2b323f" },
    },
    {
      slug: "blocked",
      label: "blocked",
      glyph: "▲",
      blurb: "stuck",
      open: true,
      light: { accent: "#d03b3b", fill: "#fdf4f4", border: "#eec3c3" },
      dark: { accent: "#d84559", fill: "#2a1c23", border: "#57303c" },
    },
  ],
};

const RESULT: KindDef = {
  slug: "result",
  label: "Result",
  blurb:
    "A result records what an action actually produced — findings, measurements, an outcome. Attach a figure whenever anything visual exists: results are the nodes that carry evidence.",
  defaultState: "inconclusive",
  wantsFigure: true,
  content: {
    template: "State what the preceding work actually produced. Separate observed evidence from interpretation.",
    title: "Lead with the key finding or outcome.",
    bullets: "List measurements, evidence, properties, and trade-offs; keep one fact per point.",
    figure: "Whenever visual evidence is possible, generate or attach a clear figure with restrained, accessible colours and a useful caption.",
  },
  states: [
    {
      slug: "good",
      label: "good",
      glyph: "✓",
      blurb: "it worked",
      light: { accent: "#0d8a63", fill: "#f0faf6", border: "#a5ddc7" },
      dark: { accent: "#26ab8b", fill: "#172c26", border: "#265448" },
    },
    {
      slug: "bad",
      label: "bad",
      glyph: "✕",
      blurb: "it did not",
      light: { accent: "#d03b3b", fill: "#fdf3f4", border: "#efc0c4" },
      dark: { accent: "#d84559", fill: "#2b1c22", border: "#573039" },
    },
    {
      slug: "retracted",
      label: "retracted",
      glyph: "↶",
      blurb: "the reported claim or measurement was later found to be wrong",
      light: { accent: "#7a4c9e", fill: "#faf5fd", border: "#d8c0e8" },
      dark: { accent: "#b58bd2", fill: "#281d30", border: "#533b63" },
    },
    {
      slug: "mixed",
      label: "mixed",
      glyph: "~",
      blurb: "tradeoffs",
      light: { accent: "#eda100", fill: "#fdf8eb", border: "#e9cd93" },
      dark: { accent: "#c98500", fill: "#241f12", border: "#4a3d1c" },
    },
    {
      slug: "inconclusive",
      label: "inconclusive",
      glyph: "?",
      blurb: "needs more",
      light: { accent: "#6b7789", fill: "#f8f9fb", border: "#d5dbe4" },
      dark: { accent: "#8b97ab", fill: "#1c2130", border: "#323a4a" },
    },
  ],
};

const OPTIONS: KindDef = {
  slug: "options",
  label: "Decision",
  blurb:
    "A fork with candidate branches. Creates the branch point and one planned action per candidate, so alternatives you did not pursue stay on the chart instead of being forgotten.",
  defaultState: "open",
  fork: true,
  content: {
    template: "Describe a genuine decision point and preserve every plausible candidate, including options not chosen.",
    title: "Name the decision to be made.",
    bullets: "Summarise the deciding criteria or constraints.",
    figure: "Use a figure only when it materially clarifies the comparison.",
  },
  states: [
    {
      slug: "open",
      label: "open",
      glyph: "⋔",
      blurb: "undecided fork",
      open: true,
      light: { accent: "#4a3aa7", fill: "#f6f5fd", border: "#c3bce8" },
      dark: { accent: "#9085e9", fill: "#1d1b33", border: "#3a3560" },
    },
    {
      slug: "resolved",
      label: "resolved",
      glyph: "◆",
      blurb: "decided",
      light: { accent: "#5d6f96", fill: "#f7f8fc", border: "#ccd5e6" },
      dark: { accent: "#7d87a8", fill: "#1b1f2e", border: "#333a4c" },
    },
  ],
};

const NOTE: KindDef = {
  slug: "note",
  label: "Note",
  blurb:
    "A constraint, fact, or open question that shapes the work without being a step in it — 'must stay under 200ms', 'the staging DB is a snapshot from March'. Use when something matters but is not an action, result, or fork.",
  defaultState: "active",
  attaches: true,
  content: {
    template: "Capture durable context that affects the work but is not itself a step or outcome.",
    title: "State the constraint, fact, assumption, or open question directly.",
    bullets: "Add scope, source, or implications only when useful.",
    figure: "Attach a figure only when the note refers to visual source material.",
  },
  states: [
    {
      slug: "active",
      label: "active",
      glyph: "※",
      blurb: "holds right now",
      light: { accent: "#6b7789", fill: "#fbfbfc", border: "#dfe3ea" },
      dark: { accent: "#8b97ab", fill: "#1b1f2b", border: "#333b49" },
    },
    {
      slug: "retired",
      label: "retired",
      glyph: "·",
      blurb: "no longer applies",
      light: { accent: "#9aa3b2", fill: "#fafbfc", border: "#e6e9ee" },
      dark: { accent: "#6b7484", fill: "#181c25", border: "#2a303b" },
    },
  ],
};

export const DEFAULT_VOCAB: Vocabulary = {
  name: "default",
  kinds: [ACTION, RESULT, OPTIONS, NOTE],
};

/** A lab notebook: what was asked, what was measured, what it means. */
const RESEARCH: Vocabulary = {
  name: "research",
  kinds: [
    { ...ACTION, slug: "question", label: "Question", blurb: "An open question the work is trying to answer." },
    { ...ACTION, slug: "experiment", label: "Experiment", blurb: "A run, trial, or measurement being carried out." },
    { ...RESULT, slug: "finding", label: "Finding", blurb: "What an experiment showed. Attach the plot." },
    NOTE,
  ],
};

/** Decisions and their rationale, without the step-by-step exploration. */
const DECISION_LOG: Vocabulary = {
  name: "decision-log",
  kinds: [
    OPTIONS,
    { ...RESULT, slug: "decision", label: "Decision", blurb: "What was chosen and why.", wantsFigure: false },
    NOTE,
  ],
};

export const BUILTIN_TEMPLATES: Record<string, Vocabulary> = {
  default: DEFAULT_VOCAB,
  research: RESEARCH,
  "decision-log": DECISION_LOG,
};

export function kindDef(vocab: Vocabulary, slug: string): KindDef | undefined {
  return vocab.kinds.find((k) => k.slug === slug);
}

export function stateDef(vocab: Vocabulary, kind: string, state: string): StateDef | undefined {
  return kindDef(vocab, kind)?.states.find((s) => s.slug === state);
}

/** Every state in the vocabulary, deduped — `flow_state` and `flow_find` span kinds. */
export function allStates(vocab: Vocabulary): StateDef[] {
  const seen = new Map<string, StateDef>();
  for (const k of vocab.kinds) {
    for (const s of k.states) if (!seen.has(s.slug)) seen.set(s.slug, s);
  }
  return [...seen.values()];
}

export function statesFor(vocab: Vocabulary): Record<string, readonly string[]> {
  return Object.fromEntries(vocab.kinds.map((k) => [k.slug, k.states.map((s) => s.slug)]));
}

export function defaultStates(vocab: Vocabulary): Record<string, string> {
  return Object.fromEntries(vocab.kinds.map((k) => [k.slug, k.defaultState]));
}

/** Slug → glyph across all kinds; the renderer draws this beside the state label. */
export function glyphs(vocab: Vocabulary): Record<string, string> {
  return Object.fromEntries(allStates(vocab).map((s) => [s.slug, s.glyph]));
}

/** States drawn as in-flight; the card's stripe pulses for these. */
export function pulseStates(vocab: Vocabulary): string[] {
  return allStates(vocab).filter((s) => s.pulse).map((s) => s.slug);
}

/** States that still need attention — drives `flow_find({unresolved:true})`. */
export function openStates(vocab: Vocabulary): string[] {
  return allStates(vocab).filter((s) => s.open).map((s) => s.slug);
}

export function kindLabels(vocab: Vocabulary): Record<string, string> {
  return Object.fromEntries(vocab.kinds.map((k) => [k.slug, k.label]));
}

export function inksFor(vocab: Vocabulary, mode: "light" | "dark"): Record<string, StateInk> {
  return Object.fromEntries(allStates(vocab).map((s) => [s.slug, mode === "dark" ? s.dark : s.light]));
}

/** Shallow per-kind merge, mirroring resolveTheme: defaults → user → project. */
export type VocabOverride = {
  /** Names a builtin template to start from instead of `default`. */
  template?: string;
  kinds?: Array<Partial<KindDef> & { slug: string }>;
  /** Removes inherited kinds at this layer; a later layer may add them again. */
  removeKinds?: string[];
};

export function resolveVocab(base: Vocabulary, ...overrides: (VocabOverride | undefined)[]): Vocabulary {
  let out = base;
  for (const o of overrides) {
    if (!o) continue;
    const named = o.template ? BUILTIN_TEMPLATES[o.template] : undefined;
    if (named) out = named;
    const byslug = new Map(out.kinds.map((k) => [k.slug, k]));
    for (const slug of o.removeKinds ?? []) byslug.delete(slug);
    for (const patch of o.kinds ?? []) {
      const existing = byslug.get(patch.slug);
      // A patch naming an unknown kind adds it, so a project can extend a template.
      byslug.set(patch.slug, {
        ...(existing ?? { label: patch.slug, blurb: "", states: [], defaultState: "" }),
        ...patch,
        content: { ...existing?.content, ...patch.content },
        presentation: { ...existing?.presentation, ...patch.presentation },
      } as KindDef);
    }
    out = { ...out, kinds: [...byslug.values()] };
  }
  return out;
}

export function kindPresentations(vocab: Vocabulary): Record<string, KindPresentation> {
  return Object.fromEntries(vocab.kinds.map((k) => [k.slug, k.presentation ?? {}]));
}

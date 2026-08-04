import type {
  Direction,
  Figure,
  FlowEdge,
  FlowNode,
  Graph,
  NodeKind,
  NodeState,
} from "./store.js";

/**
 * The current on-disk format. Bump when a change cannot be read by the previous
 * reader, and add a migration — a chart a user cannot open is data loss.
 */
export const SCHEMA_VERSION = 2;

/**
 * Every mutation is an operation, and the graph is the fold of the log. This is
 * the shape the team tier needs: ops are small, ordered, and mergeable, so
 * syncing becomes shipping ops to a relay rather than reconciling whole graphs.
 * Locally it changes nothing a user can see.
 */
export type Op =
  | { t: "init"; title: string; description?: string; direction: Direction }
  | { t: "meta"; title?: string; description?: string; direction?: Direction }
  | {
      t: "node.put";
      id: string;
      title?: string;
      kind?: NodeKind;
      state?: NodeState;
      bullets?: string[];
      group?: string;
    }
  | { t: "node.state"; id: string; state: NodeState }
  | { t: "node.del"; id: string }
  | { t: "edge.put"; id: string; from: string; to: string; label?: string; dashed: boolean }
  | { t: "edge.del"; from: string; to: string }
  | { t: "figure.add"; nodeId: string; figure: Figure }
  | { t: "figure.clear"; nodeId: string };

export interface Entry {
  /** Monotonic per chart; also the graph's revision after applying this op. */
  seq: number;
  at: number;
  /** Who produced it. Local edits are "local"; the team tier fills in a user. */
  by: string;
  op: Op;
}

/**
 * Human-readable summary for the activity list, derived rather than stored.
 * `existed` distinguishes an add from an update, which the op itself does not
 * — the activity list is much less useful if every change reads the same.
 */
export function describe(op: Op, existed = false): { kind: string; detail: string } {
  switch (op.t) {
    case "init":
      return { kind: "init", detail: op.title };
    case "meta":
      return { kind: "meta", detail: op.title ?? "updated" };
    case "node.put":
      return { kind: existed ? "node.update" : "node.add", detail: op.id };
    case "node.state":
      return { kind: "node.state", detail: `${op.id}=${op.state}` };
    case "node.del":
      return { kind: "node.remove", detail: op.id };
    case "edge.put":
      return { kind: existed ? "edge.update" : "edge.add", detail: `${op.from}->${op.to}` };
    case "edge.del":
      return { kind: "edge.remove", detail: `${op.from}->${op.to}` };
    case "figure.add":
      return { kind: "figure.add", detail: `${op.nodeId}:${op.figure.file}` };
    case "figure.clear":
      return { kind: "figure.clear", detail: op.nodeId };
  }
}

/**
 * Replay must not depend on project config — a chart written under one template
 * has to load under another. Ops carry their state explicitly; this is only the
 * floor for a legacy op that omitted one.
 */
const FALLBACK_STATE = "planned";

export function emptyGraph(chartId: string, title: string, at = Date.now()): Graph {
  return {
    chartId,
    title,
    direction: "TD",
    nodes: [],
    edges: [],
    events: [],
    revision: 0,
    createdAt: at,
    updatedAt: at,
  };
}

const MAX_EVENTS = 300;

/**
 * Applies one op in place. Total rather than throwing: a log that fails to
 * replay is a chart the user cannot open, so an op naming a node that no longer
 * exists is skipped, not fatal.
 */
export function apply(graph: Graph, entry: Entry): Graph {
  const { op, at } = entry;
  const existed =
    (op.t === "node.put" && graph.nodes.some((n) => n.id === op.id)) ||
    (op.t === "edge.put" &&
      graph.edges.some((e) => e.from === op.from && e.to === op.to && (e.label ?? "") === (op.label ?? "")));
  switch (op.t) {
    case "init": {
      graph.title = op.title;
      graph.description = op.description;
      graph.direction = op.direction;
      break;
    }
    case "meta": {
      if (op.title !== undefined) graph.title = op.title;
      if (op.description !== undefined) graph.description = op.description;
      if (op.direction !== undefined) graph.direction = op.direction;
      break;
    }
    case "node.put": {
      const existing = graph.nodes.find((n) => n.id === op.id);
      if (existing) {
        if (op.title !== undefined) existing.title = op.title;
        if (op.kind !== undefined) existing.kind = op.kind;
        if (op.state !== undefined) existing.state = op.state;
        if (op.bullets !== undefined) existing.bullets = op.bullets;
        if (op.group !== undefined) existing.group = op.group;
        existing.updatedAt = at;
      } else {
        const kind = op.kind ?? "action";
        graph.nodes.push({
          id: op.id,
          title: op.title ?? op.id,
          kind,
          state: op.state ?? FALLBACK_STATE,
          bullets: op.bullets ?? [],
          group: op.group,
          figures: [],
          createdAt: at,
          updatedAt: at,
        });
      }
      break;
    }
    case "node.state": {
      const node = graph.nodes.find((n) => n.id === op.id);
      if (node) {
        node.state = op.state;
        node.updatedAt = at;
      }
      break;
    }
    case "node.del": {
      graph.nodes = graph.nodes.filter((n) => n.id !== op.id);
      graph.edges = graph.edges.filter((e) => e.from !== op.id && e.to !== op.id);
      break;
    }
    case "edge.put": {
      const dupe = graph.edges.find(
        (e) => e.from === op.from && e.to === op.to && (e.label ?? "") === (op.label ?? ""),
      );
      if (dupe) dupe.dashed = op.dashed;
      else graph.edges.push({ id: op.id, from: op.from, to: op.to, label: op.label, dashed: op.dashed });
      break;
    }
    case "edge.del": {
      graph.edges = graph.edges.filter((e) => !(e.from === op.from && e.to === op.to));
      break;
    }
    case "figure.add": {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      if (node) {
        node.figures.push(op.figure);
        node.updatedAt = at;
      }
      break;
    }
    case "figure.clear": {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      if (node) {
        node.figures = [];
        node.updatedAt = at;
      }
      break;
    }
  }

  const { kind, detail } = describe(op, existed);
  graph.events.push({ at, kind, detail });
  if (graph.events.length > MAX_EVENTS) graph.events = graph.events.slice(-MAX_EVENTS);
  graph.revision = entry.seq;
  graph.updatedAt = at;
  return graph;
}

/** Folds a whole log, optionally onto an existing snapshot. */
export function replay(entries: Entry[], base?: Graph, chartId = "chart", title = "Untitled"): Graph {
  const graph = base ?? emptyGraph(chartId, title, entries[0]?.at);
  for (const e of entries) apply(graph, e);
  return graph;
}

/** One JSON object per line: appendable without rewriting, and greppable. */
export function encodeLog(entries: Entry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}

/**
 * A truncated final line (killed mid-append) costs that one op, not the chart —
 * so parse leniently and keep everything that reads.
 */
export function decodeLog(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Entry;
      if (parsed && typeof parsed.seq === "number" && parsed.op) out.push(parsed);
    } catch {
      // Partial write at the tail; earlier entries are still good.
    }
  }
  return out;
}

/**
 * Rebuilds a log from a graph that predates the log format, so v1 charts open
 * and keep their history rather than starting empty.
 */
export function migrateGraphToLog(graph: Graph): Entry[] {
  const at = graph.createdAt || Date.now();
  const entries: Entry[] = [];
  let seq = 0;
  const push = (op: Op, when = at) => entries.push({ seq: ++seq, at: when, by: "migrated", op });

  push({ t: "init", title: graph.title, description: graph.description, direction: graph.direction });
  for (const n of graph.nodes) {
    push(
      { t: "node.put", id: n.id, title: n.title, kind: n.kind, state: n.state, bullets: n.bullets, group: n.group },
      n.createdAt || at,
    );
    for (const f of n.figures) push({ t: "figure.add", nodeId: n.id, figure: f }, n.updatedAt || at);
  }
  for (const e of graph.edges) {
    push({ t: "edge.put", id: e.id, from: e.from, to: e.to, label: e.label, dashed: e.dashed }, at);
  }
  return entries;
}

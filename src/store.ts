import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeOfflineHtml } from "./offline.js";

export type NodeKind = "action" | "result" | "options";

/** Actions carry progress; results carry quality; options are a fork with unexplored branches. */
export type ActionState = "planned" | "exploring" | "waiting" | "done" | "abandoned" | "blocked";
export type ResultState = "good" | "bad" | "mixed" | "inconclusive";
export type OptionsState = "open" | "resolved";
export type NodeState = ActionState | ResultState | OptionsState;

export const ACTION_STATES: ActionState[] = ["planned", "exploring", "waiting", "done", "abandoned", "blocked"];
export const RESULT_STATES: ResultState[] = ["good", "bad", "mixed", "inconclusive"];
export const OPTIONS_STATES: OptionsState[] = ["open", "resolved"];

export const STATES_FOR: Record<NodeKind, readonly NodeState[]> = {
  action: ACTION_STATES,
  result: RESULT_STATES,
  options: OPTIONS_STATES,
};

export const DEFAULT_STATE: Record<NodeKind, NodeState> = {
  action: "planned",
  result: "inconclusive",
  options: "open",
};

export type Direction = "TD" | "LR" | "BT" | "RL";

export interface Figure {
  id: string;
  file: string;
  caption?: string;
  mime: string;
}

export interface FlowNode {
  id: string;
  title: string;
  kind: NodeKind;
  state: NodeState;
  /** Concise bullets — the only body content a node may carry. */
  bullets: string[];
  group?: string;
  figures: Figure[];
  createdAt: number;
  updatedAt: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
}

export interface EventEntry {
  at: number;
  kind: string;
  detail: string;
}

export interface Graph {
  chartId: string;
  title: string;
  description?: string;
  direction: Direction;
  nodes: FlowNode[];
  edges: FlowEdge[];
  events: EventEntry[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

const MAX_EVENTS = 300;

function emptyGraph(chartId: string, title: string): Graph {
  const now = Date.now();
  return {
    chartId,
    title,
    direction: "TD",
    nodes: [],
    edges: [],
    events: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export interface ChartSummary {
  chartId: string;
  title: string;
  nodes: number;
  revision: number;
  updatedAt: number;
  active: boolean;
}

/**
 * One store per project directory, holding many charts (one per chat).
 * The active chart is per server process, so parallel chats never collide.
 */
export class GraphStore {
  private graph: Graph;
  private listeners = new Set<(g: Graph) => void>();

  /** Where charts live; `flow_init` may repoint this per chart. */
  root: string;
  /** Doubles as the chart's directory name; re-slugged from the title on init. */
  chartId: string;
  /** Lock owner token, unique per store instance rather than per process. */
  private readonly owner = `${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(root: string, chartId: string, title: string) {
    this.root = root;
    this.chartId = chartId;
    // No directory yet — flow_init names the chart and creates it then, so an
    // unused server never litters .flows with an empty throwaway dir.
    this.graph = this.load() ?? emptyGraph(chartId, title);
  }

  /** Advisory lock released on shutdown so the chart can be resumed later. */
  release(): void {
    try {
      fs.rmSync(this.lockPath(this.chartId), { force: true });
    } catch {
      // Best effort.
    }
  }

  get chartDir(): string {
    return path.join(this.root, "charts", this.chartId);
  }

  get assetsDir(): string {
    return path.join(this.chartDir, "assets");
  }

  private get statePath(): string {
    return path.join(this.chartDir, "graph.json");
  }

  private load(): Graph | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Graph;
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        parsed.events ??= [];
        parsed.revision ??= 0;
        return parsed;
      }
    } catch {
      // No usable prior state.
    }
    return null;
  }

  private persist(): void {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.graph, null, 2), "utf8");
    fs.renameSync(tmp, this.statePath);
    this.writeIndex();
    writeOfflineHtml(this.graph, this.chartDir, this.assetsDir);
  }

  /** Index lets the viewer list every chat's chart without opening each one. */
  private writeIndex(): void {
    const dir = path.join(this.root, "charts");
    const entries: Record<string, unknown> = {};
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    } catch {
      // First write.
    }
    Object.assign(entries, existing);
    entries[this.chartId] = {
      chartId: this.chartId,
      title: this.graph.title,
      nodes: this.graph.nodes.length,
      revision: this.graph.revision,
      updatedAt: this.graph.updatedAt,
    };
    const tmp = path.join(dir, "index.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    fs.renameSync(tmp, path.join(dir, "index.json"));
  }

  listCharts(): ChartSummary[] {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.root, "charts", "index.json"), "utf8"));
      return Object.values(raw as Record<string, Omit<ChartSummary, "active">>)
        .map((c) => ({ ...c, active: c.chartId === this.chartId }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  /** Reads another chat's chart read-only, for the viewer's chart switcher. */
  readChart(chartId: string): Graph | null {
    if (chartId === this.chartId) return this.graph;
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.root, "charts", chartId, "graph.json"), "utf8"),
      ) as Graph;
    } catch {
      return null;
    }
  }

  get(): Graph {
    return this.graph;
  }

  subscribe(fn: (g: Graph) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(kind: string, detail: string): Graph {
    this.graph.revision += 1;
    this.graph.updatedAt = Date.now();
    this.graph.events.push({ at: this.graph.updatedAt, kind, detail });
    if (this.graph.events.length > MAX_EVENTS) {
      this.graph.events = this.graph.events.slice(-MAX_EVENTS);
    }
    this.persist();
    for (const fn of this.listeners) {
      try {
        fn(this.graph);
      } catch {
        // A broken viewer must not break the tool call.
      }
    }
    return this.graph;
  }

  /**
   * Adopts an existing chart with the same title (so a chat resumed after a
   * restart continues its tree) unless `fresh` forces a new one.
   */
  init(
    title: string,
    description?: string,
    direction: Direction = "TD",
    fresh = false,
    root?: string,
  ): { graph: Graph; resumed: boolean } {
    if (root && path.resolve(root) !== path.resolve(this.root)) {
      // Moving to a different folder: drop the lock held under the old root.
      this.release();
      this.root = path.resolve(root);
      fs.mkdirSync(path.join(this.root, "charts"), { recursive: true });
    }
    const target = this.claimDir(title, fresh);
    const existing = fresh ? null : this.readGraphAt(target);

    this.chartId = target;
    fs.mkdirSync(this.assetsDir, { recursive: true });

    if (existing) {
      this.graph = existing;
      this.graph.chartId = target;
      this.graph.title = title;
      if (description !== undefined) this.graph.description = description;
      this.graph.direction = direction;
      return { graph: this.commit("resume", `${title} (${this.graph.nodes.length} nodes)`), resumed: true };
    }

    this.graph = emptyGraph(target, title);
    this.graph.description = description;
    this.graph.direction = direction;
    return { graph: this.commit("init", title), resumed: false };
  }

  private readGraphAt(chartId: string): Graph | null {
    try {
      const g = JSON.parse(
        fs.readFileSync(path.join(this.root, "charts", chartId, "graph.json"), "utf8"),
      ) as Graph;
      if (g && Array.isArray(g.nodes) && Array.isArray(g.edges)) {
        g.events ??= [];
        g.revision ??= 0;
        return g;
      }
    } catch {
      // Nothing to resume.
    }
    return null;
  }

  /**
   * Resolves the directory for this title: reuse it when the title matches,
   * otherwise take the next free numeric suffix. Also discards the throwaway
   * startup directory once the real name is known.
   */
  private claimDir(title: string, fresh: boolean): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "chart";

    // Sweep first: a lock whose process died must not hide an otherwise
    // resumable chart, nor make a free name look occupied.
    this.sweepStaleLocks();

    const dir = path.join(this.root, "charts");
    let candidate = slug;
    for (let n = 2; ; n++) {
      const existing = this.readGraphAt(candidate);
      const held = this.isLocked(candidate);

      // A live session owns this name — never join it.
      if (!held) {
        if (!existing) {
          // Unused name: take it atomically. Losing the race means someone
          // claimed it first, so fall through to the next suffix.
          if (this.tryClaim(candidate)) return this.finish(dir, candidate);
        } else if (!fresh && existing.title === title) {
          // Same chat resuming after a restart.
          if (this.stealLock(candidate)) return this.finish(dir, candidate);
        }
      }
      candidate = `${slug}-${n}`;
    }
  }

  /** Drops the throwaway startup directory once the real name is settled. */
  private finish(dir: string, candidate: string): string {

    const startup = path.join(dir, this.chartId);
    if (this.chartId !== candidate && fs.existsSync(startup) && this.graph.nodes.length === 0) {
      try {
        fs.rmSync(startup, { recursive: true, force: true });
        this.dropFromIndex(this.chartId);
      } catch {
        // Leave it; harmless.
      }
    }
    return candidate;
  }

  /** Creates the lock exclusively; false means someone else holds this name. */
  private tryClaim(chartId: string): boolean {
    try {
      fs.mkdirSync(path.join(this.root, "charts", chartId), { recursive: true });
      fs.writeFileSync(this.lockPath(chartId), this.owner, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  /** Takes over a lock whose owning process is gone. */
  private stealLock(chartId: string): boolean {
    try {
      fs.rmSync(this.lockPath(chartId), { force: true });
      fs.writeFileSync(this.lockPath(chartId), this.owner, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  /** A lock file keeps two concurrent chats from adopting the same chart. */
  private lockPath(chartId: string): string {
    return path.join(this.root, "charts", chartId, ".lock");
  }

  private isLocked(chartId: string): boolean {
    try {
      const raw = fs.readFileSync(this.lockPath(chartId), "utf8").trim();
      // Owner is "<pid>:<store>" so sibling stores in one process still see
      // each other's locks; only this exact store may re-adopt its own.
      if (raw === this.owner) return false;
      const pid = Number(raw.split(":")[0]);
      if (!pid) return false;
      process.kill(pid, 0); // Throws if that process is gone.
      return true;
    } catch {
      return false;
    }
  }

  /** Servers are usually killed rather than exited, so tidy dead locks here. */
  private sweepStaleLocks(): void {
    const dir = path.join(this.root, "charts");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === this.chartId || name === "index.json") continue;
      if (!fs.existsSync(this.lockPath(name))) continue;
      if (!this.isLocked(name)) {
        try {
          fs.rmSync(this.lockPath(name), { force: true });
        } catch {
          // Ignore.
        }
      }
    }
  }

  /**
   * Removes a chart from the index, e.g. the throwaway startup directory.
   */
  private dropFromIndex(id: string): void {
    const file = path.join(this.root, "charts", "index.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      delete raw[id];
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");
    } catch {
      // No index yet.
    }
  }

  findNode(id: string): FlowNode | undefined {
    return this.graph.nodes.find((n) => n.id === id);
  }

  upsertNode(input: {
    id: string;
    title?: string;
    kind?: NodeKind;
    state?: NodeState;
    bullets?: string[];
    group?: string;
  }): Graph {
    const now = Date.now();
    const existing = this.findNode(input.id);
    if (existing) {
      if (input.title !== undefined) existing.title = input.title;
      if (input.kind !== undefined) existing.kind = input.kind;
      if (input.state !== undefined) existing.state = input.state;
      if (input.bullets !== undefined) existing.bullets = input.bullets;
      if (input.group !== undefined) existing.group = input.group;
      existing.updatedAt = now;
      return this.commit("node.update", input.id);
    }
    const kind = input.kind ?? "action";
    this.graph.nodes.push({
      id: input.id,
      title: input.title ?? input.id,
      kind,
      state: input.state ?? DEFAULT_STATE[kind],
      bullets: input.bullets ?? [],
      group: input.group,
      figures: [],
      createdAt: now,
      updatedAt: now,
    });
    return this.commit("node.add", `${kind}:${input.id}`);
  }

  removeNode(id: string): Graph {
    this.graph.nodes = this.graph.nodes.filter((n) => n.id !== id);
    this.graph.edges = this.graph.edges.filter((e) => e.from !== id && e.to !== id);
    return this.commit("node.remove", id);
  }

  addEdge(from: string, to: string, label?: string, dashed = false): Graph {
    const dupe = this.graph.edges.find(
      (e) => e.from === from && e.to === to && (e.label ?? "") === (label ?? ""),
    );
    if (dupe) {
      dupe.dashed = dashed;
      return this.commit("edge.update", `${from}->${to}`);
    }
    this.graph.edges.push({ id: randomUUID(), from, to, label, dashed });
    return this.commit("edge.add", `${from}->${to}`);
  }

  removeEdge(from: string, to: string): Graph {
    this.graph.edges = this.graph.edges.filter((e) => !(e.from === from && e.to === to));
    return this.commit("edge.remove", `${from}->${to}`);
  }

  setState(id: string, state: NodeState): Graph {
    const node = this.findNode(id);
    if (!node) throw new Error(`No node with id "${id}".`);
    node.state = state;
    node.updatedAt = Date.now();
    return this.commit("node.state", `${id}=${state}`);
  }

  attachFigure(
    nodeId: string,
    data: Buffer,
    mime: string,
    caption?: string,
    ext = "png",
    replace = false,
  ): Graph {
    const node = this.findNode(nodeId);
    if (!node) throw new Error(`No node with id "${nodeId}".`);
    const file = `${nodeId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(this.assetsDir, file), data);
    if (replace) {
      // Drop the asset files too, or a corrected figure leaves the broken one
      // orphaned on disk.
      for (const old of node.figures) {
        try {
          fs.unlinkSync(path.join(this.assetsDir, old.file));
        } catch {
          // already gone; the reference is what matters
        }
      }
      node.figures = [];
    }
    node.figures.push({ id: randomUUID(), file, caption, mime });
    node.updatedAt = Date.now();
    return this.commit(replace ? "figure.replace" : "figure.add", `${nodeId}:${file}`);
  }
}

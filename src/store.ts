import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeOfflineHtml } from "./offline.js";
import {
  SCHEMA_VERSION,
  apply as applyOp,
  decodeLog,
  encodeLog,
  migrateGraphToLog,
  replay,
  type Entry,
  type Op,
} from "./ops.js";

/**
 * Kinds and states are open strings: the vocabulary is per-project data (see
 * vocab.ts), and what is on disk must load under any template. Validation lives
 * at the tool boundary, not in the type.
 */
export type NodeKind = string;
export type NodeState = string;

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

/**
 * A lock untouched for this long is treated as abandoned. A live server
 * refreshes it on every commit and on a timer, so the window only has to
 * outlast an idle gap between tool calls — not a whole session.
 */
const LOCK_STALE_MS = 90_000;

/** How often a live holder proves it is still there. */
const LOCK_HEARTBEAT_MS = 20_000;

/**
 * Identifies this boot, so a lock written before the last restart is never
 * mistaken for a live one when the OS recycles its pid. Rounded to the minute
 * and computed once, since uptime drifts by a second between calls.
 */
const BOOT_ID = String(Math.floor((Date.now() / 1000 - os.uptime()) / 60));

function bootId(): string {
  return BOOT_ID;
}

/** Coalesce window for regenerating the offline export. */
const OFFLINE_DEBOUNCE_MS = 400;

/**
 * Ceilings, not capacity limits. A chart past this size has stopped being a
 * readable exploration and become a dump — the honest fix is to summarise a
 * branch or start a new chart, which the error says.
 */
const MAX_NODES = 300;
const MAX_EDGES = 900;

/**
 * Reads a chart in either format.
 *
 * v2 stores `{ v, graph }` beside an append-only `log.jsonl`. v1 stored the
 * bare graph with no version field. A v1 chart is read as-is and its log is
 * reconstructed on first write, so charts written before the log existed keep
 * opening — losing a user's history to a format change is not acceptable.
 */
export function readChartAt(chartDir: string): Graph | null {
  const snapshotPath = path.join(chartDir, "graph.json");
  let graph: Graph | null = null;

  try {
    const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    if (raw && typeof raw === "object" && "graph" in raw && Array.isArray(raw.graph?.nodes)) {
      graph = raw.graph as Graph; // v2
    } else if (raw && Array.isArray(raw.nodes) && Array.isArray(raw.edges)) {
      graph = raw as Graph; // v1
    }
  } catch {
    // Missing or corrupt snapshot — the log may still hold everything.
  }

  // The log outranks the snapshot: if a crash lost the snapshot write but the
  // append landed, replaying recovers the newer state.
  try {
    const entries = decodeLog(fs.readFileSync(path.join(chartDir, "log.jsonl"), "utf8"));
    const last = entries.at(-1);
    if (last && (!graph || last.seq > graph.revision)) {
      graph = replay(entries, undefined, graph?.chartId ?? path.basename(chartDir), graph?.title ?? "Untitled");
    }
  } catch {
    // No log (v1, or never written).
  }

  if (!graph) return null;
  graph.events ??= [];
  graph.revision ??= 0;
  return graph;
}

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
  /**
   * Lock owner token, unique per store instance rather than per process. The
   * start time disambiguates a recycled pid: the OS reuses pid numbers, so
   * "some process has this pid" is not "the process that wrote this is alive".
   */
  private readonly owner = `${process.pid}:${bootId()}:${randomUUID().slice(0, 8)}`;

  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stamped on every op. The team tier replaces this with a real identity. */
  author = "local";

  constructor(root: string, chartId: string, title: string) {
    this.root = root;
    this.chartId = chartId;
    // No directory yet — flow_init names the chart and creates it then, so an
    // unused server never litters .flows with an empty throwaway dir.
    this.graph = this.load() ?? emptyGraph(chartId, title);
  }

  /** Advisory lock released on shutdown so the chart can be resumed later. */
  release(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // A pending export would otherwise be lost when the process exits.
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
      this.flushOfflineHtml();
    }
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
    return readChartAt(this.chartDir);
  }

  private get logPath(): string {
    return path.join(this.chartDir, "log.jsonl");
  }

  /**
   * Appends the op, then writes the snapshot. The log is the source of truth —
   * a snapshot lost or corrupted is rebuilt by replaying it.
   */
  private persist(entry: Entry): void {
    // A chart dir deleted underneath a running server used to crash the write.
    fs.mkdirSync(this.chartDir, { recursive: true });
    fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");

    const snapshot = { v: SCHEMA_VERSION, graph: this.graph };
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(tmp, this.statePath);
    this.writeIndex();
    this.scheduleOfflineHtml();
  }

  /**
   * Regenerating the export is the most expensive part of a commit and nothing
   * waits on it, so it is coalesced onto a timer rather than run per mutation.
   * A burst of tool calls then costs one render instead of one each.
   */
  private scheduleOfflineHtml(): void {
    if (this.offlineTimer) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      this.flushOfflineHtml();
    }, OFFLINE_DEBOUNCE_MS);
    this.offlineTimer.unref?.();
  }

  /** Writes the export now; called on shutdown so nothing is left pending. */
  flushOfflineHtml(): void {
    try {
      writeOfflineHtml(this.graph, this.chartDir, this.assetsDir);
    } catch {
      // The export is derived; failing to write it must not break a tool call.
    }
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
    return this.readGraphAt(chartId);
  }

  get(): Graph {
    return this.graph;
  }

  subscribe(fn: (g: Graph) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The only way the graph changes: build an op, apply it, append it. */
  private commit(op: Op): Graph {
    const entry: Entry = {
      seq: this.graph.revision + 1,
      at: Date.now(),
      by: this.author,
      op,
    };
    applyOp(this.graph, entry);
    this.persist(entry);
    this.touchLock();
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
    this.startHeartbeat();

    if (existing) {
      this.graph = existing;
      this.graph.chartId = target;
      this.backfillLog();
      return {
        graph: this.commit({ t: "meta", title, description, direction }),
        resumed: true,
      };
    }

    this.graph = emptyGraph(target, title);
    return { graph: this.commit({ t: "init", title, description, direction }), resumed: false };
  }

  /**
   * A chart written before the log existed has history only in its snapshot.
   * Reconstructing the log from it on first write means a v1 chart keeps its
   * past instead of appearing to start at whatever op comes next.
   */
  private backfillLog(): void {
    if (fs.existsSync(this.logPath)) return;
    try {
      fs.mkdirSync(this.chartDir, { recursive: true });
      const entries = migrateGraphToLog(this.graph);
      fs.writeFileSync(this.logPath, encodeLog(entries), "utf8");
      // Continue numbering past the reconstructed history.
      this.graph.revision = entries.length;
    } catch {
      // Migration is best effort; the snapshot still opens.
    }
  }

  private readGraphAt(chartId: string): Graph | null {
    return readChartAt(path.join(this.root, "charts", chartId));
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

  /**
   * A live holder touches its lock on every commit. A lock that has not been
   * touched in far longer than that belongs to a process that died without
   * releasing it, whatever pid it claims.
   */
  private lockIsFresh(chartId: string): boolean {
    try {
      const age = Date.now() - fs.statSync(this.lockPath(chartId)).mtimeMs;
      return age < LOCK_STALE_MS;
    } catch {
      return false;
    }
  }

  /** Keeps this store's own lock warm so others can tell it is still alive. */
  private touchLock(): void {
    try {
      const now = new Date();
      fs.utimesSync(this.lockPath(this.chartId), now, now);
    } catch {
      // The lock may not exist yet during init; nothing to keep warm.
    }
  }

  /**
   * An idle session is still a live one, so the lock is refreshed on a timer
   * as well as on commit. Unref'd: this must never hold the process open.
   */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.touchLock(), LOCK_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private isLocked(chartId: string): boolean {
    try {
      const raw = fs.readFileSync(this.lockPath(chartId), "utf8").trim();
      // Owner is "<pid>:<boot>:<store>" so sibling stores in one process still
      // see each other's locks; only this exact store may re-adopt its own.
      if (raw === this.owner) return false;
      const [pidPart, bootPart] = raw.split(":");
      const pid = Number(pidPart);
      if (!pid) return false;
      try {
        process.kill(pid, 0); // Throws if no process holds this pid.
      } catch {
        return false;
      }
      // A lock from an earlier boot cannot belong to a live process, whatever
      // pid it claims.
      if (bootPart && bootPart !== bootId()) return false;
      // Same boot: the holder proves liveness by keeping the lock warm. A pid
      // check alone is not enough — pids are recycled, and a recycled pid used
      // to strand the chart, forking it to "-2" and losing the user's history.
      return this.lockIsFresh(chartId);
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

  /** Mutations describe themselves as ops; ops.apply does the work. */
  upsertNode(input: {
    id: string;
    title?: string;
    kind?: NodeKind;
    state?: NodeState;
    bullets?: string[];
    group?: string;
  }): Graph {
    // Only a new node counts against the ceiling; updates are always allowed,
    // or a full chart could not be corrected.
    if (!this.findNode(input.id) && this.graph.nodes.length >= MAX_NODES) {
      throw new Error(
        `This chart already has ${MAX_NODES} nodes, which is past what stays readable. ` +
          `Summarise a finished branch into one result node, or start a new chart with flow_init.`,
      );
    }
    return this.commit({ t: "node.put", ...input });
  }

  removeNode(id: string): Graph {
    return this.commit({ t: "node.del", id });
  }

  addEdge(from: string, to: string, label?: string, dashed = false): Graph {
    this.assertEdgeIsSane(from, to);
    return this.commit({ t: "edge.put", id: randomUUID(), from, to, label, dashed });
  }

  /**
   * A cycle in an exploration chart is almost always a mistake — the tree
   * records what followed what, so a loop says work caused itself. Layout also
   * has to break the cycle arbitrarily to rank nodes, which reads as scrambled.
   */
  private assertEdgeIsSane(from: string, to: string): void {
    const duplicate = this.graph.edges.some((e) => e.from === from && e.to === to);
    if (!duplicate && this.graph.edges.length >= MAX_EDGES) {
      throw new Error(`This chart already has ${MAX_EDGES} edges. Summarise a branch or start a new chart.`);
    }
    if (from === to) {
      throw new Error(
        `Cannot link "${from}" to itself. If the work repeated, add a new node for the second attempt.`,
      );
    }
    const path = this.pathBetween(to, from);
    if (path) {
      throw new Error(
        `Adding ${from} → ${to} would create a cycle: ${path.join(" → ")} → ${to}. ` +
          `An exploration chart reads as a tree, so add a new node for the later attempt instead of looping back.`,
      );
    }
  }

  /** Walks forward from `start`, returning the route to `goal` if one exists. */
  private pathBetween(start: string, goal: string): string[] | null {
    const outgoing = new Map<string, string[]>();
    for (const e of this.graph.edges) {
      const list = outgoing.get(e.from) ?? [];
      list.push(e.to);
      outgoing.set(e.from, list);
    }
    const seen = new Set<string>();
    const walk = (at: string, trail: string[]): string[] | null => {
      if (at === goal) return trail;
      if (seen.has(at)) return null;
      seen.add(at);
      for (const next of outgoing.get(at) ?? []) {
        const found = walk(next, [...trail, next]);
        if (found) return found;
      }
      return null;
    };
    return walk(start, [start]);
  }

  removeEdge(from: string, to: string): Graph {
    return this.commit({ t: "edge.del", from, to });
  }

  setState(id: string, state: NodeState): Graph {
    if (!this.findNode(id)) throw new Error(`No node with id "${id}".`);
    return this.commit({ t: "node.state", id, state });
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
    fs.mkdirSync(this.assetsDir, { recursive: true });
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
      this.commit({ t: "figure.clear", nodeId });
    }
    return this.commit({ t: "figure.add", nodeId, figure: { id: randomUUID(), file, caption, mime } });
  }
}

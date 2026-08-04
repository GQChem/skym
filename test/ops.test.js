import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SCHEMA_VERSION,
  apply,
  decodeLog,
  encodeLog,
  migrateGraphToLog,
  replay,
} from "../dist/ops.js";
import { GraphStore, readChartAt } from "../dist/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skym-ops-"));
const mk = (root, id = "startup") => new GraphStore(root, id, "Untitled");
const entry = (seq, op, at = 1000 + seq) => ({ seq, at, by: "test", op });

test("the graph is the fold of its log", () => {
  const g = replay([
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.put", id: "a", title: "A", kind: "action", state: "done" }),
    entry(3, { t: "node.put", id: "b", title: "B", kind: "result", state: "good" }),
    entry(4, { t: "edge.put", id: "e", from: "a", to: "b", dashed: false }),
  ]);
  assert.equal(g.title, "T");
  assert.deepEqual(g.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(g.edges.length, 1);
  assert.equal(g.revision, 4, "revision tracks the last applied seq");
});

test("replaying a log twice yields the same graph", () => {
  const log = [
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.put", id: "a", bullets: ["one"] }),
    entry(3, { t: "node.state", id: "a", state: "done" }),
    entry(4, { t: "node.put", id: "b" }),
    entry(5, { t: "edge.put", id: "e", from: "a", to: "b", dashed: true }),
    entry(6, { t: "node.del", id: "b" }),
  ];
  assert.deepEqual(replay(log), replay(log), "replay must be deterministic");
});

test("an op naming a missing node is skipped, not fatal", () => {
  const g = replay([
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.state", id: "ghost", state: "done" }),
    entry(3, { t: "figure.add", nodeId: "ghost", figure: { id: "f", file: "x.png", mime: "image/png" } }),
    entry(4, { t: "node.put", id: "real" }),
  ]);
  assert.equal(g.nodes.length, 1, "the good op still applied");
  assert.equal(g.revision, 4);
});

test("deleting a node drops its edges through the log too", () => {
  const g = replay([
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.put", id: "a" }),
    entry(3, { t: "node.put", id: "b" }),
    entry(4, { t: "edge.put", id: "e", from: "a", to: "b", dashed: false }),
    entry(5, { t: "node.del", id: "a" }),
  ]);
  assert.equal(g.edges.length, 0);
});

test("a log round-trips through encode and decode", () => {
  const log = [
    entry(1, { t: "init", title: 'Quotes " and \\ backslash', direction: "LR" }),
    entry(2, { t: "node.put", id: "a", bullets: ["line one", "line two"] }),
  ];
  assert.deepEqual(decodeLog(encodeLog(log)), log);
});

test("a truncated final line costs one op, not the chart", () => {
  const log = [
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.put", id: "a" }),
    entry(3, { t: "node.put", id: "b" }),
  ];
  // Simulate a process killed mid-append.
  const text = encodeLog(log).slice(0, -12);
  const parsed = decodeLog(text);
  assert.ok(parsed.length >= 2, "earlier entries must survive");
  assert.equal(replay(parsed).nodes.length, parsed.length - 1);
});

test("blank lines and junk in the log are ignored", () => {
  const text = ['{"seq":1,"at":1,"by":"t","op":{"t":"init","title":"T","direction":"TD"}}', "", "   ", "not json"].join("\n");
  assert.equal(decodeLog(text).length, 1);
});

test("a v1 chart still opens and keeps its history", () => {
  const root = tmp();
  const dir = path.join(root, "charts", "legacy");
  fs.mkdirSync(dir, { recursive: true });
  // Exactly what the previous version wrote: a bare graph, no version, no log.
  fs.writeFileSync(
    path.join(dir, "graph.json"),
    JSON.stringify({
      chartId: "legacy",
      title: "Legacy chart",
      direction: "TD",
      nodes: [
        { id: "a", title: "Old work", kind: "action", state: "done", bullets: ["kept"], figures: [], createdAt: 1, updatedAt: 1 },
      ],
      edges: [],
      events: [],
      revision: 7,
      createdAt: 1,
      updatedAt: 1,
    }),
    "utf8",
  );

  const g = readChartAt(dir);
  assert.ok(g, "a v1 chart must still be readable");
  assert.equal(g.title, "Legacy chart");
  assert.deepEqual(g.nodes.map((n) => n.id), ["a"]);
  assert.deepEqual(g.nodes[0].bullets, ["kept"]);
});

test("resuming a v1 chart backfills its log and keeps the nodes", () => {
  const root = tmp();
  const dir = path.join(root, "charts", "legacy-chart");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "graph.json"),
    JSON.stringify({
      chartId: "legacy-chart",
      title: "Legacy chart",
      direction: "TD",
      nodes: [
        { id: "a", title: "First", kind: "action", state: "done", bullets: [], figures: [], createdAt: 1, updatedAt: 1 },
        { id: "b", title: "Second", kind: "result", state: "good", bullets: [], figures: [], createdAt: 1, updatedAt: 1 },
      ],
      edges: [{ id: "e", from: "a", to: "b", dashed: false }],
      events: [],
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
    }),
    "utf8",
  );

  const s = mk(root);
  const { resumed } = s.init("Legacy chart");
  assert.equal(resumed, true, "must adopt the v1 chart");
  assert.deepEqual(s.get().nodes.map((n) => n.id), ["a", "b"]);

  // The log now exists and replays back to the same content.
  const log = decodeLog(fs.readFileSync(path.join(dir, "log.jsonl"), "utf8"));
  assert.ok(log.length >= 4, "init + two nodes + one edge");
  const rebuilt = replay(log);
  assert.deepEqual(rebuilt.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(rebuilt.edges.length, 1);
  s.release();
});

test("migration preserves figures", () => {
  const log = migrateGraphToLog({
    chartId: "c",
    title: "T",
    direction: "TD",
    nodes: [
      {
        id: "r",
        title: "Result",
        kind: "result",
        state: "good",
        bullets: [],
        figures: [{ id: "f", file: "plot.svg", mime: "image/svg+xml", caption: "A plot" }],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    edges: [],
    events: [],
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
  });
  const g = replay(log);
  assert.equal(g.nodes[0].figures.length, 1);
  assert.equal(g.nodes[0].figures[0].caption, "A plot");
});

test("the snapshot is versioned and the log is appended per mutation", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Versioned");
  s.upsertNode({ id: "a", title: "A" });
  s.setState("a", "done");

  const raw = JSON.parse(fs.readFileSync(path.join(s.chartDir, "graph.json"), "utf8"));
  assert.equal(raw.v, SCHEMA_VERSION);
  assert.equal(raw.graph.title, "Versioned");

  const log = decodeLog(fs.readFileSync(path.join(s.chartDir, "log.jsonl"), "utf8"));
  assert.deepEqual(log.map((e) => e.op.t), ["init", "node.put", "node.state"]);
  assert.deepEqual(log.map((e) => e.seq), [1, 2, 3]);
  assert.ok(log.every((e) => e.by === "local"), "local edits are attributed to local");
  s.release();
});

test("the log recovers a chart whose snapshot was lost", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Crashy");
  s.upsertNode({ id: "a", title: "Survives" });
  s.upsertNode({ id: "b", title: "Also survives" });
  const dir = s.chartDir;
  s.release();

  // A crash between the append and the snapshot write.
  fs.rmSync(path.join(dir, "graph.json"));

  const recovered = readChartAt(dir);
  assert.ok(recovered, "the log alone must be enough");
  assert.deepEqual(recovered.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(recovered.title, "Crashy");
});

test("a stale snapshot loses to a newer log", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Stale");
  s.upsertNode({ id: "a" });
  const dir = s.chartDir;
  const snapshot = JSON.parse(fs.readFileSync(path.join(dir, "graph.json"), "utf8"));
  s.upsertNode({ id: "b" });
  s.release();

  // Roll the snapshot back, as a partial write would.
  fs.writeFileSync(path.join(dir, "graph.json"), JSON.stringify(snapshot), "utf8");

  const recovered = readChartAt(dir);
  assert.deepEqual(recovered.nodes.map((n) => n.id), ["a", "b"], "the log is the source of truth");
});

test("a chart directory deleted underneath a running store does not crash it", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Fragile");
  fs.rmSync(s.chartDir, { recursive: true, force: true });
  assert.doesNotThrow(() => s.upsertNode({ id: "a", title: "After deletion" }));
  assert.equal(s.get().nodes.length, 1);
  s.release();
});

test("events still distinguish an add from an update", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Events");
  s.upsertNode({ id: "a", title: "One" });
  s.upsertNode({ id: "a", title: "Two" });
  const kinds = s.get().events.map((e) => e.kind);
  assert.ok(kinds.includes("node.add"));
  assert.ok(kinds.includes("node.update"));
  s.release();
});

// --- op identity: the property a remote relay depends on ---

const idEntry = (id, seq, op, at = 1000 + seq) => ({ id, seq, at, by: "test", op });

test("an entry delivered twice is applied once", () => {
  const log = [
    idEntry("i1", 1, { t: "init", title: "T", direction: "TD" }),
    idEntry("i2", 2, { t: "node.put", id: "a", title: "A", kind: "result" }),
    idEntry("i3", 3, { t: "figure.add", nodeId: "a", figure: { id: "f", file: "f.png", mime: "image/png" } }),
  ];
  const once = replay(log);
  const twice = replay([...log, ...log]);
  assert.deepEqual(twice, once, "redelivery must not change the graph");
  assert.equal(twice.nodes[0].figures.length, 1, "figure.add must not duplicate on retry");
});

test("figures still duplicate without an id, which is why ids exist", () => {
  // Guards the fix: the un-idded path is the old behaviour, kept for old logs.
  const fig = { t: "figure.add", nodeId: "a", figure: { id: "f", file: "f.png", mime: "image/png" } };
  const g = replay([
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.put", id: "a", kind: "result" }),
    entry(3, fig),
    entry(4, fig),
  ]);
  assert.equal(g.nodes[0].figures.length, 2);
});

test("a log written before ids replays unchanged", () => {
  const log = [
    entry(1, { t: "init", title: "T", direction: "TD" }),
    entry(2, { t: "node.put", id: "a", title: "A" }),
  ];
  const g = replay(log);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.revision, 2);
});

test("ids survive the log encoding round trip", () => {
  const log = [idEntry("i1", 1, { t: "init", title: "T", direction: "TD" })];
  const back = decodeLog(encodeLog(log));
  assert.equal(back[0].id, "i1");
});

test("the store stamps every op with a unique id", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Ids");
  s.upsertNode({ id: "a", title: "A", kind: "action" });
  s.upsertNode({ id: "b", title: "B", kind: "action" });
  s.release();
  const log = decodeLog(fs.readFileSync(path.join(root, "charts", "ids", "log.jsonl"), "utf8"));
  const ids = log.map((e) => e.id);
  assert.ok(ids.every(Boolean), "every entry should carry an id");
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
});

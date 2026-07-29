import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore } from "../dist/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skym-store-"));
const mk = (root, id = "startup") => new GraphStore(root, id, "Untitled");

test("does not create a directory until init names the chart", () => {
  const root = tmp();
  mk(root);
  assert.equal(fs.existsSync(path.join(root, "charts")), false, "no dir before init");
});

test("init slugs the directory from the title", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Fix the Auth Redirect!");
  assert.equal(s.chartId, "fix-the-auth-redirect");
  assert.ok(fs.existsSync(path.join(root, "charts", "fix-the-auth-redirect", "graph.json")));
});

test("same title resumes the existing chart", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Shared Title");
  a.upsertNode({ id: "n1", title: "First" });
  a.release();

  const b = mk(root);
  const { resumed } = b.init("Shared Title");
  assert.equal(resumed, true);
  assert.equal(b.chartId, "shared-title");
  assert.deepEqual(b.get().nodes.map((n) => n.id), ["n1"]);
});

test("fresh:true never adopts an existing chart", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Shared Title");
  a.upsertNode({ id: "n1" });
  a.release();

  const b = mk(root);
  const { resumed } = b.init("Shared Title", undefined, "TD", true);
  assert.equal(resumed, false);
  assert.equal(b.chartId, "shared-title-2");
  assert.equal(b.get().nodes.length, 0);
});

test("a live lock forces the next suffix", () => {
  const root = tmp();
  const a = mk(root); // holds the lock, never released
  a.init("Parallel");
  const b = mk(root);
  b.init("Parallel");
  assert.notEqual(a.chartId, b.chartId);
  assert.equal(b.chartId, "parallel-2");
});

test("a dead lock is swept and the chart resumes", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Recoverable");
  a.upsertNode({ id: "keep" });
  // Simulate a killed process: a lock file naming a pid that cannot exist.
  fs.writeFileSync(path.join(root, "charts", "recoverable", ".lock"), "999999999");

  const b = mk(root);
  const { resumed } = b.init("Recoverable");
  assert.equal(resumed, true);
  assert.equal(b.chartId, "recoverable");
  assert.deepEqual(b.get().nodes.map((n) => n.id), ["keep"]);
});

test("empty title still yields a usable directory", () => {
  const root = tmp();
  const s = mk(root);
  s.init("!!!");
  assert.equal(s.chartId, "chart");
});

test("revision increments and events are recorded", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Rev Test");
  const before = s.get().revision;
  s.upsertNode({ id: "a" });
  s.addEdge("a", "a");
  assert.equal(s.get().revision, before + 2);
  assert.ok(s.get().events.some((e) => e.kind === "node.add"));
});

test("upsert updates in place rather than duplicating", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Upsert");
  s.upsertNode({ id: "a", title: "One", bullets: ["x"] });
  s.upsertNode({ id: "a", title: "Two" });
  assert.equal(s.get().nodes.length, 1);
  assert.equal(s.get().nodes[0].title, "Two");
  assert.deepEqual(s.get().nodes[0].bullets, ["x"], "unset fields are preserved");
});

test("removing a node drops its edges", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Edges");
  s.upsertNode({ id: "a" });
  s.upsertNode({ id: "b" });
  s.addEdge("a", "b");
  s.removeNode("a");
  assert.equal(s.get().edges.length, 0);
});

test("duplicate edges collapse", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Dupes");
  s.upsertNode({ id: "a" });
  s.upsertNode({ id: "b" });
  s.addEdge("a", "b", "label");
  s.addEdge("a", "b", "label");
  assert.equal(s.get().edges.length, 1);
});

test("setState rejects an unknown node", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Missing");
  assert.throws(() => s.setState("nope", "done"), /No node with id/);
});

test("state survives a reload from disk", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Persisted");
  a.upsertNode({ id: "a", title: "Kept", bullets: ["one", "two"] });
  a.release();

  const b = mk(root);
  b.init("Persisted");
  const n = b.get().nodes[0];
  assert.equal(n.title, "Kept");
  assert.deepEqual(n.bullets, ["one", "two"]);
});

test("index lists every chart in the project", () => {
  const root = tmp();
  const a = mk(root);
  a.init("First Chart");
  a.release();
  const b = mk(root);
  b.init("Second Chart");

  const titles = b.listCharts().map((c) => c.title).sort();
  assert.deepEqual(titles, ["First Chart", "Second Chart"]);
  assert.equal(b.listCharts().find((c) => c.active).title, "Second Chart");
});

test("readChart reaches another chat's chart", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Other");
  a.upsertNode({ id: "x" });
  a.release();

  const b = mk(root);
  b.init("Mine");
  assert.equal(b.readChart("other").nodes.length, 1);
  assert.equal(b.readChart("does-not-exist"), null);
});

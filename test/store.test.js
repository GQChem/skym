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
  s.flushOfflineHtml();
  assert.equal(s.chartId, "fix-the-auth-redirect");
  assert.ok(fs.existsSync(path.join(root, "charts", "fix-the-auth-redirect", "graph.json")));
  assert.ok(fs.existsSync(path.join(root, "charts", "fix-the-auth-redirect", "flow.html")));
});

test("offline HTML is self-contained and refreshed with graph and figures", () => {
  const root = tmp();
  const s = mk(root);
  s.init('Offline </script> "Chart"');
  s.upsertNode({ id: "result", title: "Portable result", kind: "result", state: "good", bullets: ["Stored inline"] });
  s.attachFigure("result", Buffer.from("image bytes"), "image/png", "Evidence");

  s.flushOfflineHtml();
  const file = path.join(s.chartDir, "flow.html");
  const html = fs.readFileSync(file, "utf8");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /offline snapshot/);
  assert.match(html, /Portable result/);
  assert.match(html, /data:image\/png;base64,aW1hZ2UgYnl0ZXM=/);
  assert.doesNotMatch(html, /src=["']https?:/);
  assert.match(html, /Offline &lt;\/script&gt; &quot;Chart&quot;/);
  assert.match(html, /rev 3 · offline snapshot/);
  // Both themes ship pre-rendered, so the file needs no layout engine at runtime.
  assert.match(html, /id="skym-svg-light"/);
  assert.match(html, /id="skym-svg-dark"/);
  assert.doesNotMatch(html, /mermaid/i);
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
  s.upsertNode({ id: "b" });
  s.addEdge("a", "b");
  assert.equal(s.get().revision, before + 3);
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

test("a lock whose pid was recycled does not strand the chart", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Recycled pid");
  a.upsertNode({ id: "n", title: "Existing work" });
  const dir = a.chartDir;

  // The holder dies without releasing, and the OS later hands its pid to an
  // unrelated live process — here, this very test runner. The giveaway is that
  // nothing has kept the lock warm since.
  const lock = path.join(dir, ".lock");
  const stolen = fs.readFileSync(lock, "utf8").split(":");
  fs.writeFileSync(lock, `${process.pid}:${stolen[1]}:someone-else`, "utf8");
  const cold = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, cold, cold);

  const b = mk(root);
  const out = b.init("Recycled pid");
  assert.equal(out.resumed, true, "must resume rather than fork to -2");
  assert.equal(b.chartId, a.chartId);
  assert.equal(out.graph.nodes.length, 1);
});

test("a lock from an earlier boot is never treated as live", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Old boot");
  a.upsertNode({ id: "n", title: "Work" });

  const lock = path.join(a.chartDir, ".lock");
  // Same pid, but a boot id from before the machine last started.
  fs.writeFileSync(lock, `${process.pid}:0:previous-boot`, "utf8");

  const b = mk(root);
  assert.equal(b.init("Old boot").resumed, true);
  assert.equal(b.chartId, a.chartId);
});

test("a live lock still blocks a second chat", () => {
  const root = tmp();
  const a = mk(root);
  a.init("Concurrent");
  a.upsertNode({ id: "n", title: "Held" });

  // a is still running and keeps its lock warm, so b must not join it.
  const b = mk(root);
  b.init("Concurrent");
  assert.notEqual(b.chartId, a.chartId, "two chats must not share one chart");
});

test("a self-edge is rejected with a usable suggestion", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Self");
  s.upsertNode({ id: "a" });
  assert.throws(() => s.addEdge("a", "a"), /itself.*new node/s);
  s.release();
});

test("an edge that would close a cycle is rejected and names the path", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Cycles");
  for (const id of ["a", "b", "c"]) s.upsertNode({ id });
  s.addEdge("a", "b");
  s.addEdge("b", "c");

  assert.throws(() => s.addEdge("c", "a"), /cycle: a → b → c → a/);
  // The chart is unchanged: a rejected edge must not half-apply.
  assert.equal(s.get().edges.length, 2);
  s.release();
});

test("a diamond is not a cycle", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Diamond");
  for (const id of ["a", "b", "c", "d"]) s.upsertNode({ id });
  s.addEdge("a", "b");
  s.addEdge("a", "c");
  s.addEdge("b", "d");
  assert.doesNotThrow(() => s.addEdge("c", "d"), "two routes to one node is normal");
  assert.equal(s.get().edges.length, 4);
  s.release();
});

test("re-adding an existing edge still works", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Redundant");
  s.upsertNode({ id: "a" });
  s.upsertNode({ id: "b" });
  s.addEdge("a", "b");
  assert.doesNotThrow(() => s.addEdge("a", "b", undefined, true), "updating an edge is not a cycle");
  assert.equal(s.get().edges.length, 1);
  s.release();
});

test("the node ceiling rejects new nodes but still allows updates", () => {
  const root = tmp();
  const s = mk(root);
  s.init("Full");
  for (let i = 0; i < 300; i++) s.upsertNode({ id: `n${i}` });

  assert.throws(() => s.upsertNode({ id: "one-too-many" }), /Summarise|new chart/);
  // A full chart must still be correctable.
  assert.doesNotThrow(() => s.upsertNode({ id: "n0", title: "Renamed" }));
  assert.equal(s.get().nodes.find((n) => n.id === "n0").title, "Renamed");
  s.release();
});

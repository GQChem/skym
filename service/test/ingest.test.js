import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { makePool, migrate, tx } from "../dist/service/src/db.js";
import { buildGraph, ingest } from "../dist/service/src/ingest.js";

/**
 * Integration tests against a real Postgres — the ingest guarantees (server
 * assigns seq, retries are idempotent, validation reruns) are all about
 * concurrency and constraints, which a fake would not exercise.
 *
 * Point TEST_DATABASE_URL at a throwaway database. These tests write users,
 * projects, charts and ops, and never clean up, so they must not run against
 * anything that matters. DATABASE_URL is deliberately NOT honoured: it is the
 * production connection wherever the service runs.
 *
 * Without one the suite skips rather than passing vacuously, so a green run
 * never implies coverage it does not have.
 */
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set — skipping ingest integration tests";

let pool;
let userId;

const entry = (op, opts = {}) => ({
  id: opts.id ?? randomUUID(),
  seq: opts.seq ?? 1,
  at: opts.at ?? Date.now(),
  by: opts.by ?? "test",
  op,
});

async function freshChart() {
  return tx(pool, async (c) => {
    const p = await c.query(
      "INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id",
      [`proj-${randomUUID().slice(0, 8)}`, userId],
    );
    const chart = await c.query(
      "INSERT INTO charts (project_id, slug, title) VALUES ($1, $2, $3) RETURNING id",
      [p.rows[0].id, `chart-${randomUUID().slice(0, 8)}`, "Test chart"],
    );
    return chart.rows[0].id;
  });
}

test.before(async () => {
  if (skip) return;
  pool = makePool(url);
  await migrate(pool);
  const u = await pool.query(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`test-${randomUUID()}@example.test`],
  );
  userId = u.rows[0].id;
});

test.after(async () => {
  if (pool) await pool.end();
});

test("the server assigns seq, ignoring what the client proposed", { skip }, async () => {
  const chartId = await freshChart();
  // Both clients think they are writing seq 1 — the collision the local store
  // could not detect, because seq came from its own revision counter.
  const a = entry({ t: "init", title: "A", direction: "TD" }, { seq: 1 });
  const b = entry({ t: "node.put", id: "n1", title: "N1", kind: "action" }, { seq: 1 });

  const first = await ingest(pool, chartId, [a], userId);
  const second = await ingest(pool, chartId, [b], userId);

  assert.equal(first.accepted[0].seq, 1);
  assert.equal(second.accepted[0].seq, 2, "the second writer must be renumbered, not collide");
  assert.equal(second.revision, 2);
});

test("re-posting a batch changes nothing", { skip }, async () => {
  const chartId = await freshChart();
  const batch = [
    entry({ t: "init", title: "T", direction: "TD" }),
    entry({ t: "node.put", id: "a", title: "A", kind: "result" }),
    entry({ t: "figure.add", nodeId: "a", figure: { id: "f1", file: "f.png", mime: "image/png" } }),
  ];

  const first = await ingest(pool, chartId, batch, userId);
  const again = await ingest(pool, chartId, batch, userId);

  assert.equal(first.accepted.length, 3);
  assert.equal(again.accepted.length, 0, "nothing new on redelivery");
  assert.deepEqual(again.duplicates.length, 3);
  assert.equal(again.revision, first.revision, "revision must not advance");

  const graph = await tx(pool, (c) => buildGraph(c, chartId));
  assert.equal(graph.nodes[0].figures.length, 1, "the figure must not be duplicated");
});

test("an op with no id is refused", { skip }, async () => {
  const chartId = await freshChart();
  const bad = { seq: 1, at: Date.now(), by: "test", op: { t: "init", title: "X", direction: "TD" } };
  const r = await ingest(pool, chartId, [bad], userId);
  assert.equal(r.accepted.length, 0);
  assert.match(r.rejected[0].reason, /no id/);
});

test("validation reruns on ops the server did not author", { skip }, async () => {
  const chartId = await freshChart();
  await ingest(pool, chartId, [
    entry({ t: "init", title: "T", direction: "TD" }),
    entry({ t: "node.put", id: "a", kind: "action" }),
    entry({ t: "node.put", id: "b", kind: "action" }),
    entry({ t: "edge.put", id: "e1", from: "a", to: "b", dashed: false }),
  ], userId);

  // A hostile or buggy client sending an edge that closes a cycle.
  const r = await ingest(pool, chartId, [
    entry({ t: "edge.put", id: "e2", from: "b", to: "a", dashed: false }),
  ], userId);

  assert.equal(r.accepted.length, 0, "the cycle must be refused server-side");
  assert.match(r.rejected[0].reason, /cycle/i);
});

test("one bad op does not sink the rest of the batch", { skip }, async () => {
  const chartId = await freshChart();
  const r = await ingest(pool, chartId, [
    entry({ t: "init", title: "T", direction: "TD" }),
    entry({ t: "node.put", id: "a", kind: "action", bullets: ["x".repeat(300)] }),
    entry({ t: "node.put", id: "b", kind: "action", title: "B" }),
  ], userId);

  assert.equal(r.accepted.length, 2);
  assert.equal(r.rejected.length, 1);
  const graph = await tx(pool, (c) => buildGraph(c, chartId));
  assert.deepEqual(graph.nodes.map((n) => n.id), ["b"]);
});

test("the stored log rebuilds the same graph", { skip }, async () => {
  const chartId = await freshChart();
  await ingest(pool, chartId, [
    entry({ t: "init", title: "Rebuilt", direction: "LR" }),
    entry({ t: "node.put", id: "a", title: "A", kind: "action", state: "done" }),
    entry({ t: "node.put", id: "b", title: "B", kind: "result", state: "good" }),
    entry({ t: "edge.put", id: "e", from: "a", to: "b", dashed: false }),
  ], userId);

  const graph = await tx(pool, (c) => buildGraph(c, chartId));
  assert.equal(graph.title, "Rebuilt");
  assert.equal(graph.direction, "LR");
  assert.deepEqual(graph.nodes.map((n) => n.id), ["a", "b"]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.revision, 4);
});

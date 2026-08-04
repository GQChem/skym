import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EDGES,
  MAX_NODES,
  ValidationError,
  checkBullets,
  checkEdge,
  checkNodeCeiling,
  checkState,
  pathBetween,
} from "../dist/validate.js";
import { DEFAULT_VOCAB } from "../dist/vocab.js";

// These run without a GraphStore on purpose: the service replays ops it did not
// author and has to enforce the same rules from a bare graph.
const graph = (nodes = [], edges = []) => ({
  chartId: "t",
  title: "T",
  direction: "TD",
  nodes: nodes.map((id) => ({ id, title: id, kind: "action", state: "planned", bullets: [], figures: [] })),
  edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to, dashed: false })),
  events: [],
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
});

test("a self-edge is refused", () => {
  assert.throws(() => checkEdge(graph(["a"]), "a", "a"), ValidationError);
});

test("an edge closing a cycle is refused and names the path", () => {
  const g = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  assert.throws(
    () => checkEdge(g, "c", "a"),
    (err) => err instanceof ValidationError && /a → b → c/.test(err.message),
  );
});

test("a plain forward edge is allowed", () => {
  assert.doesNotThrow(() => checkEdge(graph(["a", "b"], [["a", "b"]]), "b", "c"));
});

test("re-adding an existing edge is allowed past the ceiling", () => {
  const edges = Array.from({ length: MAX_EDGES }, (_, i) => [`n${i}`, `n${i + 1}`]);
  const g = graph([], edges);
  // A duplicate does not grow the chart, so it must not trip the ceiling.
  assert.doesNotThrow(() => checkEdge(g, "n0", "n1"));
  assert.throws(() => checkEdge(g, "zzz", "yyy"), ValidationError);
});

test("the node ceiling only applies to new nodes", () => {
  const g = graph(Array.from({ length: MAX_NODES }, (_, i) => `n${i}`));
  assert.throws(() => checkNodeCeiling(g, true), ValidationError);
  assert.doesNotThrow(() => checkNodeCeiling(g, false), "updating an existing node must still work");
});

test("prose in a bullet is refused, a clause is not", () => {
  assert.doesNotThrow(() => checkBullets(["Swap cache to Redis", "TTL 60s"]));
  assert.throws(
    () => checkBullets(["This is one sentence. And here is another. And a third one follows."]),
    ValidationError,
  );
  assert.throws(() => checkBullets(["x".repeat(201)]), ValidationError);
});

test("a state must belong to its kind", () => {
  assert.equal(checkState(DEFAULT_VOCAB, "action", "done"), "done");
  assert.equal(checkState(DEFAULT_VOCAB, "action", undefined), undefined);
  assert.throws(() => checkState(DEFAULT_VOCAB, "action", "good"), ValidationError);
  assert.throws(() => checkState(DEFAULT_VOCAB, "nosuchkind", "done"), ValidationError);
});

test("pathBetween finds a route or reports none", () => {
  const g = graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
  assert.deepEqual(pathBetween(g, "a", "c"), ["a", "b", "c"]);
  assert.equal(pathBetween(g, "c", "a"), null);
});

test("a cyclic graph does not hang the walk", () => {
  // Charts should never contain one, but a replayed log from elsewhere might.
  const g = graph(["a", "b"], [["a", "b"], ["b", "a"]]);
  assert.doesNotThrow(() => pathBetween(g, "a", "zzz"));
});

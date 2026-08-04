import type { Graph } from "./store.js";
import type { Vocabulary } from "./vocab.js";
import { statesFor } from "./vocab.js";

/**
 * The rules that keep a chart readable, as pure functions over a graph.
 *
 * These used to live inside GraphStore and the MCP tool handlers, above the op
 * layer — so a server replaying a client's ops enforced none of them. Both
 * sides call these, because a relay must not trust what it is sent.
 */

export const MAX_NODES = 300;
export const MAX_EDGES = 900;
export const MAX_BULLET_CHARS = 200;

export class ValidationError extends Error {}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

export function checkNodeCeiling(graph: Graph, isNew: boolean): void {
  if (isNew && graph.nodes.length >= MAX_NODES) {
    fail(
      `This chart already has ${MAX_NODES} nodes, which is past what stays readable. ` +
        `Summarise a finished branch into one result node, or start a new chart with flow_init.`,
    );
  }
}

/** Free-form prose in a bullet defeats the convention, so reject it early. */
export function checkBullets(bullets: string[] | undefined): void {
  if (!bullets) return;
  for (const b of bullets) {
    if (b.length > MAX_BULLET_CHARS) {
      fail(`Bullet too long (${b.length} chars, max ${MAX_BULLET_CHARS}): "${b.slice(0, 60)}…"`);
    }
    if (b.split(/[.!?]\s+[A-Z]/).length > 2) {
      fail(`Bullet reads as prose, not a bullet: "${b.slice(0, 70)}…". Split it into separate short bullets.`);
    }
  }
}

/** A state must belong to its node's kind, under the vocabulary in force. */
export function checkState(vocab: Vocabulary, kind: string, state: string | undefined): string | undefined {
  if (state === undefined) return undefined;
  const allowed = statesFor(vocab)[kind];
  if (!allowed) return fail(`Unknown node kind "${kind}".`);
  if (!allowed.includes(state)) {
    fail(`State "${state}" is not valid for a ${kind} node. Use one of: ${allowed.join(", ")}.`);
  }
  return state;
}

/** Walks forward from `start`, returning the route to `goal` if one exists. */
export function pathBetween(graph: Graph, start: string, goal: string): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const e of graph.edges) {
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

/**
 * A cycle in an exploration chart is almost always a mistake — the tree records
 * what followed what, so a loop says work caused itself. Layout also has to
 * break the cycle arbitrarily to rank nodes, which reads as scrambled.
 */
export function checkEdge(graph: Graph, from: string, to: string): void {
  const duplicate = graph.edges.some((e) => e.from === from && e.to === to);
  if (!duplicate && graph.edges.length >= MAX_EDGES) {
    fail(`This chart already has ${MAX_EDGES} edges. Summarise a branch or start a new chart.`);
  }
  if (from === to) {
    fail(`Cannot link "${from}" to itself. If the work repeated, add a new node for the second attempt.`);
  }
  const route = pathBetween(graph, to, from);
  if (route) {
    fail(
      `Adding ${from} → ${to} would create a cycle: ${route.join(" → ")} → ${to}. ` +
        `An exploration chart reads as a tree, so add a new node for the later attempt instead of looping back.`,
    );
  }
}

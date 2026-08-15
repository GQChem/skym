import type { PoolClient } from "pg";
import type { Pool } from "./db.js";
import { tx } from "./db.js";
import { apply, emptyGraph, type Entry } from "../../src/ops.js";
import type { Graph } from "../../src/store.js";
import { checkBullets, checkEdge, checkNodeCeiling, ValidationError } from "../../src/validate.js";

export interface IngestResult {
  /** Ops actually written, in the order the server assigned. */
  accepted: Array<{ opId: string; seq: number }>;
  /** Already present — a retried batch, not an error. */
  duplicates: string[];
  rejected: Array<{ opId: string; reason: string }>;
  revision: number;
}

/**
 * Accepts a batch of ops for a chart.
 *
 * Three things the local store never had to do:
 *  - assign `seq` here, because two agents on one chart both propose the same
 *    next number and the client's value is only a hint;
 *  - skip ops already stored, keyed on the client-minted id, so a retried
 *    delivery is harmless (figure.add appends, so re-applying duplicates it);
 *  - re-run validation, because a relay must not trust what it is sent.
 *
 * The whole batch runs in one transaction with the chart row locked, so
 * concurrent writers serialise rather than interleaving seq numbers.
 */
export async function ingest(pool: Pool, chartId: string, entries: Entry[], author: string): Promise<IngestResult> {
  return tx(pool, async (c) => {
    const chart = await c.query<{ revision: string }>(
      "SELECT revision FROM charts WHERE id = $1 FOR UPDATE",
      [chartId],
    );
    if (chart.rowCount === 0) throw new Error(`no such chart ${chartId}`);

    let revision = Number(chart.rows[0]!.revision);
    const graph = await buildGraph(c, chartId);

    const accepted: IngestResult["accepted"] = [];
    const duplicates: string[] = [];
    const rejected: IngestResult["rejected"] = [];

    for (const entry of entries) {
      const opId = entry.id;
      if (!opId) {
        rejected.push({ opId: "(missing)", reason: "entry has no id; the relay needs one to be idempotent" });
        continue;
      }

      const seen = await c.query("SELECT 1 FROM ops WHERE chart_id = $1 AND op_id = $2", [chartId, opId]);
      if (seen.rowCount) {
        duplicates.push(opId);
        continue;
      }

      try {
        validate(graph, entry);
      } catch (err) {
        // One bad op must not sink the batch: record it and keep the rest.
        rejected.push({ opId, reason: (err as Error).message });
        continue;
      }

      revision += 1;
      const stamped: Entry = { ...entry, seq: revision };
      await c.query(
        `INSERT INTO ops (chart_id, seq, op_id, at, author, op) VALUES ($1, $2, $3, $4, $5, $6)`,
        [chartId, revision, opId, entry.at ?? Date.now(), entry.by ?? author, JSON.stringify(entry.op)],
      );
      apply(graph, stamped);
      accepted.push({ opId, seq: revision });
    }

    if (accepted.length) {
      await c.query("UPDATE charts SET revision = $1, updated_at = now(), title = $2 WHERE id = $3", [
        revision,
        graph.title,
        chartId,
      ]);
    }

    return { accepted, duplicates, rejected, revision };
  });
}

/** Folds the stored log. Charts are capped, so this stays small enough to redo. */
export async function buildGraph(c: PoolClient, chartId: string): Promise<Graph> {
  const meta = await c.query<{ slug: string; title: string }>(
    "SELECT slug, title FROM charts WHERE id = $1",
    [chartId],
  );
  const row = meta.rows[0];
  const graph = emptyGraph(row?.slug ?? chartId, row?.title ?? "Untitled");

  const ops = await c.query<{ seq: string; at: string; author: string; op: unknown; op_id: string }>(
    "SELECT seq, at, author, op, op_id FROM ops WHERE chart_id = $1 ORDER BY seq ASC",
    [chartId],
  );
  for (const r of ops.rows) {
    apply(graph, {
      id: r.op_id,
      seq: Number(r.seq),
      at: Number(r.at),
      by: r.author,
      op: r.op as Entry["op"],
    });
  }
  return graph;
}

/** The same rules the MCP server enforces, re-run on ops we did not author. */
function validate(graph: Graph, entry: Entry): void {
  const op = entry.op;
  switch (op.t) {
    case "node.put": {
      checkBullets(op.bullets);
      if (op.badge !== undefined && op.badge !== null && (typeof op.badge !== "string" || op.badge.length > 24)) {
        throw new ValidationError("node badge must be at most 24 characters");
      }
      if (op.provenance !== undefined && op.provenance !== null && typeof op.provenance !== "object") {
        throw new ValidationError("node provenance must be an object");
      }
      if (op.derivedBadge !== undefined && op.derivedBadge !== null && typeof op.derivedBadge !== "object") {
        throw new ValidationError("node derived badge must be an object");
      }
      checkNodeCeiling(graph, !graph.nodes.some((n) => n.id === op.id));
      break;
    }
    case "edge.put": {
      checkEdge(graph, op.from, op.to);
      break;
    }
    case "node.state": {
      if (!graph.nodes.some((n) => n.id === op.id)) {
        throw new ValidationError(`no node "${op.id}" to set state on`);
      }
      break;
    }
    case "file.add": {
      if (!graph.nodes.some((n) => n.id === op.nodeId)) throw new ValidationError(`no node "${op.nodeId}" for file`);
      const a = op.artifact;
      if (!a || !a.id || !a.file || !a.name || !a.mime || !Number.isFinite(a.bytes) || a.bytes < 0) {
        throw new ValidationError("invalid file metadata");
      }
      if (a.file !== a.file.split(/[/\\]/).pop() || a.file.length > 240 || a.name.length > 240) {
        throw new ValidationError("invalid file name");
      }
      break;
    }
    default:
      // init/meta/deletes/figures carry nothing the ceiling or the tree cares about.
      break;
  }
}

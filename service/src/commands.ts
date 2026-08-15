import type { Pool } from "./db.js";
import { tx } from "./db.js";
import { recordAudit } from "./audit.js";

export type CommandStatus = "queued" | "claimed" | "running" | "done" | "failed" | "cancelled";

export interface AgentCommand {
  id: string;
  chartId: string;
  nodeId: string | null;
  verb: string;
  body: string | null;
  status: CommandStatus;
  createdAt: Date;
  leaseExpiresAt: Date | null;
}

const fields = `id, chart_id AS "chartId", node_id AS "nodeId", verb, body, status,
                created_at AS "createdAt", lease_expires_at AS "leaseExpiresAt"`;

export async function createCommand(
  pool: Pool,
  input: { chartId: string; nodeId?: string; verb?: string; body?: string; userId: string; idempotencyKey?: string },
): Promise<AgentCommand> {
  return tx(pool, async (client) => {
    const r = await client.query<AgentCommand & { inserted: boolean }>(
      `INSERT INTO commands (chart_id, node_id, verb, body, created_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (created_by, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING ${fields}, (xmax = 0) AS inserted`,
      [input.chartId, input.nodeId ?? null, input.verb ?? "work_on", input.body ?? null, input.userId, input.idempotencyKey ?? null],
    );
    const command = r.rows[0]!;
    if (command.inserted) {
      await recordAudit(client, {
        actorId: input.userId, event: "command.created", targetType: "command", targetId: command.id,
        metadata: { chartId: input.chartId, nodeId: input.nodeId ?? null, verb: input.verb ?? "work_on" },
      });
    }
    return command;
  });
}

export async function claimCommand(pool: Pool, chartId: string, agentId: string): Promise<AgentCommand | null> {
  return tx(pool, async (client) => {
    const r = await client.query<AgentCommand>(
      `WITH candidate AS (
         SELECT id FROM commands
          WHERE chart_id = $1
            AND (status = 'queued' OR (status IN ('claimed', 'running') AND lease_expires_at <= now()))
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE commands c
          SET status = 'claimed', claimed_by = $2, claimed_at = now(),
              lease_expires_at = now() + interval '30 minutes', updated_at = now()
         FROM candidate
        WHERE c.id = candidate.id
       RETURNING c.id, c.chart_id AS "chartId", c.node_id AS "nodeId", c.verb, c.body, c.status,
                 c.created_at AS "createdAt", c.lease_expires_at AS "leaseExpiresAt"`,
      [chartId, agentId],
    );
    return r.rows[0] ?? null;
  });
}

export async function updateCommand(
  pool: Pool,
  commandId: string,
  agentId: string,
  status: "running" | "done" | "failed",
  result?: string,
): Promise<AgentCommand | null> {
  const terminal = status === "done" || status === "failed";
  const r = await pool.query<AgentCommand>(
    `UPDATE commands SET status = $3, result = $4,
       lease_expires_at = CASE WHEN $5 THEN NULL ELSE now() + interval '30 minutes' END,
       finished_at = CASE WHEN $5 THEN now() ELSE finished_at END, updated_at = now()
     WHERE id = $1 AND claimed_by = $2 AND status IN ('claimed', 'running')
     RETURNING ${fields}`,
    [commandId, agentId, status, result ?? null, terminal],
  );
  return r.rows[0] ?? null;
}

export async function cancelCommand(pool: Pool, commandId: string, userId: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE commands c SET status = 'cancelled', finished_at = now(), lease_expires_at = NULL, updated_at = now()
      FROM charts ch JOIN projects p ON p.id = ch.project_id
     WHERE c.id = $1 AND c.chart_id = ch.id AND c.status IN ('queued', 'claimed')
       AND (p.owner_id = $2 OR EXISTS (
         SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = $2 AND m.role IN ('owner', 'member')
       ))`,
    [commandId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listCommands(pool: Pool, chartId: string, limit = 50): Promise<AgentCommand[]> {
  const r = await pool.query<AgentCommand>(
    `SELECT ${fields} FROM commands WHERE chart_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [chartId, limit],
  );
  return r.rows;
}

export async function countPendingCommands(pool: Pool, chartId: string): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM commands
      WHERE chart_id = $1 AND status IN ('queued', 'claimed', 'running')`,
    [chartId],
  );
  return Number(r.rows[0]?.count ?? 0);
}

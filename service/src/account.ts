import type { Pool } from "./db.js";
import { tx } from "./db.js";
import { recordAudit } from "./audit.js";

export interface AccountExport {
  exportedAt: string;
  account: unknown;
  projects: unknown[];
  memberships: unknown[];
  charts: unknown[];
  operations: unknown[];
  figures: unknown[];
  agents: unknown[];
  commands: unknown[];
  auditEvents: unknown[];
}

export async function exportAccount(pool: Pool, userId: string): Promise<AccountExport> {
  const [account, projects, memberships, charts, operations, figures, agents, commands, auditEvents] = await Promise.all([
    pool.query("SELECT id, email, name, avatar_url, plan, created_at FROM users WHERE id = $1", [userId]),
    pool.query("SELECT id, name, repo_key, created_at FROM projects WHERE owner_id = $1 ORDER BY created_at", [userId]),
    pool.query(
      `SELECT p.id AS project_id, p.name, m.role, m.created_at
         FROM project_members m JOIN projects p ON p.id = m.project_id
        WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT c.id, c.project_id, c.slug, c.title, c.revision, c.vocab, c.created_at, c.updated_at
         FROM charts c JOIN projects p ON p.id = c.project_id
        WHERE p.owner_id = $1 ORDER BY c.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT o.chart_id, o.seq, o.op_id, o.at, o.author, o.op, o.created_at
         FROM ops o JOIN charts c ON c.id = o.chart_id JOIN projects p ON p.id = c.project_id
        WHERE p.owner_id = $1 ORDER BY o.chart_id, o.seq`,
      [userId],
    ),
    pool.query(
      `SELECT f.chart_id, f.file, f.mime, f.bytes, f.created_at
         FROM figures f JOIN charts c ON c.id = f.chart_id JOIN projects p ON p.id = c.project_id
        WHERE p.owner_id = $1 ORDER BY f.chart_id, f.file`,
      [userId],
    ),
    pool.query(
      "SELECT id, label, created_at, last_used_at, revoked_at FROM agent_tokens WHERE user_id = $1 ORDER BY created_at",
      [userId],
    ),
    pool.query(
      `SELECT cmd.id, cmd.chart_id, cmd.node_id, cmd.verb, cmd.body, cmd.status, cmd.result,
              cmd.created_at, cmd.finished_at
         FROM commands cmd JOIN charts c ON c.id = cmd.chart_id JOIN projects p ON p.id = c.project_id
        WHERE p.owner_id = $1 OR cmd.created_by = $1 ORDER BY cmd.created_at`,
      [userId],
    ),
    pool.query(
      "SELECT event, target_type, target_id, metadata, created_at FROM audit_events WHERE actor_id = $1 ORDER BY created_at",
      [userId],
    ),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    account: account.rows[0] ?? null,
    projects: projects.rows,
    memberships: memberships.rows,
    charts: charts.rows,
    operations: operations.rows,
    figures: figures.rows,
    agents: agents.rows,
    commands: commands.rows,
    auditEvents: auditEvents.rows,
  };
}

/** Delete database ownership atomically, returning blobs that may then be unlinked. */
export async function deleteAccount(pool: Pool, userId: string): Promise<string[]> {
  return tx(pool, async (client) => {
    const blobs = await client.query<{ storage_key: string }>(
      `SELECT f.storage_key FROM figures f
         JOIN charts c ON c.id = f.chart_id JOIN projects p ON p.id = c.project_id
        WHERE p.owner_id = $1`,
      [userId],
    );
    await recordAudit(client, { actorId: userId, event: "account.deleted", targetType: "user", targetId: userId });
    const removed = await client.query("DELETE FROM users WHERE id = $1", [userId]);
    if ((removed.rowCount ?? 0) !== 1) throw new Error("account not found");
    return blobs.rows.map((row) => row.storage_key);
  });
}

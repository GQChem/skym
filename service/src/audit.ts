import type pg from "pg";

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export interface AuditEvent {
  actorId?: string | null;
  event: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Record only identifiers and deliberate metadata; never credentials or OAuth codes. */
export async function recordAudit(db: Queryable, entry: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (actor_id, event, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      entry.actorId ?? null,
      entry.event,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

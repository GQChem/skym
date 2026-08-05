import fs from "node:fs";
import path from "node:path";
import type { Pool } from "./db.js";

/**
 * Figure blobs live on disk, their metadata in Postgres.
 *
 * The op log only ever carries a filename — `figure.add` references the blob
 * out of band — so without this the hosted viewer has a reference and no bytes.
 * Blobs are written under BLOB_DIR, which must be a mounted Railway volume:
 * the container filesystem is ephemeral and anything else vanishes on redeploy.
 * Named for the storage, not the caller — figures are the first thing to live
 * here, not the last.
 */

const MAX_BYTES = 8 * 1024 * 1024;

export const blobDir = (): string => process.env.BLOB_DIR ?? "/data/blobs";

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

export const isAllowedMime = (mime: string): boolean => mime in MIME_EXT;

/**
 * Chart id plus filename, both sanitised. Keeping the chart id in the path
 * means one chart's upload can never overwrite another's, whatever the agent
 * sends as a filename.
 */
function storageKey(chartId: string, file: string): string {
  const safe = path.basename(file).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(chartId, safe);
}

export interface StoredFigure {
  file: string;
  mime: string;
  bytes: number;
  storageKey: string;
}

const MB = 1024 * 1024;

/**
 * What each plan grants. Config rather than schema, so changing a tier's size
 * is a redeploy and not a migration. Env overrides let a deploy tune limits
 * without a code change.
 */
export const planLimits = (): Record<string, number> => ({
  free: Number(process.env.STORAGE_QUOTA_FREE ?? 50 * MB),
  pro: Number(process.env.STORAGE_QUOTA_PRO ?? 1024 * MB),
});

export const DEFAULT_PLAN = "free";

/** An unknown plan falls back to free rather than granting unlimited space. */
export const limitForPlan = (plan: string | null | undefined): number => {
  const limits = planLimits();
  return limits[plan ?? DEFAULT_PLAN] ?? limits[DEFAULT_PLAN]!;
};

export interface Usage {
  used: number;
  quota: number;
  plan: string;
}

/**
 * Everything the user owns, across every chart in every project they own.
 * Charts shared with them count against the owner, not the reader — otherwise
 * being invited to a project would silently consume your own allowance.
 *
 * The allowance is the user's explicit override if set, else their plan's.
 */
export async function usageFor(pool: Pool, userId: string): Promise<Usage> {
  const [used, account] = await Promise.all([
    pool.query<{ used: string | null }>(
      `SELECT sum(f.bytes) AS used
         FROM figures f
         JOIN charts c ON c.id = f.chart_id
         JOIN projects p ON p.id = c.project_id
        WHERE p.owner_id = $1`,
      [userId],
    ),
    pool.query<{ plan: string | null; storage_limit_bytes: string | null }>(
      "SELECT plan, storage_limit_bytes FROM users WHERE id = $1",
      [userId],
    ),
  ]);

  const row = account.rows[0];
  const plan = row?.plan ?? DEFAULT_PLAN;
  const override = row?.storage_limit_bytes;
  return {
    used: Number(used.rows[0]?.used ?? 0),
    quota: override === null || override === undefined ? limitForPlan(plan) : Number(override),
    plan,
  };
}

export class QuotaExceeded extends Error {
  constructor(readonly usage: Usage) {
    super("storage quota exceeded");
    this.name = "QuotaExceeded";
  }
}

/**
 * Refuses the upload rather than evicting anything.
 *
 * A figure is the evidence behind a result: deleting one to make room leaves
 * the node claiming a finding whose proof is a broken image. Charts stay
 * trustworthy, and hitting the ceiling is the user's decision to resolve.
 */
async function assertRoom(pool: Pool, chartId: string, file: string, incoming: number): Promise<void> {
  const owner = await pool.query<{ owner_id: string }>(
    `SELECT p.owner_id FROM charts c JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
    [chartId],
  );
  const userId = owner.rows[0]?.owner_id;
  if (!userId) return;

  const usage = await usageFor(pool, userId);
  // Replacing a figure only costs the difference, or correcting one would be
  // charged twice.
  const prior = await pool.query<{ bytes: string }>(
    "SELECT bytes FROM figures WHERE chart_id = $1 AND file = $2",
    [chartId, path.basename(file)],
  );
  const freed = Number(prior.rows[0]?.bytes ?? 0);

  if (usage.used - freed + incoming > usage.quota) throw new QuotaExceeded(usage);
}

export async function putFigure(
  pool: Pool,
  chartId: string,
  file: string,
  mime: string,
  data: Buffer,
): Promise<StoredFigure> {
  if (!isAllowedMime(mime)) throw new Error(`unsupported figure type: ${mime}`);
  if (data.length > MAX_BYTES) throw new Error("figure too large");
  // Checked before the write, so a refused upload leaves nothing on the volume.
  await assertRoom(pool, chartId, file, data.length);

  const key = storageKey(chartId, file);
  const dest = path.join(blobDir(), key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Write then rename, so a half-written blob is never served.
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);

  await pool.query(
    `INSERT INTO figures (chart_id, file, mime, bytes, storage_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chart_id, file)
     DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, storage_key = EXCLUDED.storage_key`,
    [chartId, path.basename(file), mime, data.length, key],
  );

  return { file: path.basename(file), mime, bytes: data.length, storageKey: key };
}

export interface FigureBlob {
  mime: string;
  path: string;
}

export async function findFigure(pool: Pool, chartId: string, file: string): Promise<FigureBlob | null> {
  const r = await pool.query<{ mime: string; storage_key: string }>(
    "SELECT mime, storage_key FROM figures WHERE chart_id = $1 AND file = $2",
    [chartId, path.basename(file)],
  );
  const row = r.rows[0];
  if (!row) return null;

  const root = path.resolve(blobDir());
  const full = path.resolve(root, row.storage_key);
  // The key comes from our own writer, but a traversal here would serve any
  // file on the volume, so it is checked rather than trusted.
  if (!full.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return { mime: row.mime, path: full };
}

/**
 * Unlinks a blob by its storage key. Best-effort: a file already gone is the
 * desired end state, and a failure here must not abort deleting the chart.
 */
export function removeBlob(key: string): void {
  const root = path.resolve(blobDir());
  const full = path.resolve(root, key);
  // Same guard as reads: a crafted key must not reach outside the volume.
  if (!full.startsWith(root + path.sep)) return;
  try {
    fs.rmSync(full, { force: true });
  } catch {
    /* nothing left to remove */
  }
}

/** Which of these filenames the service already holds bytes for. */
export async function haveFigures(pool: Pool, chartId: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  const r = await pool.query<{ file: string }>(
    "SELECT file FROM figures WHERE chart_id = $1 AND file = ANY($2::text[])",
    [chartId, files.map((f) => path.basename(f))],
  );
  return new Set(r.rows.map((row) => row.file));
}

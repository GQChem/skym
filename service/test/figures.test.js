import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makePool, migrate, tx } from "../dist/service/src/db.js";

/**
 * Figure storage: blobs on disk, metadata in Postgres. Same convention as the
 * ingest suite — a real database or an honest skip, never a vacuous pass.
 */
const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set — skipping figure integration tests";

let pool;
let userId;
let figures;
let blobDir;

test.before(async () => {
  if (skip) return;
  // BLOB_DIR is read at call time, so it must be set before the import.
  blobDir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-blobs-"));
  process.env.BLOB_DIR = blobDir;
  figures = await import("../dist/service/src/figures.js");

  pool = makePool(url);
  await migrate(pool);
  const u = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `fig-${randomUUID().slice(0, 8)}@test.local`,
  ]);
  userId = u.rows[0].id;
});

test.after(async () => {
  await pool?.end();
});

async function freshChart() {
  return tx(pool, async (c) => {
    const p = await c.query("INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id", [
      `proj-${randomUUID().slice(0, 8)}`,
      userId,
    ]);
    const chart = await c.query(
      "INSERT INTO charts (project_id, slug, title) VALUES ($1, $2, $3) RETURNING id",
      [p.rows[0].id, randomUUID().slice(0, 8), "Figures"],
    );
    return chart.rows[0].id;
  });
}

test("a stored figure comes back with its bytes", { skip }, async () => {
  const chartId = await freshChart();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  const stored = await figures.putFigure(pool, chartId, "plot.png", "image/png", bytes);
  assert.equal(stored.bytes, bytes.length);

  const found = await figures.findFigure(pool, chartId, "plot.png");
  assert.ok(found, "the blob is findable");
  assert.equal(found.mime, "image/png");
  assert.deepEqual(fs.readFileSync(found.path), bytes, "the bytes round-trip intact");
});

test("re-uploading the same filename replaces it rather than duplicating", { skip }, async () => {
  const chartId = await freshChart();
  await figures.putFigure(pool, chartId, "p.png", "image/png", Buffer.from([1]));
  await figures.putFigure(pool, chartId, "p.png", "image/png", Buffer.from([2, 2]));

  const r = await pool.query("SELECT bytes FROM figures WHERE chart_id = $1 AND file = $2", [chartId, "p.png"]);
  assert.equal(r.rows.length, 1, "one row per (chart, file)");
  assert.equal(Number(r.rows[0].bytes), 2, "the newer upload wins");
});

test("two charts may each hold a figure of the same name", { skip }, async () => {
  const a = await freshChart();
  const b = await freshChart();
  await figures.putFigure(pool, a, "same.png", "image/png", Buffer.from([0xa]));
  await figures.putFigure(pool, b, "same.png", "image/png", Buffer.from([0xb]));

  const fa = await figures.findFigure(pool, a, "same.png");
  const fb = await figures.findFigure(pool, b, "same.png");
  assert.notEqual(fa.path, fb.path, "one chart's upload cannot clobber another's");
  assert.deepEqual(fs.readFileSync(fa.path), Buffer.from([0xa]));
  assert.deepEqual(fs.readFileSync(fb.path), Buffer.from([0xb]));
});

test("a traversing filename cannot escape the blob directory", { skip }, async () => {
  const chartId = await freshChart();
  const stored = await figures.putFigure(pool, chartId, "../../etc/passwd", "image/png", Buffer.from([9]));

  const full = path.resolve(blobDir, stored.storageKey);
  assert.ok(full.startsWith(path.resolve(blobDir)), `blob escaped its directory: ${full}`);
  assert.ok(!stored.file.includes("/") && !stored.file.includes("\\"), "the stored name is a bare filename");
});

test("a figure of another chart is not served for this one", { skip }, async () => {
  const a = await freshChart();
  const b = await freshChart();
  await figures.putFigure(pool, a, "only-a.png", "image/png", Buffer.from([1]));
  assert.equal(await figures.findFigure(pool, b, "only-a.png"), null);
});

test("an unsupported type is refused", { skip }, async () => {
  const chartId = await freshChart();
  await assert.rejects(
    () => figures.putFigure(pool, chartId, "x.html", "text/html", Buffer.from("<script>")),
    /unsupported figure type/,
  );
});

// --- listing must not multiply rows ---

test("an owner who is also a member sees each chart once", { skip }, async () => {
  const chartId = await freshChart();
  const projectId = (
    await pool.query("SELECT project_id FROM charts WHERE id = $1", [chartId])
  ).rows[0].project_id;

  // Exactly what attachChart writes: an owner membership for a project the
  // user already owns. A LEFT JOIN here returned the chart twice.
  await pool.query(
    "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
    [projectId, userId],
  );

  const r = await pool.query(
    `SELECT c.id FROM charts c
       JOIN projects p ON p.id = c.project_id
      WHERE (p.owner_id = $1
             OR EXISTS (SELECT 1 FROM project_members m
                         WHERE m.project_id = p.id AND m.user_id = $1))
        AND c.id = $2`,
    [userId, chartId],
  );
  assert.equal(r.rows.length, 1, "owner + member must not duplicate the chart");
});

test("deleting a chart takes its ops and figures with it", { skip }, async () => {
  const chartId = await freshChart();
  await figures.putFigure(pool, chartId, "gone.png", "image/png", Buffer.alloc(64));
  const blob = await figures.findFigure(pool, chartId, "gone.png");
  assert.ok(fs.existsSync(blob.path), "the blob is on disk to begin with");

  const before = (await figures.usageFor(pool, userId)).used;
  for (const row of (await pool.query("SELECT storage_key FROM figures WHERE chart_id = $1", [chartId])).rows) {
    figures.removeBlob(row.storage_key);
  }
  await pool.query("DELETE FROM charts WHERE id = $1", [chartId]);

  assert.ok(!fs.existsSync(blob.path), "the blob is unlinked from the volume");
  assert.equal(
    (await pool.query("SELECT 1 FROM figures WHERE chart_id = $1", [chartId])).rows.length,
    0,
    "figure rows cascade with the chart",
  );
  assert.equal(
    (await figures.usageFor(pool, userId)).used,
    before - 64,
    "the freed bytes come back to the owner's quota",
  );
});

// --- storage quota: refuse the upload, never evict what is already there ---

test("usage counts every chart the user owns", { skip }, async () => {
  const a = await freshChart();
  const b = await freshChart();
  const before = (await figures.usageFor(pool, userId)).used;

  await figures.putFigure(pool, a, "u1.png", "image/png", Buffer.alloc(100));
  await figures.putFigure(pool, b, "u2.png", "image/png", Buffer.alloc(150));

  const after = await figures.usageFor(pool, userId);
  assert.equal(after.used - before, 250, "bytes sum across the user's charts");
  assert.equal(after.plan, "free", "a new account starts on the free plan");
  assert.equal(after.quota, figures.limitForPlan("free"));
});

/** Sets this user's explicit allowance, restoring it afterwards. */
async function withLimit(bytes, fn) {
  await pool.query("UPDATE users SET storage_limit_bytes = $1 WHERE id = $2", [bytes, userId]);
  try {
    await fn();
  } finally {
    await pool.query("UPDATE users SET storage_limit_bytes = NULL WHERE id = $1", [userId]);
  }
}

test("a plan change moves the ceiling without touching stored bytes", { skip }, async () => {
  await pool.query("UPDATE users SET plan = 'pro' WHERE id = $1", [userId]);
  try {
    const u = await figures.usageFor(pool, userId);
    assert.equal(u.plan, "pro");
    assert.equal(u.quota, figures.limitForPlan("pro"));
    assert.ok(u.quota > figures.limitForPlan("free"), "pro grants more than free");
  } finally {
    await pool.query("UPDATE users SET plan = 'free' WHERE id = $1", [userId]);
  }
});

test("an explicit per-user limit overrides the plan", { skip }, async () => {
  await withLimit(4242, async () => {
    const u = await figures.usageFor(pool, userId);
    assert.equal(u.quota, 4242, "the override wins over the plan default");
    assert.equal(u.plan, "free", "the plan itself is unchanged");
  });
  assert.equal((await figures.usageFor(pool, userId)).quota, figures.limitForPlan("free"), "clearing it reverts");
});

test("an unknown plan falls back to free rather than unlimited", { skip }, async () => {
  await pool.query("UPDATE users SET plan = 'legacy-tier' WHERE id = $1", [userId]);
  try {
    assert.equal((await figures.usageFor(pool, userId)).quota, figures.limitForPlan("free"));
  } finally {
    await pool.query("UPDATE users SET plan = 'free' WHERE id = $1", [userId]);
  }
});

test("an upload over quota is refused and nothing is written", { skip }, async () => {
  const chartId = await freshChart();
  const used = (await figures.usageFor(pool, userId)).used;
  await withLimit(used + 50, async () => {
    await assert.rejects(
      () => figures.putFigure(pool, chartId, "toobig.png", "image/png", Buffer.alloc(500)),
      (e) => e.name === "QuotaExceeded",
    );
    assert.equal(await figures.findFigure(pool, chartId, "toobig.png"), null, "no row survives a refusal");
    const stray = path.join(blobDir, chartId, "toobig.png");
    assert.ok(!fs.existsSync(stray), "no blob is left on the volume");
  });
});

test("replacing a figure is charged only the difference", { skip }, async () => {
  const chartId = await freshChart();
  await figures.putFigure(pool, chartId, "same.png", "image/png", Buffer.alloc(400));
  const used = (await figures.usageFor(pool, userId)).used;

  // Room for the existing 400 bytes and nothing more: a same-size replacement
  // must still fit, or correcting a figure would be impossible at the ceiling.
  await withLimit(used, async () => {
    await figures.putFigure(pool, chartId, "same.png", "image/png", Buffer.alloc(400));
    assert.equal((await figures.usageFor(pool, userId)).used, used, "usage did not double-count");
  });
});

test("one user's uploads do not consume another's quota", { skip }, async () => {
  const other = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `other-${randomUUID().slice(0, 8)}@test.local`,
  ]);
  const otherId = other.rows[0].id;

  const chartId = await freshChart();
  await figures.putFigure(pool, chartId, "mine.png", "image/png", Buffer.alloc(300));

  assert.equal((await figures.usageFor(pool, otherId)).used, 0, "usage is scoped to the owner");
});

test("missing reports only what the service does not already hold", { skip }, async () => {
  const chartId = await freshChart();
  await figures.putFigure(pool, chartId, "have.png", "image/png", Buffer.from([1]));

  const have = await figures.haveFigures(pool, chartId, ["have.png", "absent.png"]);
  assert.ok(have.has("have.png"));
  assert.ok(!have.has("absent.png"));
});

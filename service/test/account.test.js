import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { deleteAccount, exportAccount } from "../dist/service/src/account.js";
import { approvePairing, redeemPairing, startPairing } from "../dist/service/src/auth.js";
import { makePool, migrate } from "../dist/service/src/db.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set — skipping account integration tests";
let pool;

test.before(async () => {
  if (skip) return;
  pool = makePool(url);
  await migrate(pool);
});

test.after(async () => {
  if (pool) {
    await pool.query("DELETE FROM users WHERE email LIKE 'account-%@test.local'").catch(() => {});
    await pool.end();
  }
});

async function fixture() {
  const user = (await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `account-${randomUUID()}@test.local`,
  ])).rows[0];
  const project = (await pool.query(
    "INSERT INTO projects (name, owner_id) VALUES ('Export project', $1) RETURNING id", [user.id],
  )).rows[0];
  const chart = (await pool.query(
    "INSERT INTO charts (project_id, slug, title) VALUES ($1, 'export', 'Export chart') RETURNING id",
    [project.id],
  )).rows[0];
  await pool.query(
    `INSERT INTO figures (chart_id, file, mime, bytes, storage_key)
     VALUES ($1, 'proof.png', 'image/png', 3, $2)`,
    [chart.id, `${chart.id}/proof.png`],
  );
  return { userId: user.id, chartId: chart.id };
}

test("account export contains owned chart data but no credential hashes", { skip }, async () => {
  const { userId, chartId } = await fixture();
  await pool.query("INSERT INTO agent_tokens (user_id, token_hash, label) VALUES ($1, 'secret-hash', 'test')", [userId]);
  const out = await exportAccount(pool, userId);
  assert.equal(out.charts[0].id, chartId);
  assert.equal(out.figures[0].file, "proof.png");
  assert.equal(out.agents[0].token_hash, undefined);
});

test("account deletion removes database ownership and returns blob keys", { skip }, async () => {
  const { userId, chartId } = await fixture();
  assert.deepEqual(await deleteAccount(pool, userId), [`${chartId}/proof.png`]);
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [userId])).rowCount, 0);
  const audit = await pool.query("SELECT actor_id FROM audit_events WHERE event = 'account.deleted' AND target_id = $1", [userId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].actor_id, null, "audit survives account removal without retaining an FK");
});

test("a pairing can be redeemed exactly once under concurrent polls", { skip }, async () => {
  const { userId } = await fixture();
  const pairing = await startPairing(pool);
  assert.equal(await approvePairing(pool, pairing.userCode, userId), true);
  const results = await Promise.all([
    redeemPairing(pool, pairing.deviceCode),
    redeemPairing(pool, pairing.deviceCode),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["expired", "ready"]);
  assert.equal((await pool.query("SELECT 1 FROM agent_tokens WHERE user_id = $1", [userId])).rowCount, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { claimCommand, countPendingCommands, createCommand, updateCommand } from "../dist/service/src/commands.js";
import { makePool, migrate } from "../dist/service/src/db.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "TEST_DATABASE_URL not set — skipping command integration tests";
let pool;
let userId;
let chartId;
let agentA;
let agentB;

test.before(async () => {
  if (skip) return;
  pool = makePool(url);
  await migrate(pool);
  userId = (await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [`command-${randomUUID()}@test.local`])).rows[0].id;
  const projectId = (await pool.query("INSERT INTO projects (name, owner_id) VALUES ('Commands', $1) RETURNING id", [userId])).rows[0].id;
  chartId = (await pool.query("INSERT INTO charts (project_id, slug, title) VALUES ($1, 'commands', 'Commands') RETURNING id", [projectId])).rows[0].id;
  agentA = (await pool.query("INSERT INTO agent_tokens (user_id, token_hash) VALUES ($1, $2) RETURNING id", [userId, randomUUID()])).rows[0].id;
  agentB = (await pool.query("INSERT INTO agent_tokens (user_id, token_hash) VALUES ($1, $2) RETURNING id", [userId, randomUUID()])).rows[0].id;
});

test.after(async () => {
  if (pool && userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => {});
  if (pool) await pool.end();
});

test("command creation is idempotent for a browser retry", { skip }, async () => {
  await pool.query("DELETE FROM commands WHERE chart_id = $1", [chartId]);
  const key = randomUUID();
  const first = await createCommand(pool, { chartId, userId, nodeId: "n1", body: "work", idempotencyKey: key });
  const second = await createCommand(pool, { chartId, userId, nodeId: "n1", body: "work", idempotencyKey: key });
  assert.equal(second.id, first.id);
});

test("concurrent agents cannot claim the same command", { skip }, async () => {
  await pool.query("DELETE FROM commands WHERE chart_id = $1", [chartId]);
  const command = await createCommand(pool, { chartId, userId, body: "only once", idempotencyKey: randomUUID() });
  const claims = await Promise.all([claimCommand(pool, chartId, agentA), claimCommand(pool, chartId, agentB)]);
  const claimed = claims.filter((x) => x?.id === command.id);
  assert.equal(claimed.length, 1);
});

test("only the claiming agent can advance a command", { skip }, async () => {
  await pool.query("DELETE FROM commands WHERE chart_id = $1", [chartId]);
  const command = await createCommand(pool, { chartId, userId, body: "owned lease", idempotencyKey: randomUUID() });
  const claimed = await claimCommand(pool, chartId, agentA);
  assert.equal(claimed.id, command.id);
  assert.equal(await updateCommand(pool, command.id, agentB, "running"), null);
  assert.equal((await updateCommand(pool, command.id, agentA, "running")).status, "running");
  assert.equal((await updateCommand(pool, command.id, agentA, "done", "finished")).status, "done");
  assert.equal(await countPendingCommands(pool, chartId), 0);
});

test("pending count includes queued and in-progress commands", { skip }, async () => {
  await pool.query("DELETE FROM commands WHERE chart_id = $1", [chartId]);
  await createCommand(pool, { chartId, userId, body: "queued", idempotencyKey: randomUUID() });
  await createCommand(pool, { chartId, userId, body: "claimed", idempotencyKey: randomUUID() });
  await claimCommand(pool, chartId, agentA);
  assert.equal(await countPendingCommands(pool, chartId), 2);
});

test("an expired lease can be recovered by another agent", { skip }, async () => {
  await pool.query("DELETE FROM commands WHERE chart_id = $1", [chartId]);
  const command = await createCommand(pool, { chartId, userId, body: "recover", idempotencyKey: randomUUID() });
  await claimCommand(pool, chartId, agentA);
  await pool.query("UPDATE commands SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [command.id]);
  assert.equal((await claimCommand(pool, chartId, agentB)).id, command.id);
});

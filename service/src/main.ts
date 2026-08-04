import { makePool, migrate } from "./db.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);

/**
 * Listen first, migrate second.
 *
 * A healthcheck that never gets a port is indistinguishable from a hundred
 * other faults, so the server binds immediately and reports why it is unwell
 * through /health. Migrating before listening meant a missing DATABASE_URL or
 * a slow database looked like a silent container death.
 */
const missing = ["DATABASE_URL"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`FATAL: missing required environment: ${missing.join(", ")}`);
  console.error("Set it in Railway → Variables. Reference the Postgres service, e.g. ${{Postgres.DATABASE_URL}}");
}

let ready = false;
let bootError: string | null = missing.length ? `missing environment: ${missing.join(", ")}` : null;

const pool = missing.length ? null : makePool();

const server = createServer(pool, () => ({ ready, bootError }));
server.listen(port, "0.0.0.0", () => console.log(`skym service listening on ${port}`));

if (pool) {
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied migrations: ${applied.join(", ")}` : "schema up to date");
    ready = true;
  } catch (err) {
    bootError = `migration failed: ${(err as Error).message}`;
    console.error(`FATAL: ${bootError}`);
  }
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal}: draining`);
  server.close();
  if (pool) await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

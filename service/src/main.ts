import { makePool, migrate } from "./db.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);

const pool = makePool();
const applied = await migrate(pool);
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const server = createServer(pool);
// Railway routes to the container's PORT on all interfaces.
server.listen(port, "0.0.0.0", () => console.log(`skym service listening on ${port}`));

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal}: draining`);
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

import { spawnSync } from "node:child_process";

/**
 * Runs the integration tests against a throwaway database.
 *
 * Resolution order, each with a reason it might not work, reported rather than
 * left to fail as a DNS error six tests deep:
 *   1. TEST_DATABASE_URL      — set it yourself, always wins
 *   2. DATABASE_PUBLIC_URL    — Railway's public endpoint, if enabled
 *   3. a local Postgres       — the default, and the one that should be used
 */
const LOCAL = "postgres://postgres:postgres@127.0.0.1:5432/skym_test";

const candidates = [
  ["TEST_DATABASE_URL", process.env.TEST_DATABASE_URL],
  ["DATABASE_PUBLIC_URL", process.env.DATABASE_PUBLIC_URL],
  ["local Postgres", process.env.LOCAL_DATABASE_URL ?? LOCAL],
];

const picked = candidates.find(([, v]) => v && !v.includes(".railway.internal"));

if (!picked) {
  console.error("No usable database.\n");
  if (process.env.DATABASE_URL?.includes(".railway.internal")) {
    console.error(
      "DATABASE_URL points at Railway's private host, which only resolves inside\n" +
        "Railway. `railway run` forwards variables but runs the process locally, so\n" +
        "that hostname cannot be reached from here.\n",
    );
  }
  console.error("Pick one:");
  console.error("  • Local Postgres (recommended — these tests write junk rows):");
  console.error(`      createdb skym_test && npm run test:db`);
  console.error("  • Railway's public endpoint:");
  console.error("      Railway → Postgres → Settings → Networking → enable public networking,");
  console.error("      then: TEST_DATABASE_URL=<DATABASE_PUBLIC_URL> npm run test:db");
  process.exit(1);
}

const [source, url] = picked;
const safe = url.replace(/:\/\/[^@]*@/, "://***@");
console.log(`ingest tests → ${source}: ${safe}\n`);

const r = spawnSync("npm", ["test"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, TEST_DATABASE_URL: url },
});
process.exit(r.status ?? 1);

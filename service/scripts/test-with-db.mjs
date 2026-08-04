import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";

/**
 * Runs the integration tests against whatever database is actually reachable.
 *
 * Railway's private hostname is the right address *inside* Railway and
 * unreachable outside it, so this resolves it rather than assuming: inside a
 * container (railway ssh) the private URL works and nothing needs exposing.
 */
const LOCAL = "postgres://postgres:postgres@127.0.0.1:5432/skym_test";

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** A name that resolves is not a database: open the port before choosing it. */
async function reachable(url) {
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  if (!parsed) return false;
  try {
    await dns.lookup(parsed.hostname);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(Number(parsed.port || 5432), parsed.hostname);
  });
}

const candidates = [
  ["TEST_DATABASE_URL", process.env.TEST_DATABASE_URL],
  // Inside Railway this is private and correct; outside it will not resolve
  // and we fall through rather than failing six tests deep on a DNS error.
  ["DATABASE_URL (private)", process.env.DATABASE_URL],
  ["DATABASE_PUBLIC_URL", process.env.DATABASE_PUBLIC_URL],
  ["local Postgres", process.env.LOCAL_DATABASE_URL ?? LOCAL],
];

let picked = null;
for (const [source, url] of candidates) {
  if (!url) continue;
  if (await reachable(url)) {
    picked = [source, url];
    break;
  }
}

if (!picked) {
  console.error("No reachable database.\n");
  if (process.env.DATABASE_URL?.includes(".railway.internal")) {
    console.error(
      "DATABASE_URL points at Railway's private network, which does not resolve\n" +
        "from here. `railway run` forwards variables but runs the process locally.\n",
    );
    console.error("Run the tests inside Railway instead — no public endpoint needed:");
    console.error("    railway ssh --service skym");
    console.error("    cd /app/service && TEST_DATABASE_URL=\"$DATABASE_URL\" npm test\n");
  }
  console.error("Or use a local Postgres:");
  console.error("    createdb skym_test && npm run test:db");
  process.exit(1);
}

const [source, url] = picked;
console.log(`ingest tests → ${source}: ${url.replace(/:\/\/[^@]*@/, "://***@")}\n`);

const r = spawnSync("npm", ["test"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, TEST_DATABASE_URL: url },
});
process.exit(r.status ?? 1);

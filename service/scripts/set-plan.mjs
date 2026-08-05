/**
 * Moves a user between plans.
 *
 * Billing is not built yet, so plan changes are operational: comping an early
 * user, granting yourself pro, correcting a mistake. Takes an email rather
 * than an id, because that is what a human actually knows.
 *
 *   node scripts/set-plan.mjs <email> <plan>
 *   node scripts/set-plan.mjs me@example.com pro
 *
 * Run it where DATABASE_URL points at the target database — inside Railway
 * (`railway ssh`) for production, since the private host does not resolve
 * from outside.
 */
import pg from "pg";

const [email, plan] = process.argv.slice(2);

if (!email || !plan) {
  console.error("usage: node scripts/set-plan.mjs <email> <plan>");
  process.exit(2);
}

const KNOWN = ["free", "pro"];
if (!KNOWN.includes(plan)) {
  // An unknown plan silently falls back to free at check time, which would
  // look like the change simply did not work.
  console.error(`unknown plan "${plan}" — expected one of: ${KNOWN.join(", ")}`);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes("localhost") || url.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
});

try {
  const r = await pool.query(
    "UPDATE users SET plan = $1 WHERE lower(email) = lower($2) RETURNING id, email, plan, storage_limit_bytes",
    [plan, email],
  );

  if (!r.rows.length) {
    // Sign-in creates the row, so a missing user usually means a typo or an
    // account that has never signed in.
    console.error(`no user with email ${email}`);
    const all = await pool.query("SELECT email, plan FROM users ORDER BY created_at");
    console.error(`\nknown users (${all.rows.length}):`);
    for (const u of all.rows) console.error(`  ${u.email}  [${u.plan}]`);
    process.exit(1);
  }

  const u = r.rows[0];
  console.log(`${u.email} → plan=${u.plan}`);
  if (u.storage_limit_bytes !== null) {
    // The override wins over the plan, so a stale one makes this a no-op.
    console.log(`note: storage_limit_bytes=${u.storage_limit_bytes} overrides the plan's allowance`);
  }
} finally {
  await pool.end();
}

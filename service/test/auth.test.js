import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupExpiredAuth, hashToken, listAgentTokens, newToken, revokeAgentToken, roleAllows, safeEqual,
} from "../dist/service/src/auth.js";

// The DB-backed halves of auth are covered in ingest.test.js's environment;
// these are the pure pieces, which are also the ones worth getting wrong-proof.

test("a token is never stored in the clear", () => {
  const token = newToken();
  const hash = hashToken(token);
  assert.notEqual(hash, token);
  assert.equal(hash.length, 64, "sha-256 hex");
  assert.equal(hashToken(token), hash, "hashing is stable");
});

test("tokens are unguessable and unique", () => {
  const seen = new Set(Array.from({ length: 500 }, () => newToken()));
  assert.equal(seen.size, 500);
  // 32 random bytes, base64url — no padding, URL-safe.
  for (const t of seen) assert.match(t, /^[A-Za-z0-9_-]{43}$/);
});

test("safeEqual matches only identical strings", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"), "different lengths must not throw");
  assert.ok(!safeEqual("", "x"));
});

test("project roles grant only their intended chart capabilities", () => {
  for (const capability of ["read", "write", "delete", "manage"]) {
    assert.equal(roleAllows("owner", capability), true, `owner may ${capability}`);
  }
  assert.equal(roleAllows("member", "read"), true);
  assert.equal(roleAllows("member", "write"), true);
  assert.equal(roleAllows("member", "delete"), false);
  assert.equal(roleAllows("member", "manage"), false);
  assert.equal(roleAllows("viewer", "read"), true);
  assert.equal(roleAllows("viewer", "write"), false);
  assert.equal(roleAllows("viewer", "delete"), false);
  assert.equal(roleAllows("viewer", "manage"), false);
  assert.equal(roleAllows(null, "read"), false);
});

test("connected-agent metadata never includes token hashes", async () => {
  const pool = {
    query: async () => ({ rows: [{ id: "a", label: "laptop", created_at: new Date(1), last_used_at: null }] }),
  };
  assert.deepEqual(await listAgentTokens(pool, "u"), [
    { id: "a", label: "laptop", createdAt: new Date(1), lastUsedAt: null },
  ]);
});

test("revocation is scoped to the owning user", async () => {
  let params;
  const pool = { query: async (_sql, p) => { params = p; return { rowCount: 1, rows: [] }; } };
  assert.equal(await revokeAgentToken(pool, "user-1", "token-1"), true);
  assert.deepEqual(params, ["token-1", "user-1"]);
});

test("expired auth cleanup reports both removals", async () => {
  const results = [{ rowCount: 3 }, { rowCount: 2 }];
  const pool = { query: async () => ({ ...results.shift(), rows: [] }) };
  assert.deepEqual(await cleanupExpiredAuth(pool), { pairings: 3, sessions: 2 });
});

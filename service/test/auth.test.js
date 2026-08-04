import assert from "node:assert/strict";
import test from "node:test";
import { hashToken, newToken, safeEqual } from "../dist/auth.js";

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

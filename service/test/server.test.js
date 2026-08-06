import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { decodeChartCursor, encodeChartCursor, takeRateLimit } from "../dist/service/src/server.js";

test("chart cursors round-trip without exposing query syntax", () => {
  const cursor = { updatedAt: "2026-08-06T10:20:30.000Z", id: randomUUID() };
  assert.deepEqual(decodeChartCursor(encodeChartCursor(cursor)), cursor);
});

test("malformed chart cursors are rejected", () => {
  assert.equal(decodeChartCursor("not-base64-json"), null);
  assert.equal(decodeChartCursor(Buffer.from(JSON.stringify({ id: "no", updatedAt: "yesterday" })).toString("base64url")), null);
});

test("rate limits reset after their window", () => {
  const key = `test:${randomUUID()}`;
  assert.equal(takeRateLimit(key, 2, 1_000, 10_000), 0);
  assert.equal(takeRateLimit(key, 2, 1_000, 10_100), 0);
  assert.equal(takeRateLimit(key, 2, 1_000, 10_200), 1);
  assert.equal(takeRateLimit(key, 2, 1_000, 11_001), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { SyncClient, awaitPairing, startPairing } from "../dist/sync.js";

// A stub fetch: the point of these tests is the queue's behaviour under
// failure and retry, which a real server would make slower and less certain.
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", body, headers: init.headers ?? {} });
    const out = await handler({ url: String(url), body, n: calls.length });
    return {
      ok: out.status === undefined || (out.status >= 200 && out.status < 300),
      status: out.status ?? 200,
      json: async () => out.body ?? {},
      text: async () => JSON.stringify(out.body ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

const entry = (id, seq) => ({ id, seq, at: 1000 + seq, by: "test", op: { t: "node.put", id: `n${seq}` } });

const client = async (fetchImpl, opts = {}) => {
  const c = new SyncClient({
    url: "https://svc.test",
    token: "tok",
    chartId: "local",
    fetchImpl,
    flushMs: 5,
    ...opts,
  });
  await c.attach({ slug: "chart", title: "Chart" });
  return c;
};

test("attach resolves the remote chart id", async () => {
  const f = stubFetch(() => ({ body: { chartId: "remote-1", projectId: "p", revision: 0 } }));
  const c = await client(f);
  assert.match(f.calls[0].url, /\/api\/charts\/attach$/);
  assert.equal(f.calls[0].body.slug, "chart");
  assert.equal(f.calls[0].headers.Authorization, "Bearer tok");
  await c.close();
});

test("enqueue never throws and never blocks", async () => {
  const f = stubFetch(() => ({ body: { chartId: "remote-1" } }));
  const c = await client(f);
  // Synchronous by contract — commit() calls this inside a sync function.
  assert.doesNotThrow(() => c.enqueue(entry("a", 1)));
  assert.equal(c.pending, 1);
  await c.close();
});

test("a flush ships the queue and clears it", async () => {
  const f = stubFetch(({ url }) =>
    url.endsWith("/attach")
      ? { body: { chartId: "remote-1" } }
      : { body: { accepted: [{ opId: "a", seq: 1 }], duplicates: [], rejected: [], revision: 1 } },
  );
  const c = await client(f);
  c.enqueue(entry("a", 1));
  c.enqueue(entry("b", 2));
  await c.flush();
  assert.equal(c.pending, 0);
  const post = f.calls.find((x) => x.url.includes("/ops"));
  assert.equal(post.body.ops.length, 2, "both ops go in one batch");
  assert.equal(c.lastError, null);
  await c.close();
});

test("a failed flush keeps the ops for the next try", async () => {
  let fail = true;
  const f = stubFetch(({ url }) => {
    if (url.endsWith("/attach")) return { body: { chartId: "remote-1" } };
    if (fail) return { status: 503, body: { error: "down" } };
    return { body: { accepted: [], duplicates: [], rejected: [], revision: 1 } };
  });
  const c = await client(f);
  c.enqueue(entry("a", 1));

  await c.flush();
  assert.equal(c.pending, 1, "a lost batch must not be dropped");
  assert.match(c.lastError, /503/);

  fail = false;
  await c.flush();
  assert.equal(c.pending, 0, "the retry drains it");
  assert.equal(c.lastError, null, "a success clears the error");
  await c.close();
});

test("a flush failure reaches onError rather than throwing", async () => {
  const seen = [];
  const f = stubFetch(({ url }) =>
    url.endsWith("/attach") ? { body: { chartId: "r" } } : { status: 500, body: {} },
  );
  const c = await client(f, { onError: (e) => seen.push(e.message) });
  c.enqueue(entry("a", 1));
  await assert.doesNotReject(() => c.flush());
  assert.equal(seen.length, 1);
  await c.close();
});

test("nothing is sent before attach resolves a chart", async () => {
  const f = stubFetch(() => ({ body: {} }));
  const c = new SyncClient({ url: "https://svc.test", token: "t", chartId: "local", fetchImpl: f, flushMs: 5 });
  c.enqueue(entry("a", 1));
  await c.flush();
  assert.equal(c.pending, 1, "queued, but not shipped to nowhere");
  assert.equal(f.calls.length, 0);
});

test("close drains what is still queued", async () => {
  const f = stubFetch(({ url }) =>
    url.endsWith("/attach") ? { body: { chartId: "r" } } : { body: { accepted: [], revision: 1 } },
  );
  const c = await client(f);
  c.enqueue(entry("a", 1));
  await c.close();
  assert.equal(c.pending, 0, "a last op must not be lost on shutdown");
});

test("pairing polls until the user approves", async () => {
  const f = stubFetch(({ url, n }) => {
    if (url.endsWith("/pair/start")) {
      return {
        body: {
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://svc.test/pair",
          expires_in: 900,
        },
      };
    }
    // Pending twice, then approved.
    return n < 4 ? { status: 202, body: { status: "pending" } } : { body: { status: "ready", token: "agent-tok" } };
  });

  const prompt = await startPairing("https://svc.test", f);
  assert.equal(prompt.userCode, "ABCD-EFGH");
  const token = await awaitPairing("https://svc.test", prompt.deviceCode, { intervalMs: 1, fetchImpl: f });
  assert.equal(token, "agent-tok");
});

test("an expired pairing code fails loudly", async () => {
  const f = stubFetch(() => ({ status: 410, body: { status: "expired" } }));
  await assert.rejects(
    () => awaitPairing("https://svc.test", "dev-1", { intervalMs: 1, fetchImpl: f }),
    /expired/,
  );
});

test("pairing gives up rather than polling forever", async () => {
  const f = stubFetch(() => ({ status: 202, body: { status: "pending" } }));
  await assert.rejects(
    () => awaitPairing("https://svc.test", "dev-1", { intervalMs: 1, timeoutMs: 20, fetchImpl: f }),
    /timed out/,
  );
});

// --- the wiring: a store's commits reach the queue ---

test("ops committed to a store land in the sync queue", async () => {
  const { GraphStore } = await import("../dist/store.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const f = stubFetch(({ url }) =>
    url.endsWith("/attach") ? { body: { chartId: "remote-1" } } : { body: { accepted: [], revision: 0 } },
  );
  const c = await client(f);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skym-sync-"));
  const store = new GraphStore(root, "wired", "Wired");
  // This is the subscription index.ts installs.
  store.subscribe((_g, entry) => {
    if (entry) c.enqueue(entry);
  });

  store.init("Wired");
  store.upsertNode({ id: "a", title: "A", kind: "action" });
  store.release();

  assert.ok(c.pending >= 2, `expected queued ops, got ${c.pending}`);
  await c.flush();
  const posted = f.calls.filter((x) => x.url.includes("/ops"));
  assert.equal(posted.length, 1, "one batch, not one request per op");
  const ids = posted[0].body.ops.map((o) => o.id);
  assert.ok(ids.every(Boolean), "every shipped op carries an id");
  assert.equal(new Set(ids).size, ids.length, "no duplicates in the batch");
  await c.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncClient, awaitPairing, startPairing } from "../dist/sync.js";

// A stub fetch: the point of these tests is the queue's behaviour under
// failure and retry, which a real server would make slower and less certain.
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    // Figure uploads send bytes, not JSON; those are recorded raw.
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : undefined;
    const bytes = raw && typeof raw !== "string" ? Buffer.from(raw) : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", body, bytes, headers: init.headers ?? {} });
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

test("attach sends the resolved vocabulary to the hosted viewer", async () => {
  const f = stubFetch(() => ({ body: { chartId: "remote-1" } }));
  const vocab = { name: "custom", kinds: [] };
  const c = new SyncClient({ url: "https://svc.test", token: "tok", chartId: "local", fetchImpl: f });
  await c.attach({ slug: "chart", title: "Chart", vocab });
  assert.deepEqual(f.calls[0].body.vocab, vocab);
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

// --- figures: the op names a file, the bytes travel separately ---

const figureStub = (missing = ["fig.png"]) =>
  stubFetch(({ url }) => {
    if (url.endsWith("/attach")) return { body: { chartId: "remote-1" } };
    if (url.endsWith("/figures/missing")) return { body: { missing } };
    return { body: { accepted: [], revision: 0 } };
  });

test("a queued figure uploads its bytes after the ops", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-fig-"));
  const file = "fig.png";
  fs.writeFileSync(path.join(dir, file), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const f = figureStub();
  const c = await client(f);
  c.enqueue(entry("a", 1));
  c.enqueueFigure({ file, path: path.join(dir, file), mime: "image/png" });
  await c.flush();

  const put = f.calls.find((x) => x.method === "PUT");
  assert.ok(put, "the blob is uploaded");
  assert.match(put.url, /\/figures\/fig\.png$/);
  assert.equal(put.headers["Content-Type"], "image/png");
  assert.deepEqual([...put.bytes], [0x89, 0x50, 0x4e, 0x47], "the actual bytes are sent");

  // The ops batch must land first: bytes are meaningless without their op.
  const opsAt = f.calls.findIndex((x) => x.url.includes("/ops"));
  const putAt = f.calls.indexOf(put);
  assert.ok(opsAt < putAt, "ops ship before the blobs that reference them");

  assert.equal(c.pending, 0, "a delivered figure leaves the queue");
  await c.close();
});

test("a figure the service already holds is not re-uploaded", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-fig-"));
  fs.writeFileSync(path.join(dir, "fig.png"), Buffer.from([1, 2, 3]));

  // The server reports nothing missing, as it would on a resumed sync.
  const f = figureStub([]);
  const c = await client(f);
  c.enqueueFigure({ file: "fig.png", path: path.join(dir, "fig.png"), mime: "image/png" });
  await c.flush();

  assert.equal(f.calls.filter((x) => x.method === "PUT").length, 0, "no blob re-sent");
  assert.equal(c.pending, 0, "it is still dropped from the queue");
  await c.close();
});

test("a figure whose file vanished is dropped, not retried forever", async () => {
  const f = figureStub();
  const c = await client(f);
  c.enqueueFigure({ file: "fig.png", path: "/definitely/not/here.png", mime: "image/png" });
  await c.flush();

  assert.equal(f.calls.filter((x) => x.method === "PUT").length, 0);
  assert.equal(c.pending, 0, "a missing asset cannot block the queue");
  assert.equal(c.lastError, null);
  await c.close();
});

test("attaching a figure to a store queues both the op and its bytes", async () => {
  const { GraphStore } = await import("../dist/store.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  // The store generates its own timestamped filename, so the stub echoes back
  // whatever it is asked about rather than naming one.
  const f = stubFetch(({ url, body }) => {
    if (url.endsWith("/attach")) return { body: { chartId: "remote-1" } };
    if (url.endsWith("/figures/missing")) return { body: { missing: body.files } };
    return { body: { accepted: [], revision: 0 } };
  });
  const c = await client(f);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skym-sync-"));
  const store = new GraphStore(root, "figs", "Figs");
  // The wiring index.ts installs: ops queue, and figure.add also queues bytes.
  store.subscribe((_g, entry) => {
    if (!entry) return;
    c.enqueue(entry);
    if (entry.op.t === "figure.add") {
      c.enqueueFigure({
        file: entry.op.figure.file,
        path: path.join(store.assetsDir, entry.op.figure.file),
        mime: entry.op.figure.mime ?? "image/png",
      });
    }
  });

  store.init("Figs");
  store.upsertNode({ id: "a", title: "A", kind: "action" });
  store.attachFigure("a", Buffer.from([7, 7, 7]), "image/png", "a caption");
  store.release();

  assert.ok(c.pending >= 3, `expected ops plus a figure, got ${c.pending}`);

  await c.flush();
  const put = f.calls.find((x) => x.method === "PUT");
  assert.ok(put, "the figure's bytes follow its op to the service");
  assert.deepEqual([...put.bytes], [7, 7, 7], "the bytes written to disk are the ones sent");
  assert.equal(c.pending, 0);
  await c.close();
});

test("reattach re-points the chart instead of forking a new one", async () => {
  const f = stubFetch(({ url, n }) =>
    url.endsWith("/attach") ? { body: { chartId: `remote-${n}` } } : { body: { accepted: [], revision: 0 } },
  );
  // A tool ran before flow_init, so this attached under the throwaway id.
  const c = await client(f, {});
  c.enqueue(entry("a", 1));

  await c.reattach("swap-the-viewer", "Swap the viewer");
  const attaches = f.calls.filter((x) => x.url.endsWith("/attach"));
  assert.equal(attaches.length, 2, "the second attach carries the real slug");
  assert.equal(attaches[1].body.slug, "swap-the-viewer");
  assert.equal(attaches[1].body.repo_key, attaches[0].body.repo_key, "same project, not a new one");

  // Ops queued before the rename still belong to this chart.
  await c.flush();
  const ops = f.calls.filter((x) => x.url.includes("/ops"));
  assert.ok(ops.length >= 1, "queued ops survive the re-point");
  assert.ok(ops.at(-1).url.includes("remote-2"), "and land on the re-pointed chart");
  await c.close();
});

test("reattach to the slug already attached is a no-op", async () => {
  const f = stubFetch(({ url }) =>
    url.endsWith("/attach") ? { body: { chartId: "remote-1" } } : { body: { accepted: [], revision: 0 } },
  );
  const c = await client(f);
  await c.reattach("chart", "Chart");
  assert.equal(f.calls.filter((x) => x.url.endsWith("/attach")).length, 1, "no redundant attach");
  await c.close();
});

test("the same figure queued twice is uploaded once", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-fig-"));
  fs.writeFileSync(path.join(dir, "dup.png"), Buffer.from([5]));

  const f = stubFetch(({ url, body }) => {
    if (url.endsWith("/attach")) return { body: { chartId: "remote-1" } };
    if (url.endsWith("/figures/missing")) return { body: { missing: body.files } };
    return { body: { accepted: [], revision: 0 } };
  });
  const c = await client(f);

  // A backfill queues from the replayed log and from the graph's own state,
  // so the same file arrives twice.
  const up = { file: "dup.png", path: path.join(dir, "dup.png"), mime: "image/png" };
  c.enqueueFigure(up);
  c.enqueueFigure({ ...up });
  assert.equal(c.pending, 1, "the duplicate never enters the queue");

  await c.flush();
  assert.equal(f.calls.filter((x) => x.method === "PUT").length, 1, "uploaded once");
  await c.close();
});

test("figures already on the graph are offered for backfill", async () => {
  const { GraphStore } = await import("../dist/store.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const f = stubFetch(({ url, body }) => {
    if (url.endsWith("/attach")) return { body: { chartId: "remote-1" } };
    if (url.endsWith("/figures/missing")) return { body: { missing: body.files } };
    return { body: { accepted: [], revision: 0 } };
  });
  const c = await client(f);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skym-backfill-"));
  const store = new GraphStore(root, "old", "Old chart");
  store.init("Old chart");
  store.upsertNode({ id: "a", title: "A", kind: "action" });
  store.attachFigure("a", Buffer.from([1, 2, 3, 4]), "image/png", "from before uploads existed");
  store.release();

  // A fresh client that never saw those commits — the reconnect case.
  const fresh = await client(f);
  for (const node of store.get().nodes) {
    for (const figure of node.figures) {
      fresh.enqueueFigure({
        file: figure.file,
        path: path.join(store.assetsDir, figure.file),
        mime: figure.mime ?? "image/png",
      });
    }
  }
  assert.ok(fresh.pending > 0, "the graph's existing figures are queued");

  await fresh.flush();
  const put = f.calls.find((x) => x.method === "PUT");
  assert.ok(put, "a figure with no op in this session still uploads");
  assert.deepEqual([...put.bytes], [1, 2, 3, 4]);
  await fresh.close();
  await c.close();
});

test("a figure refused for quota is dropped, and the reason survives", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-fig-"));
  fs.writeFileSync(path.join(dir, "big.png"), Buffer.from([1, 2, 3]));

  const errors = [];
  const f = stubFetch(({ url }) => {
    if (url.endsWith("/attach")) return { body: { chartId: "remote-1" } };
    if (url.endsWith("/figures/missing")) return { body: { missing: ["big.png"] } };
    if (url.includes("/figures/")) return { status: 507, body: { error: "storage quota exceeded" } };
    return { body: { accepted: [], revision: 0 } };
  });
  const c = await client(f, { onError: (e) => errors.push(e.message) });

  c.enqueue(entry("a", 1));
  c.enqueueFigure({ file: "big.png", path: path.join(dir, "big.png"), mime: "image/png" });
  await c.flush();

  assert.equal(c.pending, 0, "an over-quota blob is not retried forever");
  assert.match(c.lastError ?? "", /507|quota/, "the reason outlives the successful flush");
  assert.equal(errors.length, 1, "the user is told once");

  // A second flush must not re-send it.
  const puts = f.calls.filter((x) => x.method === "PUT").length;
  await c.flush();
  assert.equal(f.calls.filter((x) => x.method === "PUT").length, puts, "no retry");
  await c.close();
});

// --- pairing must outlive the process that started it ---

test("a pending code is remembered and redeemed later", async () => {
  const { readPendingPairing, writePendingPairing, clearPendingPairing, tryRedeem } = await import(
    "../dist/sync.js"
  );
  const priorHome = process.env.SKYM_HOME;
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "skym-pairing-"));
  process.env.SKYM_HOME = isolatedHome;
  clearPendingPairing();
  assert.equal(readPendingPairing(), null, "starts clean");

  const prompt = { deviceCode: "dev-9", userCode: "AAAA-BBBB", verificationUri: "https://svc.test/pair", expiresIn: 900 };
  writePendingPairing(prompt);

  // A different process would read it back from disk exactly like this.
  const back = readPendingPairing();
  assert.equal(back.deviceCode, "dev-9");
  assert.equal(back.userCode, "AAAA-BBBB");

  // Still pending on the first look, ready once approved.
  let approved = false;
  const f = stubFetch(() => (approved ? { body: { status: "ready", token: "tok-1" } } : { status: 202, body: { status: "pending" } }));
  assert.equal((await tryRedeem("https://svc.test", "dev-9", f)).status, "pending");
  approved = true;
  const out = await tryRedeem("https://svc.test", "dev-9", f);
  assert.equal(out.status, "ready");
  assert.equal(out.token, "tok-1");

  clearPendingPairing();
  assert.equal(readPendingPairing(), null, "cleared once redeemed");
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.SKYM_HOME;
  else process.env.SKYM_HOME = priorHome;
});

test("an expired pending code is reported, not retried forever", async () => {
  const { tryRedeem } = await import("../dist/sync.js");
  const f = stubFetch(() => ({ status: 410, body: { status: "expired" } }));
  assert.equal((await tryRedeem("https://svc.test", "dev-x", f)).status, "expired");
});

test("hosted commands are claimed and advanced through the attached chart", async () => {
  const command = { id: "11111111-1111-4111-8111-111111111111", status: "claimed", body: "work" };
  const f = stubFetch(({ url, body }) => {
    if (url.endsWith("/api/charts/attach")) return { body: { chartId: "22222222-2222-4222-8222-222222222222" } };
    if (url.endsWith("/commands/claim")) return { body: { command } };
    if (url.endsWith(`/api/commands/${command.id}`)) return { body: { command: { ...command, status: body.status } } };
    return { body: {} };
  });
  const c = new SyncClient({ url: "https://svc.test", token: "t", chartId: "local", fetchImpl: f });
  await c.attach({ slug: "local", title: "Commands" });
  assert.equal((await c.claimCommand()).id, command.id);
  assert.equal((await c.updateCommand(command.id, "done", "finished")).status, "done");
  assert.deepEqual(f.calls.at(-1).body, { status: "done", result: "finished" });
});

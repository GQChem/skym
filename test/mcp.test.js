import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Tests run against the deployed service by default, so what they exercise is
 * what ships. SKYM_TEST_SERVICE points elsewhere — a dev deploy, or an
 * unreachable address for an offline run.
 *
 * The agent is unpaired here, so flow_init reports a pairing code and the
 * chart stays local; that is the path these tests cover. Verifying a *paired*
 * agent end to end needs a token and is not something a unit test should mint.
 */
// Unit tests never create pairing rows in production. A dedicated E2E job may
// opt into a disposable deployment through SKYM_TEST_SERVICE.
const SERVICE_URL = process.env.SKYM_TEST_SERVICE ?? "http://127.0.0.1:9";

/** Boots the real server over stdio, as Claude Code does. */
async function boot(vocab) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skym-mcp-"));
  // The vocabulary is read from the project dir, so point it at a scratch one.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-proj-"));
  if (vocab) {
    fs.mkdirSync(path.join(projectDir, ".skym"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".skym", "config.json"), JSON.stringify({ vocab }), "utf8");
  }
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        SKYM_NO_OPEN: "1",
        SKYM_SERVICE_URL: SERVICE_URL,
        SKYM_STATE_DIR: root,
        SKYM_PROJECT_DIR: projectDir,

      },
    }),
  );
  return { client, root, projectDir, [Symbol.asyncDispose]: () => client.close() };
}

const text = (r) => r.content[0].text;

test("exposes the expected tool surface", async () => {
  const s = await boot();
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "flow_action", "flow_chart", "flow_command_state", "flow_edge", "flow_figure", "flow_find", "flow_inbox",
      "flow_init", "flow_note", "flow_options", "flow_remove", "flow_result",
      "flow_show", "flow_state",
    ]);
  } finally {
    await s.client.close();
  }
});

test("a project template replaces the generated per-kind tools", async () => {
  const s = await boot({ template: "research" });
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    for (const want of ["flow_question", "flow_experiment", "flow_finding"]) {
      assert.ok(names.includes(want), `expected ${want}, got ${names.join(", ")}`);
    }
    for (const gone of ["flow_action", "flow_result"]) {
      assert.ok(!names.includes(gone), `${gone} should not exist under the research template`);
    }
  } finally {
    await s.client.close();
  }
});

test("a templated tool enforces its own states and defaults", async () => {
  const s = await boot({ template: "research" });
  try {
    await s.client.callTool({ name: "flow_init", arguments: { title: "Lab" } });
    const ok = await s.client.callTool({
      name: "flow_finding",
      arguments: { id: "f1", title: "p99 dropped", state: "good" },
    });
    assert.match(text(ok), /1 good/);

    // A state from another kind must still be refused.
    const bad = await s.client.callTool({ name: "flow_finding", arguments: { id: "f2", state: "planned" } });
    assert.ok(bad.isError, "a foreign state should be rejected");

    // No state given falls to the kind's default, not a hardcoded "planned".
    const dflt = await s.client.callTool({ name: "flow_question", arguments: { id: "q1", title: "Why?" } });
    assert.match(text(dflt), /1 planned/);
  } finally {
    await s.client.close();
  }
});

test("a project can add a kind of its own alongside the builtins", async () => {
  const s = await boot({
    kinds: [
      {
        slug: "risk",
        label: "Risk",
        blurb: "Something that could go wrong.",
        defaultState: "watch",
        states: [
          {
            slug: "watch",
            label: "watch",
            glyph: "!",
            blurb: "keep an eye on it",
            light: { accent: "#b45309", fill: "#fffbeb", border: "#fcd34d" },
            dark: { accent: "#fbbf24", fill: "#292524", border: "#78350f" },
          },
        ],
      },
    ],
  });
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("flow_risk"), `expected flow_risk, got ${names.join(", ")}`);
    assert.ok(names.includes("flow_action"), "the builtin kinds should survive");

    await s.client.callTool({ name: "flow_init", arguments: { title: "Mixed" } });
    const added = await s.client.callTool({ name: "flow_risk", arguments: { id: "r1", title: "Disk fills" } });
    assert.match(text(added), /1 watch/);
  } finally {
    await s.client.close();
  }
});

test("builds a tree and reports state counts", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Tree" });
    await call("flow_action", { id: "a", title: "Do it", bullets: ["one"], state: "done" });
    const r = await call("flow_result", { id: "b", title: "It worked", state: "good", after: "a" });
    assert.match(text(r), /1 done/);
    assert.match(text(r), /1 good/);

    const shown = text(await call("flow_show", {}));
    assert.ok(shown.includes("n_a --> n_b"), "after: should draw the edge");
  } finally {
    await s.client.close();
  }
});

test("rejects a state that belongs to another kind", async () => {
  const s = await boot();
  try {
    await s.client.callTool({ name: "flow_init", arguments: { title: "Guards" } });
    const bad = await s.client.callTool({ name: "flow_action", arguments: { id: "x", state: "good" } });
    assert.ok(bad.isError, "good is not an action state");
    const bad2 = await s.client.callTool({ name: "flow_result", arguments: { id: "y", state: "done" } });
    assert.ok(bad2.isError, "done is not a result state");
  } finally {
    await s.client.close();
  }
});

test("rejects prose-shaped bullets", async () => {
  const s = await boot();
  try {
    await s.client.callTool({ name: "flow_init", arguments: { title: "Prose" } });
    const r = await s.client.callTool({
      name: "flow_action",
      arguments: { id: "x", bullets: ["First a thing. Then another thing. Finally a third."] },
    });
    assert.ok(r.isError);
    assert.match(text(r), /prose/i);
  } finally {
    await s.client.close();
  }
});

test("rejects a fork with fewer than two options", async () => {
  const s = await boot();
  try {
    await s.client.callTool({ name: "flow_init", arguments: { title: "Fork" } });
    const r = await s.client.callTool({
      name: "flow_options",
      arguments: { id: "f", options: [{ id: "only", title: "Only" }] },
    });
    assert.ok(r.isError);
  } finally {
    await s.client.close();
  }
});

test("options seeds one planned action per candidate", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Seeded" });
    const r = await call("flow_options", {
      id: "f",
      title: "Which?",
      options: [{ id: "p", title: "P" }, { id: "q", title: "Q" }],
    });
    assert.match(text(r), /2 planned/);
    assert.match(text(r), /1 open/);
    // Candidates hang off the fork with dashed edges.
    const src = text(await call("flow_show", {}));
    assert.ok(src.includes("n_f -.-> n_p"));
  } finally {
    await s.client.close();
  }
});

test("nudges when a result has no figure", async () => {
  const s = await boot();
  try {
    await s.client.callTool({ name: "flow_init", arguments: { title: "Nudge" } });
    const r = await s.client.callTool({
      name: "flow_result",
      arguments: { id: "r", title: "Finding", state: "good" },
    });
    assert.ok(!r.isError, "should succeed, not fail");
    assert.match(text(r), /No figure attached/);
  } finally {
    await s.client.close();
  }
});

test("attaching a figure clears the nudge and stores the file", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Figure" });
    await call("flow_result", { id: "r", title: "Finding", state: "good" });
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await call("flow_figure", { node_id: "r", base64: png, mime: "image/png" });
    assert.ok(!text(r).includes("No figure attached"));

    const assets = path.join(s.root, "charts", "figure", "assets");
    const files = fs.readdirSync(assets);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".png"));
  } finally {
    await s.client.close();
  }
});

test("svg+xml figures get a .svg extension", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Svg" });
    await call("flow_result", { id: "r", state: "good" });
    await call("flow_figure", {
      node_id: "r",
      base64: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64"),
      mime: "image/svg+xml",
    });
    const files = fs.readdirSync(path.join(s.root, "charts", "svg", "assets"));
    assert.ok(files[0].endsWith(".svg"), `expected .svg, got ${files[0]}`);
  } finally {
    await s.client.close();
  }
});

test("replace swaps the figure and deletes the old file", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Replace" });
    await call("flow_result", { id: "r", state: "good" });
    const svg = (body) => Buffer.from(body).toString("base64");
    await call("flow_figure", {
      node_id: "r",
      base64: svg("<svg xmlns='http://www.w3.org/2000/svg'><!--first--></svg>"),
      mime: "image/svg+xml",
    });
    const assets = path.join(s.root, "charts", "replace", "assets");
    assert.equal(fs.readdirSync(assets).length, 1);

    // Appending without the flag keeps both.
    await call("flow_figure", {
      node_id: "r",
      base64: svg("<svg xmlns='http://www.w3.org/2000/svg'><!--second--></svg>"),
      mime: "image/svg+xml",
    });
    assert.equal(fs.readdirSync(assets).length, 2);

    const r = await call("flow_figure", {
      node_id: "r",
      base64: svg("<svg xmlns='http://www.w3.org/2000/svg'><!--third--></svg>"),
      mime: "image/svg+xml",
      replace: true,
    });
    assert.match(text(r), /replaced/);
    const left = fs.readdirSync(assets);
    assert.equal(left.length, 1, `stale assets left behind: ${left.join(", ")}`);
    assert.match(
      fs.readFileSync(path.join(assets, left[0]), "utf8"),
      /third/,
      "the surviving file should be the newest",
    );
  } finally {
    await s.client.close();
  }
});

test("edges to unknown nodes are refused", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Dangling" });
    await call("flow_action", { id: "a" });
    const r = await s.client.callTool({ name: "flow_edge", arguments: { from: "a", to: "ghost" } });
    assert.ok(r.isError);
  } finally {
    await s.client.close();
  }
});

test("folder puts the chart where asked", async () => {
  const s = await boot();
  try {
    const r = await s.client.callTool({
      name: "flow_init",
      arguments: { title: "Placed", folder: "docs/design" },
    });
    assert.ok(!r.isError, text(r));
    // SKYM_STATE_DIR is overridden by folder, which resolves against the project dir.
    const dir = path.join(s.projectDir, "docs", "design", "charts", "placed");
    assert.ok(fs.existsSync(path.join(dir, "graph.json")), `expected chart at ${dir}`);
  } finally {
    await s.client.close();
  }
});

test("folder may point outside the project directory", async () => {
  const s = await boot();
  try {
    const outside = path.join(os.tmpdir(), `skym-outside-${Date.now()}`);
    const r = await s.client.callTool({
      name: "flow_init",
      arguments: { title: "Outside", folder: outside },
    });
    assert.ok(!r.isError, text(r));
    assert.ok(fs.existsSync(path.join(outside, "charts")), "chart written outside the project");
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    await s.client.close();
  }
});

test("charts persist under .flows with a slugged directory", async () => {
  const s = await boot();
  try {
    await s.client.callTool({ name: "flow_init", arguments: { title: "My Great Chart!" } });
    const dir = path.join(s.root, "charts", "my-great-chart");
    assert.ok(fs.existsSync(path.join(dir, "graph.json")));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "graph.json"), "utf8"));
    // v2: the snapshot is versioned, so the graph sits under a `graph` key.
    assert.equal(saved.v, 2);
    assert.equal(saved.graph.title, "My Great Chart!");

    // Every mutation is also appended to the log the team tier will ship.
    const log = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").trim().split("\n");
    assert.equal(log.length, 1);
    assert.equal(JSON.parse(log[0]).op.t, "init");
  } finally {
    await s.client.close();
  }
});

test("flow_chart attaches a data-drawn figure without an image", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Charts" });
    await call("flow_result", { id: "r", title: "Latency", state: "good" });
    const out = await call("flow_chart", {
      node_id: "r",
      kind: "bar",
      unit: "ms",
      title: "p99 by build",
      points: [
        { label: "before", value: 840 },
        { label: "after", value: 190, emphasis: true },
      ],
      caption: "p99 before and after",
    });
    assert.ok(!out.isError, text(out));
    assert.match(text(out), /Chart attached/);

    // The chart lands as a normal SVG figure, so everything downstream works.
    const assets = path.join(s.root, "charts", "charts", "assets");
    const files = fs.readdirSync(assets);
    const svg = files.find((f) => f.endsWith(".svg"));
    assert.ok(svg, "chart should be stored as an svg asset");
    const body = fs.readFileSync(path.join(assets, svg), "utf8");
    assert.match(body, /^<svg /);
    assert.ok(body.includes("840ms"));
    assert.ok(body.includes("190ms"));
  } finally {
    await s.client.close();
  }
});

test("flow_chart rejects data it cannot draw honestly", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Chart guards" });
    await call("flow_result", { id: "r", title: "X", state: "good" });

    const twoStats = await call("flow_chart", {
      node_id: "r",
      kind: "stat",
      points: [{ label: "a", value: 1 }, { label: "b", value: 2 }],
    });
    assert.ok(twoStats.isError, "a stat shows one number");

    const missing = await call("flow_chart", {
      node_id: "ghost",
      kind: "bar",
      points: [{ label: "a", value: 1 }],
    });
    assert.ok(missing.isError, "unknown node must be rejected");
  } finally {
    await s.client.close();
  }
});

test("flow_find locates nodes without dumping the chart", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Findable" });
    await call("flow_action", { id: "redis", title: "Swap cache to Redis", state: "done", bullets: ["TTL 60s"] });
    await call("flow_action", { id: "lru", title: "In-process LRU", state: "planned" });
    await call("flow_result", { id: "bench", title: "p99 dropped", state: "good", after: "redis" });

    const byText = text(await call("flow_find", { query: "redis" }));
    assert.match(byText, /redis/);
    assert.ok(!byText.includes("In-process LRU"), "must not return non-matches");

    // Bullets are searched too, not just titles.
    assert.match(text(await call("flow_find", { query: "ttl" })), /redis/i);

    const open = text(await call("flow_find", { unresolved: true }));
    assert.match(open, /lru/);
    assert.ok(!open.includes("bench"), "a good result is not unresolved");

    assert.match(text(await call("flow_find", { kind: "result" })), /bench/);
    assert.match(text(await call("flow_find", { query: "nothing-matches-this" })), /No nodes matched/);
  } finally {
    await s.client.close();
  }
});

test("flow_note records context as its own kind", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "Notes" });
    await call("flow_action", { id: "work", title: "Do the thing" });
    const r = await call("flow_note", {
      id: "budget",
      title: "Must stay under 200ms p99",
      bullets: ["Hard SLO"],
      about: "work",
    });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /1 active/);

    // A note is a note, not an action wearing a misleading state.
    const found = text(await call("flow_find", { kind: "note" }));
    assert.match(found, /budget.*note\/active/);

    // `about` links it to what it constrains.
    assert.ok(text(await call("flow_show", {})).includes("n_budget -.-> n_work"));
  } finally {
    await s.client.close();
  }
});

test("a cycle is rejected through the tools with the path named", async () => {
  const s = await boot();
  try {
    const call = (name, args) => s.client.callTool({ name, arguments: args });
    await call("flow_init", { title: "No loops" });
    await call("flow_action", { id: "a" });
    await call("flow_action", { id: "b", after: "a" });
    await call("flow_action", { id: "c", after: "b" });

    const loop = await call("flow_edge", { from: "c", to: "a" });
    assert.ok(loop.isError, "closing a loop must be rejected");
    assert.match(text(loop), /cycle: a → b → c → a/);

    const self = await call("flow_edge", { from: "a", to: "a" });
    assert.ok(self.isError, "a self-edge must be rejected");
  } finally {
    await s.client.close();
  }
});

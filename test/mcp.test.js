import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let port = 7500;

/** Boots the real server over stdio, as Claude Code does. */
async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skym-mcp-"));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        SKYM_NO_OPEN: "1",
        SKYM_STATE_DIR: root,
        SKYM_PORT: String(port++),
      },
    }),
  );
  return { client, root, [Symbol.asyncDispose]: () => client.close() };
}

const text = (r) => r.content[0].text;

test("exposes the expected tool surface", async () => {
  const s = await boot();
  try {
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "flow_action", "flow_edge", "flow_figure", "flow_init",
      "flow_options", "flow_remove", "flow_result", "flow_show", "flow_state",
    ]);
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
    // SKYM_STATE_DIR is overridden by folder, which resolves against the cwd.
    const dir = path.join(process.cwd(), "docs", "design", "charts", "placed");
    assert.ok(fs.existsSync(path.join(dir, "graph.json")), `expected chart at ${dir}`);
    fs.rmSync(path.join(process.cwd(), "docs"), { recursive: true, force: true });
  } finally {
    await s.client.close();
  }
});

test("folder cannot escape the project directory", async () => {
  const s = await boot();
  try {
    for (const bad of ["../outside", "../../etc", path.resolve("/tmp/elsewhere")]) {
      const r = await s.client.callTool({
        name: "flow_init",
        arguments: { title: "Escape", folder: bad },
      });
      assert.ok(r.isError, `${bad} should be refused`);
      assert.match(text(r), /inside the project directory/);
    }
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
    assert.equal(saved.title, "My Great Chart!");
  } finally {
    await s.client.close();
  }
});

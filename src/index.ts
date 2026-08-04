#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  GraphStore,
  type Direction,
  type NodeKind,
  type NodeState,
} from "./store.js";
import { toMermaid } from "./mermaid.js";
import { renderChart, validateChart } from "./chart.js";
import { DEFAULT_THEME, paletteFor } from "./theme.js";
import { loadConfig } from "./config.js";
import { allStates, kindDef, openStates, statesFor, type KindDef } from "./vocab.js";
import { startViewer, type Viewer } from "./server.js";

const projectDir = process.env.SKYM_PROJECT_DIR ?? process.cwd();
const preferredPort = Number(process.env.SKYM_PORT ?? 7373);
const autoOpen = process.env.SKYM_NO_OPEN !== "1";

// Charts live in the project so they are visible and committable.
const root = process.env.SKYM_STATE_DIR ?? path.join(projectDir, ".flows");

// One chart per server process — and Claude Code starts one process per chat.
const chartId = process.env.SKYM_CHART_ID ?? randomUUID().slice(0, 8);
fs.mkdirSync(path.join(root, "charts"), { recursive: true });

const store = new GraphStore(root, chartId, "Untitled chart");
// Tools are generated from this, so it must resolve before registration below.
const config = loadConfig(projectDir);
const vocab = config.vocab;
const STATES_FOR = statesFor(vocab);
const OPEN_STATES = openStates(vocab);
let viewer: Viewer | null = null;
let opened = false;

function openBrowser(url: string): void {
  if (!autoOpen || opened) return;
  opened = true;
  const cmd =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  try {
    spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless; URL is still reported in the tool result.
  }
}

async function ensureViewer(): Promise<Viewer> {
  if (!viewer) viewer = await startViewer(store, preferredPort, projectDir);
  openBrowser(`${viewer.url}?chart=${store.chartId}`);
  return viewer;
}

const server = new McpServer({ name: "skym-flow", version: "0.2.0" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

function summary(lead: string, hint?: string): string {
  const g = store.get();
  const byState = g.nodes.reduce<Record<string, number>>((a, n) => {
    a[n.state] = (a[n.state] ?? 0) + 1;
    return a;
  }, {});
  const tally = Object.entries(byState).map(([k, v]) => `${v} ${k}`).join(", ") || "empty";
  const url = viewer ? `${viewer.url}?chart=${store.chartId}` : "(viewer not started)";
  return [lead, hint, `"${g.title}" rev ${g.revision} · ${g.nodes.length} nodes (${tally}) · ${url}`]
    .filter(Boolean)
    .join("\n");
}

const bulletsSchema = z
  .array(z.string().min(1).max(200))
  .max(12)
  .describe(
    "Concise bullet points — the node body. One short clause each, no paragraphs, no trailing periods. E.g. [\"Swap cache to Redis\", \"TTL 60s\"].",
  );

/**
 * Relative paths resolve against the project; absolute paths are taken as
 * given, so a chart can live beside work that is not inside the project.
 */
function resolveFolder(folder: string): string {
  return path.resolve(projectDir, folder);
}

function assertState(kind: NodeKind, state: string | undefined): NodeState | undefined {
  if (state === undefined) return undefined;
  const allowed = STATES_FOR[kind];
  if (!allowed) throw new Error(`Unknown node kind "${kind}".`);
  if (!allowed.includes(state)) {
    throw new Error(`State "${state}" is not valid for a ${kind} node. Use one of: ${allowed.join(", ")}.`);
  }
  return state;
}

/** Free-form prose in a bullet defeats the convention, so reject it early. */
function validateBullets(bullets: string[] | undefined): void {
  if (!bullets) return;
  for (const b of bullets) {
    if (b.length > 200) throw new Error(`Bullet too long (${b.length} chars, max 200): "${b.slice(0, 60)}…"`);
    const sentences = b.split(/[.!?]\s+[A-Z]/).length;
    if (sentences > 2) {
      throw new Error(
        `Bullet reads as prose, not a bullet: "${b.slice(0, 70)}…". Split it into separate short bullets.`,
      );
    }
  }
}

server.registerTool(
  "flow_init",
  {
    title: "Start this chat's chart",
    description:
      "Create the exploration chart for THIS conversation and open the live viewer. Call once at the start. Each chat gets its own chart; the title should name what this chat is about (e.g. \"Fixing the auth redirect loop\").",
    inputSchema: {
      title: z.string().min(1).describe("What this chat is working on. Shown in the viewer and the chart switcher."),
      description: z.string().optional().describe("One-line goal for this exploration."),
      direction: z.enum(["TD", "LR", "BT", "RL"]).optional().describe("Layout. TD (default) reads as a top-down tree."),
      fresh: z
        .boolean()
        .optional()
        .describe(
          "Force a new empty chart even if one with this title exists. Default false — reusing the same title resumes that chart, so a chat picks up where it left off after a restart.",
        ),
      folder: z
        .string()
        .optional()
        .describe(
          "Where to save this chart and its figures. Relative paths resolve against the project directory; the chart lands in <folder>/charts/<slug>/. Defaults to '.flows'. Use this to keep a chart beside the work it documents, e.g. 'docs/design' or 'experiments/run-3'.",
        ),
    },
  },
  async ({ title, description, direction, fresh, folder }) => {
    const root = folder ? resolveFolder(folder) : undefined;
    const { resumed } = store.init(title, description, (direction as Direction) ?? "TD", fresh ?? false, root);
    const v = await ensureViewer();
    const g = store.get();
    return ok(
      summary(
        resumed
          ? `Resumed chart "${title}" with ${g.nodes.length} existing nodes.\nSaved in ${path.relative(projectDir, store.chartDir) || store.chartDir}`
          : `Chart "${title}" ready.\nSaved in ${path.relative(projectDir, store.chartDir) || store.chartDir}`,
        resumed
          ? "Continue the existing tree — check current states before adding nodes, and reuse existing ids to update them."
          : "Next: add an options node for the choices you see, or an action node for what you're doing first.",
      ) + `\nViewer: ${v.url}?chart=${store.chartId}`,
    );
  },
);

/** "planned = candidate step, not started; exploring = …" — teaches the model the vocabulary. */
function stateProse(kind: KindDef): string {
  const each = kind.states.map((s) => `${s.slug} = ${s.blurb}`).join("; ");
  return `${each}. Defaults to ${kind.defaultState}.`;
}

/**
 * One tool per configured kind. The prose is composed from the template, so a
 * project that renames or drops a kind never leaves the model reading about
 * states that no longer exist.
 */
function registerKindTool(kind: KindDef): void {
  const states = kind.states.map((s) => s.slug) as [string, ...string[]];

  const common = {
    id: z.string().min(1).describe(`Stable slug, e.g. 'try-redis-cache'. Reuse it to update this ${kind.slug} node.`),
    title: z.string().optional().describe("Short headline."),
    bullets: bulletsSchema.optional(),
    state: z.enum(states).optional().describe(stateProse(kind)),
    group: z.string().optional().describe("Optional lane, e.g. 'Caching' — clusters related branches."),
  };

  const shape: Record<string, z.ZodTypeAny> = { ...common };
  if (kind.attaches) {
    shape.about = z
      .string()
      .optional()
      .describe("Id of the node this constrains; draws a dashed edge from this node to it.");
  } else {
    shape.after = z.string().optional().describe("Id of the node this follows; draws the edge for you.");
    shape.edge_label = z.string().optional().describe("Label for the edge from `after`.");
  }
  if (kind.fork) {
    shape.options = z
      .array(
        z.object({
          id: z.string().min(1).describe("Slug for this candidate."),
          title: z.string().min(1).describe("Short name of the option."),
          bullets: z.array(z.string().min(1).max(200)).max(12).optional().describe("Why it might work; tradeoffs."),
        }),
      )
      .min(2)
      .describe("The candidates. At least two — a fork with one option is not a fork.");
  }

  server.registerTool(
    `flow_${kind.slug}`,
    {
      title: `Add or update a ${kind.slug} node`,
      description: `${kind.blurb} Body must be concise bullets.`,
      inputSchema: shape,
    },
    async (args: Record<string, unknown>) => {
      const { id, title, bullets, state, group, after, edge_label, about } = args as {
        id: string;
        title?: string;
        bullets?: string[];
        state?: string;
        group?: string;
        after?: string;
        edge_label?: string;
        about?: string;
      };
      validateBullets(bullets);
      // A new node takes the kind's default; an update with no state keeps its own.
      const resolved = assertState(kind.slug, state) ?? (store.findNode(id) ? undefined : kind.defaultState);
      store.upsertNode({ id, title, kind: kind.slug, state: resolved, bullets, group });
      if (after) {
        if (!store.findNode(after)) throw new Error(`Cannot link from unknown node "${after}".`);
        store.addEdge(after, id, edge_label, false);
      }
      if (about) {
        if (!store.findNode(about)) throw new Error(`Cannot attach a ${kind.slug} to unknown node "${about}".`);
        store.addEdge(id, about, undefined, true);
      }

      if (kind.fork) {
        const options = (args.options ?? []) as Array<{ id: string; title: string; bullets?: string[] }>;
        // Candidates are actions when the vocabulary has one, else the fork's own kind.
        const seedKind = kindDef(vocab, "action") ?? kind;
        for (const o of options) {
          validateBullets(o.bullets);
          // Only seed a candidate if it is new — never clobber an explored branch.
          if (!store.findNode(o.id)) {
            store.upsertNode({
              id: o.id,
              title: o.title,
              kind: seedKind.slug,
              state: seedKind.defaultState,
              bullets: o.bullets ?? [],
              group,
            });
          }
          store.addEdge(id, o.id, undefined, true);
        }
        await ensureViewer();
        return ok(
          summary(
            `Branch "${id}" with ${options.length} options.`,
            `Candidates start as '${seedKind.defaultState}'. Set one to 'exploring' when you start it, and mark the rest 'abandoned' if ruled out.`,
          ),
        );
      }

      await ensureViewer();
      const node = store.findNode(id)!;
      let hint: string | undefined;
      if (kind.wantsFigure && node.figures.length === 0) {
        hint =
          "No figure attached. If this has anything visual — a plot, screenshot, or diagram — attach it with flow_figure.";
      } else if (state === "done") {
        const resultKind = vocab.kinds.find((k) => k.wantsFigure);
        if (resultKind) hint = `Now record what happened with flow_${resultKind.slug} — that is where the findings and figures live.`;
      }
      return ok(summary(`${kind.label} "${id}" saved.`, hint));
    },
  );
}

for (const kind of vocab.kinds) registerKindTool(kind);

server.registerTool(
  "flow_state",
  {
    title: "Update a node's state",
    description:
      "Move a node to a new state. Call this as work happens — set an action to 'exploring' when starting and 'done'/'abandoned' when it resolves, so the chart tracks reality.",
    inputSchema: {
      id: z.string().describe("Node id."),
      state: z
        .enum(allStates(vocab).map((s) => s.slug) as [string, ...string[]])
        .describe("Must be valid for that node's kind."),
    },
  },
  async ({ id, state }) => {
    const node = store.findNode(id);
    if (!node) throw new Error(`No node with id "${id}".`);
    assertState(node.kind, state);
    store.setState(id, state as NodeState);
    await ensureViewer();
    return ok(summary(`"${id}" → ${state}.`));
  },
);

server.registerTool(
  "flow_edge",
  {
    title: "Connect two nodes",
    description: "Link nodes when the relation is not a simple follow-on (which `after` already handles).",
    inputSchema: {
      from: z.string(),
      to: z.string(),
      label: z.string().optional().describe("Edge text, e.g. 'if it regresses'."),
      dashed: z.boolean().optional().describe("Dashed = tentative, optional, or an unexplored branch."),
    },
  },
  async ({ from, to, label, dashed }) => {
    for (const id of [from, to]) {
      if (!store.findNode(id)) throw new Error(`No node with id "${id}".`);
    }
    store.addEdge(from, to, label, dashed ?? false);
    await ensureViewer();
    return ok(summary(`Edge ${from} → ${to}.`));
  },
);

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
};

server.registerTool(
  "flow_figure",
  {
    title: "Attach a figure to a node",
    description:
      "Embed an image on a node — normally a result. Use for plots, screenshots, diagrams, benchmark charts. Accepts a file path or base64 data.",
    inputSchema: {
      node_id: z.string(),
      path: z.string().optional().describe("Local image path; relative paths resolve against the project dir."),
      base64: z.string().optional().describe("Raw base64 image data."),
      mime: z.string().optional().describe("MIME for base64, e.g. 'image/png' or 'image/svg+xml'."),
      caption: z.string().optional().describe("What the figure shows."),
      replace: z
        .boolean()
        .optional()
        .describe(
          "Drop the node's existing figures (and their files) instead of appending. Use when re-attaching a corrected version of the same figure.",
        ),
    },
  },
  async ({ node_id, path: filePath, base64, mime, caption, replace }) => {
    if (!filePath && !base64) throw new Error("Provide either 'path' or 'base64'.");
    let data: Buffer;
    let ext = "png";
    let type = mime ?? "image/png";
    if (filePath) {
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectDir, filePath);
      if (!fs.existsSync(abs)) throw new Error(`No such file: ${abs}`);
      data = fs.readFileSync(abs);
      ext = (path.extname(abs).slice(1) || "png").toLowerCase();
      type = mime ?? EXT_MIME[ext] ?? "application/octet-stream";
    } else {
      data = Buffer.from(base64!.replace(/^data:[^;]+;base64,/, ""), "base64");
      // "image/svg+xml" must yield "svg", not "svg+xml".
      ext = (type.split("/")[1] ?? "png").split("+")[0].replace("jpeg", "jpg");
    }
    const had = store.findNode(node_id)?.figures.length ?? 0;
    store.attachFigure(node_id, data, type, caption, ext, replace ?? false);
    await ensureViewer();
    return ok(
      summary(
        replace && had
          ? `Figure replaced on "${node_id}" (${had} removed).`
          : `Figure attached to "${node_id}".`,
      ),
    );
  },
);

server.registerTool(
  "flow_find",
  {
    title: "Search this chat's chart",
    description:
      "Find nodes by text, kind, or state without dumping the whole chart. Use this when resuming a chart you did not build, to check what is still open, or to recover a node id before updating it. Returns ids you can pass straight to the other tools.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Case-insensitive text to match against ids, titles, and bullets."),
      kind: z
        .enum(vocab.kinds.map((k) => k.slug) as [string, ...string[]])
        .optional()
        .describe("Only this kind."),
      state: z
        .enum(allStates(vocab).map((s) => s.slug) as [string, ...string[]])
        .optional()
        .describe("Only this state. 'planned' finds unexplored branches; 'exploring' finds work left running."),
      unresolved: z
        .boolean()
        .optional()
        .describe(`Only what still needs attention: ${OPEN_STATES.join(", ")}.`),
      limit: z.number().int().min(1).max(100).optional().describe("Cap the result count (default 25)."),
    },
  },
  async ({ query, kind, state, unresolved, limit }) => {
    const g = store.get();
    const needle = query?.toLowerCase();

    const hits = g.nodes.filter((n) => {
      if (kind && n.kind !== kind) return false;
      if (state && n.state !== state) return false;
      if (unresolved && !OPEN_STATES.includes(n.state)) return false;
      if (!needle) return true;
      return (
        n.id.toLowerCase().includes(needle) ||
        n.title.toLowerCase().includes(needle) ||
        n.bullets.some((b) => b.toLowerCase().includes(needle))
      );
    });

    if (!hits.length) {
      return ok(summary("No nodes matched.", "Try a broader query, or flow_show to see the whole chart."));
    }

    const shown = hits.slice(0, limit ?? 25);
    const lines = shown.map((n) => {
      const edges = g.edges.filter((e) => e.to === n.id).map((e) => e.from);
      const after = edges.length ? ` ← ${edges.join(", ")}` : "";
      const figures = n.figures.length ? ` [${n.figures.length} fig]` : "";
      return `  ${n.id}  (${n.kind}/${n.state})${figures}  ${n.title}${after}`;
    });
    const more = hits.length > shown.length ? `\n  … ${hits.length - shown.length} more` : "";
    return ok(summary(`${hits.length} match${hits.length === 1 ? "" : "es"}:\n${lines.join("\n")}${more}`));
  },
);

server.registerTool(
  "flow_chart",
  {
    title: "Draw a chart from data",
    description:
      "Attach a chart to a node from numbers directly — no image generation, and it is drawn in the chart's own palette so it matches the cards. Prefer this over flow_figure whenever the evidence is numeric. Use kind:'bar' to compare values, 'line' for a trend, 'stat' for a single headline number.",
    inputSchema: {
      node_id: z.string().describe("Node to attach the chart to — normally a result."),
      kind: z
        .enum(["bar", "line", "stat"])
        .describe(
          "bar = compare magnitudes; line = change over time; stat = one headline number. Pick by what the reader must do.",
        ),
      points: z
        .array(
          z.object({
            label: z.string().min(1).describe("Category, time bucket, or (for a stat) what the number is."),
            value: z.number().describe("The measurement."),
            emphasis: z
              .boolean()
              .optional()
              .describe("Marks the one point that matters; the rest recede. Use sparingly."),
          }),
        )
        .min(1)
        .max(12)
        .describe("The data. At most 12 — past that a card-sized chart cannot label the points."),
      title: z.string().optional().describe("Short label above the chart, e.g. 'p99 by build'."),
      unit: z.string().optional().describe("Appended to values, e.g. 'ms', '%', 'MB'."),
      delta: z.string().optional().describe("Stat only: the change, e.g. '-77% vs baseline'."),
      caption: z.string().optional().describe("What the chart shows."),
      replace: z.boolean().optional().describe("Drop existing figures on the node instead of appending."),
    },
  },
  async ({ node_id, kind, points, title, unit, delta, caption, replace }) => {
    const node = store.findNode(node_id);
    if (!node) throw new Error(`No node with id "${node_id}".`);
    const spec = { kind, points, title, unit, delta };
    validateChart(spec);

    // Rendered light: the card lays figures on a light plate in both themes.
    const palette = paletteFor(DEFAULT_THEME, "light");
    const accent = palette.states[node.state]?.accent ?? palette.focus;
    const box = { width: 320, height: kind === "stat" ? 120 : 170 };
    const svg = renderChart(spec, box, DEFAULT_THEME, palette, accent);

    store.attachFigure(node_id, Buffer.from(svg, "utf8"), "image/svg+xml", caption, "svg", replace ?? false);
    await ensureViewer();
    return ok(summary(`Chart attached to "${node_id}" (${kind}, ${points.length} points).`));
  },
);

server.registerTool(
  "flow_remove",
  {
    title: "Remove a node or edge",
    description:
      "Delete a node (and its edges) or one edge. Prefer setting state to 'abandoned' over deleting — a visible dead end is more useful than a gap.",
    inputSchema: {
      node_id: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
  },
  async ({ node_id, from, to }) => {
    if (node_id) store.removeNode(node_id);
    else if (from && to) store.removeEdge(from, to);
    else throw new Error("Provide either 'node_id' or both 'from' and 'to'.");
    await ensureViewer();
    return ok(summary("Removed."));
  },
);

server.registerTool(
  "flow_show",
  {
    title: "Show the chart",
    description: "Return the current chart as Mermaid source and re-open the viewer.",
    inputSchema: {
      reopen: z.boolean().optional().describe("Force the browser to open again."),
      list_charts: z.boolean().optional().describe("Also list other chats' charts in this project."),
    },
  },
  async ({ reopen, list_charts }) => {
    if (reopen) opened = false;
    const v = await ensureViewer();
    let extra = "";
    if (list_charts) {
      const charts = store.listCharts();
      extra =
        "\n\nCharts in this project:\n" +
        charts
          .map((c) => `  ${c.active ? "▸" : " "} ${c.chartId}  ${c.title}  (${c.nodes} nodes, rev ${c.revision})`)
          .join("\n");
    }
    return ok(
      `${summary(`Viewer: ${v.url}?chart=${store.chartId}`)}${extra}\n\n\`\`\`mermaid\n${toMermaid(store.get())}\n\`\`\``,
    );
  },
);

server.registerResource(
  "chart",
  "skym://chart",
  { title: "Current chart", description: "Mermaid source for this chat's chart.", mimeType: "text/vnd.mermaid" },
  async () => ({
    contents: [{ uri: "skym://chart", mimeType: "text/vnd.mermaid", text: toMermaid(store.get()) }],
  }),
);

const shutdown = () => {
  store.release();
  viewer?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => store.release());

await server.connect(new StdioServerTransport());

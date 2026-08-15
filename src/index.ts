#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
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
import { dataPointsFromFile } from "./data.js";
import { DEFAULT_THEME, paletteFor } from "./theme.js";
import { loadConfig } from "./config.js";
import { allStates, kindDef, openStates, type KindDef } from "./vocab.js";
import { checkBullets, checkState } from "./validate.js";
import type { Entry } from "./ops.js";
import {
  SyncClient,
  clearPendingPairing,
  readPendingPairing,
  tryRedeem,
  writePendingPairing,
  readCredentials,
  startPairing,
  writeCredentials,
  type PairingPrompt,
} from "./sync.js";


const projectDir = process.env.SKYM_PROJECT_DIR ?? process.cwd();
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
const OPEN_STATES = openStates(vocab);

let opened = false;
let sync: SyncClient | null = null;


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

/**
 * Connects the chart to the hosted service, if one is configured.
 *
 * Pairing is deliberately not awaited inside a tool call: the user has to
 * approve in a browser, which can take a minute, and a tool that blocks that
 * long reads as a hang. An unpaired agent gets instructions back instead, and
 * the chart keeps working locally in the meantime.
 */
async function ensureSync(): Promise<string | null> {
  if (!config.service) return null;
  if (sync) return null;

  let creds = readCredentials();

  if (!creds || creds.url !== config.service) {
    // A code from an earlier process may already be approved — redeem that
    // before asking the user to approve anything again.
    const pending = readPendingPairing();
    if (pending) {
      try {
        const out = await tryRedeem(config.service, pending.deviceCode);
        if (out.status === "ready" && out.token) {
          creds = { url: config.service, token: out.token };
          writeCredentials(creds);
          clearPendingPairing();
        } else if (out.status === "expired") {
          clearPendingPairing();
        } else {
          return pairingNotice(pending);
        }
      } catch {
        return pairingNotice(pending);
      }
    }
  }

  if (!creds || creds.url !== config.service) {
    try {
      const prompt = await startPairing(config.service);
      writePendingPairing(prompt);
      openBrowser(prompt.verificationUri);
      return pairingNotice(prompt);
    } catch (err) {
      return `Could not reach the skym service at ${config.service}: ${(err as Error).message}`;
    }
  }

  const client = new SyncClient({
    url: creds.url,
    token: creds.token,
    chartId: store.chartId,
    onError: () => {
      /* surfaced through summary(), not thrown into a tool call */
    },
  });
  try {
    await client.attach({
      repoKey: repoKey(),
      projectName: path.basename(projectDir),
      slug: store.chartId,
      title: store.get().title,
      vocab,
    });
  } catch (err) {
    return `Chart is local only — the service rejected it: ${(err as Error).message}`;
  }

  sync = client;

  // Everything committed before the subscription existed — the ops from
  // flow_init itself, and anything added while pairing was still pending.
  // Without this the service only ever sees a chart from the moment it
  // connected, which for a first run is nothing at all. Re-sending is safe:
  // ops carry ids and the server dedupes.
  for (const entry of store.readLog()) {
    client.enqueue(entry);
    queueFigure(client, entry);
  }

  // Figures already on the graph, whose bytes may never have been sent: charts
  // written before uploads existed, or a sync that dropped out mid-flush. The
  // service is asked what it is missing before anything is read off disk, so
  // this costs one request when there is nothing to do.
  for (const node of store.get().nodes) {
    for (const figure of node.figures) {
      client.enqueueFigure({
        file: figure.file,
        path: path.join(store.assetsDir, figure.file),
        mime: figure.mime ?? "image/png",
      });
    }
    for (const artifact of node.artifacts ?? []) {
      client.enqueueFigure({
        file: artifact.file,
        path: path.join(store.assetsDir, artifact.file),
        mime: artifact.mime,
      });
    }
  }

  // Ops are queued as they commit; the client drains on its own timer.
  store.subscribe((_g, entry) => {
    if (!entry) return;
    client.enqueue(entry);
    queueFigure(client, entry);
  });
  return null;
}

/**
 * A figure.add op names a file but carries no bytes, so the blob is queued
 * separately or the hosted viewer renders a broken image.
 */
function queueFigure(client: SyncClient, entry: Entry): void {
  if (entry.op.t !== "figure.add" && entry.op.t !== "file.add") return;
  const item = entry.op.t === "figure.add" ? entry.op.figure : entry.op.artifact;
  const { file, mime } = item;
  client.enqueueFigure({
    file,
    path: path.join(store.assetsDir, file),
    mime: mime ?? "image/png",
  });
}

const pairingNotice = (p: PairingPrompt): string =>
  `Connect this agent to skym: open ${p.verificationUri} and enter code ${p.userCode}\n` +
  `Approve it whenever — the code is remembered, so the next chart tool picks it up.`;

/** Identifies the project so charts land under it without the user naming one. */
function repoKey(): string | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (url) return url.replace(/\.git$/, "");
  } catch {
    // Not a git repo, or no origin — fall back to the folder.
  }
  return path.basename(projectDir);
}

/**
 * The chart lives on the service, so that is what the browser opens. There is
 * one viewer at one URL — no local server, and no second copy of the UI that
 * can drift from it.
 */
function chartUrl(): string {
  return `${config.service.replace(/\/$/, "")}/chart?chart=${encodeURIComponent(store.chartId)}`;
}

async function ensureViewer(): Promise<string> {
  const url = chartUrl();
  openBrowser(url);
  // Approval happens in a browser mid-session, so retry until it lands.
  if (!sync) await ensureSync().catch(() => null);
  // Flush here rather than on shutdown: an MCP server exits when its stdio
  // closes, which fires neither SIGINT nor SIGTERM, and `exit` cannot await.
  // A tool call is already async, so the round trip costs nothing structural.
  if (sync?.pending) await sync.flush().catch(() => null);
  if (sync) await sync.refreshPendingCommands().catch(() => null);
  return url;
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
  const url = chartUrl();
  const prompts = sync?.pendingCommands ?? 0;
  return [lead, hint, `"${g.title}" rev ${g.revision} · ${g.nodes.length} nodes (${tally}) · ${prompts} pending prompt${prompts === 1 ? "" : "s"} · ${url}`]
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

/** Re-evaluate badge recipes when the chart is read, so source-file changes cannot silently diverge. */
function refreshDerivedBadges(): void {
  for (const node of [...store.get().nodes]) {
    const recipe = node.derivedBadge;
    if (!recipe) continue;
    try {
      const file = path.isAbsolute(recipe.source) ? recipe.source : path.resolve(projectDir, recipe.source);
      const selected = dataPointsFromFile(file, { kind: recipe.kind ?? "stat", valueColumn: recipe.valueColumn });
      const value = selected.points.at(-1)!.value;
      const badge = recipe.format === "fraction" ? `${value} / ${selected.totalRows}`
        : recipe.format === "percent" ? `${((value / selected.totalRows) * 100).toFixed(1)}%` : `${value}`;
      if (badge !== node.badge) store.upsertNode({ id: node.id, badge });
    } catch {
      // Keep the last verified value; the recipe remains available for the next refresh.
    }
  }
}

const assertState = (kind: NodeKind, state: string | undefined): NodeState | undefined =>
  checkState(vocab, kind, state);

const validateBullets = (bullets: string[] | undefined): void => checkBullets(bullets);

server.registerTool(
  "flow_init",
  {
    title: "Start this chat's chart",
    description:
      "Create the exploration chart for THIS conversation and open the live viewer. Call once at the start. Each chat gets its own chart; the title should name what this chat is about (e.g. \"Fixing the auth redirect loop\").",
    inputSchema: {
      title: z.string().min(1).optional().describe("Required when creating; optional when resuming by chart_id."),
      chart_id: z.string().optional().describe("Exact id returned by flow_show({list_charts:true})."),
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
  async ({ title, chart_id, description, direction, fresh, folder }) => {
    const root = folder ? resolveFolder(folder) : undefined;
    if (!title && !chart_id) throw new Error("Provide title or chart_id.");
    if (fresh && !title) throw new Error("title is required with fresh:true.");
    const resolvedTitle = title ?? store.listCharts().find((c) => c.chartId === chart_id)?.title;
    if (!resolvedTitle) throw new Error(`No chart with chart_id "${chart_id}".`);
    const { resumed } = store.init(resolvedTitle, description, (direction as Direction) ?? "TD", fresh ?? false, root, chart_id, fresh !== undefined || !!chart_id);
    // init renames the chart to a slug derived from the title. A tool called
    // before this one would already have attached under the random per-process
    // id, forking a fresh chart on the service for every chat — the same title
    // over and over on the dashboard. Re-attach so the row follows the slug
    // that actually identifies this chart.
    if (sync) await sync.reattach(store.chartId, store.get().title).catch(() => {});
    // ensureViewer connects the sync and flushes; its note is what the user
    // needs to see when pairing is still outstanding.
    const syncNote = await ensureSync();
    const v = await ensureViewer();
    const g = store.get();
    return ok(
      summary(
        resumed
          ? `Resumed chart "${resolvedTitle}" (${store.chartId}) with ${g.nodes.length} existing nodes.\nSaved in ${path.relative(projectDir, store.chartDir) || store.chartDir}`
          : `Chart "${resolvedTitle}" (${store.chartId}) ready.\nSaved in ${path.relative(projectDir, store.chartDir) || store.chartDir}`,
        resumed
          ? "Continue the existing tree — check current states before adding nodes, and reuse existing ids to update them."
          : "Next: add an options node for the choices you see, or an action node for what you're doing first.",
      ) +
        `\nViewer: ${v}` +
        (syncNote ? `\n\n${syncNote}` : ""),
    );
  },
);

server.registerTool("flow_rename", {
  title: "Rename the current chart",
  description: "Change the display title without changing its stable chart_id.",
  inputSchema: { title: z.string().min(1) },
}, async ({ title }) => {
  store.rename(title);
  await ensureViewer();
  return ok(summary(`Renamed chart to "${title}".`));
});

server.registerTool("flow_delete", {
  title: "Delete a chart",
  description: "Permanently delete the active local chart. Requires its exact chart_id as confirmation.",
  inputSchema: { chart_id: z.string() },
}, async ({ chart_id }) => {
  if (chart_id !== store.chartId) throw new Error(`Confirmation must equal active chart_id "${store.chartId}".`);
  if (sync) await sync.deleteChart();
  store.deleteChart();
  return ok(`Deleted chart "${chart_id}" locally${sync ? " and from the hosted service" : ""}. This cannot be recovered by skym.`);
});

server.registerTool("flow_merge", {
  title: "Merge another chart into this chart",
  description: "Copy nodes and edges from another chart_id. Conflicting node ids are prefixed with the source chart_id.",
  inputSchema: { chart_id: z.string() },
}, async ({ chart_id }) => {
  const merged = store.mergeFrom(chart_id);
  await ensureViewer();
  return ok(summary(`Merged ${merged.nodes} nodes and ${merged.edges} edges from "${chart_id}".`));
});

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
    title: z.string().optional().describe(kind.content?.title ?? "Short headline with the key concept."),
    bullets: bulletsSchema.optional().describe(kind.content?.bullets ?? "Concise supporting points."),
    state: z.enum(states).optional().describe(stateProse(kind)),
    group: z.string().optional().describe("Optional lane, e.g. 'Caching' — clusters related branches."),
    badge: z.string().max(24).nullable().optional().describe(
      "Compact marker at the card's top-left: a count ('10,000'), reduction ('27 / 600'), or final id. Null clears it.",
    ),
    provenance: z.object({
      script: z.string().optional(),
      output_path: z.string().optional(),
      job_id: z.string().optional(),
      date: z.string().optional(),
      commit: z.string().optional(),
    }).nullable().optional().describe("Structured, searchable origin of this result."),
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
      description: [kind.blurb, kind.content?.template, kind.content?.figure].filter(Boolean).join(" "),
      inputSchema: shape,
    },
    async (args: Record<string, unknown>) => {
      const { id, title, bullets, state, group, badge, provenance, after, edge_label, about } = args as {
        id: string;
        title?: string;
        bullets?: string[];
        state?: string;
        group?: string;
        badge?: string | null;
        provenance?: { script?: string; output_path?: string; job_id?: string; date?: string; commit?: string } | null;
        after?: string;
        edge_label?: string;
        about?: string;
      };
      validateBullets(bullets);
      // A new node takes the kind's default; an update with no state keeps its own.
      const resolved = assertState(kind.slug, state) ?? (store.findNode(id) ? undefined : kind.defaultState);
      store.upsertNode({ id, title, kind: kind.slug, state: resolved, bullets, group, badge,
        provenance: provenance === null ? null : provenance ? { script: provenance.script, outputPath: provenance.output_path, jobId: provenance.job_id, date: provenance.date, commit: provenance.commit } : undefined });
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
        hint = `No figure attached. ${kind.content?.figure ??
          "If this has anything visual — a plot, screenshot, or diagram — attach it with flow_figure."}`;
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
  py: "text/x-python",
  js: "text/javascript",
  ts: "text/plain",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  zip: "application/zip",
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
  "flow_file",
  {
    title: "Attach a file to a node",
    description:
      "Attach a local source file, configuration, report, archive, or other reproducibility artifact. Skym copies and syncs the bytes without putting file contents in model context.",
    inputSchema: {
      node_id: z.string().describe("Existing node that this file documents."),
      path: z.string().describe("Local file path; relative paths resolve against the project directory."),
      label: z.string().max(120).optional().describe("Short explanation of what this file represents."),
      mime: z.string().optional().describe("Override MIME type when the extension is ambiguous."),
    },
  },
  async ({ node_id, path: filePath, label, mime }) => {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectDir, filePath);
    if (!fs.existsSync(abs)) throw new Error(`No such file: ${abs}`);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const type = mime ?? EXT_MIME[ext] ?? "application/octet-stream";
    store.attachArtifact(node_id, abs, type, label);
    await ensureViewer();
    return ok(summary(`File "${path.basename(abs)}" attached to "${node_id}".`));
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
    await ensureViewer();
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
        n.bullets.some((b) => b.toLowerCase().includes(needle)) ||
        Object.values(n.provenance ?? {}).some((value) => value?.toLowerCase().includes(needle))
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
      const files = n.artifacts?.length ? ` [${n.artifacts.length} file]` : "";
      const badge = n.badge ? ` [${n.badge}]` : "";
      const provenance = n.provenance ? ` {${Object.entries(n.provenance).map(([k,v]) => `${k}=${v}`).join(", ")}}` : "";
      return `  ${n.id}  (${n.kind}/${n.state})${badge}${figures}${files}  ${n.title}${after}${provenance}`;
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
  "flow_data",
  {
    title: "Visualize a local data file",
    description:
      "Point at a CSV, TSV, or JSON file and let skym read it locally and render an SVG. Only the compact generated figure is synchronized; the source dataset is not uploaded or copied into the prompt.",
    inputSchema: {
      node_id: z.string().describe("Result node that should carry the generated visualization."),
      path: z.string().min(1).describe("Data file path, relative to the project or absolute."),
      kind: z.enum(["bar", "line", "stat"]).describe("bar compares values; line shows ordered change; stat shows the last value."),
      label_column: z.string().optional().describe("Column used for labels. Inferred when omitted."),
      value_column: z.string().optional().describe("Numeric column to plot. Inferred when omitted."),
      max_points: z.number().int().min(2).max(12).optional().describe("Maximum rendered points. Defaults to 12."),
      title: z.string().optional(),
      unit: z.string().optional(),
      caption: z.string().optional(),
      replace: z.boolean().optional(),
      badge: z.enum(["value", "fraction", "percent"]).optional().describe("Derive and store a badge from the selected last value; fraction/percent use total source rows as denominator."),
    },
  },
  async ({ node_id, path: source, kind, label_column, value_column, max_points, title, unit, caption, replace, badge }) => {
    const node = store.findNode(node_id);
    if (!node) throw new Error(`No node with id "${node_id}".`);
    const file = path.isAbsolute(source) ? source : path.resolve(projectDir, source);
    const selected = dataPointsFromFile(file, {
      kind,
      labelColumn: label_column,
      valueColumn: value_column,
      maxPoints: max_points,
    });
    const spec = { kind, points: selected.points, title, unit };
    const palette = paletteFor(DEFAULT_THEME, "light");
    const accent = palette.states[node.state]?.accent ?? palette.focus;
    const box = { width: 320, height: kind === "stat" ? 120 : 170 };
    const svg = renderChart(spec, box, DEFAULT_THEME, palette, accent);
    store.attachFigure(
      node_id,
      Buffer.from(svg, "utf8"),
      "image/svg+xml",
      caption ?? `${selected.valueColumn} by ${selected.labelColumn} from ${path.basename(file)}`,
      "svg",
      replace ?? false,
    );
    if (badge) {
      const value = selected.points.at(-1)!.value;
      const formatted = badge === "value" ? `${value}` : badge === "fraction"
        ? `${value} / ${selected.totalRows}`
        : `${((value / selected.totalRows) * 100).toFixed(1)}%`;
      store.upsertNode({ id: node_id, badge: formatted, derivedBadge: {
        source: path.relative(projectDir, file), kind, valueColumn: selected.valueColumn, row: "last", format: badge,
      } });
    }
    await ensureViewer();
    return ok(summary(
      `Data chart attached to "${node_id}" from ${path.basename(file)}.`,
      `Read ${selected.totalRows} rows locally; rendered ${selected.points.length} points. The source dataset was not uploaded.`,
    ));
  },
);

server.registerTool("flow_retract", {
  title: "Retract a result",
  description: "Mark a node as retracted: its claim or measurement was wrong, distinct from a failed experiment.",
  inputSchema: { node_id: z.string(), reason: z.string().min(1).max(200), replaced_by: z.string().optional() },
}, async ({ node_id, reason, replaced_by }) => {
  const node = store.findNode(node_id);
  if (!node) throw new Error(`No node with id "${node_id}".`);
  assertState(node.kind, "retracted");
  if (replaced_by && !store.findNode(replaced_by)) throw new Error(`No replacement node with id "${replaced_by}".`);
  store.upsertNode({ id: node_id, state: "retracted", bullets: [...node.bullets, `Retracted: ${reason}`, ...(replaced_by ? [`Replaced by ${replaced_by}`] : [])].slice(0, 12) });
  if (replaced_by) store.addEdge(node_id, replaced_by, "superseded by", true);
  await ensureViewer();
  return ok(summary(`Retracted "${node_id}".`));
});

server.registerTool("flow_lineage", {
  title: "Trace artifact provenance",
  description: "Find a node by id, artifact name, output path, job id, or script and trace all incoming ancestors to origins.",
  inputSchema: { query: z.string().min(1) },
}, async ({ query }) => {
  await ensureViewer();
  const g = store.get();
  const q = query.toLowerCase();
  const targets = g.nodes.filter((n) => n.id.toLowerCase() === q || n.artifacts.some((a) => a.name.toLowerCase().includes(q)) || Object.values(n.provenance ?? {}).some((v) => v?.toLowerCase().includes(q)));
  if (!targets.length) return ok(summary(`No provenance chain found for "${query}".`));
  const lines: string[] = [];
  const visit = (id: string, depth: number, seen: Set<string>) => {
    if (seen.has(id)) return lines.push(`${"  ".repeat(depth)}↳ ${id} (cycle)`);
    const n = g.nodes.find((x) => x.id === id); if (!n) return;
    lines.push(`${"  ".repeat(depth)}${depth ? "↳ " : ""}${n.id}: ${n.title}`);
    const next = new Set(seen); next.add(id);
    for (const e of g.edges.filter((x) => x.to === id)) visit(e.from, depth + 1, next);
  };
  for (const target of targets) visit(target.id, 0, new Set());
  return ok(summary(`Provenance chain for "${query}":\n${lines.join("\n")}`));
});

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
  "flow_inbox",
  {
    title: "Claim work requested from the hosted chart",
    description:
      "Claim the oldest queued instruction for this chart. Call at natural checkpoints. A claimed item has a thirty-minute lease and must be advanced with flow_command_state.",
    inputSchema: {},
  },
  async () => {
    const note = await ensureSync();
    if (!sync) return ok(summary(note ?? "Hosted sync is not connected, so there is no command inbox."));
    const command = await sync.claimCommand();
    if (!command) return ok(summary("No queued hosted commands."));
    return ok(summary(
      `Claimed command ${command.id}\nVerb: ${command.verb}\nNode: ${command.nodeId ?? "(chart)"}\n\n${command.body ?? "No additional instructions."}\n\nCall flow_command_state with state:'running', then 'done' or 'failed'.`,
    ));
  },
);

server.registerTool(
  "flow_command_state",
  {
    title: "Update a hosted command",
    description: "Mark a command claimed through flow_inbox as running, done, or failed. Terminal states may include a concise result.",
    inputSchema: {
      command_id: z.string().uuid(),
      state: z.enum(["running", "done", "failed"]),
      result: z.string().max(8000).optional(),
    },
  },
  async ({ command_id, state, result }) => {
    await ensureSync();
    if (!sync) return ok(summary("Hosted sync is not connected; the command state was not changed."));
    const command = await sync.updateCommand(command_id, state, result);
    return ok(summary(`Command ${command.id}: ${command.status}.`));
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
    refreshDerivedBadges();
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
      `${summary(`Viewer: ${v}`)}${extra}\n\n\`\`\`mermaid\n${toMermaid(store.get())}\n\`\`\``,
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

  if (!sync) process.exit(0);
  // Give the queue a moment to drain rather than dropping the last ops.
  const bail = setTimeout(() => process.exit(0), 3000);
  bail.unref?.();
  void sync.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => store.release());

await server.connect(new StdioServerTransport());

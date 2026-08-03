# skym-flow

An MCP server that keeps a live **exploration chart** of what an agent is doing: what was tried, what was ruled out, and what the results were. Claude builds the tree through tools; a local page renders it and repaints instantly over SSE, with figures embedded on result nodes.

Charts are drawn by a purpose-built renderer — [dagre](https://github.com/dagrejs/dagre) for layout, hand-written SVG for the cards — so the viewer ships 71 KB and a self-contained export of a small chart is about 30 KB.

Each chat gets its own chart, saved in the project under `.flows/`.

## Install

```bash
npm install
npm run build
claude mcp add skym-flow -- node "<abs-path>/dist/index.js"
```

Then copy `CLAUDE.md.example` into your project's `CLAUDE.md` — the tools do nothing unless Claude is told to call them.

## The model

Three node kinds, all rendered as rounded rectangles and distinguished by colour and border:

| Kind | Meaning | States |
| --- | --- | --- |
| **action** | something done or to be done | `planned` `exploring` `done` `abandoned` `blocked` |
| **result** | what an action produced | `good` `bad` `mixed` `inconclusive` |
| **options** | a fork with candidate branches | `open` `resolved` |

`flow_options` creates the branch point *and* one `planned` action per candidate, so alternatives you did not pursue stay on the chart instead of being forgotten.

Node bodies are concise bullets. The server rejects prose-shaped bullets, rejects states that do not belong to a node's kind, rejects forks with fewer than two options, and nudges (without failing) when a result has no figure attached.

## Tools

| Tool | Purpose |
| --- | --- |
| `flow_init` | Start this chat's chart and open the viewer. `folder:` chooses where it is saved. |
| `flow_action` | Add/update an action. `after:` chains it to a previous node. |
| `flow_result` | Add/update a result. Attach evidence with `flow_figure`. |
| `flow_options` | Record a fork and seed its candidate branches. |
| `flow_state` | Move a node to a new state as work progresses. |
| `flow_edge` | Link nodes when the relation is not a simple follow-on. |
| `flow_chart` | Draw a chart from data — no image generation, styled to match the cards. |
| `flow_figure` | Embed an image on a node, from a path or base64. `replace:` swaps it instead of appending. |
| `flow_remove` | Delete a node or edge — prefer `abandoned` over deleting. |
| `flow_show` | Return Mermaid source; `list_charts:true` lists other chats' charts. |

## Charts from data

`flow_chart` draws the figure instead of generating an image — point it at numbers and it renders in the chart's own palette, so evidence costs no image generation and never looks pasted in:

```
flow_chart({ node_id: "bench", kind: "bar", unit: "ms", title: "p99 by build",
             points: [{ label: "before", value: 840 },
                      { label: "after", value: 190, emphasis: true }] })
```

Three forms, picked by what the reader has to do: **bar** to compare magnitudes, **line** for change over time, **stat** for a single headline number. `emphasis` marks the one point that matters and lets the rest recede. Charts are stored as ordinary SVG figures, so they zoom, export, and embed in `flow.html` like any other. Use `flow_figure` when the evidence is a real screenshot or an externally produced plot.

## Storage

```
.flows/
  charts/
    index.json                       ← every chart in the project
    speed-up-the-search-endpoint/
      log.jsonl                      ← append-only history; the source of truth
      graph.json                     ← versioned snapshot of the fold
      flow.html                      ← self-contained offline viewer
      assets/                        ← figures
    debug-the-flaky-ci-runner/
      log.jsonl
      graph.json
      flow.html
```

Every mutation appends one operation to `log.jsonl`, and the chart is the fold of that log; `graph.json` caches the fold and carries a schema version. The log wins on read, so a crash between the append and the snapshot write costs nothing — replaying recovers it. Charts written before the log existed are read as-is and have their log reconstructed on first write, so no history is lost to the format change.

Directories are named from the chart title, with a numeric suffix on collision. `graph.json` and `flow.html` are replaced atomically, so a crash mid-write cannot corrupt them.

**Offline viewing.** Every chart update regenerates `flow.html`. Both themes are
rendered ahead of time and embedded along with the figures, so the file carries
no layout engine at all — it can be copied elsewhere and opened without the MCP
server or internet.

**Choosing the folder.** `flow_init` takes a `folder` argument to put a chart beside the work it documents — `flow_init({ title: "Cache benchmarks", folder: "experiments/run-3" })` writes to `experiments/run-3/charts/cache-benchmarks/`. Relative paths resolve against the project directory; an absolute path is taken as given, so a chart can live beside work outside the project. Without it, charts go to `.flows/`.

**Resuming.** Calling `flow_init` with a title that already exists reattaches to that chart and continues its tree — so a chat picks up where it left off after a Claude Code restart. Pass `fresh: true` to force a new chart instead. A chart held by a *running* session is never adopted: each chat takes the next free suffix, enforced by an advisory `.lock` file claimed with an exclusive `wx` write. Locks whose process has died are swept automatically.

The shipped `.gitignore` commits `graph.json` but ignores `assets/` — charts stay reviewable in diffs without dragging binaries into history. Delete that line to commit figures too.

## Viewer

- **Chart switcher** (top-left) moves between chats' charts. The live one is marked `● live`; others open read-only.
- **Figures** toggles embedded images on the cards; off, nodes just note the count. Either way the side panel shows them, and clicking any figure zooms it.
- **Click a node** for its bullets and figures; **right-click** for its actions (work on it, copy id, copy node).
- **Scroll** to zoom, **drag** to pan, **Fit** (or `f`) to re-centre. Pan/zoom survives live updates.
- **Detail** follows the zoom: cards shed bullets, then figures, keeping only the headline when zoomed out — so a large chart stays readable as structure. Cards re-measure at each level, so the whole graph gets tighter rather than just clipping. Pin a level from the dropdown to override.
- **Theme** toggles light/dark and persists — layout runs in the page, so it repaints without a round trip.
- **SVG** exports the chart. **Legend** documents the state vocabulary; **Activity** lists recent revisions.

## Customising the cards

Card geometry, type scale, and palette are data, resolved as **defaults → user → project**. Drop a `theme.json` at `~/.skym/theme.json` for every project, or `.skym/theme.json` inside one to override it there:

```json
{ "card": { "width": 320, "radius": 14 }, "light": { "states": { "good": { "accent": "#0f766e" } } } }
```

Any subset works; unspecified values fall through. Note that state colours were validated for colour-vision separation — if you replace them, keep the pairs distinguishable.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `SKYM_PORT` | `7373` | Preferred port; probes upward if taken. |
| `SKYM_PROJECT_DIR` | cwd | Project root — `.flows/` is created here. |
| `SKYM_STATE_DIR` | `<project>/.flows` | Override the chart location entirely. |
| `SKYM_CHART_ID` | slug of title | Pin a chart directory, e.g. to resume one. |
| `SKYM_NO_OPEN` | unset | Set to `1` to never auto-open a browser. |

## Practical points

When displaying the chart in a browser page, do NOT open http://127.0.0.1:7373/chart?... because it loads a static page without figures. Instead DO OPEN http://127.0.0.1:7373/. Replace the port if needed.

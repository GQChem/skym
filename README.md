# skym-flow

An MCP server that keeps a live **exploration chart** of what an agent is doing: what was tried, what was ruled out, and what the results were. Claude builds the tree through tools; a local page renders it and repaints instantly over SSE, with figures embedded on result nodes.

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
| `flow_init` | Start this chat's chart and open the viewer. |
| `flow_action` | Add/update an action. `after:` chains it to a previous node. |
| `flow_result` | Add/update a result. Attach evidence with `flow_figure`. |
| `flow_options` | Record a fork and seed its candidate branches. |
| `flow_state` | Move a node to a new state as work progresses. |
| `flow_edge` | Link nodes when the relation is not a simple follow-on. |
| `flow_figure` | Embed an image on a node, from a path or base64. |
| `flow_remove` | Delete a node or edge — prefer `abandoned` over deleting. |
| `flow_show` | Return Mermaid source; `list_charts:true` lists other chats' charts. |

## Storage

```
.flows/
  charts/
    index.json                       ← every chart in the project
    speed-up-the-search-endpoint/
      graph.json                     ← the chart itself
      assets/                        ← figures
    debug-the-flaky-ci-runner/
      graph.json
```

Directories are named from the chart title, with a numeric suffix on collision. `graph.json` is written atomically (tmp + rename), so a crash mid-write cannot corrupt it.

**Resuming.** Calling `flow_init` with a title that already exists reattaches to that chart and continues its tree — so a chat picks up where it left off after a Claude Code restart. Pass `fresh: true` to force a new chart instead. A chart held by a *running* session is never adopted: each chat takes the next free suffix, enforced by an advisory `.lock` file claimed with an exclusive `wx` write. Locks whose process has died are swept automatically.

The shipped `.gitignore` commits `graph.json` but ignores `assets/` — charts stay reviewable in diffs without dragging binaries into history. Delete that line to commit figures too.

## Viewer

- **Chart switcher** (top-left) moves between chats' charts. The live one is marked `● live`; others open read-only.
- **Click a node** for its bullets and figures; click a figure to zoom.
- **Scroll** to zoom, **drag** to pan, **Fit** (or `f`) to re-centre. Pan/zoom survives live updates.
- **Theme** toggles light/dark and persists. **SVG** exports the chart.
- **Legend** documents the state vocabulary; **Activity** lists recent revisions.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `SKYM_PORT` | `7373` | Preferred port; probes upward if taken. |
| `SKYM_PROJECT_DIR` | cwd | Project root — `.flows/` is created here. |
| `SKYM_STATE_DIR` | `<project>/.flows` | Override the chart location entirely. |
| `SKYM_CHART_ID` | slug of title | Pin a chart directory, e.g. to resume one. |
| `SKYM_NO_OPEN` | unset | Set to `1` to never auto-open a browser. |

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

Four node kinds, drawn as cards and distinguished by a state stripe, a glyph, and a written label — never by colour alone:

| Kind | Meaning | States |
| --- | --- | --- |
| **action** | something done or to be done | `planned` `exploring` `waiting` `done` `abandoned` `blocked` |
| **result** | what an action produced | `good` `bad` `mixed` `inconclusive` |
| **options** | a fork with candidate branches | `open` `resolved` |
| **note** | standing context, not a step | `active` `retired` |

`flow_options` creates the branch point *and* one `planned` action per candidate, so alternatives you did not pursue stay on the chart instead of being forgotten.

Node bodies are concise bullets. The server rejects prose-shaped bullets, states that do not belong to a node's kind, forks with fewer than two options, self-edges, and edges that would close a cycle — an exploration reads as a tree, so a loop is almost always a mistake, and the error names the offending path. Charts are capped at 300 nodes and 900 edges, past which the honest fix is to summarise a branch or start a new chart. A result with no figure gets a nudge, not a failure.

## Tools

| Tool | Purpose |
| --- | --- |
| `flow_init` | Start this chat's chart and open the viewer. `folder:` chooses where it is saved. |
| `flow_action` | Add/update an action. `after:` chains it to a previous node. |
| `flow_result` | Add/update a result. Attach evidence with `flow_figure`. |
| `flow_options` | Record a fork and seed its candidate branches. |
| `flow_note` | Record a constraint, fact, or open question that shapes the work. |
| `flow_find` | Search the chart by text, kind, or state — for resuming one you did not build. |
| `flow_state` | Move a node to a new state as work progresses. |
| `flow_edge` | Link nodes when the relation is not a simple follow-on. |
| `flow_chart` | Draw a chart from data — no image generation, styled to match the cards. |
| `flow_data` | Point at CSV/TSV/JSON; skym reads it locally and uploads only a generated SVG. |
| `flow_figure` | Embed an image on a node, from a path or base64. `replace:` swaps it instead of appending. |
| `flow_remove` | Delete a node or edge — prefer `abandoned` over deleting. |
| `flow_show` | Return Mermaid source; `list_charts:true` lists other chats' charts. |
| `flow_inbox` | Claim work requested from the hosted chart. |
| `flow_command_state` | Mark a hosted request running, done, or failed. |

## Charts from data

`flow_chart` draws the figure instead of generating an image — point it at numbers and it renders in the chart's own palette, so evidence costs no image generation and never looks pasted in:

```
flow_chart({ node_id: "bench", kind: "bar", unit: "ms", title: "p99 by build",
             points: [{ label: "before", value: 840 },
                      { label: "after", value: 190, emphasis: true }] })
```

Three forms, picked by what the reader has to do: **bar** to compare magnitudes, **line** for change over time, **stat** for a single headline number. `emphasis` marks the one point that matters and lets the rest recede. Charts are stored as ordinary SVG figures, so they zoom, export, and embed in `flow.html` like any other. Use `flow_figure` when the evidence is a real screenshot or an externally produced plot.

For data already on disk, avoid copying it through the model context. `flow_data`
reads CSV, TSV, or JSON locally, infers columns when possible, reduces large
series to at most 12 legible marks, and uploads only the generated SVG:

```
flow_data({ node_id: "bench", path: "results/latency.csv", kind: "line",
            label_column: "build", value_column: "p99", unit: "ms" })
```

The source dataset stays local. This keeps token use and hosted data exposure
small while preserving a visual artifact on the result.

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
- **Show** groups the focused views: **Successful paths** keeps good outcomes and their causal ancestors, **Working now** keeps actively exploring nodes and their context, and **Figures** toggles embedded images on cards. Waiting work is deliberately excluded from Working now because it is paused on an external event.
- **Click a node** for its bullets and figures; **right-click** for its actions (work on it, copy id, copy node).
- **Scroll** to zoom, **drag** to pan, **Fit** (or `f`) to re-centre. Pan/zoom survives live updates.
- **Detail** follows the zoom: cards drop their bullets once text stops being legible, so a large chart reads as structure. Cards re-measure at each level, so the whole graph gets tighter rather than just clipping. Pin **Content** or **Titles** from the dropdown to override.
- **Light/Dark** shows the current theme and toggles it; the choice persists and repaints without a round trip.
- **SVG** exports the chart. **Legend** documents the state vocabulary; **Activity** lists recent revisions.

## Customising the cards

Card geometry, type scale, and palette are data, resolved as **defaults → user → project**. Drop a `config.json` at `~/.skym/config.json` for every project, or `.skym/config.json` inside one to override it there:

```json
{ "theme": { "card": { "width": 320, "radius": 14 }, "light": { "states": { "good": { "accent": "#0f766e" } } } } }
```

Any subset works; unspecified values fall through. Note that state colours were validated for colour-vision separation — if you replace them, keep the pairs distinguishable. A bare `theme.json` in the same directory is still read as the theme section.

## Templates: choosing the node vocabulary

Which kinds a chart may contain, and which states each carries, can be configured globally in `~/.skym/config.json` and overridden per project in `.skym/config.json`. One tool is generated per kind — a project using the `research` template gets `flow_question`, `flow_experiment`, and `flow_finding` instead of `flow_action` and `flow_result`, each with its own states and its own description. The viewer's **Design** dialog builds these settings visually and can copy the correct file contents for either scope.

Pick a builtin template:

```json
{ "vocab": { "template": "research" } }
```

| Template | Kinds |
| --- | --- |
| `default` | action, result, options, note |
| `research` | question, experiment, finding, note |
| `decision-log` | options, decision, note |

Or define a kind of your own, which is added alongside the template's:

```json
{
  "vocab": {
    "kinds": [{
      "slug": "risk",
      "label": "Risk",
      "blurb": "Something that could go wrong.",
      "defaultState": "watch",
      "states": [{
        "slug": "watch", "label": "watch", "glyph": "⚠", "blurb": "keep an eye on it",
        "light": { "accent": "#b45309", "fill": "#fffbeb", "border": "#fcd34d" },
        "dark":  { "accent": "#fbbf24", "fill": "#292524", "border": "#78350f" }
      }]
    }]
  }
}
```

A state may also set `"pulse": true` to animate the card's stripe while the work is live, and `"open": true` to count as unresolved in `flow_find`. Charts are stored with their kind and state as plain strings, so a chart written under one template still opens under another — an unrecognised state simply draws in neutral ink.

Each kind can also control both agent output and card presentation:

```json
{
  "vocab": { "kinds": [{
    "slug": "result",
    "content": {
      "template": "Lead with the key finding and keep evidence concrete.",
      "title": "One short key concept.",
      "bullets": "Measurements, properties and trade-offs; one fact per point.",
      "figure": "Whenever possible generate a figure using a restrained indigo and green palette."
    },
    "presentation": { "typeLabel": "left", "stateLabel": "left", "bullets": true, "figures": "show" }
  }] }
}
```

`typeLabel` and `stateLabel` independently accept `top`, `left`, or `hidden`; side labels are drawn inside a wider, high-contrast state rail. `figures` accepts `inherit`, `show`, or `hide`. Restart the MCP server after changing a config file because node tools and their instructions are generated when the server starts.

The Design dialog can also remove a node type. In JSON the same operation is portable as `"removeKinds": ["note"]`. Existing chart nodes are preserved, but the removed type no longer generates an MCP tool after restart.

## The service

Charts live on the hosted service — that is where the viewer is, and it needs no setup. The first `flow_init` prints a short code and opens a browser; approve it once and every chart from that machine syncs.

```
Connect this agent to skym: open https://skym-production.up.railway.app/pair and enter code ABCD-EFGH
```

The token is stored in `~/.skym/credentials.json`, so pairing happens once per machine, not once per project. Charts are grouped by git remote, so every chat in a repo lands under the same project without anyone creating one.

Local `.flows/` files are still written alongside (`"storage": "service"` turns that off), so a chart stays greppable and committable.

## Configuration

Everything below is optional — the defaults are the product.

| Env var | Default | Meaning |
| --- | --- | --- |
| `SKYM_SERVICE_URL` | the hosted service | Point at a different deploy, e.g. a self-hosted one. |
| `SKYM_HOME` | `~/.skym` | Relocate credentials and user configuration. |
| `SKYM_PROJECT_DIR` | cwd | Project root — `.flows/` is created here. |
| `SKYM_STATE_DIR` | `<project>/.flows` | Override the chart location entirely. |
| `SKYM_CHART_ID` | slug of title | Pin a chart directory, e.g. to resume one. |
| `SKYM_NO_OPEN` | unset | Set to `1` to never auto-open a browser. |

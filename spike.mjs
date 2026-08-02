import fs from "node:fs";
import path from "node:path";
import dagre from "@dagrejs/dagre";
import { layoutGraph } from "./dist/layout.js";
import { renderSvg } from "./dist/render.js";
import { DEFAULT_THEME, paletteFor } from "./dist/theme.js";

const chart = process.argv[2] ?? ".flows/charts/verify-the-viewer-fixes";
const graph = JSON.parse(fs.readFileSync(path.join(chart, "graph.json"), "utf8"));
const assetsDir = path.join(chart, "assets");

const dataUrl = (file) => {
  try {
    const b = fs.readFileSync(path.join(assetsDir, file));
    const mime = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
    return `data:${mime};base64,${b.toString("base64")}`;
  } catch {
    return "";
  }
};

const out = [];
for (const mode of ["light", "dark"]) {
  const palette = paletteFor(DEFAULT_THEME, mode);
  const layout = layoutGraph(graph, DEFAULT_THEME, dagre, true);
  const svg = renderSvg(layout, { theme: DEFAULT_THEME, palette, figureSrc: dataUrl });
  fs.writeFileSync(
    `spike-${mode}.html`,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${palette.surface};display:flex;justify-content:center;padding:28px">${svg}</body>`,
  );
  out.push(`${mode}: ${layout.width.toFixed(0)}x${layout.height.toFixed(0)}`);
}
console.log(out.join("  ·  "), `| ${graph.nodes.length} nodes`);

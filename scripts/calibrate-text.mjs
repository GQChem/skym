import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { textWidth } from "../dist/layout.js";

/**
 * textWidth is an estimate, and a wrong one costs real layout quality: too wide
 * and text wraps that would have fit, too narrow and it overflows the card.
 * This compares it against the browser's own measureText for a spread of real
 * strings and reports the error, so the constants can be re-tuned deliberately.
 *
 * Usage: node scripts/calibrate-text.mjs [path-to-browser]
 */

const SAMPLES = [
  ["Serve tsc output as native ESM", 12.5, 400],
  ["dagre ships self-contained ESM", 12.5, 400],
  ["A considerably longer title that must wrap", 14, 600],
  ["Redis cuts p99 to 190ms under load", 14, 600],
  ["ACTION · PLANNED", 10, 600],
  ["RESULT · INCONCLUSIVE", 10, 600],
  ["abcdefghijklmnopqrstuvwxyz", 12.5, 400],
  ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", 12.5, 400],
  ["0123456789", 12.5, 400],
  ["Waiting on infra to provision Redis", 14, 600],
  ["First 12s after deploy sees 4x origin load", 12.5, 400],
];

const BROWSERS = [
  process.argv[2],
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) {
  console.error("No Chrome/Edge found. Pass a path: node scripts/calibrate-text.mjs <browser>");
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skym-calib-"));
const page = path.join(dir, "m.html");
fs.writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><body><pre id="o"></pre><script>
const c=document.createElement("canvas").getContext("2d");
const s=${JSON.stringify(SAMPLES)};
const out=[];
for(const [t,size,weight] of s){
  c.font=weight+" "+size+'px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  out.push(JSON.stringify({t,size,weight,real:+c.measureText(t).width.toFixed(2)}));
}
document.getElementById("o").textContent=out.join("\\n");
</script></body>`,
  "utf8",
);

const res = spawnSync(
  browser,
  ["--headless=new", "--disable-gpu", "--dump-dom", "--virtual-time-budget=3000", `file:///${page}`],
  { encoding: "utf8", timeout: 60_000 },
);

const body = (res.stdout ?? "").match(/<pre id="o">([\s\S]*?)<\/pre>/)?.[1] ?? "";
const rows = body
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l.replace(/&quot;/g, '"').replace(/&amp;/g, "&")));

if (!rows.length) {
  console.error("Browser returned no measurements.");
  process.exit(1);
}

let worst = 0;
console.log("  est     real    err     text");
for (const { t, size, weight, real } of rows) {
  const est = textWidth(t, size, weight);
  const err = (est - real) / real;
  worst = Math.max(worst, Math.abs(err));
  const flag = Math.abs(err) > 0.03 ? " <-- off" : "";
  console.log(
    `  ${est.toFixed(1).padStart(6)} ${real.toFixed(1).padStart(7)} ${(err * 100).toFixed(1).padStart(6)}%  ${t.slice(0, 44)}${flag}`,
  );
}
console.log(`\nworst error: ${(worst * 100).toFixed(1)}%`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(worst > 0.05 ? 1 : 0);

import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Screenshots the live viewer and reports what actually rendered — the check
 * that the app works, as opposed to the unit tests, which only prove the pieces
 * do. Uses headless Chrome/Edge directly rather than puppeteer, so it needs no
 * dependency and no hardcoded browser path.
 *
 * Usage: node scripts/shoot.mjs [url] [out.png]
 */

const url = process.argv[2] ?? "http://127.0.0.1:7373/";
const out = process.argv[3] ?? "live.png";

const CANDIDATES = [
  process.env.SKYM_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const browser = CANDIDATES.find((b) => fs.existsSync(b));
if (!browser) {
  console.error("No Chrome/Edge/Brave found. Set SKYM_BROWSER to a browser path.");
  process.exit(1);
}

const run = (args) =>
  spawnSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", ...args], {
    encoding: "utf8",
    timeout: 90_000,
  });

// Probe first: a screenshot of a blank page looks fine in CI and tells nobody
// that the module failed to evaluate.
const dom = run(["--virtual-time-budget=6000", "--dump-dom", url]).stdout ?? "";
const cards = (dom.match(/class="skym-node"/g) || []).length;
const figures = (dom.match(/class="skym-figure"/g) || []).length;

const shot = run([`--screenshot=${out}`, "--window-size=1500,950", "--virtual-time-budget=6000", url]);
if (!fs.existsSync(out)) {
  console.error("Screenshot failed:", (shot.stderr ?? "").split("\n").slice(-3).join("\n"));
  process.exit(1);
}

console.log(`${out}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
console.log(`cards: ${cards}  figures: ${figures}`);
if (!cards) {
  console.error("No cards rendered — the viewer is blank. Check the browser console.");
  process.exit(1);
}

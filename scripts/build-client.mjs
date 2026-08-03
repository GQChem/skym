import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The viewer imports the same layout/render/theme modules the server uses, so
 * there is exactly one renderer. tsc emits them with `.js` specifiers already,
 * which browsers accept as-is — this just stages them plus dagre under public/.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = ["theme.js", "layout.js", "render.js"];
const outDir = path.join(root, "public", "vendor");

fs.mkdirSync(outDir, { recursive: true });

for (const file of shared) {
  const src = path.join(root, "dist", file);
  if (!fs.existsSync(src)) {
    console.error(`missing ${src} — run tsc first`);
    process.exit(1);
  }
  // Strip the sourcemap comment: dist/*.js.map is not served under public/.
  const code = fs.readFileSync(src, "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, "");
  fs.writeFileSync(path.join(outDir, file), code, "utf8");
}

const dagreSrc = path.join(root, "node_modules", "@dagrejs", "dagre", "dist", "dagre.esm.js");
fs.writeFileSync(
  path.join(outDir, "dagre.js"),
  fs.readFileSync(dagreSrc, "utf8").replace(/^\/\/# sourceMappingURL=.*$/m, ""),
  "utf8",
);

const bytes = [...shared, "dagre.js"].reduce(
  (sum, f) => sum + fs.statSync(path.join(outDir, f)).size,
  0,
);
console.log(`client bundle: ${(bytes / 1024).toFixed(0)} KB (${shared.length + 1} modules)`);

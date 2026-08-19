import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const PUBLIC = path.join(process.cwd(), "public");
const app = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");

/**
 * A duplicate binding is a *fatal* SyntaxError: the module never evaluates and
 * the page renders blank, with nothing in the served files to suggest why.
 * `node --check` does not catch it across the file the way this does, and it
 * shipped once already — hence a test rather than a habit.
 */
test("no identifier is declared twice at module scope", () => {
  const declared = new Map();
  for (const m of app.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    const name = m[1];
    const line = app.slice(0, m.index).split("\n").length;
    assert.ok(
      !declared.has(name),
      `"${name}" is declared twice at module scope (lines ${declared.get(name)} and ${line}) — this is a fatal SyntaxError and the viewer will render blank`,
    );
    declared.set(name, line);
  }
});

test("every element the viewer looks up exists in the markup", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const m of app.matchAll(/\$\("([^"]+)"\)/g)) {
    if (!ids.has(m[1])) missing.push(m[1]);
  }
  assert.deepEqual(missing, [], `app.js looks up ids absent from index.html: ${missing.join(", ")}`);
});

test("no id is used twice in the markup", () => {
  const seen = new Set();
  const dupes = [];
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
  }
  assert.deepEqual(dupes, [], `duplicate ids in index.html: ${dupes.join(", ")}`);
});

test("the viewer imports only modules the build actually stages", () => {
  // Read from the build script rather than restating it, so adding a shared
  // module to one place cannot silently pass here.
  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "build-client.mjs"), "utf8");
  const shared = script.match(/const shared = \[([^\]]+)\]/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  const staged = new Set([...shared, "dagre.js"]);
  for (const m of app.matchAll(/from\s+"\.\/vendor\/([^"]+)"/g)) {
    assert.ok(staged.has(m[1]), `app.js imports vendor/${m[1]}, which build-client.mjs does not stage`);
  }
});

test("every name imported from a shared module is actually exported", () => {
  for (const m of app.matchAll(/import\s+\{([^}]+)\}\s+from\s+"\.\/vendor\/([^"]+)"/g)) {
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const src = fs.readFileSync(path.join(process.cwd(), "dist", m[2]), "utf8");
    for (const name of names) {
      const exported = new RegExp(`export\\s+(?:const|function|class|let)\\s+${name}\\b`).test(src);
      assert.ok(exported, `app.js imports { ${name} } from ${m[2]}, which does not export it`);
    }
  }
});

test("the node menu can queue an explanation", () => {
  assert.match(app, /label: "Explain"/);
  assert.match(app, /verb: "explain"/);
});

test("selection survives pointer capture and selected assets are downloadable", () => {
  assert.match(app, /nodeId: target\?\.closest\("\.skym-node"\)/);
  assert.match(app, /else if \(finished\.nodeId\) select\(finished\.nodeId\)/);
  assert.match(app, /download="\$\{escapeHtml\(f\.file\)\}"/);
  assert.match(app, /class="artifact"[\s\S]*download="\$\{escapeHtml\(artifact\.name\)\}"/);
});

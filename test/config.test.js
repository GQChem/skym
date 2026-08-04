import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../dist/config.js";
import { DEFAULT_THEME, resolveTheme } from "../dist/theme.js";
import { DEFAULT_VOCAB, resolveVocab, statesFor } from "../dist/vocab.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skym-config-"));

const writeConfig = (dir, value, file = "config.json") => {
  fs.mkdirSync(path.join(dir, ".skym"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".skym", file), JSON.stringify(value), "utf8");
};

test("a project with no config yields the defaults", () => {
  const cfg = loadConfig(tmp());
  assert.equal(cfg.theme.card.width, DEFAULT_THEME.card.width);
  assert.deepEqual(
    cfg.vocab.kinds.map((k) => k.slug),
    DEFAULT_VOCAB.kinds.map((k) => k.slug),
  );
});

test("a project config.json is picked up", () => {
  const dir = tmp();
  writeConfig(dir, { theme: { card: { width: 333 } } });
  assert.equal(loadConfig(dir).theme.card.width, 333);
});

test("a bare theme.json still works", () => {
  const dir = tmp();
  writeConfig(dir, { card: { width: 321 } }, "theme.json");
  assert.equal(loadConfig(dir).theme.card.width, 321);
});

test("malformed config is ignored rather than fatal", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".skym"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".skym", "config.json"), "{not json", "utf8");
  assert.doesNotThrow(() => loadConfig(dir));
  assert.equal(loadConfig(dir).theme.card.width, DEFAULT_THEME.card.width);
});

test("a project can select a builtin template", () => {
  const dir = tmp();
  writeConfig(dir, { vocab: { template: "research" } });
  const slugs = loadConfig(dir).vocab.kinds.map((k) => k.slug);
  assert.ok(slugs.includes("finding"), `expected a finding kind, got ${slugs.join(", ")}`);
  assert.ok(!slugs.includes("result"), "research renames result to finding");
});

test("a project can add a kind of its own", () => {
  const vocab = resolveVocab(DEFAULT_VOCAB, undefined, {
    kinds: [{ slug: "risk", label: "Risk", blurb: "Something that could go wrong.", defaultState: "watch", states: [{ slug: "watch", label: "watch", glyph: "!", blurb: "keep an eye on it", light: { accent: "#000", fill: "#fff", border: "#ccc" }, dark: { accent: "#fff", fill: "#000", border: "#333" } }] }],
  });
  assert.deepEqual(statesFor(vocab).risk, ["watch"]);
  // The builtin kinds survive alongside it.
  assert.deepEqual(statesFor(vocab).action, statesFor(DEFAULT_VOCAB).action);
});

test("an unknown state gets neutral ink rather than crashing", () => {
  const merged = resolveTheme(DEFAULT_THEME, { light: { states: { invented: { accent: "#abcdef" } } } });
  assert.equal(merged.light.states.invented.accent, "#abcdef");
  // fill/border come from neutral, so the ink is complete.
  assert.equal(merged.light.states.invented.fill, DEFAULT_THEME.light.neutral.fill);
});

test("project settings win over user settings", () => {
  const merged = resolveTheme(
    DEFAULT_THEME,
    { card: { width: 300, radius: 4 } },
    { card: { width: 400 } },
  );
  assert.equal(merged.card.width, 400, "project should win");
  assert.equal(merged.card.radius, 4, "user value should survive");
});

test("unspecified values fall through to the defaults", () => {
  const merged = resolveTheme(DEFAULT_THEME, { card: { width: 400 } });
  assert.equal(merged.card.padX, DEFAULT_THEME.card.padX);
  assert.equal(merged.type.titleSize, DEFAULT_THEME.type.titleSize);
  assert.equal(merged.light.states.good.accent, DEFAULT_THEME.light.states.good.accent);
});

test("a single state colour can be overridden without losing the rest", () => {
  const merged = resolveTheme(DEFAULT_THEME, {
    light: { states: { good: { accent: "#123456" } } },
  });
  assert.equal(merged.light.states.good.accent, "#123456");
  assert.equal(merged.light.states.good.fill, DEFAULT_THEME.light.states.good.fill);
  assert.equal(merged.light.states.bad.accent, DEFAULT_THEME.light.states.bad.accent);
  assert.equal(merged.dark.states.good.accent, DEFAULT_THEME.dark.states.good.accent);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadThemeConfig } from "../dist/config.js";
import { DEFAULT_THEME, resolveTheme } from "../dist/theme.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skym-config-"));

const writeProjectTheme = (dir, value) => {
  fs.mkdirSync(path.join(dir, ".skym"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".skym", "theme.json"), JSON.stringify(value), "utf8");
};

test("a project with no config yields no overrides", () => {
  const cfg = loadThemeConfig(tmp());
  assert.equal(cfg.project, undefined);
});

test("a project theme.json is picked up", () => {
  const dir = tmp();
  writeProjectTheme(dir, { card: { width: 333 } });
  assert.equal(loadThemeConfig(dir).project.card.width, 333);
});

test("malformed config is ignored rather than fatal", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".skym"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".skym", "theme.json"), "{not json", "utf8");
  assert.doesNotThrow(() => loadThemeConfig(dir));
  assert.equal(loadThemeConfig(dir).project, undefined);
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

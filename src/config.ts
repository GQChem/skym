import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTheme, themeForVocab, DEFAULT_THEME, type Theme, type ThemeOverride } from "./theme.js";
import { DEFAULT_VOCAB, resolveVocab, type Vocabulary, type VocabOverride } from "./vocab.js";

export interface SkymConfig {
  theme?: ThemeOverride;
  vocab?: VocabOverride;
  /**
   * Whether local files are written alongside the service copy. Charts sync
   * either way — this only decides if `.flows/` is also kept on disk.
   */
  storage?: "service" | "both";
  /** Base URL of the service; defaults to the hosted one. */
  service?: string;
}

export interface ResolvedConfig {
  theme: Theme;
  vocab: Vocabulary;
  storage: "service" | "both";
  service: string;
}

const userHome = (): string => process.env.SKYM_HOME ?? path.join(os.homedir(), ".skym");
const PROJECT_FILE = path.join(".skym", "config.json");

/** The pre-vocab layout kept theme keys at the top level. */
const LEGACY_PROJECT_FILE = path.join(".skym", "theme.json");

function read(file: string): SkymConfig | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SkymConfig) : undefined;
  } catch {
    // Absent or malformed config must never take the viewer down.
    return undefined;
  }
}

/** A bare theme.json is read as { theme: ... } so old configs keep working. */
function readLayer(configFile: string, legacyFile: string): SkymConfig | undefined {
  const current = read(configFile);
  if (current) return current;
  const legacy = read(legacyFile);
  return legacy ? { theme: legacy as ThemeOverride } : undefined;
}

/**
 * Charts live on the service, so it is the default rather than something to
 * configure. `service` in config or SKYM_SERVICE_URL points at a different
 * deploy — a self-hosted one, or a dev instance.
 */
const DEFAULT_SERVICE = "https://skym-production.up.railway.app";

/** Project settings win over user settings; both are optional. */
export function loadConfig(projectDir: string): ResolvedConfig {
  const user = readLayer(path.join(userHome(), "config.json"), path.join(userHome(), "theme.json"));
  const project = readLayer(path.join(projectDir, PROJECT_FILE), path.join(projectDir, LEGACY_PROJECT_FILE));

  const vocab = resolveVocab(DEFAULT_VOCAB, user?.vocab, project?.vocab);
  // The vocabulary owns its state inks, so it is folded in before overrides so
  // a config can still restyle an individual state on top.
  const theme = resolveTheme(themeForVocab(DEFAULT_THEME, vocab), user?.theme, project?.theme);

  return {
    theme,
    vocab,
    // "both" keeps the local files a user may already be committing, while the
    // service becomes the copy that outlives the machine.
    storage: project?.storage ?? user?.storage ?? "both",
    service: process.env.SKYM_SERVICE_URL || project?.service || user?.service || DEFAULT_SERVICE,
  };
}

/** What the viewer needs to draw and label a chart it did not lay out. */
export function clientConfig(c: ResolvedConfig): {
  theme: Theme;
  vocab: Vocabulary;
} {
  return { theme: c.theme, vocab: c.vocab };
}

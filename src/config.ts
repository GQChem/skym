import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ThemeOverride } from "./theme.js";

export interface ThemeConfig {
  user?: ThemeOverride;
  project?: ThemeOverride;
}

const USER_FILE = path.join(os.homedir(), ".skym", "theme.json");
const PROJECT_FILE = path.join(".skym", "theme.json");

function read(file: string): ThemeOverride | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ThemeOverride) : undefined;
  } catch {
    // Absent or malformed config must never take the viewer down.
    return undefined;
  }
}

/** Project settings win over user settings; both are optional. */
export function loadThemeConfig(projectDir: string): ThemeConfig {
  return {
    user: read(USER_FILE),
    project: read(path.join(projectDir, PROJECT_FILE)),
  };
}

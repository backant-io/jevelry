import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, useContext } from "react";
import type { Decision } from "../protocol.js";

/** Every colour the TUI draws with. Depth comes from the three background steps, not from borders. */
export interface Theme {
  name: ThemeName;
  background: string;
  panel: string;
  element: string;
  text: string;
  muted: string;
  accent: string;
  act: string;
  mark: string;
  fallBack: string;
  error: string;
  border: string;
}

export type ThemeName = "dark" | "light";

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    background: "#0d1117",
    panel: "#161b22",
    element: "#21262d",
    text: "#e6edf3",
    muted: "#7d8590",
    accent: "#3fb950",
    act: "#3fb950",
    mark: "#d29922",
    fallBack: "#f85149",
    error: "#f85149",
    border: "#30363d",
  },
  light: {
    name: "light",
    background: "#ffffff",
    panel: "#f6f8fa",
    element: "#eaeef2",
    text: "#1f2328",
    muted: "#656d76",
    accent: "#1a7f37",
    act: "#1a7f37",
    mark: "#9a6700",
    fallBack: "#cf222e",
    error: "#cf222e",
    border: "#d0d7de",
  },
};

/** What each decision means, in the same words on every screen. */
export const MEANINGS: Record<Decision, string> = { act: "Jev is sure", mark: "fairly sure, check it", fall_back: "unsure, your code decides" };

export const decisionColor = (theme: Theme, d: Decision): string => (d === "act" ? theme.act : d === "mark" ? theme.mark : theme.fallBack);

const FILE = "tui.json";

/** The theme saved in `$JEVELRY_HOME/tui.json`, dark when there is none or the file cannot be read. */
export function loadThemeName(home: string): ThemeName {
  try {
    const saved = (JSON.parse(readFileSync(join(home, FILE), "utf8")) as { theme?: unknown }).theme;
    return saved === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Keeps every other key already in the file. Throws when the file cannot be written; the caller says so in a toast. */
export function saveThemeName(home: string, name: ThemeName): void {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // No file yet, or one that is not JSON: start from an empty object.
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, FILE), `${JSON.stringify({ ...current, theme: name }, null, 2)}\n`);
}

/** The theme every component draws with; App provides the chosen one. */
export const ThemeContext = createContext<Theme>(THEMES.dark);
export const useTheme = (): Theme => useContext(ThemeContext);

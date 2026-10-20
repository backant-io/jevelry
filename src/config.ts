import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveKey } from "./key.js";

/** `$JEVELRY_HOME/config.json`: which backend jevelry asks. Nothing secret lives here; the key stays in its own store. */
export const CONFIG_FILE = "config.json";

/** The model `jevelry install --local` set up, and how jevelry reaches the server it starts for it. */
export interface LocalModel {
  /** The Hugging Face repo, like "ggml-org/vllm-d3-flash-GGUF". */
  repo: string;
  /** The gguf file in the repo, like "vllm-d3-flash-Q8_0.gguf". */
  file: string;
  quant: string;
  /** The name a person reads, like "vLLM-SR d3-flash 9B". */
  name: string;
  decisionType: string;
  /** Absolute path of the downloaded gguf. */
  path: string;
  /** Chosen free at install and fixed after, so every later ask finds the server it started. */
  port: number;
  /** The `--alias` the server answers as, like "local/vllm-d3-flash-Q8_0". */
  alias: string;
  /** Parameter count, so a launch can check the model still fits; missing in configs written before it was kept. */
  params?: number;
}

export interface Config {
  backend?: "typesafe" | "local";
  local?: LocalModel;
}

/** Empty when the file is missing, is not JSON or is not an object: an unreadable config is an unconfigured jevelry, never a crash. */
export function readConfig(home: string): Config {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, CONFIG_FILE), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

/**
 * Merges over what is there, like the TUI's theme file, so a key this build does not know survives a write.
 * Written aside and renamed over the file: an ask reading it meanwhile never sees half a file, which reads
 * as no config and would send a private state to hosted Jev.
 */
export function writeConfig(home: string, update: Config): void {
  mkdirSync(home, { recursive: true });
  const file = join(home, CONFIG_FILE);
  const aside = `${file}.${process.pid}.tmp`;
  writeFileSync(aside, `${JSON.stringify({ ...readConfig(home), ...update }, null, 2)}\n`);
  renameSync(aside, file);
}

/** The local model, only while the backend is local: switching to TypeSafe keeps the model on disk for a switch back. */
export function localModel(home: string): LocalModel | undefined {
  const config = readConfig(home);
  return config.backend === "local" ? config.local : undefined;
}

/** A chosen local model wins over a key, because choosing it was the later and more deliberate act. */
export function configured(env: NodeJS.ProcessEnv, home: string): "typesafe" | "local" | null {
  if (localModel(home)) return "local";
  return resolveKey(env, home) !== undefined ? "typesafe" : null;
}

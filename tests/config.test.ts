import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type LocalModel, configured, localModel, readConfig, writeConfig } from "../src/config.js";
import { storeKey } from "../src/key.js";

// The file key store only: the suite must never read this machine's keychain, which is the owner's.
const FILE_STORE = { JEVELRY_KEY_STORE: "file" } as NodeJS.ProcessEnv;
const home = () => mkdtempSync(join(tmpdir(), "jevelry-config-"));
const LOCAL: LocalModel = {
  repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B",
  decisionType: "vllm-d3", path: "/models/vllm-d3-flash-Q8_0.gguf", port: 41234, alias: "local/vllm-d3-flash-Q8_0",
};

describe("readConfig and writeConfig", () => {
  // A broken or hand-edited file must leave jevelry unconfigured and asking, never crash every command.
  it("reads an empty config when the file is missing, is not JSON or is not an object", () => {
    const dir = home();
    expect(readConfig(dir)).toEqual({});
    writeFileSync(join(dir, "config.json"), "{ not json");
    expect(readConfig(dir)).toEqual({});
    writeFileSync(join(dir, "config.json"), "[1, 2]");
    expect(readConfig(dir)).toEqual({});
  });

  // A newer jevelry may write keys this one does not know; switching backends must not erase them.
  it("merges a write over what is there and creates the home", () => {
    const dir = join(home(), "not-yet-there");
    writeConfig(dir, { backend: "local", local: LOCAL });
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...raw, future: 1 }));
    writeConfig(dir, { backend: "typesafe" });
    expect(readConfig(dir)).toEqual({ backend: "typesafe", local: LOCAL, future: 1 });
  });
});

describe("localModel and configured", () => {
  // Switching to hosted Jev keeps the downloaded model on file, but no ask may go to it any more.
  it("returns the local model only while the backend is local", () => {
    const dir = home();
    writeConfig(dir, { backend: "local", local: LOCAL });
    expect(localModel(dir)).toEqual(LOCAL);
    writeConfig(dir, { backend: "typesafe" });
    expect(localModel(dir)).toBeUndefined();
  });

  // The install offers its first-run choice only to a jevelry that has neither a key nor a model.
  it("says local over a key, typesafe with only a key, and null with neither", () => {
    const dir = home();
    expect(configured(FILE_STORE, dir)).toBeNull();
    storeKey("a-key", FILE_STORE, dir);
    expect(configured(FILE_STORE, dir)).toBe("typesafe");
    writeConfig(dir, { backend: "local", local: LOCAL });
    expect(configured(FILE_STORE, dir)).toBe("local");
  });
});

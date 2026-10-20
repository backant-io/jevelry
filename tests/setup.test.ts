import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CatalogModel, listModels, rank } from "../src/catalog.js";
import { readConfig, writeConfig } from "../src/config.js";
import { modelPath } from "../src/download.js";
import { SERVER_FILE, health, stopServer } from "../src/server.js";
import { SetupError, type SetupIO, installLocal, installRuntime, useTypesafe } from "../src/setup.js";
import { type FakeHf, fileBytes, startHf } from "./fixtures/hf.js";
import { FAKE_BREW, FAKE_LLAMA, M4_PRO_24, sandboxEnv, sandboxPath } from "./fixtures/sandbox.js";

/** What the installer said, showed and asked, with every question answered `answer`. */
function recorder(answer: boolean) {
  const said: string[] = [];
  const progress: Array<[string, number | undefined, number | undefined]> = [];
  const asked: string[] = [];
  const io: SetupIO = {
    say: (line) => { said.push(line); },
    progress: (step, done, total) => { progress.push([step, done, total]); },
    confirm: async (question) => {
      asked.push(question);
      return answer;
    },
  };
  return { io, said, progress, asked };
}
const home = () => mkdtempSync(join(tmpdir(), "jevelry-setup-"));

describe("installRuntime", () => {
  // A llama-server that is new enough is used as it is: nobody is asked to install anything.
  it("returns the llama-server there when its build serves the type", async () => {
    const r = recorder(true);
    expect(await installRuntime("vllm-d3", r.io, sandboxEnv(home()))).toBe(FAKE_LLAMA);
    expect(r.asked).toEqual([]);
  });

  // Homebrew changes the person's machine, so it runs only after a yes, and a no leaves the way to do it by hand.
  it("asks before upgrading an old build, and a no ends with the install instructions", async () => {
    const r = recorder(false);
    // granite-switch needs build 11700; the fake reports 11669.
    const error = await installRuntime("granite-switch", r.io, sandboxEnv(home())).catch((e: unknown) => e);
    expect(r.asked).toEqual(["install llama.cpp with Homebrew (brew upgrade llama.cpp)?"]);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as Error).message).toMatch(/^llama\.cpp is needed to run local models; install it with .* or from https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases \(build 11700 or newer\)$/);
  });

  // An upgrade that still leaves an old build must say so, not start a server that cannot load the model.
  it("checks the build again after brew and refuses one still too old", async () => {
    const r = recorder(true);
    await expect(installRuntime("granite-switch", r.io, sandboxEnv(home()))).rejects.toThrow("llama.cpp build 11669 is still older than build 11700, which granite-switch models need");
    expect(r.progress.map(([step]) => step)).toContain("brew: ==> Upgrading llama.cpp");
  });

  // A failed brew run is only fixable with its own words, so the last lines come along.
  it("reports brew's last lines when it fails", async () => {
    const r = recorder(true);
    await expect(installRuntime("granite-switch", r.io, sandboxEnv(home(), { FAKE_BREW_EXIT: "1" }))).rejects.toThrow(/^brew upgrade llama\.cpp failed with exit 1:\n[\s\S]*the fake brew was told to fail$/);
  });

  // The first-run path: no llama.cpp at all, Homebrew installs it, and the new one on PATH is found.
  it("installs llama.cpp with brew when there is none and finds it on PATH afterwards", async () => {
    const r = recorder(true);
    const bin = sandboxPath(false);
    const env = { PATH: bin, JEVELRY_KEY_STORE: "file", JEVELRY_BREW: FAKE_BREW, FAKE_BREW_INSTALL_TO: bin };
    expect(await installRuntime("vllm-d3", r.io, env)).toBe(join(bin, "llama-server"));
    expect(r.asked).toEqual(["install llama.cpp with Homebrew (brew install llama.cpp)?"]);
  });

  // Without Homebrew there is nothing jevelry may run for the person; it says how to get llama.cpp instead.
  it("gives the install instructions without asking when there is no brew", async () => {
    const r = recorder(true);
    await expect(installRuntime("vllm-d3", r.io, { PATH: sandboxPath(false), JEVELRY_KEY_STORE: "file" })).rejects.toThrow(/^llama\.cpp is needed to run local models/);
    expect(r.asked).toEqual([]);
  });
});

describe("installLocal", () => {
  let hf: FakeHf;
  let models: CatalogModel[];
  const homes: string[] = [];
  beforeAll(async () => {
    hf = await startHf();
    models = await listModels({ hfUrl: hf.url });
  });
  afterEach(() => {
    for (const h of homes) stopServer(h);
    for (const key of Object.keys(hf.behaviour)) delete hf.behaviour[key as keyof FakeHf["behaviour"]];
  });
  afterAll(async () => {
    await hf.close();
  });
  const fixture = () => {
    const dir = home();
    homes.push(dir);
    return { dir, env: sandboxEnv(dir, { JEVELRY_HF_URL: hf.url, JEVELRY_MACHINE: JSON.stringify(M4_PRO_24), FAKE_LLAMA_LOAD_MS: "100" }) };
  };
  const choice = (id: string) => rank(models, M4_PRO_24).find((c) => c.model.id === id)!;

  // The whole first run in one call: the verified file, the config, a running server and a real answer from it.
  it("downloads, writes the config, starts the server and answers one smoke question", async () => {
    const { dir, env } = fixture();
    const r = recorder(true);
    const local = await installLocal(choice("vllm-d3-flash"), dir, r.io, env);
    const path = modelPath(dir, "ggml-org/vllm-d3-flash-GGUF", "vllm-d3-flash-Q8_0.gguf");
    expect(local).toMatchObject({ repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B", decisionType: "vllm-d3", path, alias: "local/vllm-d3-flash-Q8_0" });
    expect(readConfig(dir)).toEqual({ backend: "local", local });
    expect(readFileSync(path)).toEqual(fileBytes("vllm-d3-flash-Q8_0.gguf"));
    expect(await health(local.port)).toBe("ok");
    expect(r.said).toEqual([expect.stringMatching(/^vLLM-SR d3-flash 9B answered in \d+ ms on this machine$/)]);
    expect(r.progress.filter(([step]) => step === "download").at(-1)).toEqual(["download", 6000, 6000]);
    expect(r.progress.map(([step]) => step)).toContain("loading the model");
  });

  // Two models loaded at once is how a GPU runs out of memory: switching stops the old server first.
  it("stops the previous model's server before the new one starts", async () => {
    const { dir, env } = fixture();
    const first = await installLocal(choice("d1-3b"), dir, recorder(true).io, env);
    const { pid } = JSON.parse(readFileSync(join(dir, SERVER_FILE), "utf8")) as { pid: number };
    const second = await installLocal(choice("kev-4b"), dir, recorder(true).io, env);
    expect(second.port).not.toBe(first.port);
    expect(await health(first.port)).toBe("down");
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  // A model too big for this machine is refused before a single byte is downloaded.
  it("refuses a model that won't fit before any request", async () => {
    const { dir, env } = fixture();
    const before = hf.requests.length;
    await expect(installLocal(choice("vllm-d3"), dir, recorder(true).io, env)).rejects.toThrow(/^vLLM-SR d3 27B needs about 22\.\d GB and this machine has about 17\.2 GB for models$/);
    expect(hf.requests.length).toBe(before);
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  // The catalog's size is an estimate; the exact size from Hugging Face decides, before the download.
  it("refuses when the exact file size won't fit, downloading nothing", async () => {
    const { dir, env } = fixture();
    hf.behaviour.size = 40e9;
    const before = hf.requests.length;
    await expect(installLocal(choice("vllm-d3-flash"), dir, recorder(true).io, env)).rejects.toThrow(/^vLLM-SR d3-flash 9B needs about 41\.\d GB/);
    expect(hf.requests.slice(before).some((req) => req.url.includes("/resolve/"))).toBe(false);
  });

  // Someone switching from hosted Jev to a model that then fails to start must still have the
  // hosted Jev that worked: the config changes only once the new model has answered.
  it("leaves the previous config and no server behind when the new model fails its check", async () => {
    const { dir } = fixture();
    useTypesafe(dir);
    const env = sandboxEnv(dir, { JEVELRY_HF_URL: hf.url, JEVELRY_MACHINE: JSON.stringify(M4_PRO_24), FAKE_LLAMA_FAIL: "1" });
    await expect(installLocal(choice("vllm-d3-flash"), dir, recorder(true).io, env)).rejects.toThrow(/the local model server stopped while starting/);
    expect(readConfig(dir)).toEqual({ backend: "typesafe" });
    expect(existsSync(join(dir, SERVER_FILE))).toBe(false);
  });

  // A base URL exported in the shell points every ask elsewhere; the setup check must still ask the
  // model it just installed, or it would pass on another server's answer.
  it("asks the new model itself even when TYPESAFE_BASE_URL is exported", async () => {
    const { dir } = fixture();
    const env = sandboxEnv(dir, { JEVELRY_HF_URL: hf.url, JEVELRY_MACHINE: JSON.stringify(M4_PRO_24), FAKE_LLAMA_LOAD_MS: "100", TYPESAFE_BASE_URL: "http://127.0.0.1:9" });
    const r = recorder(true);
    const local = await installLocal(choice("vllm-d3-flash"), dir, r.io, env);
    expect(r.said).toEqual([expect.stringMatching(/^vLLM-SR d3-flash 9B answered in \d+ ms on this machine$/)]);
    expect(readConfig(dir)).toEqual({ backend: "local", local });
  });

  // The CLI and the TUI show a SetupError's message and nothing else, so every failure must arrive as one.
  it("turns any failure into a SetupError with its reason", async () => {
    const { dir } = fixture();
    const env = sandboxEnv(dir, { JEVELRY_HF_URL: "http://127.0.0.1:9", JEVELRY_MACHINE: JSON.stringify(M4_PRO_24) });
    const error = await installLocal(choice("vllm-d3-flash"), dir, recorder(true).io, env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as Error).message).toMatch(/^could not reach Hugging Face/);
  });
});

describe("useTypesafe", () => {
  // Switching to hosted Jev keeps the model on file, so switching back needs no download.
  it("sets the backend to typesafe and keeps the local model", () => {
    const dir = home();
    const local = { repo: "r", file: "f.gguf", quant: "Q8_0", name: "M", decisionType: "kev", path: "/p", port: 1, alias: "local/f" };
    writeConfig(dir, { backend: "local", local });
    useTypesafe(dir);
    expect(readConfig(dir)).toEqual({ backend: "typesafe", local });
  });
});

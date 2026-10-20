import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModel } from "../src/config.js";
import { SERVER_FILE, buildOf, ensureServer, health, launchArgs, llamaServerPath, localFetch, serverBuild, startServer, stopServer } from "../src/server.js";
import { FAKE_LLAMA, sandboxEnv, sandboxPath } from "./fixtures/sandbox.js";

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  return !alive(pid);
};

// Every home a test makes is stopped after it, so no fake server outlives its test.
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) stopServer(home); });

async function fixture(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "jevelry-server-"));
  homes.push(home);
  const path = join(home, "vllm-d3-flash-Q8_0.gguf");
  writeFileSync(path, "not a model");
  const argv = join(home, "argv.ndjson");
  const local: LocalModel = {
    repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B",
    decisionType: "vllm-d3", path, port: await freePort(), alias: "local/vllm-d3-flash-Q8_0",
  };
  const env = sandboxEnv(home, { FAKE_LLAMA_ARGV_FILE: argv, ...extra });
  const starts = (): string[][] => (existsSync(argv) ? readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
  return { home, local, env, starts };
}

describe("buildOf and serverBuild", () => {
  // The build decides whether a decision type can run at all, from either version format llama.cpp has printed.
  it("reads the build from new and old version lines, and treats build 0 or no match as unknown", () => {
    expect(buildOf("version: 0.7.0 (build 11669, commit 620d222)\nbuilt with clang")).toBe(11669);
    expect(buildOf("version: 7210 (2ba719519)")).toBe(7210);
    expect(buildOf("version: 0 (unknown)")).toBeNull();
    expect(buildOf("version: 0.7.0 (build 0, commit unknown)")).toBeNull();
    expect(buildOf("llama-server: command not found")).toBeNull();
  });

  // llama-server prints its version on stderr, which a stdout-only read would miss.
  it("runs --version and reads stderr", () => {
    expect(serverBuild(FAKE_LLAMA)).toBe(11669);
  });
});

describe("llamaServerPath", () => {
  // The override is how the tests never reach a real llama-server; PATH is how a person's install is found.
  it("prefers JEVELRY_LLAMA_SERVER, then searches PATH, and is undefined when neither has one", () => {
    expect(llamaServerPath({ JEVELRY_LLAMA_SERVER: FAKE_LLAMA, PATH: sandboxPath() })).toBe(FAKE_LLAMA);
    const bin = sandboxPath();
    expect(llamaServerPath({ PATH: bin })).toBe(join(bin, "llama-server"));
    expect(llamaServerPath({ PATH: sandboxPath(false) })).toBeUndefined();
  });
});

describe("launchArgs", () => {
  // Each flag is there for a model family that answers wrong or overcommits memory without it.
  it("launches one slot with a fixed context, a prompt-sized batch and an idle unload", () => {
    const { path } = { path: "/m/x.gguf" };
    expect(launchArgs({ repo: "r", file: "x.gguf", quant: "Q8_0", name: "X", decisionType: "vllm-d3", path, port: 41000, alias: "local/x" })).toEqual([
      "-m", "/m/x.gguf", "--host", "127.0.0.1", "--port", "41000", "--alias", "local/x", "--no-webui", "--no-mmproj",
      "-c", "8192", "-b", "4096", "-ub", "4096", "-np", "1", "--sleep-idle-seconds", "300",
    ]);
  });
});

describe("ensureServer and stopServer", () => {
  // A batch of asks fires at once on a cold start; one server each would load the model many times over.
  it("starts one server for concurrent calls, waits out the loading, and stopServer stops it", async () => {
    // Loading outlasts the first 500 ms poll, so the wait passes through both states.
    const { home, local, env, starts } = await fixture({ FAKE_LLAMA_LOAD_MS: "1200" });
    const waited: string[] = [];
    await Promise.all([1, 2, 3, 4, 5].map(() => ensureServer(home, local, env, { onWait: (s) => waited.push(s) })));
    expect(starts()).toEqual([launchArgs(local)]);
    expect(waited[0]).toBe("starting");
    expect(waited).toContain("loading");
    expect(await health(local.port)).toBe("ok");
    const server = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number };
    expect(server).toMatchObject({ port: local.port, path: local.path, alias: local.alias });
    // Ready already: a second call finds it and starts nothing.
    await ensureServer(home, local, env);
    expect(starts()).toHaveLength(1);
    expect(stopServer(home)).toBe(true);
    expect(await gone(server.pid)).toBe(true);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
    expect(stopServer(home)).toBe(false);
  });

  // The person sees why the model did not start (an architecture this build lacks, a bad file), not a timeout.
  it("reports the last log lines when the server stops while starting", async () => {
    const { home, local, env } = await fixture({ FAKE_LLAMA_FAIL: "llama_model_load: error loading model architecture: unknown model architecture: 'vllm-d3'" });
    await expect(ensureServer(home, local, env)).rejects.toThrow(/^the local model server stopped while starting; the last lines of .*llama-server\.log:\n[\s\S]*unknown model architecture: 'vllm-d3'$/);
  });

  // Asking some other program on the port would send the state to it and read its answer as Jev's.
  it("refuses another server on the port without starting one", async () => {
    const { home, local, env, starts } = await fixture();
    const other = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/v1/models" ? JSON.stringify({ object: "list", data: [{ id: "someone-else" }] }) : JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => other.listen(local.port, "127.0.0.1", resolve));
    try {
      await expect(ensureServer(home, local, env)).rejects.toThrow(`another server answers on port ${local.port}, not local/vllm-d3-flash-Q8_0; run jevelry install --local to pick a new port`);
      expect(starts()).toHaveLength(0);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  // A model that never finishes loading must end the wait with where to look, not hang the ask forever.
  it("gives up after the timeout and names the log", async () => {
    const { home, local, env } = await fixture({ FAKE_LLAMA_LOAD_MS: "60000" });
    await expect(ensureServer(home, local, env, { timeoutMs: 1000 })).rejects.toThrow(/^the local model server did not become ready in 1 s; see .*llama-server\.log$/);
  });

  // Both failures point at the one command that fixes them.
  it("says to run the install when llama-server or the model file is missing", async () => {
    const { home, local, env } = await fixture();
    await expect(startServer(home, local, { PATH: sandboxPath(false) })).rejects.toThrow("llama-server is not installed; run jevelry install --local");
    await expect(startServer(home, { ...local, path: join(home, "gone.gguf") }, env)).rejects.toThrow(`the model file is missing: ${join(home, "gone.gguf")}; run jevelry install --local`);
  });

  // After a reboot the recorded pid may belong to any program; SIGTERM to it could lose someone's work.
  it("never signals a live process whose command line is not the model's server", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-server-"));
    const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(join(home, SERVER_FILE), JSON.stringify({ pid: stranger.pid, port: 1, path: "/models/x.gguf", alias: "local/x" }));
      expect(stopServer(home)).toBe(false);
      expect(alive(stranger.pid!)).toBe(true);
      expect(existsSync(join(home, SERVER_FILE))).toBe(false);
    } finally {
      stranger.kill();
    }
  });
});

describe("localFetch", () => {
  // The first ask in local mode is what starts the server: nobody has to start it by hand.
  it("starts the server before the first request goes out", async () => {
    const { home, local, env } = await fixture({ FAKE_LLAMA_LOAD_MS: "100" });
    const response = await localFetch(home, local, env)(`http://127.0.0.1:${local.port}/v1/models`);
    expect(((await response.json()) as { data: Array<{ id: string }> }).data[0]?.id).toBe(local.alias);
  });
});

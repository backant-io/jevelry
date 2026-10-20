import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModel } from "../src/config.js";
import { budgetBytes, realMachine } from "../src/estimate.js";
import { SERVER_FILE, buildOf, ensureServer, health, launchArgs, llamaServerPath, localFetch, serverBuild, startServer, stopServer } from "../src/server.js";
import { FAKE_LLAMA, killFakes, sandboxEnv, sandboxPath } from "./fixtures/sandbox.js";

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

// Every home a test makes is stopped after it, and its fakes killed whatever stopServer did, so no fake server outlives its test.
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    stopServer(home);
    killFakes(join(home, "argv.ndjson"));
  }
});

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
  const starts = (): Array<{ pid: number; args: string[]; env: string[] }> => (existsSync(argv) ? readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number; args: string[]; env: string[] }) : []);
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
    expect(starts().map((s) => s.args)).toEqual([launchArgs(local)]);
    expect(waited[0]).toBe("starting");
    expect(waited).toContain("loading");
    expect(await health(local.port)).toBe("ok");
    const server = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number };
    expect(server).toMatchObject({ port: local.port, path: local.path, alias: local.alias });
    // Ready already: a second call finds it and starts nothing.
    await ensureServer(home, local, env);
    expect(starts()).toHaveLength(1);
    expect(stopServer(home)).toBe(server.pid);
    expect(await gone(server.pid)).toBe(true);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
    expect(stopServer(home)).toBeNull();
  });

  // The person sees why the model did not start (an architecture this build lacks, a bad file), not a timeout.
  it("reports the last log lines when the server stops while starting", async () => {
    const { home, local, env } = await fixture({ FAKE_LLAMA_FAIL: "llama_model_load: error loading model architecture: unknown model architecture: 'vllm-d3'" });
    await expect(ensureServer(home, local, env)).rejects.toThrow(/^the local model server stopped while starting; the last lines of .*llama-server\.log:\n[\s\S]*unknown model architecture: 'vllm-d3'$/);
  });

  // Asking some other program on the port would send it the state and read its answer as Jev's, and
  // what a server says about itself proves nothing: this one even claims the model's alias.
  it("sends no request to a server on the port that is not ours, and starts none", async () => {
    const { home, local, env, starts } = await fixture();
    const requests: string[] = [];
    const other = createHttpServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/v1/models" ? JSON.stringify({ object: "list", data: [{ id: local.alias, aliases: [local.alias] }] }) : JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => other.listen(local.port, "127.0.0.1", resolve));
    try {
      const ask = localFetch(home, local, env)(`http://127.0.0.1:${local.port}/v1/systemone`, { method: "POST", body: "{}" });
      await expect(ask).rejects.toThrow(`another server answers on port ${local.port}, not local/vllm-d3-flash-Q8_0; run jevelry install --local to pick a new port`);
      expect(new Set(requests)).toEqual(new Set(["/health"]));
      expect(starts()).toHaveLength(0);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  // Two models at once is how a GPU runs out of memory: a program still holding the old model's
  // config must not load it beside the one jevelry was switched to.
  it("refuses to start a model while another model of ours runs, and starts nothing", async () => {
    const { home, local, env, starts } = await fixture({ FAKE_LLAMA_LOAD_MS: "100" });
    await ensureServer(home, local, env);
    const path = join(home, "other-Q4_K_M.gguf");
    writeFileSync(path, "not a model either");
    const other: LocalModel = { ...local, file: "other-Q4_K_M.gguf", path, port: await freePort(), alias: "local/other-Q4_K_M" };
    await expect(ensureServer(home, other, env)).rejects.toThrow("a different local model is running (local/vllm-d3-flash-Q8_0); run jevelry stop first, or restart this program if jevelry was switched to another model");
    expect(starts()).toHaveLength(1);
    expect(await health(other.port)).toBe("down");
  });

  // A synced $JEVELRY_HOME or a config from a bigger machine must not load what this machine cannot
  // hold, and JEVELRY_MACHINE, which only browses another machine's picks, must not lift that limit.
  it("refuses to start a model that won't fit this machine, whatever JEVELRY_MACHINE says", async () => {
    const huge = { os: "darwin", chip: "Apple M4 Pro", cpus: 12, ramBytes: 2 ** 50, darwinMajor: 24, gpu: null };
    const { home, local, env, starts } = await fixture({ JEVELRY_MACHINE: JSON.stringify(huge) });
    // Sparse: as big as the whole of this machine's memory, on paper only.
    const budget = budgetBytes(realMachine());
    truncateSync(local.path, Math.ceil(budget));
    const need = Math.ceil(budget) + 1.5 * 2 ** 30;
    await expect(ensureServer(home, local, env)).rejects.toThrow(
      `local/vllm-d3-flash-Q8_0 needs about ${(need / 1e9).toFixed(1)} GB and this machine has about ${(budget / 1e9).toFixed(1)} GB for models; run jevelry install --local to pick a smaller model`,
    );
    expect(starts()).toHaveLength(0);
  });

  // The hosted key must never sit in a long-lived process, and llama-server reads LLAMA_ARG_* settings
  // that could load something other than what the launch arguments say.
  it("starts the server without TYPESAFE_API_KEY or any LLAMA_ variable", async () => {
    const { home, local, env, starts } = await fixture({ FAKE_LLAMA_LOAD_MS: "100", TYPESAFE_API_KEY: "ts-secret", LLAMA_ARG_MODEL: "/elsewhere.gguf" });
    await ensureServer(home, local, env);
    expect(starts().map((s) => s.env)).toEqual([[]]);
  });

  // A jevelry killed while it started the server leaves its lock behind; no later ask may wait on a dead process.
  it("takes over a lock whose holder died", async () => {
    const { home, local, env, starts } = await fixture({ FAKE_LLAMA_LOAD_MS: "100" });
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    writeFileSync(join(home, "server.lock"), String(dead.pid));
    await ensureServer(home, local, env);
    expect(starts()).toHaveLength(1);
    expect(existsSync(join(home, "server.lock"))).toBe(false);
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
  // One that names the model file but serves another port is not the server on record either.
  it("never signals a live process whose command line is not the model's server", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-server-"));
    const stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const otherPort = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", "-m", "/models/x.gguf", "--port", "12"], { stdio: "ignore" });
    try {
      for (const pid of [stranger.pid, otherPort.pid]) {
        writeFileSync(join(home, SERVER_FILE), JSON.stringify({ pid, port: 1, path: "/models/x.gguf", alias: "local/x" }));
        expect(stopServer(home)).toBeNull();
        expect(alive(pid!)).toBe(true);
        expect(existsSync(join(home, SERVER_FILE))).toBe(false);
      }
    } finally {
      stranger.kill();
      otherPort.kill();
    }
  });
});

describe("health", () => {
  // A server busy past the 2 s check is still there: reading it as down would start a second one beside it.
  it("is loading when /health is slow, and down only when the connection is refused", async () => {
    const slow = createHttpServer((_req, res) => { setTimeout(() => res.end("{}"), 2500); });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      expect(await health((slow.address() as { port: number }).port)).toBe("loading");
    } finally {
      slow.closeAllConnections();
      await new Promise((resolve) => slow.close(resolve));
    }
    expect(await health(await freePort())).toBe("down");
  });
});

describe("localFetch", () => {
  // The first ask in local mode is what starts the server: nobody has to start it by hand.
  it("starts the server before the first request goes out", async () => {
    const { home, local, env } = await fixture({ FAKE_LLAMA_LOAD_MS: "100" });
    const response = await localFetch(home, local, env)(`http://127.0.0.1:${local.port}/v1/models`);
    expect(((await response.json()) as { data: Array<{ id: string }> }).data[0]?.id).toBe(local.alias);
  });

  // The SDK ends a request by aborting its signal; a wait that ignored it would hold the ask for the whole load.
  it("gives up waiting for a slow load when the request is aborted", async () => {
    const { home, local, env } = await fixture({ FAKE_LLAMA_LOAD_MS: "4000" });
    const started = Date.now();
    await expect(localFetch(home, local, env)(`http://127.0.0.1:${local.port}/v1/models`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow(/aborted due to timeout/);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

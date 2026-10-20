import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LocalModel, readConfig, writeConfig } from "../src/config.js";
import { SERVER_FILE, launchArgs, stopServer } from "../src/server.js";
import { type FakeHf, startHf } from "./fixtures/hf.js";
import { FAKE_LLAMA, M2_16, M4_PRO_24, killFakes, liveFakes, sandboxEnv } from "./fixtures/sandbox.js";
import type { Machine } from "../src/estimate.js";

const QUESTIONS = JSON.stringify({ urgent: { type: "noul", instructions: "Is it urgent?" } });

/**
 * Spawned asynchronously: the fake Hugging Face answers on this process's event loop. The environment
 * is the sandbox's alone (PATH holds only node and the fakes), so no code path can reach this
 * machine's real llama-server or brew, and stdin is a pipe, never a terminal.
 */
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/jevelry.js", ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end("");
  });

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

let hf: FakeHf;
beforeAll(async () => { hf = await startHf(); });
afterAll(async () => hf.close());

// Every home is stopped after its test, and its fakes killed whatever stopServer did: a fake server
// started by a spawned jevelry outlives that process by design.
const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) {
    stopServer(dir);
    killFakes(join(dir, "argv.ndjson"));
  }
});

const envFor = (home: string, machine: Machine, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  sandboxEnv(home, { JEVELRY_HF_URL: hf.url, JEVELRY_MACHINE: JSON.stringify(machine), FAKE_LLAMA_LOAD_MS: "100", ...extra });

function fixture(machine: Machine = M4_PRO_24, prefix = "jevelry-local-cli-") {
  const home = mkdtempSync(join(tmpdir(), prefix));
  homes.push(home);
  return { home, env: envFor(home, machine) };
}

const recordedPid = (home: string): number => (JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number }).pid;

/** A local model on file, as an install leaves it, without downloading or starting anything. */
async function configuredLocal(home: string): Promise<LocalModel> {
  const path = join(home, "vllm-d3-flash-Q8_0.gguf");
  writeFileSync(path, "not a model");
  const local: LocalModel = {
    repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B",
    decisionType: "vllm-d3", path, port: await freePort(), alias: "local/vllm-d3-flash-Q8_0",
  };
  writeConfig(home, { backend: "local", local });
  return local;
}

describe("jevelry models --local", () => {
  // A too-big model crashed this machine's GPU: the list a person picks from must say a 27B won't fit
  // on a 24 GB M4 Pro and put the model that runs well at the top, where Enter takes it.
  it("ranks the models for a 24 GB M4 Pro: the 27B rows won't fit and vllm-d3-flash Q8_0 runs well first", async () => {
    const { env } = fixture();
    const r = await run(["models", "--local"], env);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("This machine: Apple M4 Pro, 24 GB memory, about 17 GB usable by the GPU");
    const rows = lines.slice(lines.findIndex((l) => l.trimStart().startsWith("#")) + 1).filter((l) => /^\s+\d+\s/.test(l));
    expect(rows[0]).toMatch(/^\s+1\s+vllm-d3-flash\s+vLLM-SR d3-flash 9B\s+Q8_0\s.*runs well/);
    const big = rows.filter((l) => l.includes("27B"));
    expect(big.length).toBe(3);
    for (const row of big) expect(row).toContain("won't fit");
  });

  // Agents read the list as JSON: the same ranking, with the bytes, the fit and the speed as numbers.
  it("prints the same ranking as JSON rows with --json", async () => {
    const { env } = fixture();
    const r = await run(["models", "--local", "--json"], env);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ id: string; name: string; fit: string; seconds_per_question: number | null }>;
    expect(rows[0]).toEqual({
      id: "vllm-d3-flash", repo: "ggml-org/vllm-d3-flash-GGUF", name: "vLLM-SR d3-flash 9B", quant: "Q8_0", file: "vllm-d3-flash-Q8_0.gguf",
      download_bytes: expect.any(Number), need_bytes: expect.any(Number), fit: "runs well", score: 55.79,
      seconds_per_question: expect.any(Number), licence: "Apache-2.0", decision_type: "vllm-d3",
    });
    const big = rows.filter((row) => row.name.includes("27B"));
    expect(big.map((row) => [row.fit, row.seconds_per_question])).toEqual(Array(3).fill(["won't fit", null]));
    // Runs well, then tight, then won't fit: an agent taking the first row takes one that runs.
    const order = ["runs well", "tight", "won't fit"];
    expect(rows.map((row) => order.indexOf(row.fit))).toEqual([...rows.map((row) => order.indexOf(row.fit))].sort());
  });

  // --json is the ranked rows of --local; alone there are none, and an agent must be told, not handed nothing to parse.
  it("exits 2 for --json without --local", async () => {
    const { env } = fixture();
    const r = await run(["models", "--json"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe("jevelry: --json needs --local\n");
    expect(r.stdout).toBe("");
  });

  // In local mode there is one model, the one on this machine: listing it must not start a server to ask it.
  it("names the local model without starting its server when jevelry runs one", async () => {
    const { home, env } = fixture();
    const local = await configuredLocal(home);
    const r = await run(["models"], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${local.alias}\tlocal\tvLLM-SR d3-flash 9B on this machine\n`);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
  });
});

describe("jevelry install --local <model> --yes, then ask and stop", () => {
  // One install for the three tests, so its server lives across them and is stopped once, after them.
  let home: string;
  let argv: string;
  let localEnv: NodeJS.ProcessEnv;
  let installed: { status: number | null; stdout: string; stderr: string };
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "jevelry-local-cli-"));
    argv = join(home, "argv.ndjson");
    localEnv = envFor(home, M4_PRO_24, { FAKE_LLAMA_ARGV_FILE: argv });
    installed = await run(["install", "--local", "vllm-d3-flash", "--yes"], localEnv);
  });
  afterAll(() => {
    stopServer(home);
    killFakes(argv);
  });

  // The whole first run from one command an agent can type: verified file, config, running server, and an answer.
  it("writes config.json, starts the server and prints the smoke answer", () => {
    expect(installed.status).toBe(0);
    const config = readConfig(home);
    expect(config).toMatchObject({ backend: "local", local: { repo: "ggml-org/vllm-d3-flash-GGUF", quant: "Q8_0", alias: "local/vllm-d3-flash-Q8_0" } });
    expect(existsSync(config.local!.path)).toBe(true);
    expect(installed.stderr).toMatch(/^jevelry: vLLM-SR d3-flash 9B answered in \d+ ms on this machine$/m);
    expect(installed.stderr).toContain("jevelry: jevelry now asks vLLM-SR d3-flash 9B on this machine (local/vllm-d3-flash-Q8_0)\n");
    // Not a terminal: progress is whole lines, never carriage returns that garble a CI log.
    expect(installed.stderr).not.toContain("\r");
    expect(existsSync(join(home, SERVER_FILE))).toBe(true);
  });

  // The point of the install: the command a person already uses now answers from the model on this machine.
  it("answers the next jevelry ask from the local server it started", async () => {
    const r = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], localEnv);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { model: string; answers: { urgent: { decision: string } } };
    expect(doc.model).toBe("local/vllm-d3-flash-Q8_0");
    expect(doc.answers.urgent.decision).toBe("act");
    // The ask reused the server the install left running instead of loading the model again.
    expect(readFileSync(argv, "utf8").trim().split("\n")).toHaveLength(1);
  });

  // A model holds GPU memory while it runs: `stop` must give it back, and say so truthfully either way.
  it("stops the server with jevelry stop and leaves no process behind", async () => {
    const { pid } = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number };
    expect(alive(pid)).toBe(true);
    const r = await run(["stop"], localEnv);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("jevelry: stopped the local model server\n");
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
    const again = await run(["stop"], localEnv);
    expect(again.stderr).toBe("jevelry: no local model server was running\n");
  });
});

describe("jevelry stop and switches wait for the server to be gone", () => {
  // "stopped" is a promise that the model left the GPU's memory. Said while it still unloads, the next
  // install loads its model beside it, which is how a GPU runs out; install --typesafe makes the same promise.
  it("says stopped only once a server slow to exit is gone, and install --typesafe waits for it too", async () => {
    const { home, env } = fixture();
    const slow = { ...env, FAKE_SIGTERM_DELAY_MS: "1000" };
    expect((await run(["install", "--local", "vllm-d3-flash", "--yes"], slow)).status).toBe(0);
    const first = recordedPid(home);
    const stop = await run(["stop"], slow);
    expect(stop.stderr).toBe("jevelry: stopped the local model server\n");
    expect(stop.status).toBe(0);
    expect(alive(first)).toBe(false);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
    expect((await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], slow)).status).toBe(0);
    const second = recordedPid(home);
    expect((await run(["install", "--typesafe"], { ...slow, TYPESAFE_API_KEY: "test-key" })).status).toBe(0);
    expect(alive(second)).toBe(false);
  });

  // Ctrl-C during an install leaves only time for SIGTERM, and the new model may take seconds to unload.
  // An ask on the old setup meanwhile must be refused, not load the old model beside the new one.
  it("refuses an ask on the old model while the interrupted install's server is still exiting", async () => {
    const { home, env } = fixture();
    expect((await run(["install", "--local", "vllm-d3-flash", "--yes"], env)).status).toBe(0);
    const child = spawn(process.execPath, ["bin/jevelry.js", "install", "--local", "kev-4b", "--yes"], { env: { ...env, FAKE_LLAMA_LOAD_MS: "20000", FAKE_SIGTERM_DELAY_MS: "3000" }, stdio: "ignore" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    try {
      // Interrupted once the new server runs and loads, not before it could even handle SIGTERM.
      for (let i = 0; i < 200 && !liveFakes(join(home, "argv.ndjson")).some((f) => f.args[1]!.includes("Kev-4B")); i++) await sleep(50);
      child.kill("SIGINT");
      expect(await exited).toBe(130);
      const ask = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
      expect(ask.status).toBe(6);
      expect(JSON.parse(ask.stdout)).toMatchObject({ error: { message: expect.stringContaining("a different local model is running (local/Kev-4B-Q8_0)") } });
      expect(liveFakes(join(home, "argv.ndjson"))).toHaveLength(1);
    } finally {
      child.kill("SIGKILL");
    }
  });

  // Cron jobs and launchd agents run without a locale, and ps then escapes every non-ASCII byte of a path.
  // jevelry must still know its own server, or it refuses it on every ask and never stops it.
  it("installs, asks and stops in a home whose path is not ASCII, with no locale set", async () => {
    const { home, env } = fixture(M4_PRO_24, "jevelry-local-cli-hömé-");
    expect(env.LANG).toBeUndefined();
    const install = await run(["install", "--local", "vllm-d3-flash", "--yes"], env);
    expect(install.stderr).toContain("jevelry now asks vLLM-SR d3-flash 9B");
    expect(install.status).toBe(0);
    const pid = recordedPid(home);
    expect((await run(["stop"], env)).stderr).toBe("jevelry: stopped the local model server\n");
    expect(alive(pid)).toBe(false);
  });

  // A server no record names (its jevelry was killed between starting it and writing it down) still holds a
  // model in memory: jevelry stop must find it by its command line, in a non-ASCII home without a locale too.
  it("stops a server in this home's models folder that no record names", async () => {
    const { home, env } = fixture(M4_PRO_24, "jevelry-local-cli-hömé-");
    const path = join(home, "models", "ggml-org", "Kev-4B-GGUF", "Kev-4B-Q8_0.gguf");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not a model");
    const local: LocalModel = { repo: "ggml-org/Kev-4B-GGUF", file: "Kev-4B-Q8_0.gguf", quant: "Q8_0", name: "Kev 4B", decisionType: "kev", path, port: await freePort(), alias: "local/Kev-4B-Q8_0" };
    const stray = spawn(FAKE_LLAMA, launchArgs(local), { env, stdio: "ignore" });
    for (let i = 0; i < 100 && liveFakes(join(home, "argv.ndjson")).length === 0; i++) await sleep(20);
    const started = Date.now();
    const stop = await run(["stop"], env);
    expect(stop.stderr).toBe("jevelry: stopped the local model server\n");
    // Asked to exit first, like the recorded server, rather than killed after the 15 s grace.
    expect(Date.now() - started).toBeLessThan(5000);
    for (let i = 0; i < 40 && alive(stray.pid!); i++) await sleep(50);
    expect(alive(stray.pid!)).toBe(false);
  });
});

describe("jevelry install --local refusals", () => {
  // A typo must not install the nearest model or nothing silently: exit 2 names the list to pick from.
  it("exits 2 for a model the list does not have, downloading nothing", async () => {
    const { home, env } = fixture();
    const r = await run(["install", "--local", "nosuch", "--yes"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("jevelry: unknown model nosuch; jevelry models --local lists them\n");
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(existsSync(join(home, "models"))).toBe(false);
  });

  // An agent without a terminal cannot answer the picker: it gets the table to choose from and an exit that says it chose nothing.
  it("prints the table and exits 2 when no model is named and nobody can choose", async () => {
    const { home, env } = fixture();
    const r = await run(["install", "--local"], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("This machine: Apple M4 Pro, 24 GB memory");
    expect(r.stderr).toMatch(/\n\s+1\s+vllm-d3-flash\s/);
    expect(r.stderr).toContain("jevelry: choose a model: jevelry install --local <id>\n");
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  // A model too big for the GPU is what crashed this machine: even with --yes it is refused before any download.
  it("refuses a model that won't fit with exit 1, even with --yes", async () => {
    const { home, env } = fixture();
    const r = await run(["install", "--local", "vllm-d3", "--yes"], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/jevelry: vLLM-SR d3 27B needs about 22\.\d GB and this machine has about 17\.2 GB for models\n/);
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(existsSync(join(home, "models"))).toBe(false);
  });

  // A forced quant and a row number skip the table's advice, so they must meet the same refusal: a 27B crashed
  // this 24 GB machine's GPU.
  it("refuses a forced vllm-d3:Q8_0 and the 27B's row number, creating no models folder", async () => {
    const { home, env } = fixture();
    const rows = JSON.parse((await run(["models", "--local", "--json"], env)).stdout) as Array<{ id: string }>;
    const row = rows.findIndex((r) => r.id === "vllm-d3") + 1;
    expect(row).toBeGreaterThan(0);
    for (const wanted of ["vllm-d3:Q8_0", String(row)]) {
      const r = await run(["install", "--local", wanted, "--yes"], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/jevelry: vLLM-SR d3 27B needs about \d+\.\d GB and this machine has about 17\.2 GB for models\n/);
    }
    expect(existsSync(join(home, "models"))).toBe(false);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  // Ctrl-C or a kill while the model loads must not leave it in the GPU's memory with no config naming it.
  it("stops the new server and exits 130 or 143 when the install is interrupted while the model loads", async () => {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { home, env } = fixture();
      const child = spawn(process.execPath, ["bin/jevelry.js", "install", "--local", "vllm-d3-flash", "--yes"], { env: { ...env, FAKE_LLAMA_LOAD_MS: "20000" }, stdio: "ignore" });
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      try {
        for (let i = 0; i < 200 && !existsSync(join(home, SERVER_FILE)); i++) await sleep(50);
        const { pid } = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number };
        child.kill(signal);
        expect(await exited).toBe(code);
        for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
        expect(alive(pid)).toBe(false);
        expect(existsSync(join(home, "config.json"))).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    }
  });

  // A tight fit leaves the machine little memory, so without a terminal it waits for --yes instead of installing anyway.
  it("installs a tight fit only with --yes when nobody can answer", async () => {
    const { home, env } = fixture(M2_16);
    const before = hf.requests.length;
    const r = await run(["install", "--local", "vllm-d3-flash:Q8_0"], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is a tight fit");
    expect(r.stderr).toContain("run again with --yes to answer yes");
    expect(r.stderr).toContain("jevelry: nothing changed\n");
    expect(hf.requests.slice(before).some((req) => req.url.includes("/resolve/"))).toBe(false);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });
});

describe("jevelry install without --local", () => {
  // A jevelry that already asks somewhere is left alone, and the person learns where and how to switch.
  it("reports what is configured, a key or a local model, and changes nothing", async () => {
    const { home, env } = fixture();
    const before = hf.requests.length;
    const hosted = await run(["install"], { ...env, TYPESAFE_API_KEY: "test-key" });
    expect(hosted.status).toBe(0);
    expect(hosted.stderr).toContain("jevelry: jevelry asks hosted Jev with your TypeSafe key; jevelry install --local or --typesafe changes it\n");
    expect(existsSync(join(home, "config.json"))).toBe(false);
    await configuredLocal(home);
    const local = await run(["install"], { ...env, TYPESAFE_API_KEY: "test-key" });
    expect(local.stderr).toContain("jevelry: jevelry asks vLLM-SR d3-flash 9B on this machine; jevelry install --local or --typesafe changes it\n");
    expect(hf.requests.length).toBe(before);
  });

  // A pipe or a CI job cannot answer the first-run question, so both ways to set Jev up are named instead.
  it("names both ways to set up when nothing is configured and nobody can choose", async () => {
    const { home, env } = fixture();
    const r = await run(["install"], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`jevelry: no key stored; put it in TYPESAFE_API_KEY, your keychain (service typesafe-api-key, account jevelry) or ${join(home, "env")}\n`);
    expect(r.stderr).toContain("jevelry: or run a model on this machine: jevelry models --local, then jevelry install --local <id>\n");
  });

  // Switching to hosted Jev is one flag, and the local model stays on file so switching back needs no download.
  it("switches to TypeSafe with --typesafe and keeps the local model on file", async () => {
    const { home, env } = fixture();
    const local = await configuredLocal(home);
    const r = await run(["install", "--typesafe"], { ...env, TYPESAFE_API_KEY: "test-key" });
    expect(r.status).toBe(0);
    expect(readConfig(home)).toEqual({ backend: "typesafe", local });
    expect(r.stderr).toContain("jevelry: a TypeSafe key is already available\n");
  });

  // Hosted Jev without a key fails every ask: the model that answers now stays the one jevelry asks.
  it("keeps the local setup when --typesafe finds no key", async () => {
    const { home, env } = fixture();
    const local = await configuredLocal(home);
    const r = await run(["install", "--typesafe"], env);
    expect(r.status).toBe(0);
    expect(readConfig(home)).toEqual({ backend: "local", local });
    expect(r.stderr).toContain("jevelry: no key stored;");
    expect(r.stderr).toContain("jevelry: nothing changed\n");
  });
});

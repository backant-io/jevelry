import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LocalModel, writeConfig } from "../src/config.js";
import { SERVER_FILE, stopServer } from "../src/server.js";
import { killFakes, liveFakes, sandboxEnv } from "./fixtures/sandbox.js";
import { type TestServer, startServer as startTypesafe } from "./fixtures/server.js";

const QUESTIONS = JSON.stringify({ urgent: { type: "noul", instructions: "Is it urgent?" } });

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

/**
 * Spawned asynchronously: the hosted fake answers on this process's event loop. The environment is
 * the sandbox's alone, so the binary finds the fake llama-server and nothing else on this machine.
 */
const run = (args: string[], env: NodeJS.ProcessEnv, input = "") =>
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
    child.stdin.end(input);
  });

// Every home is stopped after its test, and its fakes killed whatever stopServer did: a fake server
// started by a spawned jevelry outlives that process by design.
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    stopServer(home);
    killFakes(join(home, "argv.ndjson"));
  }
});

let typesafe: TestServer;
beforeAll(async () => { typesafe = await startTypesafe(); });
afterAll(async () => typesafe.close());

async function fixture(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "jevelry-local-ask-"));
  homes.push(home);
  const path = join(home, "vllm-d3-flash-Q8_0.gguf");
  writeFileSync(path, "not a model");
  const local: LocalModel = {
    repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B",
    decisionType: "vllm-d3", path, port: await freePort(), alias: "local/vllm-d3-flash-Q8_0",
  };
  writeConfig(home, { backend: "local", local });
  const argv = join(home, "argv.ndjson");
  const env = sandboxEnv(home, { FAKE_LLAMA_ARGV_FILE: argv, FAKE_LLAMA_LOAD_MS: "200", ...extra });
  const starts = (): number => (existsSync(argv) ? readFileSync(argv, "utf8").trim().split("\n").length : 0);
  return { home, local, env, starts };
}

describe("jevelry ask in local mode", () => {
  // Once a local model is installed, the same command a person already uses must answer from it,
  // starting the server on the first ask and reusing it after.
  it("starts the local server on the first ask, answers through it and reuses it", async () => {
    const { home, local, env, starts } = await fixture();
    const first = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const doc = JSON.parse(first.stdout) as { model: string; answers: { urgent: { decision: string; yes: boolean } } };
    expect(doc.model).toBe(local.alias);
    expect(doc.answers.urgent).toMatchObject({ decision: "act", yes: true });
    expect(existsSync(join(home, SERVER_FILE))).toBe(true);
    const second = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    expect(second.status).toBe(0);
    expect(starts()).toBe(1);
  });

  // A batch fires its asks at once on a cold start; each starting its own server would load the model many times.
  it("starts one server for a batch of concurrent asks", async () => {
    const { local, env, starts } = await fixture();
    const lines = [1, 2, 3, 4].map((id) => JSON.stringify({ id, questions: JSON.parse(QUESTIONS), state: "Help!" })).join("\n");
    const r = await run(["ask", "--batch"], env, lines);
    expect(r.status).toBe(0);
    const answers = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { model: string });
    expect(answers.map((a) => a.model)).toEqual(Array(4).fill(local.alias));
    expect(starts()).toBe(1);
  });

  // Agents run commands in parallel: each cold ask starting its own server would load the model once
  // per process. The server listens late, so every ask finds the port down and must find the others' launch.
  it("starts exactly one server when jevelry processes ask at once on a cold start", async () => {
    const { home, env, starts } = await fixture({ FAKE_LLAMA_LISTEN_DELAY_MS: "1500" });
    const ask = () => run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    const results = await Promise.all([ask(), ask(), ask()]);
    expect(results.map((r) => r.status)).toEqual([0, 0, 0]);
    expect(starts()).toBe(1);
    const started = JSON.parse(readFileSync(env.FAKE_LLAMA_ARGV_FILE!, "utf8")) as { pid: number };
    expect(JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8"))).toMatchObject({ pid: started.pid });
  });

  // The environment wins everywhere in jevelry: a host that exports a base URL for one command gets exactly that server.
  it("still asks TYPESAFE_BASE_URL when the environment sets it, starting nothing", async () => {
    const { home, env, starts } = await fixture();
    const r = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], { ...env, TYPESAFE_BASE_URL: typesafe.url, TYPESAFE_API_KEY: "test-key" });
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { model: string }).model).toBe("jev-1.13.0");
    expect(starts()).toBe(0);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
  });

  // JEVELRY_TIMEOUT_MS is how a host bounds an ask; a model still loading must not hold it for the whole load.
  it("fails after about JEVELRY_TIMEOUT_MS while the model loads, not after the load", async () => {
    const { env } = await fixture({ FAKE_LLAMA_LOAD_MS: "4000", JEVELRY_TIMEOUT_MS: "1000" });
    const started = Date.now();
    const r = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    expect(r.status).toBe(6);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // With room under the timeout, the error a person reads points at the server's log, not at a generic SDK timeout.
  it("names the server log when the model does not load within JEVELRY_TIMEOUT_MS", async () => {
    const { env } = await fixture({ FAKE_LLAMA_LOAD_MS: "6000", JEVELRY_TIMEOUT_MS: "3000" });
    const r = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    expect(r.status).toBe(6);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "transport", message: expect.stringMatching(/the local model server did not become ready in 1 s; see .*llama-server\.log$/) } });
  });

  // A failure on this machine is the local server's, not TypeSafe's, and its reason is in the server's log.
  it("names the local model server and its log when it answers 500", async () => {
    const { env } = await fixture({ FAKE_LLAMA_ANSWER_STATUS: "500" });
    const r = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    expect(r.status).toBe(6);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "transport", message: expect.stringMatching(/^the local model server answered 500: .*; see llama-server\.log in \$JEVELRY_HOME$/) } });
  });

  // A local server that cannot start is a transport failure like a network one: exit 6, with the reason to act on.
  it("exits 6 with the reason when the local server cannot start", async () => {
    const { env, local } = await fixture();
    writeFileSync(join(env.JEVELRY_HOME!, "config.json"), JSON.stringify({ backend: "local", local: { ...local, path: join(env.JEVELRY_HOME!, "gone.gguf") } }));
    const r = await run(["ask", "--questions", QUESTIONS, "--state", '"Help!"'], env);
    expect(r.status).toBe(6);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "transport", message: expect.stringContaining("the model file is missing") } });
  });

  // Ctrl-C lands at any moment. Between starting the server and writing down which process it is, it
  // would leave a model loaded that nothing knows about: no stop finds it and the next ask loads another.
  it("leaves no server without a record when jevelry ask gets SIGINT around the spawn, 60 runs", async () => {
    const once = async (atUs: number | null): Promise<{ recordedAtUs: number; orphans: number[]; signal: unknown }> => {
      // The model sits outside the models folder, so only holding the signal can pass, not the stray check.
      const { home, env } = await fixture({ FAKE_LLAMA_LOAD_MS: "100", FAKE_LLAMA_LIFETIME_MS: "6000" });
      const record = join(home, SERVER_FILE);
      const t0 = process.hrtime.bigint();
      const sinceUs = (): number => Number(process.hrtime.bigint() - t0) / 1000;
      const child = spawn(process.execPath, ["bin/jevelry.js", "ask", "--questions", '{"q":{"type":"noul","instructions":"x"}}', "--state", '"x"'], { env, stdio: "ignore" });
      const closed = new Promise((resolve) => child.on("close", (_code, signal) => resolve(signal)));
      let recordedAtUs = -1;
      // Busy loops, not timers: the window between spawn and record is about a millisecond wide.
      if (atUs === null) {
        while (recordedAtUs < 0 && sinceUs() < 3e6) if (existsSync(record)) recordedAtUs = sinceUs();
      } else {
        while (sinceUs() < atUs) {
          // Wait for the moment to interrupt.
        }
        child.kill("SIGINT");
      }
      const signal = await closed;
      // A server spawned just before the signal needs a moment to start and write its line.
      await sleep(300);
      let named: unknown = null;
      try {
        named = (JSON.parse(readFileSync(record, "utf8")) as { pid: unknown }).pid;
      } catch {
        // No record at all.
      }
      const orphans = liveFakes(join(home, "argv.ndjson")).map((f) => f.pid).filter((pid) => pid !== named);
      stopServer(home);
      killFakes(join(home, "argv.ndjson"));
      return { recordedAtUs, orphans, signal };
    };
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push((await once(null)).recordedAtUs);
    const center = times.sort((a, b) => a - b)[2]!;
    expect(center).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (let run = 0; run < 60; run++) {
      // From 8 ms before to 2 ms after the moment the record usually appears.
      const at = center - 8000 + Math.random() * 10000;
      const { orphans, signal } = await once(at);
      if (orphans.length > 0) wrong.push(`SIGINT at ${Math.round(at)} us left pid ${orphans.join(", ")}`);
      // Held, never swallowed: Ctrl-C still ends the ask once the record is written.
      if (signal !== "SIGINT") wrong.push(`SIGINT at ${Math.round(at)} us ended the ask with ${String(signal)}`);
    }
    expect(wrong).toEqual([]);
  }, 180000);
});

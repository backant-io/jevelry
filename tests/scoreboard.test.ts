import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needBytes } from "../src/estimate.js";
import { type TestServer, startServer } from "./fixtures/server.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
let server: TestServer;
const children: ChildProcess[] = [];
beforeAll(async () => { server = await startServer(); });
afterAll(async () => {
  for (const child of children) child.kill();
  await server.close();
});

const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-scoreboard-"));
  mkdirSync(join(home, ".jevelry"));
  return home;
};

/** Spawned asynchronously: the fake server answers on this process's own event loop. `--quick` skips the install and times three rounds. */
const run = (home: string, args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("node", ["scripts/scoreboard.mjs", "--quick", ...args], {
      env: { PATH: process.env.PATH, HOME: home, JEVELRY_HOME: join(home, ".jevelry"), JEVELRY_KEY_STORE: "file", TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.url, JEVELRY_JEVELS: FIXTURES, JEVELRY_KNOWN_SERVERS: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const timedAsk = (id: string, ms: number): string =>
  JSON.stringify({ kind: "ask", id, at: "2026-11-10T10:00:00.000Z", jevel: { name: "ticket-triage", version: 3 }, model: "local/a.gguf", state_hash: "sha256:x", answers: {}, usage: { input_tokens: 500, output_tokens: 1 }, ms, cwd: "/w" });

// Every change to jevelry is judged on this record, so it has to run anywhere, cost nothing and say what it left out.
describe("npm run scoreboard", () => {
  it("times start-up and reads the speed of logged asks without asking a model, and names what it did not measure", async () => {
    const home = makeHome();
    const copy = JSON.stringify({ ...JSON.parse(timedAsk("d", 3)), cached_from: "a", usage: { input_tokens: 0, output_tokens: 0 } });
    writeFileSync(join(home, ".jevelry", "log.jsonl"), `${[timedAsk("a", 100), timedAsk("b", 300), timedAsk("c", 200), copy].join("\n")}\n`);
    const out = join(home, "board.json");
    const before = server.requests.length;
    const r = await run(home, ["--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const board = JSON.parse(readFileSync(out, "utf8")) as Record<string, any>;
    expect(board.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(board.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(board.start.bare_node_ms.median).toBeGreaterThan(0);
    // Every time in a record depends on what else the machine was doing: a record taken at a load average of 149
    // showed bare Node starting in 786 ms, thirteen times its usual 60. The record says how busy the machine was.
    expect(board.machine.load_1m).toBeGreaterThanOrEqual(0);
    expect(board.start.jevelry_version_ms.median).toBeGreaterThan(0);
    expect(board.speed).toEqual([{ jevel: "ticket-triage", model: "local/a.gguf", asks: 3, p50_ms: 200, p95_ms: 300, tokens_per_s: 2500, cold_asks: 0, cold_p50_ms: null }]);
    expect([board.install, board.footprint, board.quality]).toEqual([null, null, null]);
    // What the repeat cache saved shows next to the model's own speed: one ask in four here never reached the model.
    expect(board.repeats).toEqual({ answered_by_model: 3, answered_from_log: 1 });
    const left = (board.not_measured as string[]).join("\n");
    expect(left).toMatch(/install/);
    expect(left).toMatch(/model server/);
    expect(left).toMatch(/--eval/);
    // No logged ask waited for a model to load, so there is no cold time to give.
    expect(left).toMatch(/cold asks/);
    // Asking is never the default: on hosted Jev every case costs money, and a local model would have to load.
    expect(server.requests.length).toBe(before);
  });
  // A result is a dated record: written over, the trend it is kept for is gone.
  it("refuses to write over a result that is already there", async () => {
    const home = makeHome();
    const out = join(home, "board.json");
    writeFileSync(out, "kept");
    const r = await run(home, ["--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already/);
    expect(readFileSync(out, "utf8")).toBe("kept");
  });
  it("sets the memory of a running model server next to jevelry's estimate for it", async () => {
    const home = makeHome();
    const model = join(home, "a.gguf");
    writeFileSync(model, "x".repeat(4096));
    // Any live process whose command line carries the alias stands in for a llama-server jevelry started.
    const stand = spawn("node", ["-e", "setTimeout(() => {}, 30000)", "--", "--alias", "local/a.gguf", "--port", "1"], { stdio: "ignore" });
    children.push(stand);
    writeFileSync(join(home, ".jevelry", "server.json"), JSON.stringify({ pid: stand.pid, port: 1, path: model, alias: "local/a.gguf" }));
    writeFileSync(join(home, ".jevelry", "config.json"), JSON.stringify({ backend: "local", local: { path: model, alias: "local/a.gguf", port: 1, params: 2e9, decisionType: "vllm-d3" } }));
    const out = join(home, "board.json");
    const r = await run(home, ["--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const { footprint } = JSON.parse(readFileSync(out, "utf8")) as { footprint: { model: string; rss_bytes: number; file_bytes: number; estimate_bytes: number } };
    expect(footprint.model).toBe("local/a.gguf");
    expect(footprint.rss_bytes).toBeGreaterThan(1e6);
    expect(footprint.file_bytes).toBe(4096);
    expect(footprint.estimate_bytes).toBe(needBytes({ bytes: 4096, params: 2e9, decisionType: "vllm-d3" }));
  });
  it("asks every jevel's cases only with --eval, and records what was right with its interval", async () => {
    const home = makeHome();
    const out = join(home, "board.json");
    const r = await run(home, ["--eval", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const { quality, not_measured } = JSON.parse(readFileSync(out, "utf8")) as { quality: Array<Record<string, any>>; not_measured: string[] };
    const gate = quality.find((q) => q.jevel === "wake-gate");
    expect(gate).toMatchObject({ model: "jev-1.13.0", checks: 4, right: 4 });
    expect(gate?.interval[0]).toBeCloseTo(0.5101, 3);
    // run-gate has no cases.json: left out and said so, never counted as zero right.
    expect(quality.some((q) => q.jevel === "run-gate")).toBe(false);
    expect(not_measured.join("\n")).toMatch(/run-gate/);
  });
  // What lets a release wait on the cases without anyone choosing a bar: the same model must not answer worse than
  // it did in the last record.
  it("fails with --gate when a jevel's cases score worse than in an earlier result of the same model, and passes when they do not", async () => {
    const home = makeHome();
    const first = join(home, "first.json");
    expect((await run(home, ["--eval", "--out", first])).status).toBe(0);
    const same = await run(home, ["--eval", "--gate", first, "--out", join(home, "second.json")]);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toMatch(/gate: against first\.json: \d+ jevels compared, none worse/);
    // An earlier result in which every case was right: against it this run is worse wherever it misses one.
    const perfect = JSON.parse(readFileSync(first, "utf8")) as { quality: Array<{ right: number; checks: number; wrong_at_act: number }> };
    for (const row of perfect.quality) { row.right = row.checks; row.wrong_at_act = 0; }
    writeFileSync(join(home, "perfect.json"), JSON.stringify(perfect));
    const worse = await run(home, ["--eval", "--gate", join(home, "perfect.json"), "--out", join(home, "third.json")]);
    expect(worse.status).toBe(8);
    expect(worse.stdout).toMatch(/gate: against perfect\.json: \d+ jevels compared, \d+ worse/);
    expect(worse.stdout).toMatch(/worse: [a-z-]+: \d+ of \d+ right, was \d+/);
    // The result is still written: a failed gate is a record too.
    expect(JSON.parse(readFileSync(join(home, "third.json"), "utf8")).quality.length).toBeGreaterThan(0);
    const noEval = await run(home, ["--gate", first, "--out", join(home, "fourth.json")]);
    expect(noEval.status).toBe(1);
    expect(noEval.stderr).toMatch(/--eval/);
  }, 90000);
});

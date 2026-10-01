import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LATENCY = 80;
let inFlight = 0;
let maxInFlight = 0;
const constructed = vi.fn();

/** A client that answers every question after LATENCY ms and counts how many asks are open at once. */
const fakeClient = {
  async systemOne(request: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, LATENCY));
    inFlight -= 1;
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([name, q]) => [
        name,
        q.type === "noul"
          ? { type: "noul", noul: 0.97 }
          : q.type === "choice"
            ? { type: "choice", choice: Object.keys(q.criteria ?? {})[0], probabilities: { [Object.keys(q.criteria ?? {})[0] ?? ""]: 1 }, confidence: 0.95 }
            : { type: "score", score: 0.3, legend: { 0: "a" }, probabilities: { 0: 1 }, confidence: 0.95 },
      ]),
    );
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } };
  },
} as unknown as TypeSafeClient;

vi.mock("../src/decide.js", async (original) => ({
  ...(await original<typeof import("../src/decide.js")>()),
  defaultClient: () => { constructed(); return fakeClient; },
}));

const { buildProgram } = await import("../src/program.js");

const QUESTIONS = { urgent: { type: "noul", instructions: "Is it urgent?" } };
const STATE = { employee: { title: "COO", authority: [] }, events: [], filing: {}, candidates: [{}] };
let home: string;
let stdout: string[];

/** Runs `jevelry ask --batch` in this process with `lines` on stdin and returns the parsed stdout lines. */
async function batch(lines: string[], args: string[] = []): Promise<Array<Record<string, unknown>>> {
  Object.defineProperty(process, "stdin", { value: Readable.from([lines.join("\n")]), configurable: true });
  await buildProgram().parseAsync(["node", "jevelry", "ask", "--batch", ...args]);
  return stdout.join("").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  inFlight = 0;
  maxInFlight = 0;
  constructed.mockClear();
  home = mkdtempSync(join(tmpdir(), "jevelry-batch-"));
  vi.stubEnv("JEVELRY_HOME", home);
  vi.stubEnv("JEVELRY_JEVELS", join(process.cwd(), "tests", "fixtures", "jevels"));
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("ask --batch", () => {
  // The point of a batch is that N decisions cost one boot and one latency, not N of either.
  it("answers N asks concurrently within the bound, with one client, in about one latency per wave", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => JSON.stringify({ id: `a${i}`, questions: QUESTIONS, state: `ticket ${i}` }));
    const started = Date.now();
    const out = await batch(lines, ["--concurrency", "4"]);
    const elapsed = Date.now() - started;
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // Two waves of four: about 2 latencies. Serial would be 8.
    expect(elapsed).toBeLessThan(LATENCY * 4);
    expect(out.map((l) => l.id).sort()).toEqual(lines.map((_, i) => `a${i}`).sort());
    for (const line of out) expect(line).toMatchObject({ protocol: 2, answers: { urgent: { decision: "act" } } });
  });

  it("runs every ask at once under the default bound", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: i, questions: QUESTIONS, state: "x" }));
    const started = Date.now();
    const out = await batch(lines);
    expect(Date.now() - started).toBeLessThan(LATENCY * 3);
    expect(maxInFlight).toBe(10);
    expect(out).toHaveLength(10);
  });

  // One host bug in one line must not cost the other employees their decisions.
  it("answers a bad line with an error line and still answers the others", async () => {
    const out = await batch([
      JSON.stringify({ id: "good", jevel: "wake-gate", state: STATE }),
      "not json",
      JSON.stringify({ id: "nojevel", state: "x" }),
      JSON.stringify({ id: "badstate", jevel: "wake-gate", state: 42 }),
      JSON.stringify({ id: "also-good", questions: QUESTIONS, state: "x" }),
    ]);
    const byId = (id: unknown) => out.find((l) => l.id === id);
    expect(out).toHaveLength(5);
    expect(byId("good")).toMatchObject({ protocol: 2, jevel: { name: "wake-gate", version: 1 } });
    expect(byId("also-good")).toMatchObject({ protocol: 2, answers: { urgent: { decision: "act" } } });
    expect(byId(null)).toMatchObject({ line: 2, protocol: 2, error: { exit: 2, code: "bad_input" } });
    expect(byId("nojevel")).toMatchObject({ error: { code: "bad_input", field: "jevel" } });
    expect(byId("badstate")).toMatchObject({ error: { code: "bad_input", field: "state" } });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("logs each answered ask as a single ask does, with its log_id on the line", async () => {
    const out = await batch([
      JSON.stringify({ id: "a", jevel: "wake-gate", state: STATE }),
      JSON.stringify({ id: "b", questions: QUESTIONS, state: "x" }),
      "{}",
    ]);
    const log = readFileSync(join(home, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; kind: string; state?: unknown });
    expect(log).toHaveLength(2);
    const ids = out.filter((l) => l.log_id).map((l) => l.log_id);
    expect(log.map((l) => l.id).sort()).toEqual([...ids].sort());
    for (const line of log) expect(line).not.toHaveProperty("state");
  });

  it("keeps the log out with --no-log and puts the state in with --log-state", async () => {
    const noLog = await batch([JSON.stringify({ id: "a", questions: QUESTIONS, state: "x" })], ["--no-log"]);
    expect(noLog[0]?.log_id).toBeNull();
    stdout = [];
    await batch([JSON.stringify({ id: "a", questions: QUESTIONS, state: "secret" })], ["--log-state"]);
    expect(JSON.parse(readFileSync(join(home, "log.jsonl"), "utf8").trim())).toMatchObject({ state: "secret" });
  });
});

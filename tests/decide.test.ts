import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jevel } from "../src/decide.js";
import { JevelError } from "../src/jevel.js";
import { type AskLine, readLog } from "../src/log.js";
import { type TestServer, startServer } from "./fixtures/server.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const state = { employee: { title: "COO", authority: [] }, events: [{ kind: "task.submitted" }], filing: {}, candidates: [{}, {}] };

let server: TestServer;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());

const client = (apiKey = "test-key", baseURL = server.url) => new TypeSafeClient({ apiKey, baseURL, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
const load = (options: { home?: string; log?: boolean; client?: TypeSafeClient } = {}) =>
  jevel("wake-gate", { jevels: [FIXTURES], home: options.home ?? mkdtempSync(join(tmpdir(), "jevelry-decide-")), client: options.client ?? client(), ...(options.log === undefined ? {} : { log: options.log }) });

describe("jevel() at load", () => {
  it("throws JevelError for a jevel that is not there, so a typo fails at startup and not at the first decision", () => {
    expect(() => jevel("missing", { jevels: [FIXTURES] })).toThrow(JevelError);
  });
  it("names the jevel and its version", () => {
    const wake = load();
    expect([wake.name, wake.version]).toEqual(["wake-gate", 1]);
  });
});

describe("decide", () => {
  it("returns every answer with a uniform answer field and writes one log line", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-decide-"));
    const d = await load({ home }).decide(state);
    expect(d.error).toBeNull();
    expect(d.model).toBe("jev-1.13.0");
    expect(d.usage).toEqual({ input_tokens: 123, output_tokens: 12 });
    // The server answers noul 0.08 for worth_*, 0.97 for the rest, score 0.3 at confidence 0.72.
    expect(d.worth_a_turn).toMatchObject({ type: "noul", yes: false, answer: false, decision: "act" });
    expect(d.depth).toMatchObject({ type: "score", score: 0.3, answer: 0 });
    expect(d["same_as[1]"]).toMatchObject({ type: "noul", answer: true });
    const lines = (await readLog(home)) as AskLine[];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.id).toBe(d.logId);
    expect(Object.keys(lines[0]?.answers ?? {})).toEqual(["worth_a_turn", "depth", "same_as[0]", "same_as[1]"]);
  });

  // Jev unavailable is weather, never a crash: the program takes its old path and the log still shows the decision point fired.
  for (const [label, make, code] of [
    ["429", () => ({ state: { ...state, fail: 429 } }), "rate_limited"],
    ["529", () => ({ state: { ...state, fail: 529 } }), "overloaded"],
    ["401", () => ({ state, client: client("wrong-key") }), "auth"],
    ["connection refused", () => ({ state, client: client("test-key", "http://127.0.0.1:1") }), "transport"],
  ] as const) {
    it(`returns every question fall_back with error.code ${code} on ${label}, and logs it`, async () => {
      const home = mkdtempSync(join(tmpdir(), "jevelry-decide-"));
      const input = make() as { state: unknown; client?: TypeSafeClient };
      const d = await load({ home, ...(input.client ? { client: input.client } : {}) }).decide(input.state);
      expect(d.error?.code).toBe(code);
      expect(d.model).toBeNull();
      for (const q of ["worth_a_turn", "depth", "same_as[0]", "same_as[1]"]) {
        expect(d[q]).toMatchObject({ decision: "fall_back", answer: null, certainty: 0 });
      }
      expect(d.depth?.type).toBe("score");
      const lines = (await readLog(home)) as AskLine[];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ kind: "ask", id: d.logId, answers: {}, model: null, error: { code } });
    });
  }

  it("throws for a state the jevel refuses, which is a bug in the caller and costs no request", async () => {
    const before = server.requests.length;
    await expect(load().decide({ employee: {} })).rejects.toThrow(JevelError);
    await expect(load().decide(42)).rejects.toThrow(JevelError);
    expect(server.requests.length).toBe(before);
  });

  it("writes nothing with log: false", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-decide-"));
    const d = await load({ home, log: false }).decide(state);
    expect(d.logId).toBeNull();
    expect(existsSync(join(home, "log.jsonl"))).toBe(false);
  });

  it("keeps the answer when the log cannot be written, warning instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jevelry-decide-blocked-"));
    writeFileSync(join(dir, "blocker"), "a regular file, so no home can be made beneath it");
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const d = await load({ home: join(dir, "blocker", "home") }).decide(state);
      expect(d.logId).toBeNull();
      expect(d.worth_a_turn?.decision).toBe("act");
      expect(String(warn.mock.calls[0]?.[0])).toContain("could not be logged");
    } finally {
      warn.mockRestore();
    }
  });
});

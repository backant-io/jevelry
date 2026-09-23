import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jevel } from "../src/decide.js";
import { JevelError } from "../src/jevel.js";
import { type AskLine, outcomeOf, readLog } from "../src/log.js";
import { report } from "../src/report.js";
import { type TestServer, startServer } from "./fixtures/server.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const state = { employee: { title: "COO", authority: [] }, events: [{ kind: "task.submitted" }], filing: {}, candidates: [{}, {}] };

let server: TestServer;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());

const client = (apiKey = "test-key", baseURL = server.url) => new TypeSafeClient({ apiKey, baseURL, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
const load = (options: { home?: string; log?: boolean; logState?: boolean; client?: TypeSafeClient } = {}) =>
  jevel("wake-gate", {
    jevels: [FIXTURES],
    home: options.home ?? mkdtempSync(join(tmpdir(), "jevelry-decide-")),
    client: options.client ?? client(),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.logState === undefined ? {} : { logState: options.logState }),
  });

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
      expect(lines[0]).toMatchObject({ kind: "ask", id: d.logId, model: null, error: { code } });
      // Every decision point that fired is tracked: the report counts this ask as fall_back for each question.
      const rows = report(lines);
      expect(rows.map((r) => [r.question, r.asks, r.decisions.fall_back])).toEqual([["depth", 1, 1], ["same_as", 2, 2], ["worth_a_turn", 1, 1]]);
      expect(() => outcomeOf(lines[0]!, "worth_a_turn", "agree")).toThrow(JevelError);
    });
  }

  it("throws for a state the jevel refuses, which is a bug in the caller and costs no request", async () => {
    const before = server.requests.length;
    await expect(load().decide({ employee: {} })).rejects.toThrow(JevelError);
    await expect(load().decide(42)).rejects.toThrow(JevelError);
    expect(server.requests.length).toBe(before);
  });

  // States often hold customer text: hash only by default, the state itself only when the host asks.
  it("logs the state only with logState: true or JEVELRY_LOG_STATE=1, on answered and failed asks", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-decide-"));
    await load({ home }).decide(state);
    await load({ home, logState: true }).decide(state);
    await load({ home, logState: true }).decide({ ...state, fail: 429 });
    vi.stubEnv("JEVELRY_LOG_STATE", "1");
    try {
      await load({ home }).decide(state);
    } finally {
      vi.unstubAllEnvs();
    }
    const lines = (await readLog(home)) as AskLine[];
    expect(lines.map((l) => l.state)).toEqual([undefined, state, { ...state, fail: 429 }, state]);
    expect(lines[2]?.error?.code).toBe("rate_limited");
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

describe("jevelry types", () => {
  it("types each answer by its jevel, so a wrong literal fails to compile", () => {
    const dir = mkdtempSync(join(tmpdir(), "jevelry-types-"));
    const out = join(dir, "jevels.d.ts");
    const r = spawnSync("node", ["bin/jevelry.js", "types", "--out", out], { encoding: "utf8", env: { ...process.env, JEVELRY_HOME: dir } });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('"ticket-triage": TicketTriage;');
    writeFileSync(
      join(dir, "use.ts"),
      [
        'import { jevel } from "jevelry";',
        'const d = await jevel("ticket-triage").decide({});',
        'const team: "billing" | "technical" | "account" | "other" | null = d.team.answer;',
        "// @ts-expect-error a team this jevel does not have",
        'const wrong: "sales" | null = d.team.answer;',
        "const urgent: boolean | null = d.urgent.answer;",
        "const frustration: number | null = d.frustration.answer;",
        'const same = await jevel("duplicate-issue").decide({});',
        'const first: boolean | null = same["same_as[0]"].answer;',
        'if (d.team.decision === "act") { const sure: "billing" | "technical" | "account" | "other" = d.team.answer; void sure; }',
        'const loose = await jevel(String("any")).decide({});',
        "const anything: string | boolean | number | null | undefined = loose.whatever?.answer;",
        "const logId: string | null = d.logId;",
        "void [team, wrong, urgent, frustration, first, anything, logId];",
        "export {};",
      ].join("\n"),
    );
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"],
          typeRoots: [join(process.cwd(), "node_modules", "@types")],
          paths: { jevelry: [join(process.cwd(), "dist", "index.d.ts")] },
        },
        files: ["use.ts", "jevels.d.ts"],
      }),
    );
    const tsc = spawnSync("node", [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  });

  it("compiles the README snippet without the types file under noUncheckedIndexedAccess, and every doc shows the same one", () => {
    // Somebody pastes this block before they ever run `jevelry types`, so it has to hold in the strictest common setup.
    const readme = readFileSync("README.md", "utf8");
    const section = readme.slice(readme.indexOf("## In your program"));
    const snippet = /```ts\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    expect(snippet).toContain("decide(");
    for (const doc of ["AGENTS.md", "llms.txt", join("skills", "jevelry", "SKILL.md")]) expect(readFileSync(doc, "utf8"), doc).toContain(snippet);
    const dir = mkdtempSync(join(tmpdir(), "jevelry-snippet-"));
    const [imports, ...rest] = snippet.split("\n\n");
    writeFileSync(
      join(dir, "use.ts"),
      [imports, "declare const ticket: { subject: string; message: string };", "declare function route(t: unknown, team: unknown): void;", "declare function flagForQueueOwner(t: unknown): void;", "declare function leaveInGeneralQueue(t: unknown): void;", ...rest, "export {};"].join("\n"),
    );
    writeFileSync(join(dir, "package.json"), '{ "type": "module" }');
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noUncheckedIndexedAccess: true, noEmit: true, skipLibCheck: true, types: ["node"],
          typeRoots: [join(process.cwd(), "node_modules", "@types")],
          paths: { jevelry: [join(process.cwd(), "dist", "index.d.ts")] },
        },
        files: ["use.ts"],
      }),
    );
    const tsc = spawnSync("node", [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
    expect(tsc.stdout + tsc.stderr).toBe("");
    expect(tsc.status).toBe(0);
  });
});

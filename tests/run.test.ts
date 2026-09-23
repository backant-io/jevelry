import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Ajv } from "ajv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jevel } from "../src/decide.js";
import { JevelError, parseJevel } from "../src/jevel.js";
import { type RunLine, readLog } from "../src/log.js";
import type { Answer } from "../src/protocol.js";
import { planCall } from "../src/run.js";
import { type TestServer, startServer } from "./fixtures/server.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const schema = JSON.parse(readFileSync("docs/protocol/ask.schema.json", "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
// The fixture's flaky command writes what it received into $RUN_OUT and exits 3.
const FLAKY_ARGS = (decision: string) => `${decision} flaky 1 true`;

let server: TestServer;
let out: string;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());
beforeEach(() => { out = mkdtempSync(join(tmpdir(), "jevelry-run-out-")); });

const refuses = (frontmatter: string, field: string): void => {
  expect(() => parseJevel(`---\n${frontmatter}\n---\n`, "t")).toThrowError(expect.objectContaining({ name: "JevelError", field }) as unknown as Error);
};
const choice = "type: choice, instructions: x, criteria: { a: x, b: x }";

describe("parsing run", () => {
  it("refuses run on a question that is no choice", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: noul, instructions: x, run: { "true": "echo" } }`, "questions.q.run");
  });
  it("refuses run naming an option the criteria lack", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { c: "echo" } }`, "questions.q.run.c");
  });
  it("refuses a second question with run, because one question picks the command", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { a: "echo" } }\n  r: { ${choice}, run: { a: "echo" } }`, "questions.r.run");
  });
  it("refuses {{x}} when x is no question, or a score", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { a: "echo {{nope}}" } }`, "questions.q.run.a");
    refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { a: "echo {{s}}" } }\n  s: { type: score, instructions: x, criteria: [x, y] }`, "questions.q.run.a");
  });
  it("refuses a repeat question as an argument, because it has one answer per element", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { a: "echo {{r}}" } }\n  r: { type: noul, instructions: x, repeat: { over: items, as: item } }`, "questions.q.run.a");
  });
  it("refuses an argument whose option names the shell would read as syntax", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { a: "echo {{n}}" } }\n  n: { type: choice, instructions: x, criteria: { "ok": x, "x; rm -rf ~": x } }`, "questions.n.criteria.x; rm -rf ~");
  });
  it("refuses a dispatcher option named fall_back, which a handler map could not tell apart", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: choice, instructions: x, criteria: { a: x, fall_back: x }, run: { a: "echo" } }`, "questions.q.criteria.fall_back");
  });
  it("refuses arguments in fall_back, because fall_back runs when nothing was decided", () => {
    refuses(`name: t\nversion: 1\nfall_back: "echo {{q}}"\nquestions:\n  q: { ${choice}, run: { a: "echo" } }`, "fall_back");
  });
});

const call = parseJevel(
  `---\nname: t\nversion: 1\nfall_back: "echo unsure"\nquestions:\n  cause: { type: choice, instructions: x, criteria: { flaky: x, defect: x }, thresholds: { act: 0.9, mark: 0.7 }, run: { flaky: "rerun {{retries}} {{loud}}", defect: "echo defect" } }\n  retries: { type: choice, instructions: x, criteria: { "1": x, "2": x } }\n  loud: { type: noul, instructions: x }\n---\n`,
  "t",
).jevel;
const pick = (choice: string, certainty: number): Answer => ({ type: "choice", choice, probabilities: {}, confidence: certainty, certainty, decision: "act" });
const noul = (yes: boolean, certainty: number): Answer => ({ type: "noul", noul: yes ? certainty : 1 - certainty, yes, certainty, decision: "act" });

describe("the call's certainty", () => {
  it("is the least certain of the dispatcher and the arguments its command names", () => {
    // One unsure argument spoils the call, even when the dispatcher is sure.
    const c = planCall(call, { cause: pick("flaky", 0.99), retries: pick("2", 0.75), loud: noul(true, 0.95) });
    expect(c).toMatchObject({ option: "flaky", command: "rerun 2 true", certainty: 0.75, decision: "mark" });
    expect(planCall(call, { cause: pick("flaky", 0.99), retries: pick("2", 0.5), loud: noul(true, 0.95) })).toMatchObject({ option: null, command: "echo unsure", decision: "fall_back" });
  });
  it("ignores arguments the picked command does not name", () => {
    const c = planCall(call, { cause: pick("defect", 0.95), retries: pick("2", 0.1), loud: noul(true, 0.5) });
    expect(c).toMatchObject({ option: "defect", command: "echo defect", certainty: 0.95, decision: "act", args: {} });
  });
  it("has no command for an option the run block leaves out", () => {
    const other = parseJevel(`---\nname: t\nversion: 1\nquestions:\n  q: { type: choice, instructions: x, criteria: { a: x, other: x }, run: { a: "echo a" } }\n---\n`, "t").jevel;
    expect(planCall(other, { q: pick("other", 0.99) })).toMatchObject({ option: "other", command: null, decision: "act" });
  });
  it("is fall_back with the jevel's fall_back command when Jev could not answer", () => {
    expect(planCall(call, null)).toMatchObject({ option: null, command: "echo unsure", decision: "fall_back", certainty: 0 });
  });
});

describe("substitution", () => {
  it("fills in only a picked option name or true/false", () => {
    expect(planCall(call, { cause: pick("flaky", 1), retries: pick("1", 1), loud: noul(false, 1) }).command).toBe("rerun 1 false");
  });
  it("refuses an answer naming something that is no option, so a bad answer from the network never reaches a shell", () => {
    expect(() => planCall(call, { cause: pick("flaky", 1), retries: pick("2; touch /tmp/x", 1), loud: noul(true, 1) })).toThrow(/no option of retries/);
    expect(() => planCall(call, { cause: pick("toString", 1), retries: pick("2", 1), loud: noul(true, 1) })).toThrow(/no option of cause/);
  });
});

/** Async, never spawnSync: the test server answers on this process's event loop. */
const cli = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; home: string }>((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-home-"));
    const child = spawn("node", [join(process.cwd(), "bin/jevelry.js"), ...args], {
      cwd: out,
      env: { PATH: process.env.PATH, HOME: home, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.url, JEVELRY_KEY_STORE: "file", JEVELRY_HOME: home, JEVELRY_JEVELS: FIXTURES, RUN_OUT: out, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, home }));
    child.stdin.end();
  });
const runLines = async (home: string): Promise<RunLine[]> => (await readLog(home)).filter((l): l is RunLine => l.kind === "run");
const state = (extra: Record<string, unknown> = {}) => JSON.stringify({ test: { name: "checkout > pays", output: "Timeout after 5000 ms" }, ...extra });

describe("jevelry run", () => {
  it("act runs the command with the state on stdin and in JEVELRY_STATE, and exits with the command's code", async () => {
    const r = await cli(["run", "run-gate", "--state", state()]);
    expect(r.status).toBe(3);
    const doc = JSON.parse(r.stdout) as { run: Record<string, unknown>; log_id: string };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc.run).toMatchObject({ option: "flaky", decision: "act", exit: 3, confirmed: null });
    // The command's own output goes to stderr, so stdout stays one document.
    expect(r.stderr).toContain("ran");
    expect(readFileSync(join(out, "args"), "utf8")).toBe(FLAKY_ARGS("act"));
    expect(JSON.parse(readFileSync(join(out, "stdin.json"), "utf8"))).toEqual(JSON.parse(state()));
    expect(JSON.parse(readFileSync(join(out, "file.json"), "utf8"))).toEqual(JSON.parse(state()));
    expect(existsSync(readFileSync(join(out, "path"), "utf8").trim()), "the state file is removed afterwards").toBe(false);
  });

  it("writes a run line under the ask's id with the option, the command, the exit code and the time", async () => {
    const r = await cli(["run", "run-gate", "--state", state()]);
    const doc = JSON.parse(r.stdout) as { log_id: string; run: { command: string } };
    const [line] = await runLines(r.home);
    expect(line).toMatchObject({ kind: "run", id: doc.log_id, option: "flaky", command: doc.run.command, decision: "act", exit: 3, confirmed: null });
    expect(typeof line?.ms).toBe("number");
  });

  it("keeps the state out of the command line: a state holding shell syntax runs nothing of it", async () => {
    const pwned = join(out, "pwned");
    const r = await cli(["run", "run-gate", "--state", state({ note: `x; touch ${pwned}`, "$(touch ${pwned}2)": `\`touch ${pwned}3\`` })]);
    expect(r.status).toBe(3);
    const doc = JSON.parse(r.stdout) as { run: { command: string } };
    expect(doc.run.command).not.toContain("touch");
    for (const f of [pwned, `${pwned}2`, `${pwned}3`]) expect(existsSync(f), f).toBe(false);
  });

  it("mark with --yes runs, and records that it was confirmed", async () => {
    const r = await cli(["run", "run-gate", "--yes", "--state", state({ confidence: { cause: 0.95, retries: 0.75 } })]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).run).toMatchObject({ decision: "mark", confirmed: true, exit: 3 });
    expect(readFileSync(join(out, "args"), "utf8")).toBe(FLAKY_ARGS("mark"));
  });

  it("mark without a terminal and without --yes runs nothing and exits 9", async () => {
    const r = await cli(["run", "run-gate", "--state", state({ confidence: { cause: 0.95, retries: 0.75 } })]);
    expect(r.status).toBe(9);
    expect(JSON.parse(r.stdout).run).toMatchObject({ decision: "mark", confirmed: false, exit: null, ms: null });
    expect(existsSync(join(out, "args"))).toBe(false);
    expect((await runLines(r.home))[0]).toMatchObject({ confirmed: false, exit: null });
  });

  it("--dry-run prints what would run and runs nothing", async () => {
    const r = await cli(["run", "run-gate", "--dry-run", "--state", state()]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).run).toMatchObject({ option: "flaky", exit: null });
    expect(r.stderr).toContain("would run");
    expect(existsSync(join(out, "args"))).toBe(false);
    expect(await runLines(r.home)).toEqual([]);
  });

  it("an unsure argument sends the call to fall_back, which runs the jevel's fall_back command", async () => {
    const r = await cli(["run", "run-gate", "--state", state({ confidence: { cause: 0.95, retries: 0.2 } })]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).run).toMatchObject({ decision: "fall_back", option: null, exit: 0 });
    expect(readFileSync(join(out, "fall_back"), "utf8")).toBe("fell back\n");
    expect(existsSync(join(out, "args"))).toBe(false);
  });

  it("runs the jevel's fall_back when Jev is rate limited, then exits with the error's code", async () => {
    const r = await cli(["run", "run-gate", "--state", state({ fail: 429 })]);
    expect(r.status).toBe(3);
    const doc = JSON.parse(r.stdout) as { error: { code: string }; run: Record<string, unknown> };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc.error.code).toBe("rate_limited");
    expect(doc.run).toMatchObject({ option: null, command: 'echo fell back > "$RUN_OUT/fall_back"', decision: "fall_back", exit: 0 });
    expect(readFileSync(join(out, "fall_back"), "utf8")).toBe("fell back\n");
    expect(existsSync(join(out, "args"))).toBe(false);
  });

  it("refuses a jevel with no run as bad input, before any ask", async () => {
    const before = server.requests.length;
    const r = await cli(["run", "wake-gate", "--state", state()]);
    expect(r.status).toBe(2);
    expect(server.requests.length).toBe(before);
    expect(JSON.parse(r.stdout).error.field).toBe("run");
  });
});

describe("run() in a program", () => {
  const client = () => new TypeSafeClient({ apiKey: "test-key", baseURL: server.url, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
  const load = (home: string) => jevel("run-gate", { jevels: [FIXTURES], home, client: client() });

  it("calls the handler for the picked option with its arguments, and logs a run line", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-lib-"));
    const seen: unknown[] = [];
    const { decisions, ran } = await load(home).run(JSON.parse(state()), { flaky: (args) => { seen.push(args); return "rerun queued"; } });
    expect(seen).toEqual([{ retries: "1", loud: true }]);
    expect(ran).toEqual({ option: "flaky", decision: "act", confirmed: null, result: "rerun queued" });
    expect(existsSync(join(out, "args")), "a handler replaces the shell command").toBe(false);
    expect((await runLines(home))[0]).toMatchObject({ id: decisions.logId, option: "flaky", command: null, exit: null, confirmed: null });
  });

  it("asks confirm on mark and runs only on yes; with no confirm a mark runs nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-lib-"));
    const marked = JSON.parse(state({ confidence: { cause: 0.95, retries: 0.75 } }));
    const asked: unknown[] = [];
    let calls = 0;
    const flaky = (): void => { calls += 1; };
    const yes = await load(home).run(marked, { flaky }, { confirm: (option, certainty) => { asked.push([option, certainty]); return true; } });
    expect(asked).toEqual([["flaky", 0.75]]);
    expect(yes.ran).toMatchObject({ decision: "mark", confirmed: true });
    const no = await load(home).run(marked, { flaky }, { confirm: () => false });
    const none = await load(home).run(marked, { flaky });
    expect([no.ran?.confirmed, none.ran?.confirmed, calls]).toEqual([false, false, 1]);
  });

  it("calls fall_back with the decisions when Jev cannot answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-lib-"));
    const { ran } = await load(home).run(JSON.parse(state({ fail: 429 })), { flaky: () => "no", fall_back: (d) => d.error?.code });
    expect(ran).toEqual({ option: null, decision: "fall_back", confirmed: null, result: "rate_limited" });
  });

  it("runs the jevel's own command only with shell: true", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-lib-"));
    process.env.RUN_OUT = out;
    try {
      expect((await load(home).run(JSON.parse(state()))).ran).toBeNull();
      expect(existsSync(join(out, "args"))).toBe(false);
      const { ran } = await load(home).run(JSON.parse(state()), {}, { shell: true });
      expect(ran).toMatchObject({ option: "flaky", decision: "act", result: { exit: 3 } });
      expect(readFileSync(join(out, "args"), "utf8")).toBe(FLAKY_ARGS("act"));
    } finally {
      delete process.env.RUN_OUT;
    }
  });

  it("throws at run for a jevel with no run, the way a typo throws at load", async () => {
    await expect(jevel("wake-gate", { jevels: [FIXTURES], client: client(), log: false }).run({})).rejects.toThrow(JevelError);
  });
});

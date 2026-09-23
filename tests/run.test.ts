import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Ajv } from "ajv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jevel } from "../src/decide.js";
import { JevelError, parseJevel } from "../src/jevel.js";
import { type RunLine, readLog } from "../src/log.js";
import type { Answer } from "../src/protocol.js";
import { execute, planCall } from "../src/run.js";
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
  it("refuses {{constructor}} and {{toString}}, which only an inherited property would answer", () => {
    for (const name of ["constructor", "toString"]) {
      refuses(`name: t\nversion: 1\nquestions:\n  q: { ${choice}, run: { a: "echo {{${name}}}" } }`, "questions.q.run.a");
    }
  });
  it("refuses a question named __proto__, which would set a prototype wherever answers are gathered by name", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  __proto__: { type: noul, instructions: x }`, "questions.__proto__");
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
    // A ./jevels folder in the project wins over a shipped jevel, so the source of the commands is named first.
    expect(r.stderr).toContain(`jevelry: running flaky from ${join(FIXTURES, "run-gate", "JEVEL.md")}: printf`);
    expect(r.stderr.indexOf("jevelry: running")).toBeLessThan(r.stderr.indexOf("ran\n"));
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
    expect(r.stderr).toContain(`would run flaky from ${join(FIXTURES, "run-gate", "JEVEL.md")}: printf`);
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

describe("the command's process", () => {
  const meta = { decision: "act" as const, option: "flaky", logId: null };

  it("leaves the TypeSafe key out of the command's environment, because a jevel command is arbitrary shell", async () => {
    const before = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "parent-key";
    try {
      const file = join(out, "key");
      const done = await execute(`printf "[%s]" "$TYPESAFE_API_KEY" > "${file}"`, {}, meta);
      expect(done.exit).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("[]");
      expect(process.env.TYPESAFE_API_KEY, "the parent keeps its key").toBe("parent-key");
    } finally {
      if (before === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = before;
    }
  });

  it("names the signal that killed the command, with exit 128 plus its number", async () => {
    expect(await execute("kill -TERM $$", {}, meta)).toMatchObject({ exit: 143, signal: "SIGTERM" });
    expect(await execute("exit 4", {}, meta)).not.toHaveProperty("signal");
  });
});

const choiceOf = (choice: string, confidence = 0.95) => ({ type: "choice", choice, probabilities: { [choice]: 1 }, confidence });
const wrongShapes: Array<[string, Record<string, unknown>]> = [
  ["an option the question lacks", { cause: choiceOf("flaky"), retries: choiceOf("9; touch pwned"), loud: { type: "noul", noul: 0.99 } }],
  ["a score where a choice was asked", { cause: choiceOf("flaky"), retries: { type: "score", score: 1, legend: { "0": "a" }, probabilities: { "0": 1 }, confidence: 0.95 }, loud: { type: "noul", noul: 0.99 } }],
];

describe("an answer no command can be planned from", () => {
  for (const [label, reply] of wrongShapes) {
    it(`runs the fall_back command and exits 7 on ${label}, and logs the ask as failed`, async () => {
      const r = await cli(["run", "run-gate", "--state", state({ reply })]);
      expect(r.status).toBe(7);
      const doc = JSON.parse(r.stdout) as { error: { code: string }; run: { command: string } };
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(doc.error.code).toBe("unreadable_answer");
      expect(doc.run).toMatchObject({ option: null, decision: "fall_back", exit: 0 });
      expect(readFileSync(join(out, "fall_back"), "utf8")).toBe("fell back\n");
      expect(existsSync(join(out, "args")), "the flaky command never ran").toBe(false);
      expect(existsSync(join(out, "pwned"))).toBe(false);
      const [ask] = (await readLog(r.home)).filter((l) => l.kind === "ask") as Array<{ error?: { code: string }; answers: Record<string, { decision: string }> }>;
      expect(ask?.error?.code).toBe("unreadable_answer");
      expect(Object.values(ask?.answers ?? {}).map((a) => a.decision)).toEqual(["fall_back", "fall_back", "fall_back"]);
    });
  }

  it("calls the fall_back handler in a program, with the error on the decisions", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-lib-"));
    const client = new TypeSafeClient({ apiKey: "test-key", baseURL: server.url, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
    for (const [, reply] of wrongShapes) {
      const { decisions, ran } = await jevel("run-gate", { jevels: [FIXTURES], home, client }).run(JSON.parse(state({ reply })), {
        flaky: () => "flaky ran",
        fall_back: (d) => `fell back on ${d.error?.code}`,
      });
      expect(decisions.error?.code).toBe("unreadable_answer");
      expect(ran).toEqual({ option: null, decision: "fall_back", confirmed: null, result: "fell back on unreadable_answer" });
    }
    const asks = (await readLog(home)).filter((l) => l.kind === "ask") as Array<{ error?: unknown }>;
    expect(asks.every((a) => a.error !== undefined)).toBe(true);
  });
});

describe("names from a jevel or an answer find only own properties", () => {
  it("runs the command of an option named toString, in a program with shell: true and through a handler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jevelry-ctor-"));
    mkdirSync(join(dir, "ctor"));
    writeFileSync(join(dir, "ctor", "JEVEL.md"), `---\nname: ctor\nversion: 1\nquestions:\n  cause:\n    type: choice\n    instructions: x\n    criteria: { toString: x, other: x }\n    run:\n      toString: 'echo toString > "$RUN_OUT/ctor"'\nfall_back: 'echo fell back > "$RUN_OUT/fall_back"'\n---\n`);
    const client = new TypeSafeClient({ apiKey: "test-key", baseURL: server.url, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
    const ctor = jevel("ctor", { jevels: [dir], home: mkdtempSync(join(tmpdir(), "jevelry-ctor-home-")), client });
    process.env.RUN_OUT = out;
    try {
      const { ran } = await ctor.run({ reply: { cause: choiceOf("toString") } }, {}, { shell: true });
      expect(ran).toMatchObject({ option: "toString", decision: "act", result: { exit: 0 } });
      expect(readFileSync(join(out, "ctor"), "utf8")).toBe("toString\n");
      // A handler map without a toString of its own: Object.prototype.toString is never called as one.
      expect((await ctor.run({ reply: { cause: choiceOf("toString") } }, { other: () => "other" })).ran).toBeNull();
      expect((await ctor.run({ reply: { cause: choiceOf("toString") } }, { toString: () => "mine" })).ran?.result).toBe("mine");
    } finally {
      delete process.env.RUN_OUT;
    }
  });
});

/** Started, not awaited: the caller signals the child while the command sleeps. */
const start = (args: string[]) => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-run-home-"));
  // Its own process group, standing in for the foreground group of a terminal, so a test can send a
  // signal the way Ctrl-C does (to the whole group) or the way `kill <pid>` does (to jevelry alone).
  const child = spawn("node", [join(process.cwd(), "bin/jevelry.js"), ...args], {
    cwd: out,
    detached: true,
    env: { PATH: process.env.PATH, HOME: home, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.url, JEVELRY_KEY_STORE: "file", JEVELRY_HOME: home, JEVELRY_JEVELS: FIXTURES, RUN_OUT: out },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
  child.stderr.resume();
  const done = new Promise<{ status: number | null; stdout: string }>((resolve) => child.on("close", (status) => resolve({ status, stdout })));
  return { child, home, done };
};
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(check()).toBe(true);
};

describe("a signal to jevelry while the command runs", () => {
  // SIGTERM with `kill <jevelry pid>`, which jevelry passes on to the command; SIGINT as a terminal's
  // Ctrl-C sends it, to jevelry and the command together.
  for (const [sig, code, send] of [["SIGTERM", 143, "jevelry"], ["SIGINT", 130, "group"]] as const) {
    it(`${sig} to the ${send}: stops the command, removes the state file, logs the run, prints the document and exits ${code}`, async () => {
      const { child, home, done } = start(["run", "run-gate", "--state", state({ secret: "customer text", reply: { cause: choiceOf("defect"), retries: choiceOf("1"), loud: { type: "noul", noul: 0.99 } } })]);
      await until(() => existsSync(join(out, "path")));
      const stateFile = readFileSync(join(out, "path"), "utf8").trim();
      expect(existsSync(stateFile)).toBe(true);
      if (send === "group") process.kill(-child.pid!, sig);
      else child.kill(sig);
      const r = await done;
      expect(r.status).toBe(code);
      expect(existsSync(stateFile), "the state file is gone").toBe(false);
      const doc = JSON.parse(r.stdout) as { run: Record<string, unknown> };
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(doc.run).toMatchObject({ option: "defect", signal: sig, exit: code });
      expect((await runLines(home))[0]).toMatchObject({ option: "defect", signal: sig, exit: code });
    });
  }
});

describe("the mark prompt on a terminal", () => {
  // `script` gives jevelry a terminal. It refuses a socket on its own stdio, which is what Node's pipes
  // are, so the keys go in through a FIFO and `cat`, and the screen (stderr and stdout together) to a file.
  for (const [label, key] of [["Ctrl-D", "\u0004"], ["Ctrl-C", "\u0003"]] as const) {
    it(`${label} at the prompt is a no: nothing runs, the document prints and the exit is 9`, async () => {
      const home = mkdtempSync(join(tmpdir(), "jevelry-run-home-"));
      const [fifo, screenFile] = [join(home, "keys"), join(home, "screen")];
      execFileSync("mkfifo", [fifo]);
      const bin = join(process.cwd(), "bin/jevelry.js");
      const markState = state({ confidence: { cause: 0.95, retries: 0.75 } });
      const child = spawn("/bin/sh", ["-c", 'cat "$2" | script -q /dev/null node "$0" run run-gate --state "$1" > "$3" 2>&1', bin, markState, fifo, screenFile], {
        cwd: out,
        stdio: ["ignore", "ignore", "ignore"],
        env: { PATH: process.env.PATH, HOME: home, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.url, JEVELRY_KEY_STORE: "file", JEVELRY_HOME: home, JEVELRY_JEVELS: FIXTURES, RUN_OUT: out },
      });
      const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
      const keys = createWriteStream(fifo);
      const screen = (): string => (existsSync(screenFile) ? readFileSync(screenFile, "utf8") : "");
      await until(() => screen().includes("[y/N]"));
      keys.end(key);
      const status = await closed;
      expect(screen()).toContain(`(from ${join(FIXTURES, "run-gate", "JEVEL.md")})? [y/N]`);
      expect(status, screen()).toBe(9);
      const text = screen().replace(/\r/g, "");
      const doc = JSON.parse(text.slice(text.indexOf("{\n"), text.lastIndexOf("}") + 1)) as { run: Record<string, unknown> };
      expect(doc.run).toMatchObject({ decision: "mark", confirmed: false, exit: null });
      expect(existsSync(join(out, "args"))).toBe(false);
    });
  }
});

describe("a command keeps the terminal", () => {
  it("reads what was typed from /dev/tty, so sudo, ssh and git prompts work inside a command", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-home-"));
    const [fifo, screenFile] = [join(home, "keys"), join(home, "screen")];
    execFileSync("mkfifo", [fifo]);
    const other = state({ reply: { cause: choiceOf("other"), retries: choiceOf("1"), loud: { type: "noul", noul: 0.99 } } });
    const child = spawn("/bin/sh", ["-c", 'cat "$2" | script -q /dev/null node "$0" run run-gate --state "$1" > "$3" 2>&1', join(process.cwd(), "bin/jevelry.js"), other, fifo, screenFile], {
      cwd: out,
      stdio: ["ignore", "ignore", "ignore"],
      env: { PATH: process.env.PATH, HOME: home, TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: server.url, JEVELRY_KEY_STORE: "file", JEVELRY_HOME: home, JEVELRY_JEVELS: FIXTURES, RUN_OUT: out },
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    const keys = createWriteStream(fifo);
    const screen = (): string => (existsSync(screenFile) ? readFileSync(screenFile, "utf8") : "");
    await until(() => screen().includes("jevelry: running other from"));
    keys.end("typed\n");
    expect(await closed, screen()).toBe(0);
    expect(readFileSync(join(out, "tty"), "utf8")).toBe("typed");
  });
});

describe("the jevel's path is named before anything runs", () => {
  const where = `from ${join(FIXTURES, "run-gate", "JEVEL.md")}: printf`;
  it("on stderr before the command's own output", async () => {
    const r = await cli(["run", "run-gate", "--state", state()]);
    const line = r.stderr.indexOf(`jevelry: running flaky ${where}`);
    expect(line).toBeGreaterThanOrEqual(0);
    expect(line).toBeLessThan(r.stderr.indexOf("ran\n"));
  });
  it("on --dry-run, where nothing runs", async () => {
    const r = await cli(["run", "run-gate", "--dry-run", "--state", state()]);
    expect(r.stderr).toContain(`jevelry: act: would run flaky ${where}`);
  });
});

describe("a signal to a program while run() has a command going", () => {
  it("stops the command, removes the state file and hands {exit, signal} back; the program keeps running", async () => {
    const script = `
      import { jevel } from ${JSON.stringify(join(process.cwd(), "dist", "index.js"))};
      import { TypeSafeClient } from "@typesafe-ai/sdk";
      const client = new TypeSafeClient({ apiKey: "test-key", baseURL: process.env.URL, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" });
      const j = jevel("run-gate", { jevels: [process.env.FIXTURES], home: process.env.HOME, client });
      const { ran } = await j.run(JSON.parse(process.env.STATE), {}, { shell: true });
      console.log(JSON.stringify(ran.result));
      console.log("host still running");
    `;
    const home = mkdtempSync(join(tmpdir(), "jevelry-run-host-"));
    const child = spawn("node", ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: home, URL: server.url, FIXTURES, RUN_OUT: out, STATE: state({ reply: { cause: choiceOf("defect"), retries: choiceOf("1"), loud: { type: "noul", noul: 0.99 } } }) },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
    child.stderr.resume();
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    await until(() => existsSync(join(out, "path")));
    const stateFile = readFileSync(join(out, "path"), "utf8").trim();
    child.kill("SIGTERM");
    expect(await closed, stdout).toBe(0);
    const [result, alive] = stdout.trim().split("\n");
    expect(JSON.parse(result ?? "")).toMatchObject({ exit: 143, signal: "SIGTERM" });
    expect(alive).toBe("host still running");
    expect(existsSync(stateFile)).toBe(false);
  });
});

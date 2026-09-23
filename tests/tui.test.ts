import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AskLine, type LogLine, type OutcomeLine, readLog } from "../src/log.js";
import { App, DecisionsView, DetailView, type Filters, ReportView, rowsOf } from "../src/tui.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const SHIPPED = join(process.cwd(), "jevels");
const cwd = "/work";
const hash = `sha256:${"0".repeat(64)}`;
const ticket = { ticket: { subject: "Charged twice", message: "I was charged twice for order A-104 and I need this fixed today." } };
const legend = { "0": { what: "calm" }, "1": { what: "annoyed" }, "2": { what: "angry" } };

/** A logged the state; B did not and has one outcome already; C is a failed ask. */
const A: AskLine = {
  kind: "ask", id: "aaaaaaaa-0000-4000-8000-000000000001", at: "2026-09-22T09:00:00.000Z", jevel: { name: "ticket-triage", version: 3 }, model: "jev-1.13.0", state_hash: hash, state: ticket,
  answers: {
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.91, technical: 0.05, account: 0.03, other: 0.01 }, confidence: 0.91, certainty: 0.91, decision: "act" },
    urgent: { type: "noul", noul: 0.78, yes: true, certainty: 0.78, decision: "mark" },
    frustration: { type: "score", score: 1.2, legend, probabilities: { "0": 0.2, "1": 0.62, "2": 0.18 }, confidence: 0.62, certainty: 0.62, decision: "mark" },
  },
  usage: { input_tokens: 400, output_tokens: 12 }, cwd,
};
const B: AskLine = {
  kind: "ask", id: "bbbbbbbb-0000-4000-8000-000000000002", at: "2026-09-22T09:30:00.000Z", jevel: { name: "ticket-triage", version: 3 }, model: "jev-1.13.0", state_hash: hash,
  answers: {
    team: { type: "choice", choice: "technical", probabilities: { billing: 0.2, technical: 0.72, account: 0.05, other: 0.03 }, confidence: 0.72, certainty: 0.72, decision: "mark" },
    urgent: { type: "noul", noul: 0.1, yes: false, certainty: 0.9, decision: "act" },
    frustration: { type: "score", score: 0.1, legend, probabilities: { "0": 0.9, "1": 0.08, "2": 0.02 }, confidence: 0.9, certainty: 0.9, decision: "act" },
  },
  usage: { input_tokens: 380, output_tokens: 12 }, cwd,
};
const C: AskLine = {
  kind: "ask", id: "cccccccc-0000-4000-8000-000000000003", at: "2026-09-22T10:00:00.000Z", jevel: { name: "wake-gate", version: 1 }, model: null, state_hash: hash,
  answers: {
    worth_a_turn: { type: "noul", decision: "fall_back", answer: null, certainty: 0 },
    depth: { type: "score", decision: "fall_back", answer: null, certainty: 0 },
  },
  usage: null, cwd, error: { exit: 3, code: "rate_limited", message: "TypeSafe is rate limiting this key", retry_after_ms: 2000 },
};
const agreedB: OutcomeLine = { kind: "outcome", id: B.id, question: "team", outcome: "agree", value: null, note: null, at: "2026-09-22T11:00:00.000Z" };
const LOG: LogLine[] = [A, B, C, agreedB];

const ALL: Filters = { decision: "all", jevel: null, noOutcome: false, since: null };
const noop = (): void => undefined;
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = "\r";
const ESC = "\u001B";
const DOWN = "\u001B[B";

const homeWith = (lines: LogLine[]): string => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-tui-"));
  writeFileSync(join(home, "log.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return home;
};
const outcomesIn = async (home: string): Promise<OutcomeLine[]> => (await readLog(home)).filter((l): l is OutcomeLine => l.kind === "outcome");

describe("decisions view", () => {
  it("lists one row per question, newest ask first, with the word for every decision and an error marker", () => {
    const { lastFrame } = render(createElement(DecisionsView, { lines: LOG, filters: ALL, onFilters: noop, onOpen: noop, onReport: noop, onQuit: noop }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("8 decisions");
    const rows = frame.split("\n").filter((l) => /09-22 \d\d:\d\d/.test(l));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatch(/wake-gate\s+worth_a_turn\s+error\s+0\.00 fall_back -/);
    expect(rows.find((r) => r.includes("09:30") && r.includes("team"))).toMatch(/technical\s+0\.72 mark\s+agree/);
    expect(rows.find((r) => r.includes("09:00") && r.includes("frustration"))).toMatch(/level 1\s+0\.62 mark\s+-/);
    // Fits the 80 column terminal the TUI promises.
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("f, o and J narrow the rows, and mark with no outcome is the review queue", async () => {
    let filters = ALL;
    const view = () => createElement(DecisionsView, { lines: LOG, filters, onFilters: (f: Filters) => { filters = f; }, onOpen: noop, onReport: noop, onQuit: noop });
    const { stdin, rerender, lastFrame } = render(view());
    const press = async (key: string) => { stdin.write(key); await tick(20); rerender(view()); await tick(20); };
    await press("f");
    expect(filters.decision).toBe("act");
    expect(lastFrame()).toContain("3 decisions");
    await press("f");
    await press("o");
    expect(lastFrame()).toContain("2 marked decisions to review");
    expect(lastFrame()).not.toContain("technical");
    await press("f");
    await press("f");
    await press("o");
    expect(filters).toEqual(ALL);
    await press("J");
    expect(filters.jevel).toBe("ticket-triage");
    expect(lastFrame()).toContain("6 decisions");
    await press("J");
    expect(lastFrame()).toContain("2 decisions");
  });

  it("drops asks before --since", () => {
    expect(rowsOf(LOG, { ...ALL, since: "2026-09-22T09:15:00.000Z" }).map((r) => r.ask.id)).not.toContain(A.id);
  });
});

describe("detail view", () => {
  const detail = (row: ReturnType<typeof rowsOf>[number], thresholds: { thresholds: { act: number; mark: number }; version: number } | null) =>
    render(createElement(DetailView, { row, home: homeWith(LOG), thresholds, height: 60, onBack: noop, onRecorded: noop })).lastFrame() ?? "";
  const row = (id: string, question: string) => rowsOf(LOG, ALL).find((r) => r.ask.id === id && r.question === question)!;

  it("shows every option with its probability, the picked one marked, certainty against the thresholds and the logged state", () => {
    const frame = detail(row(A.id, "team"), { thresholds: { act: 0.8, mark: 0.6 }, version: 3 });
    expect(frame).toContain("ticket-triage v3");
    expect(frame).toMatch(/\* billing\s+0\.91\s+picked/);
    expect(frame).toMatch(/ {3}technical\s+0\.05/);
    expect(frame).toContain("certainty: 0.91 (act 0.80, mark 0.60)");
    expect(frame).toContain("decision: act");
    expect(frame).toContain('"subject": "Charged twice"');
  });

  it("shows a score's levels with their words and a noul as yes and no", () => {
    expect(detail(row(A.id, "frustration"), null)).toMatch(/\* level 1\s+0\.62\s+picked\s+annoyed/);
    expect(detail(row(A.id, "urgent"), null)).toMatch(/\* yes\s+0\.78\s+picked[\s\S]*no\s+0\.22/);
  });

  it("says how to log the state when it was not logged, and lists past outcomes", () => {
    const frame = detail(row(B.id, "team"), null);
    expect(frame).toContain("not logged. To log it next time: jevelry ask --log-state");
    expect(frame).toMatch(/09-22 11:00 agree/);
    expect(frame).toContain("thresholds unknown");
  });

  it("wraps a long line of the state at spaces, so the whole customer message stays readable", () => {
    const message = "I ordered the blue kettle on Monday, it arrived broken, the box was open and nobody answered my two emails since then, please call me";
    const frame = detail({ ...row(A.id, "team"), ask: { ...A, state: { ticket: { message } } } }, null);
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(99);
    expect(frame.replace(/\s+/g, " ")).toContain(message);
  });

  it("wraps a deeply indented line too, where a naive continuation indent would never shrink the line", () => {
    let deep: unknown = { message: "x ".repeat(80) };
    for (let i = 0; i < 50; i++) deep = { level: deep };
    const frame = detail({ ...row(A.id, "team"), ask: { ...A, state: deep } }, null);
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(99);
  });

  it("shows the error body of an ask Jev could not answer", () => {
    const frame = detail(row(C.id, "worth_a_turn"), null);
    expect(frame).toContain("answer: none, Jev could not answer");
    expect(frame).toContain("error: rate_limited (exit 3): TypeSafe is rate limiting this key");
  });
});

describe("recording outcomes from the review queue", () => {
  // The whole point of the TUI: a reviewed mark becomes an outcome line that `jevelry report` counts.
  it("a records agree with the note, d records disagree with the picked value, through the outcome writer", async () => {
    const home = homeWith(LOG);
    const queue: Filters = { decision: "mark", jevel: null, noOutcome: true, since: null };
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [FIXTURES, SHIPPED], lines: LOG, filters: queue }));
    await tick();
    expect(lastFrame()).toContain("2 marked decisions to review");
    // The newest mark first: A.urgent comes before A.frustration in the ask's own order.
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("question: urgent");
    expect(lastFrame()).toContain("certainty: 0.78 (act 0.85, mark 0.70)");
    stdin.write("n");
    await tick();
    for (const ch of "late reply") stdin.write(ch);
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write("a");
    await tick(200);
    expect(lastFrame()).toContain("recorded agree");
    expect(await outcomesIn(home)).toEqual([agreedB, expect.objectContaining({ id: A.id, question: "urgent", outcome: "agree", value: null, note: "late reply" })]);
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("1 marked decision to review");
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain("question: frustration");
    stdin.write("d");
    await tick();
    expect(lastFrame()).toContain("What was right?");
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick(200);
    const recorded = await outcomesIn(home);
    expect(recorded.at(-1)).toMatchObject({ id: A.id, question: "frustration", outcome: "disagree", value: "2", note: null });
    stdin.write(ESC);
    await tick();
    expect(lastFrame()).toContain("0 marked decisions to review");
    unmount();
  });

  it("refuses an outcome on an ask Jev could not answer and writes nothing", async () => {
    const home = homeWith(LOG);
    const r = rowsOf(LOG, ALL).find((x) => x.ask.id === C.id)!;
    const { stdin, lastFrame } = render(createElement(DetailView, { row: r, home, thresholds: null, height: 60, onBack: noop, onRecorded: noop }));
    stdin.write("a");
    await tick(200);
    expect(lastFrame()).toContain("not recorded: ask cccccccc-0000-4000-8000-000000000003 got no answer from Jev (rate_limited)");
    expect(await outcomesIn(home)).toEqual([agreedB]);
  });
});

describe("live log", () => {
  // A running program keeps deciding while the TUI is open; its new asks must show up without a restart.
  it("shows an ask appended to the log while the TUI is open", async () => {
    const home = homeWith([A]);
    const { lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: [A], filters: ALL }));
    await tick();
    expect(lastFrame()).toContain("3 decisions");
    appendFileSync(join(home, "log.jsonl"), `${JSON.stringify(B)}\n`);
    await tick(500);
    expect(lastFrame()).toContain("6 decisions");
    unmount();
  });
});

describe("unreadable log lines", () => {
  // Printing "skipped line N" to stderr would draw over the Ink screen, so the TUI counts them into its header.
  it("counts them in the header and writes nothing to stderr, also when a new broken line arrives", async () => {
    const home = homeWith([A]);
    appendFileSync(join(home, "log.jsonl"), "not json\nnull\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: [A], skipped: 2, filters: ALL }));
      await tick();
      expect(lastFrame()).toContain("3 decisions   2 unreadable log lines skipped");
      appendFileSync(join(home, "log.jsonl"), "{broken\n");
      await tick(500);
      expect(lastFrame()).toContain("3 unreadable log lines skipped");
      unmount();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("report view", () => {
  it("shows the report rows, how often act and mark were right", () => {
    const frame = render(createElement(ReportView, { lines: LOG, filters: ALL, onFilters: noop, onBack: noop })).lastFrame() ?? "";
    const team = frame.split("\n").find((l) => l.startsWith("ticket-triage") && l.includes("team"));
    // jevel, question, asks 2, act 1, mark 1, fall_back 0, outcomes 1, act right -, mark right 100%, mean certainty.
    expect(team?.split(/\s+/)).toEqual(["ticket-triage", "team", "2", "1", "1", "0", "1", "-", "100%", ((0.91 + 0.72) / 2).toFixed(2)]);
    expect(frame).toMatch(/wake-gate\s+worth_a_turn\s+1\s+0\s+0\s+1/);
  });
});

describe("jevelry tui, the command", () => {
  it("prints one line and exits 1 without a terminal", async () => {
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn("node", ["bin/jevelry.js", "tui"], { env: { PATH: process.env.PATH, JEVELRY_HOME: homeWith(LOG) } });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      child.on("close", (status) => resolve({ status, stderr }));
      child.stdin.end();
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("jevelry: tui needs an interactive terminal; use jevelry report for plain text\n");
  });

  // Every other command starts as fast as before: only the tui chunk may reach ink or react, and only through a dynamic import.
  it("keeps ink and react out of every built file but the tui chunk", () => {
    const files = readdirSync("dist").filter((f) => f.endsWith(".js"));
    const reaching = files.filter((f) => /from\s*["'](ink|react)["']|import\(["'](ink|react)["']\)/.test(readFileSync(join("dist", f), "utf8")));
    expect(reaching).toEqual(["tui.js"]);
    for (const f of files) expect(readFileSync(join("dist", f), "utf8")).not.toMatch(/from\s*["']\.\/tui\.js["']/);
    expect(readFileSync(join("dist", "cli.js"), "utf8")).toContain('import("./tui.js")');
  });
});

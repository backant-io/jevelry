// Times show in the terminal's own zone; pin it so the fixture's times read the same everywhere.
process.env.TZ = "UTC";

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AskLine, type LogLine, type OutcomeLine, type RunLine, readLog } from "../src/log.js";
import type { Answer } from "../src/protocol.js";
import { fuzzyFilter } from "../src/tui/dialog.js";
import { loadThemeName, saveThemeName } from "../src/tui/theme.js";
import { DecisionsView, type Filters, type Found, ReportView, otherValues, rowsOf } from "../src/tui/history.js";
import { DetailView, stateLines } from "../src/tui/review.js";
import { App } from "../src/tui/app.js";

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

const ALL: Filters = { decision: "all", jevel: null, noOutcome: false, failed: false, since: null };
const SIZE = { columns: 80, rows: 24 };
const noop = (): void => undefined;
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = "\r";
const CTRL_P = "\u0010";
const ESC = "\u001B";
const DOWN = "\u001B[B";
/** A card takes c, w and s only once it has been on screen this long (SETTLE_MS plus slack). */
const SETTLE = 520;

const homeWith = (lines: LogLine[]): string => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-tui-"));
  writeFileSync(join(home, "log.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return home;
};
const outcomesIn = async (home: string): Promise<OutcomeLine[]> => (await readLog(home)).filter((l): l is OutcomeLine => l.kind === "outcome");

describe("decisions view", () => {
  it("lists one row per question, newest ask first, with the word for every decision and an error marker", () => {
    const { lastFrame } = render(createElement(DecisionsView, { lines: LOG, filters: ALL, onFilters: noop, onOpen: noop, onReport: noop }));
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
    const view = () => createElement(DecisionsView, { lines: LOG, filters, onFilters: (f: Filters) => { filters = f; }, onOpen: noop, onReport: noop });
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
  const detail = (row: ReturnType<typeof rowsOf>[number], thresholds: Found | null) =>
    render(createElement(DetailView, { row, home: homeWith(LOG), thresholds, height: 60, width: 100, onBack: noop, onRecorded: noop })).lastFrame() ?? "";
  const row = (id: string, question: string) => rowsOf(LOG, ALL).find((r) => r.ask.id === id && r.question === question)!;

  it("shows every option with its probability, the picked one marked, certainty against the thresholds and the logged state", () => {
    const frame = detail(row(A.id, "team"), { thresholds: { act: 0.8, mark: 0.6 }, version: 3, question: { type: "choice", instructions: "Which team?" } });
    expect(frame).toContain("ticket-triage team  v3");
    expect(frame).toMatch(/> billing\s+█+[▏▎▍▌▋▊▉]?\s+0\.91/);
    expect(frame).toMatch(/ {2}technical\s+\S*\s+0\.05/);
    expect(frame).toContain("certainty 0.91  (act 0.80, mark 0.60)");
    // A question the file no longer has says so instead of showing the jevel-wide thresholds as its own.
    expect(detail(row(A.id, "team"), { thresholds: { act: 0.8, mark: 0.6 }, version: 3 })).toContain("this question is no longer in the jevel file");
    expect(frame).toContain("decision  act  Jev is sure");
    expect(frame).toContain("subject: Charged twice");
  });

  it("shows a score's levels with their words and a noul as yes and no", () => {
    const score = detail(row(A.id, "frustration"), null);
    expect(score).toMatch(/> 1 annoyed\s+\S+\s+0\.62/);
    expect(score).toMatch(/ {2}2 angry\s+\S+\s+0\.18/);
    expect(score).toContain("level 1: annoyed");
    expect(detail(row(A.id, "urgent"), null)).toMatch(/> yes\s+\S+\s+0\.78[\s\S]*no\s+\S+\s+0\.22/);
  });

  it("says how to log the state when it was not logged, and lists past outcomes", () => {
    const frame = detail(row(B.id, "team"), null);
    expect(frame).toContain("state not logged; set JEVELRY_LOG_STATE=1");
    expect(frame).toContain("or ask with --log-state");
    expect(frame).toContain("outcome   Jev was right (09-22 11:00)");
    expect(frame).toContain("thresholds unknown");
  });

  it("wraps a long line of the state at spaces, so the whole customer message stays readable", () => {
    const message = "I ordered the blue kettle on Monday, it arrived broken, the box was open and nobody answered my two emails since then, please call me";
    const frame = detail({ ...row(A.id, "team"), ask: { ...A, state: { ticket: { message } } } }, null);
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    const saw = stateLines({ ticket: { message } }, 46);
    for (const line of saw) expect(line.length).toBeLessThanOrEqual(46);
    expect(saw.map((l) => l.trim()).join(" ")).toContain(message);
    expect(frame).toContain(saw[2]!);
  });

  it("wraps a deeply indented line too, where a naive continuation indent would never shrink the line", () => {
    let deep: unknown = { message: "x ".repeat(80) };
    for (let i = 0; i < 50; i++) deep = { level: deep };
    const frame = detail({ ...row(A.id, "team"), ask: { ...A, state: deep } }, null);
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    for (const line of stateLines(deep, 40)) expect(line.length).toBeLessThanOrEqual(40);
  });

  it("shows what jevelry run did after the ask, so a reviewer sees the command a decision started", () => {
    const ran: RunLine = { kind: "run", id: A.id, at: A.at, option: "billing", command: 'echo "refund queued"', decision: "mark", exit: 0, ms: 42, confirmed: true };
    const withRun = rowsOf([...LOG, ran], ALL).find((r) => r.ask.id === A.id && r.question === "team")!;
    expect(detail(withRun, null).replace(/\s+/g, " ")).toContain('run: billing: echo "refund queued", exit 0 in 42 ms, confirmed');
    const declined = rowsOf([...LOG, { ...ran, exit: null, ms: null, confirmed: false }], ALL).find((r) => r.ask.id === A.id)!;
    expect(detail(declined, null).replace(/\s+/g, " ")).toContain("did not run, not confirmed");
    expect(detail(row(B.id, "team"), null)).not.toContain("run:");
  });

  it("shows the error body of an ask Jev could not answer", () => {
    const frame = detail(row(C.id, "worth_a_turn"), null);
    expect(frame).toContain("Jev could not answer");
    expect(frame.replace(/\s+/g, " ")).toContain("error rate_limited: TypeSafe is rate limiting this key");
  });
});

describe("recording outcomes from the review queue", () => {
  // The whole point of the TUI: a reviewed mark becomes an outcome line that `jevelry report` counts.
  it("a records agree with the note, d records disagree with the picked value, through the outcome writer", async () => {
    const home = homeWith(LOG);
    const queue: Filters = { decision: "mark", jevel: null, noOutcome: true, failed: false, since: null };
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [FIXTURES, SHIPPED], lines: LOG, filters: queue, screen: "history", size: SIZE }));
    await tick();
    expect(lastFrame()).toContain("2 marked decisions to review");
    // The newest mark first: A.urgent comes before A.frustration in the ask's own order.
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toMatch(/question {2}urgent/);
    expect(lastFrame()).toContain("certainty 0.78  (act 0.85, mark 0.70)");
    stdin.write("n");
    await tick();
    // Only type once the note line is up: under a loaded test run the key listener can lag the first frame.
    expect(lastFrame()).toContain("note: _");
    for (const ch of "late reply") stdin.write(ch);
    await tick();
    stdin.write(ENTER);
    await tick(SETTLE);
    stdin.write("c");
    await tick(200);
    // One outcome per visit: the detail closes and the queue shows the next mark.
    expect(lastFrame()).toContain("1 marked decision to review");
    expect(lastFrame()).toContain("Saved: Jev was right on ticket-triage urgent");
    expect(await outcomesIn(home)).toEqual([agreedB, expect.objectContaining({ id: A.id, question: "urgent", outcome: "agree", value: null, note: "late reply" })]);
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toMatch(/question {2}frustration/);
    await tick(SETTLE);
    stdin.write("w");
    await tick();
    expect(lastFrame()).toContain("What was right?");
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick(200);
    const recorded = await outcomesIn(home);
    expect(recorded.at(-1)).toMatchObject({ id: A.id, question: "frustration", outcome: "disagree", value: "2", note: null });
    expect(lastFrame()).toContain("0 marked decisions to review");
    expect(lastFrame()).toContain("Saved: Jev was wrong on ticket-triage frustration, it was level 2");
    unmount();
  });

  // A double key press, or c then w to correct a slip, would write two lines and report would count both.
  it("writes one outcome per visit, however fast c and w are pressed", async () => {
    const home = homeWith(LOG);
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: LOG, filters: ALL, screen: "history", size: SIZE }));
    await tick();
    for (const key of ["j", "j", ENTER]) { stdin.write(key); await tick(20); }
    expect(lastFrame()).toMatch(/question {2}team/);
    await tick(SETTLE);
    stdin.write("c");
    stdin.write("c");
    stdin.write("w");
    await tick(200);
    stdin.write("c");
    await tick(200);
    expect(lastFrame()).toContain("8 decisions");
    expect(lastFrame()).toContain("Saved: Jev was right on ticket-triage team");
    unmount();
    expect(await outcomesIn(home)).toEqual([agreedB, expect.objectContaining({ id: B.id, question: "team", outcome: "agree" })]);
  });

  it("refuses an outcome on an ask Jev could not answer and writes nothing", async () => {
    const home = homeWith(LOG);
    const r = rowsOf(LOG, ALL).find((x) => x.ask.id === C.id)!;
    const { stdin, lastFrame } = render(createElement(DetailView, { row: r, home, thresholds: null, height: 60, width: 120, onBack: noop, onRecorded: noop }));
    stdin.write("c");
    stdin.write("w");
    await tick(200);
    expect(lastFrame()).toContain("Jev could not answer, so there is nothing to judge.");
    expect(lastFrame()).not.toContain("What was right?");
    expect(await outcomesIn(home)).toEqual([agreedB]);
  });
});

describe("live log", () => {
  // A running program keeps deciding while the TUI is open; its new asks must show up without a restart.
  it("shows an ask appended to the log while the TUI is open", async () => {
    const home = homeWith([A]);
    const { lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: [A], filters: ALL, screen: "history", size: SIZE }));
    await tick();
    expect(lastFrame()).toContain("3 decisions");
    appendFileSync(join(home, "log.jsonl"), `${JSON.stringify(B)}\n`);
    await tick(500);
    expect(lastFrame()).toContain("6 decisions");
    unmount();
  });
});

describe("cursor", () => {
  // In any filter but the queue, a reviewer walks down the list; esc from a detail must not send them back to the top.
  it("returns to the same row after esc from a detail", async () => {
    const { stdin, lastFrame, unmount } = render(createElement(App, { home: homeWith(LOG), dirs: [], lines: LOG, filters: ALL, screen: "history", size: SIZE }));
    await tick();
    for (const key of ["j", "j", "j"]) { stdin.write(key); await tick(20); }
    const selected = () => (lastFrame() ?? "").split("\n").find((l) => l.trimStart().startsWith(">"));
    expect(selected()).toMatch(/09:30 ticket-triage urgent/);
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toMatch(/question {2}urgent/);
    stdin.write(ESC);
    await tick();
    expect(selected()).toMatch(/09:30 ticket-triage urgent/);
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
      const { lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: [A], skipped: 2, filters: ALL, screen: "history", size: SIZE }));
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

describe("disagree picker", () => {
  const answerOf = (id: string, question: string) => rowsOf(LOG, ALL).find((r) => r.ask.id === id && r.question === question)!.answer as Answer;
  it("offers every other option of a choice, every other level of a score and only the opposite of a noul", () => {
    expect(otherValues(answerOf(A.id, "team"))).toEqual(["technical", "account", "other"]);
    expect(otherValues(answerOf(A.id, "frustration"))).toEqual(["0", "2"]);
    expect(otherValues(answerOf(A.id, "urgent"))).toEqual(["no"]);
    expect(otherValues(answerOf(B.id, "urgent"))).toEqual(["yes"]);
  });
});

describe("report view", () => {
  it("keeps its header on an 80x24 screen with 30 rows and scrolls the rows with j", async () => {
    const many: LogLine[] = Array.from({ length: 30 }, (_, i) => ({
      ...B, id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`, jevel: { name: `jevel-${String(i).padStart(2, "0")}`, version: 1 }, answers: { urgent: B.answers.urgent! },
    }));
    const { stdin, lastFrame } = render(createElement(ReportView, { lines: many, filters: ALL, height: 24, onFilters: noop, onBack: noop }));
    const frame = () => lastFrame() ?? "";
    expect(frame().split("\n").length).toBeLessThanOrEqual(24);
    expect(frame()).toContain("jevel          question");
    expect(frame()).toContain("jevel-00");
    expect(frame()).not.toContain("jevel-29");
    for (let i = 0; i < 12; i++) { stdin.write("j"); await tick(10); }
    expect(frame().split("\n").length).toBeLessThanOrEqual(24);
    expect(frame()).toContain("jevel          question");
    expect(frame()).toContain("jevel-29");
    expect(frame()).not.toContain("jevel-00");
    expect(frame()).toContain("rows 11-30 of 30");
  });

  it("shows the report rows, how often act and mark were right", () => {
    const frame = render(createElement(ReportView, { lines: LOG, filters: ALL, onFilters: noop, onBack: noop })).lastFrame() ?? "";
    const team = frame.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ticket-triage") && l.includes("team"));
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
    const reaching = files.filter((f) => /from\s*["'](ink|react)(\/[^"']*)?["']|import\(["'](ink|react)(\/[^"']*)?["']\)/.test(readFileSync(join("dist", f), "utf8")));
    expect(reaching).toEqual(["tui.js"]);
    for (const f of files) expect(readFileSync(join("dist", f), "utf8")).not.toMatch(/from\s*["']\.\/tui\.js["']/);
    expect(readFileSync(join("dist", "cli.js"), "utf8")).toContain('import("./tui.js")');
  });
});

describe("the shell", () => {
  const app = (extra: Record<string, unknown> = {}) =>
    render(createElement(App, { home: homeWith(LOG), dirs: [FIXTURES], lines: LOG, version: "9.9.9", size: SIZE, ...extra }));
  const press = async (stdin: { write: (s: string) => void }, ...keys: string[]) => { for (const k of keys) { stdin.write(k); await tick(30); } };

  it("fills the terminal: as many lines as rows, none wider than the columns, at 80x24 and 120x40", async () => {
    for (const size of [SIZE, { columns: 120, rows: 40 }]) {
      const { lastFrame, unmount } = app({ size, screen: "history" });
      await tick();
      const lines = (lastFrame() ?? "").split("\n");
      expect(lines).toHaveLength(size.rows);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(size.columns);
      unmount();
    }
  });

  it("shows the screen's keys, the home directory and the version in the footer", async () => {
    const { lastFrame, unmount } = app({ screen: "history", size: { columns: 120, rows: 40 } });
    await tick();
    const footer = (lastFrame() ?? "").split("\n").at(-1) ?? "";
    expect(footer).toContain("j/k move");
    expect(footer).toMatch(/jevelry-tui-\w+ {2}v9\.9\.9/);
    unmount();
  });

  // At 80 columns a screen's keys matter more than where the log is: the path goes, the version stays.
  it("drops the home directory from the footer below 100 columns", async () => {
    const { lastFrame, unmount } = app({ screen: "history" });
    await tick();
    const footer = (lastFrame() ?? "").split("\n").at(-1) ?? "";
    expect(footer).toMatch(/v9\.9\.9$/);
    expect(footer).not.toContain("jevelry-tui-");
    expect(footer).toContain("esc back");
    unmount();
  });

  // Every screen is one key away, so nobody has to learn a menu to get around.
  it("h, v, y and t reach Home, Review, History and Try", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, "v");
    expect(lastFrame()).toContain("Review 1 of 2");
    expect(lastFrame()).toMatch(/Is Jev right\?|reading…/);
    // t opens the jevel picker; esc closes it where you were.
    await press(stdin, "t");
    expect(lastFrame()).toContain("Try a jevel");
    await press(stdin, ESC, "y");
    expect(lastFrame()).toContain("History");
    expect(lastFrame()).toContain("8 decisions");
    await press(stdin, "h");
    expect(lastFrame()).not.toContain("8 decisions");
    unmount();
  });

  it("ctrl+p lists screens, jevels, the theme switch and quit, and typing narrows it", async () => {
    const { stdin, lastFrame, unmount } = app({ size: { columns: 120, rows: 40 } });
    await tick();
    await press(stdin, CTRL_P);
    const frame = lastFrame() ?? "";
    for (const item of ["Commands", "Home", "Review marked decisions", "History", "Try a jevel", "Jevel run-gate", "Jevel ticket-triage", "Switch theme", "Quit"]) expect(frame).toContain(item);
    await press(stdin, ..."histo");
    expect(lastFrame()).toContain("History");
    expect(lastFrame()).not.toContain("Switch theme");
    await press(stdin, ENTER);
    expect(lastFrame()).not.toContain("Commands");
    expect(lastFrame()).toContain("8 decisions");
    unmount();
  });

  it("says No results for a query nothing matches, and esc closes the palette without doing anything", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, CTRL_P, ..."zzzz");
    expect(lastFrame()).toContain("No results");
    await press(stdin, ESC);
    expect(lastFrame()).not.toContain("No results");
    expect(lastFrame()).toContain("8 decisions");
    unmount();
  });

  // Letters typed into the palette are a search, never a screen key: "y" must not jump to History under the dialog.
  it("keeps the screen keys off while the palette is open", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "review" });
    await tick();
    await press(stdin, CTRL_P, "y", "q");
    expect(lastFrame()).toContain("Commands");
    await press(stdin, ESC);
    expect(lastFrame()).toMatch(/Is Jev right\?|reading…/);
    expect(lastFrame()).not.toContain("8 decisions");
    unmount();
  });

  it("keeps the screen keys off while a note is typed", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, "j", "j", ENTER, "n", ..."why? try harder");
    expect(lastFrame()).toContain("note: why? try harder_");
    expect(lastFrame()).not.toContain("Everywhere");
    unmount();
  });

  it("? shows the keys of the current screen and the keys that work everywhere", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, "?");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("This screen");
    expect(frame).toMatch(/o\s+no outcome/);
    expect(frame).toContain("Everywhere");
    expect(frame).toMatch(/ctrl\+p\s+commands/);
    await press(stdin, ESC);
    expect(lastFrame()).not.toContain("Everywhere");
    unmount();
  });

  // The choice is remembered, so the next start opens in the theme the person picked.
  it("switches the theme from the palette and remembers it in tui.json", async () => {
    const home = homeWith(LOG);
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: LOG, size: SIZE }));
    await tick();
    await press(stdin, CTRL_P, ..."theme", ENTER);
    expect(lastFrame()).toContain("Theme");
    await press(stdin, DOWN, ENTER);
    expect(lastFrame()).toContain("Saved: light theme");
    expect(JSON.parse(readFileSync(join(home, "tui.json"), "utf8"))).toEqual({ theme: "light" });
    expect(loadThemeName(home)).toBe("light");
    unmount();
  });
});

describe("theme file", () => {
  it("is dark when the file is missing or broken, and a save keeps the other keys", () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-theme-"));
    expect(loadThemeName(home)).toBe("dark");
    writeFileSync(join(home, "tui.json"), "{broken");
    expect(loadThemeName(home)).toBe("dark");
    writeFileSync(join(home, "tui.json"), JSON.stringify({ other: 1 }));
    saveThemeName(home, "light");
    expect(JSON.parse(readFileSync(join(home, "tui.json"), "utf8"))).toEqual({ other: 1, theme: "light" });
  });
});

describe("palette search", () => {
  const items = ["Home", "History", "Try a jevel", "Jevel ticket-triage", "Switch theme"].map((label) => ({ label, value: label }));
  it("matches letters in order, ignoring case, tightest and earliest match first", () => {
    expect(fuzzyFilter(items, "hi").map((i) => i.value)).toEqual(["History"]);
    expect(fuzzyFilter(items, "je").map((i) => i.value)).toEqual(["Jevel ticket-triage", "Try a jevel"]);
    expect(fuzzyFilter(items, "TICK").map((i) => i.value)).toEqual(["Jevel ticket-triage"]);
    expect(fuzzyFilter(items, "")).toHaveLength(5);
    expect(fuzzyFilter(items, "xyz")).toEqual([]);
  });
});

describe("review fixes", () => {
  const app = (extra: Record<string, unknown> = {}) =>
    render(createElement(App, { home: homeWith(LOG), dirs: [FIXTURES], lines: LOG, version: "9.9.9", size: SIZE, ...extra }));
  const press = async (stdin: { write: (s: string) => void }, ...keys: string[]) => { for (const k of keys) { stdin.write(k); await tick(30); } };

  // The toast confirms the one action this TUI exists for; it must never hide the filter line that just changed.
  it("shows the toast in the footer and leaves every content row as it was", async () => {
    const home = homeWith(LOG);
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: LOG, screen: "history", size: SIZE, filters: { ...ALL, decision: "mark", noOutcome: true } }));
    await tick();
    await press(stdin, ENTER);
    await tick(SETTLE);
    await press(stdin, "c");
    await tick(200);
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines[1]).toMatch(/^ decision mark {3}jevel all {3}outcome none yet\s*$/);
    expect(lines.at(-1)).toContain("┃ Saved: Jev was right on ticket-triage urgent");
    unmount();
  });

  it("x keeps only the asks Jev could not answer, and x again shows everything", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, "x");
    expect(lastFrame()).toContain("2 failed decisions");
    expect(lastFrame()).not.toContain("ticket-triage");
    await press(stdin, "x");
    expect(lastFrame()).toContain("8 decisions");
    unmount();
  });

  // A held key or a slow terminal delivers "jjjj" as one chunk, and two arrows in one tick; each must count.
  it("moves one row per j in a burst and per arrow in the same tick", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    const selected = () => (lastFrame() ?? "").split("\n").find((l) => l.trimStart().startsWith(">"));
    stdin.write("jjjj");
    await tick();
    expect(selected()).toMatch(/09:30 ticket-triage frustration/);
    stdin.write(`${DOWN}${DOWN}`);
    await tick();
    expect(selected()).toMatch(/09:00 ticket-triage urgent/);
    unmount();
  });

  it("puts screens and commands before the 20 jevels, marks the active row, and says how many more there are", async () => {
    const { stdin, lastFrame, unmount } = app({ dirs: [SHIPPED, FIXTURES] });
    await tick();
    await press(stdin, CTRL_P);
    const frame = lastFrame() ?? "";
    for (const item of ["Switch theme", "Help", "Quit"]) expect(frame).toContain(item);
    expect(frame).toMatch(/> Home\s+h/);
    expect(frame).toMatch(/↓ \d+ more/);
    await press(stdin, ..."ticket", ENTER);
    expect(lastFrame()).toContain("Jevel ticket-triage");
    unmount();
  });

  // Pressing y means all of History; a filter Home's failed-asks line set belongs to that one visit.
  it("opens History unfiltered on y after a jump from Home's failed asks", async () => {
    const { stdin, lastFrame, unmount } = app({ now: () => new Date("2026-09-22T12:00:00.000Z") });
    await tick();
    await press(stdin, "j", ENTER);
    expect(lastFrame()).toContain("2 failed decisions");
    await press(stdin, "h", "y");
    expect(lastFrame()).toContain("History  8 decisions");
    expect(lastFrame()).not.toContain("failed only");
    unmount();
  });

  it("keeps the help dialog clear of the footer at 80x24", async () => {
    const { stdin, lastFrame, unmount } = app({ version: "9.9.9" });
    await tick();
    await press(stdin, "?");
    expect((lastFrame() ?? "").split("\n").at(-1)).toContain("v9.9.9");
    unmount();
  });

  it("explains act, mark and fall_back in the help overlay", async () => {
    const { stdin, lastFrame, unmount } = app();
    await tick();
    await press(stdin, "?");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("What the decisions mean");
    // The same words as Home's legend and the card.
    expect(frame).toMatch(/act\s+Jev is sure/);
    expect(frame).toMatch(/mark\s+fairly sure, check it/);
    expect(frame).toMatch(/fall_back\s+unsure, your code decides/);
    // Keys that work everywhere are listed once, under Everywhere.
    expect(frame.match(/y\s+history/g)).toHaveLength(1);
    unmount();
  });

  it("offers no c or w on an ask Jev could not answer", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, ENTER);
    expect(lastFrame()).toContain("Jev could not answer");
    expect(lastFrame()).not.toContain("c correct");
    unmount();
  });

  it("shows times in the terminal's zone, the detail with seconds", async () => {
    const { stdin, lastFrame, unmount } = app({ screen: "history" });
    await tick();
    await press(stdin, "j", "j", ENTER);
    expect(lastFrame()).toContain("2026-09-22 09:30:00 (local)");
    unmount();
  });
});

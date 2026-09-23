process.env.TZ = "UTC";

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { parseJevel } from "../src/jevel.js";
import type { AskLine, LogLine, OutcomeLine } from "../src/log.js";
import { App } from "../src/tui/app.js";
import { placeOf, proposeAct, setActThreshold, tallies } from "../src/tui/tuning.js";

const SHIPPED = join(process.cwd(), "jevels");
/** A jevelry package with ticket-triage in its jevels folder: a git checkout of the source, or an installed copy. The jevels folder. */
const fakePackage = (checkout: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), "jevelry-pkg-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jevelry" }));
  if (checkout) mkdirSync(join(root, ".git"));
  cpSync(join(SHIPPED, "ticket-triage"), join(root, "jevels", "ticket-triage"), { recursive: true });
  return join(root, "jevels");
};
const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const hash = `sha256:${"0".repeat(64)}`;
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const reviewed = (list: Array<[certainty: number, right: boolean]>) => list.map(([certainty, right]) => ({ certainty, right }));
/** `n` reviewed decisions spread evenly from `from` to `to`, right when `right(c)` says so. */
const spread = (n: number, from: number, to: number, right: (c: number) => boolean) =>
  reviewed(Array.from({ length: n }, (_, i) => { const c = Math.round((from + ((to - from) * i) / (n - 1)) * 100) / 100; return [c, right(c)]; }));

describe("the tuning rule", () => {
  const thresholds = { act: 0.9, mark: 0.6 };

  // Nineteen outcomes say too little to move a threshold that decides what code does unasked.
  it("suggests nothing with fewer than 20 reviewed act or mark decisions", () => {
    const few = spread(19, 0.6, 0.99, () => true);
    expect(proposeAct({ reviewed: few, certainties: few.map((r) => r.certainty) }, thresholds)).toBeNull();
    const enough = spread(20, 0.6, 0.99, () => true);
    expect(proposeAct({ reviewed: enough, certainties: enough.map((r) => r.certainty) }, thresholds)).not.toBeNull();
  });

  // Jev is right on everything from 0.75 up and wrong below: act can come down to 0.75 and no further.
  it("proposes the lowest threshold at which act stays as right", () => {
    const r = spread(40, 0.6, 0.99, (c) => c >= 0.75);
    const certainties = [...r.map((x) => x.certainty), 0.3, 0.4];
    const p = proposeAct({ reviewed: r, certainties }, thresholds)!;
    expect(p.act).toBe(0.75);
    expect(p.agreement).toBe(1);
    expect(p.current).toBe(1);
    // The decisions from 0.75 up to 0.9 would act now, out of every decision of the question.
    expect(p.more).toBeCloseTo(certainties.filter((c) => c >= 0.75 && c < 0.9).length / certainties.length, 10);
  });

  // Below mark the decision would skip the check a person does on a mark; the rule keeps a band of 0.05 above it.
  it("never goes below the mark threshold plus 0.05", () => {
    const r = spread(40, 0.3, 0.99, () => true);
    const lowest = Math.min(...r.map((x) => x.certainty).filter((c) => c >= 0.75));
    expect(lowest).toBeGreaterThan(0.75);
    expect(proposeAct({ reviewed: r, certainties: r.map((x) => x.certainty) }, { act: 0.9, mark: 0.7 })!.act).toBe(lowest);
    const onGrid = spread(70, 0.3, 0.99, () => true);
    expect(proposeAct({ reviewed: onGrid, certainties: [] }, { act: 0.9, mark: 0.7 })!.act).toBe(0.75);
  });

  // A threshold between two reviewed certainties would let unreviewed decisions act on no evidence at all.
  it("proposes the certainty of a decision someone reviewed, never a step in between", () => {
    const r = reviewed([...Array.from({ length: 20 }, (): [number, boolean] => [0.95, true]), ...Array.from({ length: 5 }, (): [number, boolean] => [0.87, true]), [0.79, false]]);
    const unreviewed = [0.8, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86];
    const p = proposeAct({ reviewed: r, certainties: [...r.map((x) => x.certainty), ...unreviewed] }, { act: 0.9, mark: 0.6 })!;
    expect(p.act).toBe(0.87);
    expect(r.map((x) => x.certainty)).toContain(p.act);
  });

  // When act is right only 85% of the time already, "two points less" would be 83%; the floor is 90%.
  it("never proposes a threshold at which act would be right less than 90% of the time", () => {
    // 20 at or above 0.9, 17 right (85%); the five below are all right, but the pool never reaches 90% (22 of 25).
    const high = reviewed(Array.from({ length: 20 }, (_, i) => [0.9 + (i % 10) / 100, i >= 3]));
    const low = reviewed(Array.from({ length: 5 }, (_, i) => [0.85 + i / 100, true]));
    const t = { reviewed: [...high, ...low], certainties: [...high, ...low].map((x) => x.certainty) };
    expect(proposeAct(t, { act: 0.9, mark: 0.6 })).toBeNull();
    // At 91% now, 0.85 would give 89.5%: within two points, but under 90%, so the lowest that holds is 0.86 (90.4%).
    const now91 = [...reviewed(Array.from({ length: 100 }, (_, i) => [0.95, i >= 9])), ...reviewed([[0.85, false], [0.86, false], [0.87, true], [0.88, true], [0.89, true]])];
    expect(proposeAct({ reviewed: now91, certainties: now91.map((x) => x.certainty) }, { act: 0.9, mark: 0.6 })!.act).toBe(0.86);
  });

  it("suggests nothing when no lower threshold holds, or nothing reviewed reaches the current one", () => {
    const allWrongBelow = reviewed([...Array.from({ length: 20 }, (): [number, boolean] => [0.95, true]), ...Array.from({ length: 20 }, (_, i): [number, boolean] => [0.7 + i / 100, false])]);
    expect(proposeAct({ reviewed: allWrongBelow, certainties: [] }, { act: 0.9, mark: 0.6 })).toBeNull();
    expect(proposeAct({ reviewed: spread(30, 0.6, 0.85, () => true), certainties: [] }, { act: 0.9, mark: 0.6 })).toBeNull();
  });

  it("counts the latest outcome of each act or mark decision, per question, and leaves failed asks out", () => {
    const ask = (id: string, c: number, decision: "act" | "mark" | "fall_back"): AskLine => ({
      kind: "ask", id, at: "2026-09-22T09:00:00.000Z", jevel: { name: "t", version: 1 }, model: "jev-1.13.0", state_hash: hash, usage: null, cwd: "/w",
      answers: { "q[0]": { type: "noul", noul: c, yes: true, certainty: c, decision }, "q[1]": { type: "noul", noul: c, yes: true, certainty: c, decision } },
    });
    const outcome = (id: string, question: string, o: "agree" | "disagree"): OutcomeLine => ({ kind: "outcome", id, question, outcome: o, value: null, note: null, at: "2026-09-22T10:00:00.000Z" });
    const failed: AskLine = { ...ask("f", 0, "fall_back"), error: { exit: 3, code: "rate_limited", message: "late" } };
    const t = tallies([ask("a", 0.95, "act"), ask("b", 0.8, "mark"), ask("c", 0.5, "fall_back"), failed,
      outcome("a", "q[0]", "disagree"), outcome("a", "q[0]", "agree"), outcome("b", "q[1]", "disagree"), outcome("c", "q[0]", "agree")]).get("t\nq")!;
    expect(t).toMatchObject({ act: 2, mark: 2, fallBack: 4, actReviewed: 1, actRight: 1, markReviewed: 1, markRight: 0 });
    expect(t.certainties).toHaveLength(6);
    expect(t.reviewed).toEqual([{ certainty: 0.95, right: true }, { certainty: 0.8, right: false }]);
  });
});

describe("setting the act threshold in the file", () => {
  const shipped = readFileSync(join(SHIPPED, "ticket-triage", "JEVEL.md"), "utf8");
  const wake = readFileSync(join(FIXTURES, "wake-gate", "JEVEL.md"), "utf8");
  /** The lines that differ, as [line number, before, after]; the files must have the same number of lines. */
  const diff = (a: string, b: string): Array<[number, string, string]> => {
    const x = a.split("\n");
    const y = b.split("\n");
    expect(y).toHaveLength(x.length);
    return x.flatMap((l, i) => (l === y[i] ? [] : [[i + 1, l, y[i]!] as [number, string, string]]));
  };

  // A person reads the diff of their jevel in review; a reserialised file would bury the one change in noise.
  it("changes the question's act value and the version, and every other byte stays", () => {
    const edited = setActThreshold(shipped, "team", 0.72);
    expect(diff(shipped, edited.text)).toEqual([
      [3, "version: 3", "version: 4"],
      [43, "    thresholds: { act: 0.8, mark: 0.6 }", "    thresholds: { act: 0.72, mark: 0.6 }"],
    ]);
    expect(edited.changes).toEqual([
      { line: 3, before: "version: 3", after: "version: 4" },
      { line: 43, before: "    thresholds: { act: 0.8, mark: 0.6 }", after: "    thresholds: { act: 0.72, mark: 0.6 }" },
    ]);
    const parsed = parseJevel(edited.text, "ticket-triage").jevel;
    expect(parsed.questions.team!.thresholds).toEqual({ act: 0.72, mark: 0.6 });
    expect(parsed.version).toBe(4);
    expect(parsed.body).toBe(parseJevel(shipped, "ticket-triage").jevel.body);
  });

  // A CRLF file with one LF line reads as a mixed file in every diff and editor.
  it("inserts a line with the file's own CRLF line end", () => {
    const crlf = wake.replace(/\n/g, "\r\n");
    for (const question of ["worth_a_turn", "same_as"]) {
      const text = crlf.replace("    thresholds: { act: 0.85 }", "    thresholds:\r\n      mark: 0.7");
      const edited = setActThreshold(text, question, 0.8).text;
      expect(edited).not.toMatch(/[^\r]\n/);
    }
  });

  it("keeps CRLF line ends and edits a flow map without mark", () => {
    const crlf = wake.replace(/\n/g, "\r\n");
    const edited = setActThreshold(crlf, "depth", 0.75).text;
    expect(edited).toBe(crlf.replace("version: 1", "version: 2").replace("    thresholds: { act: 0.7 }", "    thresholds: { act: 0.75 }"));
  });

  it("adds the threshold to a question that inherits it, indented like its other keys", () => {
    const edited = setActThreshold(wake, "worth_a_turn", 0.8);
    expect(edited.text).toBe(wake.replace("version: 1", "version: 2").replace("  worth_a_turn:\n    type: noul", "  worth_a_turn:\n    thresholds: { act: 0.8 }\n    type: noul"));
    expect(parseJevel(edited.text, "wake-gate").jevel.questions.worth_a_turn!.thresholds).toEqual({ act: 0.8 });
    expect(edited.changes[1]).toEqual({ line: 13, before: "    type: noul", after: "    thresholds: { act: 0.8 }\n    type: noul" });
  });

  it("refuses a question the file does not have, and an act under the question's mark", () => {
    expect(() => setActThreshold(shipped, "nope", 0.7)).toThrow("no question named nope");
    expect(() => setActThreshold(shipped, "team", 0.5)).toThrow("mark (0.6) must not exceed act (0.5)");
  });

  it("tells a shipped jevel and one in JEVELRY_HOME from a project's own", () => {
    expect(placeOf("/pkg/jevels/ticket-triage/JEVEL.md", { shipped: "/pkg/jevels", home: "/h" })).toEqual({ kind: "shipped" });
    expect(placeOf("/h/jevels/x/JEVEL.md", { shipped: "/pkg/jevels", home: "/h" })).toEqual({ kind: "home" });
    expect(placeOf("/proj/jevels/x/JEVEL.md", { shipped: "/pkg/jevels", home: "/h" })).toEqual({ kind: "project" });
    expect(placeOf("/pkg/jevels-extra/x/JEVEL.md", { shipped: "/pkg/jevels", home: "/h" })).toEqual({ kind: "project" });
    // A git checkout of jevelry itself is where its jevels are written, so their files are edited in place.
    const source = fakePackage(true);
    // Only from inside the checkout: the same checkout linked into another project copies like an installed one.
    const file = join(source, "ticket-triage", "JEVEL.md");
    expect(placeOf(file, { shipped: source, home: "/h", cwd: dirname(source) })).toEqual({ kind: "source" });
    expect(placeOf(file, { shipped: source, home: "/h", cwd: join(dirname(source), "jevels") })).toEqual({ kind: "source" });
    expect(placeOf(file, { shipped: source, home: "/h", cwd: mkdtempSync(join(tmpdir(), "jevelry-proj-")) })).toEqual({ kind: "shipped" });
    const installed = fakePackage(false);
    expect(placeOf(join(installed, "ticket-triage", "JEVEL.md"), { shipped: installed, home: "/h", cwd: dirname(installed) })).toEqual({ kind: "shipped" });
  });
});

/** 50 reviewed team decisions: right from 0.70 up, wrong below; act 0.80 can come down to 0.70. */
function tuningLog(): LogLine[] {
  const lines: LogLine[] = [];
  for (let i = 0; i < 60; i++) {
    const c = Math.round((0.62 + (i % 38) / 100) * 100) / 100;
    const id = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;
    lines.push({
      kind: "ask", id, at: new Date(Date.UTC(2026, 8, 20, 0, i)).toISOString(), jevel: { name: "ticket-triage", version: 3 }, model: "jev-1.13.0", state_hash: hash, usage: null, cwd: "/w",
      answers: { team: { type: "choice", choice: "billing", probabilities: { billing: c, technical: 1 - c }, confidence: c, certainty: c, decision: c >= 0.8 ? "act" : c >= 0.6 ? "mark" : "fall_back" } },
    });
    if (i < 50) lines.push({ kind: "outcome", id, question: "team", outcome: c >= 0.7 ? "agree" : "disagree", value: null, note: null, at: new Date(Date.UTC(2026, 8, 20, 2, i)).toISOString() });
  }
  return lines;
}

describe("jevel screen", () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-tune-"));
    const project = join(mkdtempSync(join(tmpdir(), "jevelry-proj-")), "jevels");
    cpSync(join(SHIPPED, "ticket-triage"), join(project, "ticket-triage"), { recursive: true });
    const lines = tuningLog();
    writeFileSync(join(home, "log.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    return { home, project, lines };
  };
  const ENTER = "\r";
  const ESC = "\u001B";
  const press = async (stdin: { write: (s: string) => void }, ...keys: string[]) => { for (const k of keys) { stdin.write(k); await tick(40); } };

  it("shows each question's mix, how often act and mark were right, the certainties against the thresholds, at 80x24 and 120x40", async () => {
    const { home, project, lines } = setup();
    for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }]) {
      const { lastFrame, unmount } = render(createElement(App, { home, dirs: [project], project, lines, size, screen: "jevel", jevel: "ticket-triage" }));
      await tick();
      const frame = lastFrame() ?? "";
      expect(frame.split("\n")).toHaveLength(size.rows);
      for (const l of frame.split("\n")) expect(l.length).toBeLessThanOrEqual(size.columns);
      expect(frame).toContain("Jevel ticket-triage  v3 · 3 questions · 60 decisions");
      expect(frame).toMatch(/> team {2}choice {2}act ≥ 0\.80 {2}mark ≥ 0\.60 {2}60 decisions/);
      expect(frame).toMatch(/█+▓+ {2}act 40% {2}mark 60% {2}fall_back 0%/);
      expect(frame).toContain("act right 100% of 20   mark right 47% of 30");
      // Empty bins are dots, so "none" never reads as "a few"; the markers are shapes named in words.
      expect(frame).toMatch(/0 ·+[▁-█][·▁-█]+ 1 {2}certainty of each answer/);
      expect(frame).toMatch(/△ +▲ +▲ act 0\.80 {2}△ mark 0\.60/);
      expect(frame).toContain("act would still be right 100% at 0.70, and 33% more decisions would act.");
      // A question with no reviews says what it waits for instead.
      expect(frame).toContain("0 reviewed; 20 needed to suggest a threshold");
      unmount();
    }
  });

  // T writes a file the person owns, so they see the file and the exact lines before anything changes.
  it("T shows the file and the exact change, and enter writes it, bumps the version and toasts", async () => {
    const { home, project, lines } = setup();
    const path = join(project, "ticket-triage", "JEVEL.md");
    const before = readFileSync(path, "utf8");
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [project], project, lines, size: { columns: 100, rows: 30 }, screen: "jevel", jevel: "ticket-triage" }));
    await tick();
    await press(stdin, "T");
    const confirm = lastFrame() ?? "";
    expect(confirm).toContain("Set the act threshold");
    expect(confirm).toContain("ticket-triage team: act 0.80 → 0.70");
    expect(confirm).toContain("- version: 3");
    expect(confirm).toContain("+ version: 4");
    expect(confirm).toContain("- thresholds: { act: 0.8, mark: 0.6 }");
    expect(confirm).toContain("+ thresholds: { act: 0.7, mark: 0.6 }");
    // The footer names enter the way the dialog does.
    expect(confirm.split("\n").at(-1)).toMatch(/^ enter set it {2}esc cancel/);
    expect(readFileSync(path, "utf8")).toBe(before);
    await press(stdin, ESC);
    expect(readFileSync(path, "utf8")).toBe(before);
    await press(stdin, "T", ENTER);
    expect(readFileSync(path, "utf8")).toBe(before.replace("version: 3", "version: 4").replace("thresholds: { act: 0.8, mark: 0.6 }", "thresholds: { act: 0.7, mark: 0.6 }"));
    expect(lastFrame()).toContain("threshold set to 0.70 in");
    expect(lastFrame()).toMatch(/> team {2}choice {2}act ≥ 0\.70/);
    expect(lastFrame()).toContain("Jevel ticket-triage  v4");
    unmount();
  });

  // An installed jevel is jevelry's: the next update would overwrite a change made there, so the copy is tuned.
  it("offers to copy an installed shipped jevel into the project, says why, and tunes the copy", async () => {
    const { home, lines } = setup();
    const installed = fakePackage(false);
    const project = join(mkdtempSync(join(tmpdir(), "jevelry-proj-")), "jevels");
    const shippedPath = join(installed, "ticket-triage", "JEVEL.md");
    const before = readFileSync(shippedPath, "utf8");
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [project, installed], shipped: installed, project, lines, size: { columns: 100, rows: 30 }, screen: "jevel", jevel: "ticket-triage" }));
    await tick();
    expect(lastFrame()).toContain("ships with jevelry: ");
    await press(stdin, "T");
    const frame = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("Copy the jevel and set its threshold");
    expect(frame).toContain(`This jevel came with jevelry. An update would undo a change made here. Enter copies it to ${project}/ticket-triage and tunes the copy:`.replace(/\s+/g, " "));
    expect(lastFrame()).toContain("enter copy and set");
    expect((lastFrame() ?? "").split("\n").at(-1)).toMatch(/^ enter copy and set {2}esc cancel/);
    await press(stdin, ENTER);
    expect(readFileSync(shippedPath, "utf8")).toBe(before);
    const copy = join(project, "ticket-triage", "JEVEL.md");
    expect(readFileSync(copy, "utf8")).toBe(before.replace("version: 3", "version: 4").replace("thresholds: { act: 0.8, mark: 0.6 }", "thresholds: { act: 0.7, mark: 0.6 }"));
    expect(existsSync(join(project, "ticket-triage", "example.json"))).toBe(true);
    expect(lastFrame()).toContain("your project's file: ");
    unmount();
  });

  // Inside a checkout of jevelry the shipped file is the source: the person working there means to change it.
  it("tunes a shipped jevel in place inside jevelry's own git checkout", async () => {
    const { home, lines } = setup();
    const source = fakePackage(true);
    const path = join(source, "ticket-triage", "JEVEL.md");
    const before = readFileSync(path, "utf8");
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [source], shipped: source, project: source, lines, size: { columns: 80, rows: 24 }, screen: "jevel", jevel: "ticket-triage" }));
    await tick();
    expect(lastFrame()).toContain("jevelry's own source file: ");
    await press(stdin, "T");
    expect(lastFrame()).toContain("Set the act threshold");
    expect(lastFrame()).not.toContain("Cannot");
    expect((lastFrame() ?? "").split("\n").at(-1)).toMatch(/^ enter set it {2}esc cancel/);
    await press(stdin, ENTER);
    expect(readFileSync(path, "utf8")).toBe(before.replace("version: 3", "version: 4").replace("thresholds: { act: 0.8, mark: 0.6 }", "thresholds: { act: 0.7, mark: 0.6 }"));
    expect(existsSync(join(source, "ticket-triage", "ticket-triage"))).toBe(false);
    unmount();
  });

  it("enter on a question lists its decisions in History, and esc comes back", async () => {
    const { home, project, lines } = setup();
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [project], project, lines, size: { columns: 100, rows: 30 }, screen: "jevel", jevel: "ticket-triage" }));
    await tick();
    await press(stdin, ENTER);
    expect(lastFrame()).toContain("History  60 decisions");
    expect(lastFrame()).toContain("question team");
    await press(stdin, ESC);
    expect(lastFrame()).toContain("Jevel ticket-triage");
    unmount();
  });

  it("counts the thresholds worth moving on the dashboard, and enter opens that jevel", async () => {
    const { home, project, lines } = setup();
    const { stdin, lastFrame, unmount } = render(createElement(App, { home, dirs: [project], project, lines, size: { columns: 100, rows: 30 }, now: () => new Date("2026-09-20T12:00:00.000Z"), screen: "dashboard" }));
    await tick();
    expect(lastFrame()).toContain("1 threshold worth moving");
    await press(stdin, "j", ENTER);
    expect(lastFrame()).toContain("act would still be right 100% at 0.70");
    unmount();
  });
});

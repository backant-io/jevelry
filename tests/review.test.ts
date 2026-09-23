process.env.TZ = "UTC";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { type AskLine, type LogLine, type OutcomeLine, readLog } from "../src/log.js";
import { App } from "../src/tui/app.js";
import { stateLines } from "../src/tui/review.js";

const SHIPPED = join(process.cwd(), "jevels");
const hash = `sha256:${"0".repeat(64)}`;
const legend = { "0": { what: "calm" }, "1": { what: "annoyed" }, "2": { what: "angry" } };
const ticket = { ticket: { subject: "Charged twice", message: "I was charged twice for order A-104 and I need this fixed today." } };
/** Newest first in the queue: D (a choice), then A's noul and score. B's mark has an outcome, C failed. */
const A: AskLine = {
  kind: "ask", id: "aaaaaaaa-0000-4000-8000-000000000001", at: "2026-09-22T09:00:00.000Z", jevel: { name: "ticket-triage", version: 3 }, model: "jev-1.13.0", state_hash: hash, state: ticket,
  answers: {
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.91, technical: 0.05, account: 0.03, other: 0.01 }, confidence: 0.91, certainty: 0.91, decision: "act" },
    urgent: { type: "noul", noul: 0.78, yes: true, certainty: 0.78, decision: "mark" },
    frustration: { type: "score", score: 1.2, legend, probabilities: { "0": 0.2, "1": 0.62, "2": 0.18 }, confidence: 0.62, certainty: 0.62, decision: "mark" },
  },
  usage: { input_tokens: 400, output_tokens: 12 }, cwd: "/w",
};
const B: AskLine = {
  ...A, id: "bbbbbbbb-0000-4000-8000-000000000002", at: "2026-09-22T09:30:00.000Z",
  answers: { team: { type: "choice", choice: "technical", probabilities: { billing: 0.2, technical: 0.72, account: 0.05, other: 0.03 }, confidence: 0.72, certainty: 0.72, decision: "mark" } },
};
const C: AskLine = {
  ...A, id: "cccccccc-0000-4000-8000-000000000003", at: "2026-09-22T10:00:00.000Z", model: null, usage: null,
  answers: { team: { type: "choice", decision: "fall_back", answer: null, certainty: 0 } },
  error: { exit: 3, code: "rate_limited", message: "TypeSafe is rate limiting this key" },
};
const D: AskLine = {
  ...A, id: "dddddddd-0000-4000-8000-000000000004", at: "2026-09-22T11:00:00.000Z",
  answers: { team: { type: "choice", choice: "account", probabilities: { billing: 0.1, technical: 0.1, account: 0.75, other: 0.05 }, confidence: 0.75, certainty: 0.75, decision: "mark" } },
};
const agreedB: OutcomeLine = { kind: "outcome", id: B.id, question: "team", outcome: "agree", value: null, note: null, at: "2026-09-22T11:30:00.000Z" };
const LOG: LogLine[] = [A, B, C, D, agreedB];

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
/** A card takes c, w and s only once it has been on screen this long (SETTLE_MS plus slack). */
const SETTLE = 520;
/** The same verdict key again this soon after the last verdict is a held key (HELD_MS plus slack). */
const HELD = 1200;
const press = async (stdin: { write: (s: string) => void }, ...keys: string[]) => { for (const k of keys) { stdin.write(k); await tick(80); } };
const homeWith = (lines: LogLine[]): string => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-review-"));
  writeFileSync(join(home, "log.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return home;
};
const review = (lines: LogLine[], size = { columns: 80, rows: 24 }) => {
  const home = homeWith(lines);
  return { home, ...render(createElement(App, { home, dirs: [SHIPPED], lines, size, screen: "review", version: "9.9.9" })) };
};
const outcomes = async (home: string) => (await readLog(home)).filter((l): l is OutcomeLine => l.kind === "outcome");

describe("state lines", () => {
  // A reviewer reads the state the way the customer wrote it: no braces, no quotes, no escaped newlines.
  it("draws the state as indented key: value lines, lists with dashes, strings without quotes", () => {
    expect(stateLines({ ticket: { subject: "Hi", tags: ["refund", "vip"], count: 2, paid: true, note: null, empty: {} } }, 40)).toEqual([
      "ticket:",
      "  subject: Hi",
      "  tags:",
      "    - refund",
      "    - vip",
      "  count: 2",
      "  paid: true",
      "  note: null",
      "  empty: {}",
    ]);
    expect(stateLines([{ a: 1 }, "x"], 40)).toEqual(["-", "  a: 1", "- x"]);
    expect(stateLines("just text", 40)).toEqual(["just text"]);
  });

  it("wraps long values under their key and keeps the lines of a multi-line string", () => {
    const lines = stateLines({ message: "one two three four five six seven eight nine ten", body: "first line\nsecond line" }, 24);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
    expect(lines[0]).toBe("message: one two three");
    expect(lines[1]).toMatch(/^ {2}four/);
    expect(lines.slice(-2)).toEqual(["body: first line", "      second line"]);
  });
});

describe("review", () => {
  it("shows one marked decision: what Jev saw, what it decided, and the question it asks, at 80x24 and 120x40", async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }]) {
      const { lastFrame, unmount } = review(LOG, size);
      await tick(SETTLE);
      const frame = lastFrame() ?? "";
      expect(frame.split("\n")).toHaveLength(size.rows);
      for (const l of frame.split("\n")) expect(l.length).toBeLessThanOrEqual(size.columns);
      expect(frame).toContain("Review 1 of 3  marked decisions without an outcome, newest first");
      expect(frame).toContain("ticket-triage team  v3 · 2026-09-22 11:00:00 (local) · jev-1.13.0");
      expect(frame).toContain("What Jev saw");
      expect(frame).toContain("subject: Charged twice");
      expect(frame).toContain("What Jev decided");
      expect(frame).toContain("Which team should handle `ticket`?");
      expect(frame).toMatch(/> account\s+█+\S*\s+0\.75/);
      expect(frame).toMatch(/ {2}billing\s+\S+\s+0\.10/);
      // What the picked option means, from the jevel's own criteria.
      expect(frame.replace(/\s+/g, " ")).toContain("account: Logging in, a password, a seat");
      expect(frame).toContain("certainty 0.75  (act 0.80, mark 0.60)");
      expect(frame).toContain("decision  mark  fairly sure, check it");
      expect(frame).toMatch(/Jev says: team = account\s*\n\s*Is Jev right\? {2}c correct {2}w wrong {2}s skip {2}n note {2}m review acts/);
      // How this question has done so far, so the reviewer knows how much to trust the pick.
      // The so-far block fits whole at both sizes: its last line is never cut.
      expect(frame).toContain("so far  4 decisions of this question");
      expect(frame).toContain("act 25% mark 50% fall_back 25%");
      expect(frame).toContain("right   act -, mark 1/1");
      unmount();
    }
  });

  // The whole job: c, w or s moves on, and each c or w is one outcome line the report counts.
  it("c, w and s record or skip and bring the next card, newest first, and the end says what was done", async () => {
    const { home, stdin, lastFrame, unmount } = review(LOG);
    await tick(SETTLE);
    await press(stdin, "c");
    await tick(150);
    expect(lastFrame()).toContain("Review 2 of 3");
    expect(lastFrame()).toMatch(/> yes\s+\S+\s+0\.78/);
    expect(lastFrame()).toContain("Saved: Jev was right on ticket-triage team");
    await tick(SETTLE);
    await press(stdin, "s");
    expect(lastFrame()).toContain("Review 3 of 3");
    expect(lastFrame()).toMatch(/> 1 annoyed\s+\S+\s+0\.62/);
    await tick(SETTLE);
    await press(stdin, "w", "j", "\r");
    await tick(150);
    expect(lastFrame()).toContain("All reviewed");
    expect(lastFrame()).toContain("2 outcomes recorded, 1 skipped on this visit.");
    expect(await outcomes(home)).toEqual([
      agreedB,
      expect.objectContaining({ id: D.id, question: "team", outcome: "agree" }),
      expect.objectContaining({ id: A.id, question: "frustration", outcome: "disagree", value: "2" }),
    ]);
    // s brings the skipped one back.
    await press(stdin, "s");
    expect(lastFrame()).toMatch(/question {2}urgent/);
    unmount();
  });

  // A held key must not hand out verdicts on cards nobody saw: that is exactly what the tuning rule reads.
  it("records one outcome for a held c, ten presses 30 ms apart, and for a key repeat's first delay", async () => {
    const { home, stdin, lastFrame, unmount } = review(LOG);
    await tick(SETTLE);
    for (let i = 0; i < 10; i++) { stdin.write("c"); await tick(30); }
    await tick(200);
    expect(await outcomes(home)).toEqual([agreedB, expect.objectContaining({ id: D.id, question: "team", outcome: "agree" })]);
    expect(lastFrame()).toContain("Review 2 of 3");
    // A terminal's key repeat: the press, 400 ms, then repeats 33 ms apart. One press, one outcome.
    await tick(HELD);
    stdin.write("c");
    await tick(400);
    for (let i = 0; i < 9; i++) { stdin.write("c"); await tick(33); }
    await tick(200);
    expect((await outcomes(home)).slice(1)).toEqual([
      expect.objectContaining({ id: D.id, question: "team" }),
      expect.objectContaining({ id: A.id, question: "urgent", outcome: "agree" }),
    ]);
    expect(lastFrame()).toContain("Review 3 of 3");
    unmount();
  });

  // A key repeat's first delay is 300 ms on macOS, about 500 on Windows, 660 on X11 and up to 1000: every one of them
  // outlasts or nearly outlasts the next card's settle time, and the first repeat must still not be a second verdict.
  it("records exactly one outcome for a held c whatever the terminal's first repeat delay", async () => {
    for (const delay of [300, 500, 660, 1000]) {
      const { home, stdin, lastFrame, unmount } = review(LOG);
      await tick(SETTLE);
      stdin.write("c");
      await tick(delay);
      for (let i = 0; i < 9; i++) { stdin.write("c"); await tick(33); }
      await tick(200);
      expect((await outcomes(home)).length, `delay ${delay} ms`).toBe(2);
      expect(lastFrame()).toContain("Review 2 of 3");
      unmount();
    }
  }, 20000);

  // A person who means it presses again after a pause, or presses another key first: that verdict counts.
  it("takes the same verdict key again after a pause, or right after another key", async () => {
    const { home, stdin, lastFrame, unmount } = review(LOG);
    await tick(SETTLE);
    stdin.write("c");
    await tick(HELD);
    stdin.write("c");
    await tick(150);
    expect(await outcomes(home)).toHaveLength(3);
    expect(lastFrame()).toContain("Review 3 of 3");
    await tick(SETTLE);
    stdin.write("j");
    await tick(30);
    stdin.write("c");
    await tick(150);
    expect(await outcomes(home)).toHaveLength(4);
    expect(lastFrame()).toContain("All reviewed");
    unmount();
  });

  // A key pressed while the card settles does nothing, so the card says why.
  it("says reading while a new card settles, then drops the hint", async () => {
    const { stdin, lastFrame, unmount } = review(LOG);
    await tick(60);
    expect(lastFrame()).toContain("reading…");
    await tick(SETTLE);
    expect(lastFrame()).not.toContain("reading…");
    stdin.write("c");
    await tick(100);
    expect(lastFrame()).toContain("Review 2 of 3");
    expect(lastFrame()).toContain("reading…");
    unmount();
  });

  it("takes no c, w or s in the first moments a card is up, and handles keys that arrive in one read", async () => {
    const { home, stdin, lastFrame, unmount } = review(LOG);
    await tick(60);
    stdin.write("c");
    await tick(SETTLE);
    expect(await outcomes(home)).toEqual([agreedB]);
    // "sc" in one read: skip, then (the next card not yet settled) nothing.
    stdin.write("sc");
    await tick(150);
    expect(lastFrame()).toContain("Review 2 of 3");
    expect(await outcomes(home)).toEqual([agreedB]);
    unmount();
  });

  // On a noul there is one other value, so "wrong" is the whole answer; a picker with one row is a wasted key.
  it("w on a noul records the opposite value at once, and every card asks the same question with the same keys", async () => {
    const { home, stdin, lastFrame, unmount } = review([A, B, agreedB]);
    await tick(SETTLE);
    expect(lastFrame()).toMatch(/question {2}urgent/);
    expect(lastFrame()).toMatch(/Jev says: urgent = yes\s*\n\s*Is Jev right\? {2}c correct {2}w wrong \(it was no\) {2}s skip/);
    stdin.write("w");
    await tick(200);
    expect((await outcomes(home)).at(-1)).toMatchObject({ id: A.id, question: "urgent", outcome: "disagree", value: "no" });
    expect(lastFrame()).not.toContain("What was right?");
    unmount();
  });

  // The sample ticket answers all act: Review must not claim every marked decision has an outcome when there are none.
  it("says there are no marked decisions yet when the log has none, and that every one has an outcome when it does", async () => {
    const onlyAct: AskLine = { ...A, answers: { team: A.answers.team! } };
    const empty = review([onlyAct]);
    await tick();
    expect(empty.lastFrame()).toContain("No marked decisions yet");
    expect(empty.lastFrame()).toContain("Jev marks a decision when it is fairly sure.");
    empty.unmount();
    const done = review([B, agreedB]);
    await tick();
    expect(done.lastFrame()).toContain("No marked decisions to review");
    expect(done.lastFrame()).toContain("Every marked decision has an outcome.");
    done.unmount();
  });

  // Act accuracy is only known when some acts get an outcome too, so the queue switches to them.
  it("m switches to act decisions without an outcome, and back", async () => {
    const { stdin, lastFrame, unmount } = review(LOG);
    await tick();
    await press(stdin, "m");
    expect(lastFrame()).toContain("Review 1 of 1  act decisions without an outcome");
    expect(lastFrame()).toMatch(/> billing\s+\S+\s+0\.91/);
    expect(lastFrame()).toContain("m review marks");
    await press(stdin, "m");
    expect(lastFrame()).toContain("Review 1 of 3  marked decisions");
    unmount();
  });

  it("says there is nothing to review when every mark has an outcome, and never offers a failed ask", async () => {
    const { stdin, lastFrame, unmount } = review([B, C, agreedB]);
    await tick();
    expect(lastFrame()).toContain("No marked decisions to review");
    expect(lastFrame()).toContain("Every marked decision has an outcome.");
    expect(lastFrame()).toContain("m reviews act decisions");
    await press(stdin, "\u001B");
    expect(lastFrame()).toContain("Needs you");
    unmount();
  });

  it("says where to turn on state logging when the state was not logged", async () => {
    const { lastFrame, unmount } = review([{ ...D, state: undefined } as AskLine]);
    await tick();
    expect(lastFrame()).toContain("state not logged; set");
    expect(lastFrame()).toContain("JEVELRY_LOG_STATE=1");
    unmount();
  });
});

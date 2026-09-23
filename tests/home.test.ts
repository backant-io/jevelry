// "Today" is the local day; pin the zone so the fixture's hours fall on the same day everywhere.
process.env.TZ = "UTC";

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { AskLine, LogLine, OutcomeLine } from "../src/log.js";
import { App } from "../src/tui/app.js";
import { costOf, formatCost, homeStats } from "../src/tui/home.js";

const hash = `sha256:${"0".repeat(64)}`;
const legend = { "0": { what: "calm" }, "1": { what: "annoyed" }, "2": { what: "angry" } };
const A: AskLine = {
  kind: "ask", id: "aaaaaaaa-0000-4000-8000-000000000001", at: "2026-09-22T09:00:00.000Z", jevel: { name: "ticket-triage", version: 3 }, model: "jev-1.13.0", state_hash: hash,
  answers: {
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.91, technical: 0.05, account: 0.03, other: 0.01 }, confidence: 0.91, certainty: 0.91, decision: "act" },
    urgent: { type: "noul", noul: 0.78, yes: true, certainty: 0.78, decision: "mark" },
    frustration: { type: "score", score: 1.2, legend, probabilities: { "0": 0.2, "1": 0.62, "2": 0.18 }, confidence: 0.62, certainty: 0.62, decision: "mark" },
  },
  usage: { input_tokens: 400, output_tokens: 12 }, cwd: "/work",
};
const B: AskLine = {
  ...A, id: "bbbbbbbb-0000-4000-8000-000000000002", at: "2026-09-22T09:30:00.000Z", usage: { input_tokens: 380, output_tokens: 12 },
  answers: {
    team: { type: "choice", choice: "technical", probabilities: { billing: 0.2, technical: 0.72, account: 0.05, other: 0.03 }, confidence: 0.72, certainty: 0.72, decision: "mark" },
    urgent: { type: "noul", noul: 0.1, yes: false, certainty: 0.9, decision: "act" },
    frustration: { type: "score", score: 0.1, legend, probabilities: { "0": 0.9, "1": 0.08, "2": 0.02 }, confidence: 0.9, certainty: 0.9, decision: "act" },
  },
};
const C: AskLine = {
  kind: "ask", id: "cccccccc-0000-4000-8000-000000000003", at: "2026-09-22T10:00:00.000Z", jevel: { name: "wake-gate", version: 1 }, model: null, state_hash: hash,
  answers: { worth_a_turn: { type: "noul", decision: "fall_back", answer: null, certainty: 0 }, depth: { type: "score", decision: "fall_back", answer: null, certainty: 0 } },
  usage: null, cwd: "/work", error: { exit: 3, code: "rate_limited", message: "TypeSafe is rate limiting this key", retry_after_ms: 2000 },
};
const agreedB: OutcomeLine = { kind: "outcome", id: B.id, question: "team", outcome: "agree", value: null, note: null, at: "2026-09-22T11:00:00.000Z" };
/** Three days earlier, so it counts for the jevel and its trend but not for today. */
const old: AskLine = { ...B, id: "dddddddd-0000-4000-8000-000000000004", at: "2026-09-19T08:00:00.000Z" };
const agreedOldAct: OutcomeLine = { ...agreedB, id: old.id, question: "urgent", outcome: "disagree" };
const LOG: LogLine[] = [old, agreedOldAct, A, B, C, agreedB];
const NOW = new Date("2026-09-22T12:00:00.000Z");

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const homeWith = (lines: LogLine[]): string => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-home-"));
  writeFileSync(join(home, "log.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return home;
};
const app = (lines: LogLine[], size = { columns: 80, rows: 24 }) =>
  render(createElement(App, { home: homeWith(lines), dirs: [], lines, version: "9.9.9", size, now: () => NOW }));

describe("home numbers", () => {
  const s = homeStats(LOG, NOW);

  it("counts today's decisions by kind, and leaves older days out", () => {
    expect(s.today).toMatchObject({ asks: 3, decisions: 8, act: 3, mark: 3, fallBack: 2 });
  });

  // What a day of asks cost is the price of the input tokens; the failed ask was not charged.
  it("prices today's input tokens at the model's rate", () => {
    expect(s.today.cost.dollars).toBeCloseTo(((400 + 380) / 1_000_000) * 0.042, 12);
    expect(formatCost(s.today.cost)).toBe("$0.000033");
  });

  // One ask without usage must not hide what the rest of the day cost; it is counted next to the sum.
  it("sums the asks it can price and counts the answered asks without usage or with an unpriced model", () => {
    expect(costOf([A, { ...A, usage: null }])).toEqual({ dollars: (400 / 1_000_000) * 0.042, noUsage: 1, noPrice: 0 });
    expect(formatCost(costOf([A, { ...A, usage: null }, { ...A, usage: null }]))).toBe("$0.000017, 2 asks without usage");
    expect(formatCost(costOf([{ ...A, model: "jev-9.0.0" }]))).toBe("$0, 1 ask on an unpriced model");
    expect(costOf([C])).toEqual({ dollars: 0, noUsage: 0, noPrice: 0 });
    expect(formatCost(costOf([C]))).toBe("$0");
    expect(formatCost({ dollars: 1.5, noUsage: 0, noPrice: 0 })).toBe("$1.50");
  });

  it("counts decisions per hour over the last 24 hours, the current hour last", () => {
    expect(s.hourly).toHaveLength(24);
    expect(s.hourly[20]).toBe(3);
    expect(s.hourly[21]).toBe(5);
    expect(s.hourly.reduce((a, b) => a + b, 0)).toBe(8);
  });

  // The review queue is every mark nobody has judged yet, not only today's, and a failed ask has nothing to judge.
  it("counts marked decisions with no outcome from the whole log, and today's failed asks with the most common error", () => {
    expect(s.toReview).toBe(3);
    expect(s.failedToday).toEqual({ count: 1, topError: "rate_limited" });
  });

  it("gives each jevel its decisions, how often act and mark were right, and a 14-day trend", () => {
    const triage = s.jevels.find((j) => j.name === "ticket-triage")!;
    expect(triage.decisions).toBe(9);
    expect(triage.actRight).toBe(0);
    expect(triage.markRight).toBe(1);
    expect(triage.mix).toEqual({ act: 5, mark: 4, fallBack: 0 });
    expect(triage.trend).toHaveLength(14);
    expect(triage.trend[13]).toBe(6);
    expect(triage.trend[10]).toBe(3);
    expect(s.jevels.find((j) => j.name === "wake-gate")).toMatchObject({ decisions: 2, actRight: null, markRight: null });
  });
});

describe("home screen", () => {
  it("answers 'is Jev deciding well, and what needs me' on an 80x24 terminal", async () => {
    const { lastFrame, unmount } = app(LOG);
    await tick();
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines).toHaveLength(24);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
    expect(frame).toContain("◆ JEVELRY  Use Jev everywhere to make & track decisions  v9.9.9");
    expect(frame).toContain("Today  8 decisions · 3 asks · $0.000033");
    expect(frame).toContain("act: Jev was sure · mark: fairly sure, check it");
    expect(frame).toContain("fall_back: unsure, your code decides");
    expect(frame).toMatch(/[█▓░]+ act 38% mark 38% fall_back 25%/);
    expect(frame).toContain("24h · peak 5/h");
    expect(frame).toContain("Needs you");
    expect(frame).toContain("● 3 marked decisions to review");
    expect(frame).toContain("● 1 ask failed today (rate_limited)");
    expect(frame).toMatch(/ticket-triage\s+9\s+0% of 1\s+[▁-█]{14}  peak 6\/day/);
    expect(frame).toMatch(/wake-gate\s+2\s+-\s+[▁-█]{14}/);
    unmount();
  });

  it("draws the block logo and the mark right and mix columns on a 120x40 terminal", async () => {
    const { lastFrame, unmount } = app(LOG, { columns: 120, rows: 40 });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(40);
    for (const l of frame.split("\n")) expect(l.length).toBeLessThanOrEqual(120);
    expect(frame).toContain("█▀▀▀ █    █▀▀█");
    expect(frame).not.toContain("◆ JEVELRY");
    // The side column shows the selected jevel per question, and the rest of the height is the live feed.
    expect(frame).toMatch(/ticket-triage {2}per question/);
    expect(frame).toMatch(/frustration\s+[█▓░]+ -/);
    expect(frame).toContain("Latest decisions");
    expect(frame).toMatch(/09-22 10:00 wake-gate\s+worth_a_turn\s+error\s+fall_back/);
    unmount();
  });

  it("fits 100x30 whole: block logo, the cost, the enter mark, and the mix column", async () => {
    const { lastFrame, unmount } = app(LOG, { columns: 100, rows: 30 });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame.split("\n")).toHaveLength(30);
    expect(frame).toContain("█▀▀▀ █    █▀▀█");
    expect(frame).toContain("8 decisions · 3 asks · $0.000033");
    expect(frame).toContain("3 marked decisions to review  ⏎");
    expect(frame).toMatch(/ticket-triage\s+9\s+0% of 1\s+█+▓+\s+[▁-█]{14}  peak 6\/day/);
    expect(frame).not.toContain("…");
    unmount();
  });

  it("enter on the marked decisions opens Review, on the failed asks History with only today's failed asks, on a jevel its screen", async () => {
    const { stdin, lastFrame, unmount } = app(LOG);
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Was Jev right?");
    stdin.write("h");
    await tick();
    stdin.write("j");
    await tick();
    stdin.write("\r");
    await tick();
    // Only the failed ask of today: its two questions, not every fall_back in the log.
    expect(lastFrame()).toContain("2 failed decisions");
    expect(lastFrame()).toContain("failed only");
    expect(lastFrame()).toContain("since 09-22 00:00");
    expect(lastFrame()).toMatch(/wake-gate\s+worth_a_turn\s+error/);
    expect(lastFrame()).not.toContain("ticket-triage");
    stdin.write("h");
    await tick();
    stdin.write("j");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Jevel ticket-triage");
    unmount();
  });

  it("says nothing needs you when every mark has an outcome and nothing failed", async () => {
    const { lastFrame, unmount } = app([B, agreedB]);
    await tick();
    expect(lastFrame()).toContain("Nothing. Every marked decision has an outcome.");
    unmount();
  });

  // After a first act on an empty log there is nothing to review yet, which is different from everything reviewed.
  it("says no marked decisions yet when the log has none", async () => {
    const onlyActs: AskLine = { ...B, answers: { urgent: B.answers.urgent! } };
    const { lastFrame, unmount } = app([onlyActs]);
    await tick();
    expect(lastFrame()).toContain("No marked decisions yet.");
    unmount();
  });

  it("shows the priced sum and how many asks carry no usage", async () => {
    const { lastFrame, unmount } = app([{ ...A, id: "eeeeeeee-0000-4000-8000-000000000005", usage: null }, A]);
    await tick();
    expect(lastFrame()).toContain("Today  6 decisions · 2 asks · $0.000017, 1 ask without usage");
    unmount();
  });

  // A first run must lead somewhere: the empty log offers a live try of a shipped jevel.
  it("opens on a first-run panel with an empty log, and enter goes to Try with ticket-triage", async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }]) {
      const { stdin, lastFrame, unmount } = app([], size);
      await tick();
      expect(lastFrame()).toContain("No decisions yet.");
      expect(lastFrame()).toContain("Try ticket-triage with a sample ticket ⏎");
      expect(lastFrame()?.split("\n")).toHaveLength(size.rows);
      stdin.write("\r");
      await tick();
      expect(lastFrame()).toContain("Try ticket-triage");
      expect(lastFrame()).toContain("coming in the next task");
      unmount();
    }
  });
});

describe("home feed", () => {
  // The feed is the reason to keep Home open; a new ask must be visible the moment it lands.
  it("marks an ask that arrives while Home is open with a dot on its feed row", async () => {
    const home = homeWith([A]);
    const { lastFrame, unmount } = render(createElement(App, { home, dirs: [], lines: [A], version: "9.9.9", size: { columns: 120, rows: 40 }, now: () => NOW }));
    await tick();
    expect(lastFrame()).not.toMatch(/● 09-22 09:30/);
    appendFileSync(join(home, "log.jsonl"), `${JSON.stringify(B)}\n`);
    await tick(500);
    expect(lastFrame()).toMatch(/● 09-22 09:30 ticket-triage/);
    unmount();
  });

  // At 80x24 only two jevel rows fit; moving into the feed must not scroll the table or print a zero count.
  it("keeps the jevels table where it was when the cursor moves into the feed", async () => {
    const third: AskLine = { ...A, id: "ffffffff-0000-4000-8000-000000000006", at: "2026-09-21T10:00:00.000Z", jevel: { name: "zz-last", version: 1 },
      answers: { ok: { type: "noul", noul: 0.95, yes: true, certainty: 0.95, decision: "act" } } };
    const lines = [...LOG, third];
    const { stdin, lastFrame, unmount } = app(lines);
    await tick();
    const table = () => (lastFrame() ?? "").split("\n").filter((l) => /^\s+(> )?(ticket-triage|wake-gate|zz-last)\s+\d/.test(l)).map((l) => l.trim().replace(/^> /, "").split(/\s+/)[0]);
    expect(table()).toEqual(["ticket-triage", "wake-gate"]);
    // Straight into the feed: the table stays on its first rows.
    stdin.write("jjjjjjj");
    await tick();
    expect(table()).toEqual(["ticket-triage", "wake-gate"]);
    expect(lastFrame()).toContain("↓ 1 more below");
    // Back up onto the last jevel scrolls the table to it, and on into the feed leaves it there.
    for (const key of ["k", "k", "k"]) { stdin.write(key); await tick(30); }
    expect(table()).toEqual(["wake-gate", "zz-last"]);
    expect(lastFrame()).toContain("↑ 1 above");
    stdin.write("jj");
    await tick();
    expect(table()).toEqual(["wake-gate", "zz-last"]);
    expect(lastFrame()).not.toContain("↓ 0");
    unmount();
  });

  it("enter on a feed row opens that decision, and esc comes back to Home", async () => {
    const { stdin, lastFrame, unmount } = app(LOG, { columns: 120, rows: 40 });
    await tick();
    // Two needs, two jevels, then the feed, newest first.
    stdin.write("jjjj");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("wake-gate worth_a_turn  v1");
    expect(lastFrame()).toMatch(/question {2}worth_a_turn/);
    stdin.write("\u001B");
    await tick();
    expect(lastFrame()).toContain("Latest decisions");
    unmount();
  });
});

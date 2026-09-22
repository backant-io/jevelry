import { describe, expect, it } from "vitest";
import type { AskLine, LogLine } from "../src/log.js";
import { renderReport, report } from "../src/report.js";

const askLine = (id: string, at: string, verdict: "act" | "mark" | "fall_back", certainty: number, name = "wake-gate"): AskLine => ({
  kind: "ask",
  id,
  at,
  jevel: { name, version: 1 },
  model: "jev-1.13.0",
  state_hash: "sha256:" + "0".repeat(64),
  answers: {
    worth_a_turn: { type: "noul", noul: 1 - certainty, yes: false, certainty, verdict },
    "same_as[0]": { type: "noul", noul: 0.9, yes: true, certainty: 0.9, verdict: "act" },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
  cwd: "/w",
});

const lines: LogLine[] = [
  askLine("a", "2026-09-22T10:00:00.000Z", "act", 0.95),
  askLine("b", "2026-09-22T11:00:00.000Z", "act", 0.91),
  askLine("c", "2026-09-22T12:00:00.000Z", "mark", 0.75),
  askLine("d", "2026-09-21T12:00:00.000Z", "fall_back", 0.55, "return-kind"),
  { kind: "outcome", id: "a", question: "worth_a_turn", outcome: "agree", value: null, note: null, at: "2026-09-22T10:05:00.000Z" },
  { kind: "outcome", id: "b", question: "worth_a_turn", outcome: "disagree", value: null, note: null, at: "2026-09-22T11:05:00.000Z" },
  { kind: "outcome", id: "c", question: "worth_a_turn", outcome: "agree", value: null, note: null, at: "2026-09-22T12:05:00.000Z" },
];

describe("report", () => {
  it("folds asks and outcomes per jevel and question, repeat answers under their question", () => {
    const rows = report(lines);
    expect(rows.map((r) => [r.jevel, r.question])).toEqual([
      ["return-kind", "same_as"],
      ["return-kind", "worth_a_turn"],
      ["wake-gate", "same_as"],
      ["wake-gate", "worth_a_turn"],
    ]);
    const w = rows.find((r) => r.jevel === "wake-gate" && r.question === "worth_a_turn");
    expect(w).toEqual({
      jevel: "wake-gate",
      question: "worth_a_turn",
      asks: 3,
      verdicts: { act: 2, mark: 1, fall_back: 0 },
      outcomes: 3,
      agreement_act: 0.5,
      agreement_mark: 1,
      mean_certainty: (0.95 + 0.91 + 0.75) / 3,
    });
    const s = rows.find((r) => r.jevel === "wake-gate" && r.question === "same_as");
    expect(s?.asks).toBe(3);
    expect(s?.agreement_act).toBeNull();
  });
  it("filters by jevel and since", () => {
    expect(report(lines, { jevel: "return-kind" }).every((r) => r.jevel === "return-kind")).toBe(true);
    const recent = report(lines, { since: "2026-09-22T10:30:00.000Z" });
    expect(recent.find((r) => r.jevel === "wake-gate" && r.question === "worth_a_turn")?.asks).toBe(2);
    expect(recent.some((r) => r.jevel === "return-kind")).toBe(false);
  });
  it("renders a table and a sentence for an empty log", () => {
    const text = renderReport(report(lines));
    expect(text.split("\n")[0]).toMatch(/jevel\s+question\s+asks\s+act\s+mark\s+fall_back\s+outcomes\s+agree\(act\)\s+agree\(mark\)\s+certainty/);
    expect(text).toContain("wake-gate");
    expect(renderReport([])).toBe("no asks in the log\n");
  });
});

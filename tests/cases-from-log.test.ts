import { describe, expect, it } from "vitest";
import { stateHash } from "../src/ask.js";
import { casesFromLog } from "../src/eval.js";
import type { AskLine, LogLine, OutcomeLine } from "../src/log.js";

const state = (n: number) => ({ ticket: { subject: `case ${n}` } });
const ask = (id: string, n: number, extra: Partial<AskLine> = {}): AskLine => ({
  kind: "ask", id, at: `2026-11-0${n}T10:00:00.000Z`, jevel: { name: "ticket-triage", version: 3 }, model: "local/a.gguf", state_hash: stateHash(state(n)), state: state(n),
  answers: {
    team: { type: "choice", choice: "billing", probabilities: { billing: 0.8, account: 0.2 }, confidence: 0.8, certainty: 0.8, decision: "mark" },
    urgent: { type: "noul", noul: 0.9, yes: true, certainty: 0.9, decision: "act" },
    frustration: { type: "score", score: 1.2, legend: { "0": "calm", "1": "annoyed", "2": "angry" }, probabilities: {}, confidence: 0.7, certainty: 0.7, decision: "mark" },
  },
  usage: { input_tokens: 1, output_tokens: 1 }, cwd: "/w", ...extra,
});
const outcome = (id: string, question: string, verdict: "agree" | "disagree", value: string | null = null, at = "2026-11-09T10:00:00.000Z"): OutcomeLine => ({ kind: "outcome", id, question, outcome: verdict, value, note: null, at });
const QUESTIONS = ["team", "urgent", "frustration"];

// Shipped jevels have three to six cases. The answers a person confirmed or corrected in real use are the cases
// worth adding: each is a state that actually came up, with what was actually true.
describe("casesFromLog", () => {
  it("turns a reviewed ask into a case: what was confirmed as it was answered, what was corrected as the person gave it", () => {
    const lines: LogLine[] = [ask("aaaaaaaa-1", 1), outcome("aaaaaaaa-1", "team", "disagree", "account"), outcome("aaaaaaaa-1", "urgent", "agree"), outcome("aaaaaaaa-1", "frustration", "disagree", "2")];
    expect(casesFromLog(lines, "ticket-triage", QUESTIONS, new Set())).toEqual({
      cases: [{ name: "from the log, 2026-11-01 aaaaaaaa", state: state(1), expect: { team: "account", urgent: true, frustration: 2 } }],
      withoutState: 0,
    });
  });
  it("reads a bare disagree on a noul as the other answer, and leaves out a choice or score nobody corrected", () => {
    const lines: LogLine[] = [ask("b", 2), outcome("b", "urgent", "disagree"), outcome("b", "team", "disagree"), outcome("b", "frustration", "agree")];
    expect(casesFromLog(lines, "ticket-triage", QUESTIONS, new Set()).cases[0]?.expect).toEqual({ urgent: false, frustration: 1 });
  });
  it("takes the last word on a question, yes and no as a noul's value, and only questions the jevel still has", () => {
    const lines: LogLine[] = [
      ask("c", 3),
      outcome("c", "urgent", "agree", null, "2026-11-09T10:00:00.000Z"),
      outcome("c", "urgent", "disagree", "no", "2026-11-09T11:00:00.000Z"),
      outcome("c", "team", "agree"),
    ];
    expect(casesFromLog(lines, "ticket-triage", ["urgent"], new Set()).cases[0]?.expect).toEqual({ urgent: false });
  });
  // A case needs its state. The log keeps only a hash unless state logging is on, and says how many that cost.
  it("skips asks logged without their state and counts them, and asks nobody reviewed, another jevel's, and states already among the cases", () => {
    const { state: _dropped, ...hashOnly } = ask("d", 4);
    const lines: LogLine[] = [
      hashOnly, outcome("d", "urgent", "agree"),
      ask("e", 5),
      ask("f", 6, { jevel: { name: "other", version: 1 } }), outcome("f", "urgent", "agree"),
      ask("g", 7), outcome("g", "urgent", "agree"),
      ask("h", 8), outcome("h", "urgent", "agree"),
    ];
    const found = casesFromLog(lines, "ticket-triage", QUESTIONS, new Set([stateHash(state(7))]));
    expect(found.cases.map((c) => c.name)).toEqual(["from the log, 2026-11-08 h"]);
    expect(found.withoutState).toBe(1);
  });
});

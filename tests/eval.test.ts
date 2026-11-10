import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AskResult } from "../src/ask.js";
import { type Case, evaluate, judge, readCases, renderEval, wilson } from "../src/eval.js";
import { JevelError } from "../src/jevel.js";
import { type Answer, type Decision, PROTOCOL } from "../src/protocol.js";

const choice = (value: string, decision: Decision): Answer => ({ type: "choice", choice: value, probabilities: { [value]: 0.9 }, confidence: 0.9, certainty: 0.9, decision });
const noul = (yes: boolean, decision: Decision): Answer => ({ type: "noul", noul: yes ? 0.95 : 0.05, yes, certainty: 0.95, decision });
const score = (value: number, decision: Decision): Answer => ({ type: "score", score: value, legend: {}, probabilities: {}, confidence: 0.8, certainty: 0.8, decision });

describe("wilson", () => {
  // Shipped jevels have three to six cases: a bare 100% would read as proof, and the interval says what four cases can show.
  it("says four right of four still allows an accuracy near one half", () => {
    const [low, high] = wilson(4, 4);
    expect(low).toBeCloseTo(0.5101, 3);
    expect(high).toBe(1);
  });
  it("narrows as the cases grow, and never leaves [0, 1]", () => {
    const [low, high] = wilson(95, 100);
    expect(low).toBeCloseTo(0.8882, 3);
    expect(high).toBeCloseTo(0.9785, 3);
    expect(wilson(0, 4)[0]).toBe(0);
    expect(wilson(0, 4)[1]).toBeCloseTo(0.4899, 3);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("judge", () => {
  // The rules of tests/live/jevels.test.ts, so the command and the suite never disagree about what a right answer is.
  it("holds a clear case to its value and to a decision that is not fall_back", () => {
    expect(judge("flaky", choice("flaky", "act"))).toBe(true);
    expect(judge("flaky", choice("flaky", "mark"))).toBe(true);
    expect(judge("flaky", choice("flaky", "fall_back"))).toBe(false);
    expect(judge("flaky", choice("defect", "act"))).toBe(false);
  });
  it("asks of an unclear case only that the answer is not a confident one", () => {
    expect(judge(null, choice("flaky", "mark"))).toBe(true);
    expect(judge(null, noul(true, "fall_back"))).toBe(true);
    expect(judge(null, choice("flaky", "act"))).toBe(false);
  });
  it("reads a noul by its yes and a score by its nearest level", () => {
    expect(judge(true, noul(true, "act"))).toBe(true);
    expect(judge(false, noul(true, "act"))).toBe(false);
    expect(judge(1, score(1.4, "act"))).toBe(true);
    expect(judge(1, score(1.6, "act"))).toBe(false);
  });
  it("refuses an expectation of another kind than the answer, which is a mistake in cases.json and not a wrong answer", () => {
    expect(() => judge("yes", noul(true, "act"))).toThrow(JevelError);
    expect(() => judge(true, choice("flaky", "act"))).toThrow(JevelError);
  });
});

const cases: Case[] = [
  { name: "clear flaky", state: { n: 1 }, expect: { cause: "flaky", "same_as[0]": true } },
  { name: "clear defect, answered flaky and sure", state: { n: 2 }, expect: { cause: "defect", "same_as[0]": false, "same_as[1]": false } },
  { name: "unclear", state: { n: 3 }, expect: { cause: null } },
];
const answersBy: Record<number, Record<string, Answer>> = {
  1: { cause: choice("flaky", "act"), "same_as[0]": noul(true, "mark") },
  2: { cause: choice("flaky", "act"), "same_as[0]": noul(false, "act"), "same_as[1]": noul(false, "act") },
  3: { cause: choice("flaky", "mark") },
};
const askCase = async (state: unknown): Promise<AskResult> => {
  const n = (state as { n: number }).n;
  return {
    ok: true,
    ms: 100 * n,
    request_hash: "sha256:r",
    document: { protocol: PROTOCOL, log_id: null, jevel: { name: "failing-test", version: 2 }, model: "local/a.gguf", state_hash: "sha256:x", answers: answersBy[n] ?? {}, usage: { input_tokens: 1, output_tokens: 1 } },
  };
};

describe("evaluate", () => {
  it("counts per question what was right, what reached act and what was wrong at act, a repeated question under its own name", async () => {
    const result = await evaluate(cases, askCase);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const e = result.evaluation;
    expect(e.jevel).toEqual({ name: "failing-test", version: 2 });
    expect(e.model).toBe("local/a.gguf");
    expect(e.questions).toEqual([
      // flaky right at act, defect answered flaky at act, the unclear one kept off act.
      { question: "cause", checks: 3, right: 2, accuracy: 2 / 3, interval: wilson(2, 3), clear: 2, act: 2, wrong_at_act: 1 },
      { question: "same_as", checks: 3, right: 3, accuracy: 1, interval: wilson(3, 3), clear: 3, act: 2, wrong_at_act: 0 },
    ]);
    expect([e.checks, e.right, e.p50_ms]).toEqual([6, 5, 200]);
    expect(e.cases[1]).toMatchObject({ name: "clear defect, answered flaky and sure", ms: 200 });
    expect(e.cases[1]?.checks[0]).toEqual({ question: "cause", want: "defect", got: "flaky", decision: "act", right: false });
  });
  it("stops at the first case Jev could not answer and names it, because half an eval reads like a result", async () => {
    const failing = async (state: unknown): Promise<AskResult> =>
      (state as { n: number }).n === 2 ? { ok: false, error: { exit: 6, code: "transport", message: "down" } } : askCase(state);
    expect(await evaluate(cases, failing)).toEqual({ ok: false, case: "clear defect, answered flaky and sure", error: { exit: 6, code: "transport", message: "down" } });
  });
  it("refuses a case that expects a question the jevel did not answer", async () => {
    await expect(evaluate([{ name: "typo", state: { n: 1 }, expect: { cuase: "flaky" } }], askCase)).rejects.toThrow(/typo.*cuase/);
  });
  it("renders the table with intervals, a summary line and every wrong check by its case", async () => {
    const result = await evaluate(cases, askCase);
    if (!result.ok) throw new Error("unreachable");
    const text = renderEval(result.evaluation);
    expect(text.split("\n")[0]).toMatch(/question\s+checks\s+right\s+accuracy \(95%\)\s+act\s+wrong at act/);
    expect(text).toMatch(/cause\s+3\s+2\s+67% \(21-94%\)\s+2\/2\s+1/);
    expect(text).toContain("3 cases, 6 checks, 5 right against local/a.gguf; median 200 ms per case");
    expect(text).toContain('wrong: "clear defect, answered flaky and sure": cause expected defect, got flaky at act');
  });
});

describe("readCases", () => {
  const file = (content: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), "jevelry-cases-")), "cases.json");
    writeFileSync(path, content);
    return path;
  };
  it("reads the array as it is", () => {
    expect(readCases(file(JSON.stringify(cases)))).toEqual(cases);
  });
  it("refuses a missing file, a file that is no array of cases and an expectation that is no value, each with the reason", () => {
    expect(() => readCases(join(tmpdir(), "jevelry-no-such-dir", "cases.json"))).toThrow(/no cases\.json/);
    expect(() => readCases(file("{"))).toThrow(JevelError);
    expect(() => readCases(file('{"name":"x"}'))).toThrow(/array/);
    expect(() => readCases(file('[{"name":"x","state":{}}]'))).toThrow(/expect/);
    expect(() => readCases(file('[{"name":"x","state":{},"expect":{"q":{"nested":1}}}]'))).toThrow(/q/);
    expect(() => readCases(file("[]"))).toThrow(/no cases/);
  });
});

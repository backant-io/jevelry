import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JevelError, checkState, expandQuestions, getPath, loadJevel } from "../src/jevel.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const { jevel } = loadJevel("wake-gate", [FIXTURES]);

describe("getPath", () => {
  const v = { a: { b: [{ c: 1 }, { c: 2 }] }, items: ["x", "y"] };
  it("walks dots and brackets", () => {
    expect(getPath(v, "a.b[1].c")).toBe(2);
    expect(getPath(v, "items")).toEqual(["x", "y"]);
    expect(getPath(v, "items[0]")).toBe("x");
  });
  it("answers undefined for a missing step", () => {
    expect(getPath(v, "a.x.y")).toBeUndefined();
    expect(getPath(v, "items[5]")).toBeUndefined();
    expect(getPath("a string", "a")).toBeUndefined();
  });
});

describe("checkState", () => {
  it("passes when every required key is present", () => {
    expect(() => checkState(jevel, { employee: {}, events: [], candidates: [] })).not.toThrow();
  });
  it("names the first missing required key", () => {
    expect(() => checkState(jevel, { employee: {} })).toThrowError(
      expect.objectContaining({ field: "state.required", message: expect.stringContaining("`events`") }) as unknown as Error,
    );
  });
  it("refuses a non-object state when keys are required", () => {
    expect(() => checkState(jevel, "text")).toThrow(JevelError);
  });
});

describe("expandQuestions", () => {
  const state = {
    employee: { title: "COO", authority: ["read_readings"] },
    events: [{ kind: "task.submitted" }],
    filing: { title: "xAI credits out" },
    candidates: [{ title: "openai credits out" }, { title: "grok 403" }, { title: "reaper storm" }],
  };
  it("passes plain questions through in the SDK's shape", () => {
    const { questions } = expandQuestions(jevel, state);
    expect(questions.worth_a_turn).toEqual({
      type: "noul",
      instructions: "Does any event in `events` require an act that `employee`, holding `employee.authority`, must perform now?",
      criteria: {
        true: "An event names work, a review, a message or a decision only this employee can act on.",
        false: "Every event is informational, already handled, or for somebody else.",
      },
    });
    expect(questions.depth?.type).toBe("score");
    expect((questions.depth as unknown as { criteria: unknown[] }).criteria).toHaveLength(3);
  });
  it("expands a repeat into one question per element with rewritten paths", () => {
    const { questions, thresholds } = expandQuestions(jevel, state);
    expect(Object.keys(questions)).toEqual(["worth_a_turn", "depth", "same_as[0]", "same_as[1]", "same_as[2]"]);
    expect(questions["same_as[1]"]).toEqual({
      type: "noul",
      instructions: "Does `candidates[1]` describe the same incident as `filing`?",
    });
    expect(thresholds["same_as[2]"]).toEqual({ act: 0.85, mark: 0.7 });
  });
  it("rewrites paths that continue into the element", () => {
    const j = structuredClone(jevel);
    j.questions.same_as = {
      type: "noul",
      repeat: { over: "candidates", as: "candidate" },
      instructions: { question: "Is `candidate.title` the same as `filing.title`?", note: "`candidate` is one candidate" },
    };
    const { questions } = expandQuestions(j, state);
    expect(questions["same_as[0]"]).toEqual({
      type: "noul",
      instructions: { question: "Is `candidates[0].title` the same as `filing.title`?", note: "`candidates[0]` is one candidate" },
    });
  });
  it("merges thresholds per question over the jevel's", () => {
    const { thresholds } = expandQuestions(jevel, state);
    expect(thresholds.worth_a_turn).toEqual({ act: 0.9, mark: 0.7 });
    expect(thresholds.depth).toEqual({ act: 0.7, mark: 0.7 });
  });
  it("expands to nothing over an empty array", () => {
    const { questions } = expandQuestions(jevel, { ...state, candidates: [] });
    expect(Object.keys(questions)).toEqual(["worth_a_turn", "depth"]);
  });
  it("refuses a repeat over a path that is not an array", () => {
    expect(() => expandQuestions(jevel, { ...state, candidates: "no" })).toThrowError(
      expect.objectContaining({ field: "questions.same_as.repeat.over" }) as unknown as Error,
    );
  });
});

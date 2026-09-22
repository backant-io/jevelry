import { describe, expect, it } from "vitest";
import {
  BYTES_PER_TOKEN,
  MODEL_STATE_PLUS_QUESTION_TOKENS,
  MODEL_TOTAL_TOKENS,
  checkBudgets,
  estimateTokens,
} from "../src/budget.js";

describe("estimateTokens", () => {
  it("is pessimistic: ceil(utf8 bytes / 3), strings measured raw", () => {
    expect(BYTES_PER_TOKEN).toBe(3);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
  it("measures structured values as their JSON", () => {
    expect(estimateTokens({ a: 1 })).toBe(Math.ceil(Buffer.byteLength('{"a":1}') / 3));
  });
  it("counts bytes, not characters", () => {
    expect(estimateTokens("ééé")).toBe(2);
  });
});

describe("checkBudgets", () => {
  const q = { a: { type: "noul", instructions: "x".repeat(30) } };
  it("passes a small request", () => {
    expect(checkBudgets("small", q)).toBeNull();
  });
  it("names the jevel ceiling first when the state alone is over it", () => {
    const breach = checkBudgets("x".repeat(300), q, 50);
    expect(breach).toEqual({ limit: "jevel", estimate: 100, ceiling: 50 });
  });
  it("names state_plus_question when the state and the longest question pass 32000", () => {
    const state = "x".repeat(MODEL_STATE_PLUS_QUESTION_TOKENS * 3);
    const breach = checkBudgets(state, q);
    expect(breach?.limit).toBe("state_plus_question");
    expect(breach?.ceiling).toBe(MODEL_STATE_PLUS_QUESTION_TOKENS);
    expect(breach?.estimate).toBeGreaterThan(MODEL_STATE_PLUS_QUESTION_TOKENS);
  });
  it("names total when the state fits but the sum of questions does not", () => {
    const state = "x".repeat(20_000 * 3);
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) many[`q${i}`] = { type: "noul", instructions: "y".repeat(10_000 * 3) };
    const breach = checkBudgets(state, many);
    expect(breach?.limit).toBe("total");
    expect(breach?.ceiling).toBe(MODEL_TOTAL_TOKENS);
  });
});

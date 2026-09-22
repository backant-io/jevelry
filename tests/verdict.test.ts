import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, certaintyOf, mergeThresholds, verdictOf } from "../src/verdict.js";

describe("certaintyOf", () => {
  it("is the confidence for choice and score", () => {
    expect(certaintyOf({ type: "choice", confidence: 0.81 })).toBe(0.81);
    expect(certaintyOf({ type: "score", confidence: 0.92 })).toBe(0.92);
  });
  it("is the distance from indifference for a noul, which has no confidence", () => {
    expect(certaintyOf({ type: "noul", noul: 0.95 })).toBeCloseTo(0.95);
    expect(certaintyOf({ type: "noul", noul: 0.08 })).toBeCloseTo(0.92);
    expect(certaintyOf({ type: "noul", noul: 0.5 })).toBeCloseTo(0.5);
  });
});

describe("verdictOf", () => {
  const t = { act: 0.9, mark: 0.7 };
  it("acts at or above act", () => {
    expect(verdictOf(0.9, t)).toBe("act");
    expect(verdictOf(0.97, t)).toBe("act");
  });
  it("marks between mark and act", () => {
    expect(verdictOf(0.7, t)).toBe("mark");
    expect(verdictOf(0.89, t)).toBe("mark");
  });
  it("falls back under mark", () => {
    expect(verdictOf(0.69, t)).toBe("fall_back");
    expect(verdictOf(0, t)).toBe("fall_back");
  });
});

describe("mergeThresholds", () => {
  it("starts from the runtime defaults", () => {
    expect(mergeThresholds()).toEqual(DEFAULT_THRESHOLDS);
    expect(DEFAULT_THRESHOLDS).toEqual({ act: 0.9, mark: 0.7 });
  });
  it("lets a later layer override one field and keeps the other", () => {
    expect(mergeThresholds({ act: 0.8 }, undefined, { mark: 0.5 })).toEqual({ act: 0.8, mark: 0.5 });
    expect(mergeThresholds({ act: 0.95, mark: 0.6 }, { act: 0.7 })).toEqual({ act: 0.7, mark: 0.6 });
  });
});

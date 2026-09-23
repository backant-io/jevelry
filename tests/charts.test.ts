import { describe, expect, it } from "vitest";
import { bar, histogram, mix, spark } from "../src/tui/charts.js";

describe("spark", () => {
  it("draws the highest value full and zero as the floor, one glyph per value", () => {
    expect(spark([0, 1, 2, 4, 8], 5)).toBe("▁▃▄▅█");
  });

  // An hour with one decision next to an hour with a hundred must still show that something happened.
  it("never draws a value above zero as the floor glyph", () => {
    expect(spark([1, 100], 2)).toBe("▂█");
  });

  it("is all floor when every value is zero, and empty for no values", () => {
    expect(spark([0, 0, 0], 3)).toBe("▁▁▁");
    expect(spark([], 5)).toBe("");
  });

  it("sums into buckets when there are more values than cells, so no decision is dropped", () => {
    expect(spark([1, 1, 0, 0, 5, 5], 3)).toBe("▃▁█");
  });
});

describe("bar", () => {
  it("fills whole cells and one eighth-block for the rest, padded to the width", () => {
    expect(bar(0.5, 10)).toBe("█████     ");
    expect(bar(0.91, 10)).toBe("█████████▏");
    expect(bar(0.0625, 2)).toBe("▏ ");
  });

  it("clamps outside 0 to 1", () => {
    expect(bar(-1, 4)).toBe("    ");
    expect(bar(3, 4)).toBe("████");
  });
});

describe("mix", () => {
  it("splits the width by share with a different glyph per decision, so it reads without colour", () => {
    expect(mix(6, 3, 1, 10)).toBe("██████▓▓▓░");
  });

  it("always sums to the width and keeps a cell for a small share", () => {
    const m = mix(98, 1, 1, 20);
    expect(m).toHaveLength(20);
    expect(m).toContain("▓");
    expect(m).toContain("░");
  });

  it("is empty when there are no decisions", () => {
    expect(mix(0, 0, 0, 12)).toBe("");
  });
});

describe("histogram", () => {
  it("counts certainties into columns and marks each threshold under its column", () => {
    const [top, marks] = histogram([0.05, 0.95, 0.95, 0.72], 10, [0.7, 0.9]).split("\n");
    expect(top).toBe("▅▁▁▁▁▁▁▅▁█");
    expect(marks).toBe("       │ │");
  });

  it("puts a certainty of exactly 1 in the last column", () => {
    expect(histogram([1], 4, []).split("\n")[0]).toBe("▁▁▁█");
  });
});

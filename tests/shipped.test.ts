import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as lib from "../src/index.js";

describe("shipped jevels", () => {
  it("every jevel under ./jevels loads with no warnings", () => {
    const shipped = lib.listJevels([join(process.cwd(), "jevels")]);
    expect(shipped.map((j) => j.name)).toEqual(["return-kind", "wake-gate"]);
    for (const { name } of shipped) {
      const { warnings } = lib.loadJevel(name, [join(process.cwd(), "jevels")]);
      expect(warnings, name).toEqual([]);
    }
  });
});

describe("library surface", () => {
  it("exports what a host needs in process", () => {
    for (const name of ["ask", "stateHash", "loadJevel", "expandQuestions", "verdictOf", "estimateTokens", "checkBudgets", "report", "readLog", "PROTOCOL", "EXIT"]) {
      expect(lib, name).toHaveProperty(name);
    }
  });
});

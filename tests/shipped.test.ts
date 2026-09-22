import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as lib from "../src/index.js";

const JEVELS = join(process.cwd(), "jevels");
const dirs = readdirSync(JEVELS).filter((name) => statSync(join(JEVELS, name)).isDirectory()).sort();
// The catalogue lists these, the live suite asks every one of them and the README points a reader
// at the list: a jevel dropped into the folder without a line here is one nobody wrote a state for.
const EXPECTED = [
  "alert-cause",
  "change-risk",
  "checklist-compliance",
  "duplicate-issue",
  "escalation-route",
  "issue-readiness",
  "log-triage",
  "meeting-notes",
  "message-triage",
  "notification-triage",
  "pr-description-check",
  "reply-check",
  "review-comment-kind",
  "review-quality",
  "task-difficulty",
  "ticket-triage",
];

describe("shipped jevels", () => {
  it("ships the sixteen the catalogue names, each with a JEVEL.md and an example.json", () => {
    expect(dirs).toEqual(EXPECTED);
    for (const name of dirs) {
      expect(existsSync(join(JEVELS, name, "JEVEL.md")), `${name}/JEVEL.md`).toBe(true);
      expect(existsSync(join(JEVELS, name, "example.json")), `${name}/example.json`).toBe(true);
    }
    expect(lib.listJevels([JEVELS]).map((j) => j.name)).toEqual(EXPECTED);
  });

  it("every jevel under ./jevels loads with no warnings", () => {
    for (const name of dirs) {
      const { warnings } = lib.loadJevel(name, [JEVELS]);
      expect(warnings, name).toEqual([]);
    }
  });

  it("every example.json is a state its own jevel accepts and asks at least one question about", () => {
    for (const name of dirs) {
      const { jevel } = lib.loadJevel(name, [JEVELS]);
      const state: unknown = JSON.parse(readFileSync(join(JEVELS, name, "example.json"), "utf8"));
      // checkState throws on a missing required key and expandQuestions throws on a `repeat` whose
      // array is missing, so an example that drifts from the frontmatter fails here, before the
      // live suite spends a call finding out.
      expect(() => lib.checkState(jevel, state), name).not.toThrow();
      const { questions } = lib.expandQuestions(jevel, state);
      expect(Object.keys(questions).length, name).toBeGreaterThan(0);
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

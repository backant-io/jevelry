import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as lib from "../src/index.js";
import { baseName, readCases } from "./helpers/withCases.js";

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
  "failing-test",
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
  it("ships the seventeen the catalogue names, each with a JEVEL.md and an example.json", () => {
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasWhat = (entry: unknown): boolean => isObject(entry) && typeof entry.what === "string" && entry.what !== "";

describe("cases.json", () => {
  it("is carried by every shipped jevel", () => {
    for (const name of dirs) expect(existsSync(join(JEVELS, name, "cases.json")), `${name}/cases.json`).toBe(true);
  });

  for (const name of dirs) {
    it(`${name}: every case is a state the jevel accepts, with expectations that fit its questions`, () => {
      const { jevel } = lib.loadJevel(name, [JEVELS]);
      const cases = readCases(name);
      expect(Array.isArray(cases), name).toBe(true);
      expect(cases.length, `${name} needs at least three cases`).toBeGreaterThanOrEqual(3);
      // Every expanded name that any case can ask, and the non-null values expected for each: a
      // question nobody expects an answer to, or one expected the same way every time, proves
      // nothing about the criteria, so both are counted here and asserted below.
      const names = new Set<string>();
      const nonNullCases = new Map<string, number>();
      const values = new Map<string, Set<string>>();
      let cases_with_a_null = 0;
      for (const c of cases) {
        expect(typeof c.name === "string" && c.name !== "", `${name}: a case has no name`).toBe(true);
        const where = `${name} case "${c.name}"`;
        expect(() => lib.checkState(jevel, c.state), where).not.toThrow();
        expect(JSON.stringify(c.state).length, `${where} state is too long for one screen`).toBeLessThan(1500);
        const { questions } = lib.expandQuestions(jevel, c.state);
        for (const q of Object.keys(questions)) names.add(q);
        expect(isObject(c.expect), `${where} has no expect object`).toBe(true);
        if (Object.values(c.expect).some((v) => v === null)) cases_with_a_null += 1;
        for (const [q, want] of Object.entries(c.expect)) {
          const question = questions[q] as { type: string; criteria?: unknown } | undefined;
          expect(question, `${where} expects \`${q}\`, which is not a question of ${name}`).toBeDefined();
          if (want === null) continue;
          nonNullCases.set(q, (nonNullCases.get(q) ?? 0) + 1);
          const base = baseName(q);
          values.set(base, (values.get(base) ?? new Set()).add(JSON.stringify(want)));
          if (question?.type === "choice") {
            expect(Object.keys(question.criteria as Record<string, unknown>), `${where}: \`${q}\` expects an option`).toContain(want);
          } else if (question?.type === "noul") {
            expect(typeof want, `${where}: \`${q}\` is a noul, so it expects true or false`).toBe("boolean");
          } else {
            const levels = (question?.criteria as unknown[]).length;
            expect(Number.isInteger(want) && (want as number) >= 0 && (want as number) < levels, `${where}: \`${q}\` expects a level index under ${levels}`).toBe(true);
          }
        }
      }
      for (const q of names) {
        expect(nonNullCases.get(q) ?? 0, `${name}: \`${q}\` is expected non-null in fewer than two cases`).toBeGreaterThanOrEqual(2);
        expect(values.get(baseName(q))?.size ?? 0, `${name}: \`${baseName(q)}\` is expected the same way in every case`).toBeGreaterThanOrEqual(2);
      }
      expect(cases_with_a_null, `${name}: no case is marked unclear with a null`).toBeGreaterThanOrEqual(1);
    });

    it(`${name}: every instruction and every criteria entry carries the fields Jev reads`, () => {
      const { jevel, warnings } = lib.loadJevel(name, [JEVELS]);
      expect(warnings, name).toEqual([]);
      for (const [id, q] of Object.entries(jevel.questions)) {
        const at = `${name}.questions.${id}`;
        const instructions = q.instructions as Record<string, unknown>;
        expect(isObject(instructions), `${at}.instructions must be an object`).toBe(true);
        expect(typeof instructions.question === "string" && instructions.question !== "", `${at}.instructions.question`).toBe(true);
        if (q.type === "choice") {
          for (const [option, entry] of Object.entries(q.criteria as Record<string, unknown>)) {
            expect(hasWhat(entry), `${at}.criteria.${option}.what`).toBe(true);
          }
        } else if (q.type === "score") {
          for (const [i, entry] of (q.criteria as unknown[]).entries()) expect(hasWhat(entry), `${at}.criteria[${i}].what`).toBe(true);
        } else {
          for (const side of ["true", "false"]) {
            expect(hasWhat((q.criteria as Record<string, unknown>)[side]), `${at}.criteria.${side}.what`).toBe(true);
          }
        }
      }
    });
  }
});

describe("library surface", () => {
  it("exports what a host needs in process", () => {
    for (const name of ["ask", "stateHash", "loadJevel", "expandQuestions", "decisionOf", "estimateTokens", "checkBudgets", "report", "readLog", "PROTOCOL", "EXIT"]) {
      expect(lib, name).toHaveProperty(name);
    }
  });
});

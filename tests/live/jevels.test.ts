import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { expandQuestions, loadJevel } from "../../src/jevel.js";
import { readCases } from "../helpers/withCases.js";

const key = process.env.TYPESAFE_API_KEY;
const haveKey = key !== undefined && key.trim() !== "";
if (!haveKey) process.stderr.write("jevelry live tests skipped: TYPESAFE_API_KEY is not set\n");
const live = haveKey ? describe : describe.skip;

const JEVELS = join(process.cwd(), "jevels");
const schema = JSON.parse(readFileSync("docs/protocol/ask.schema.json", "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
const home = mkdtempSync(join(tmpdir(), "jevelry-live-jevels-"));
const names = readdirSync(JEVELS).filter((name) => statSync(join(JEVELS, name)).isDirectory()).sort();

// The SDK reads TYPESAFE_LOG_LEVEL and this suite asserts an empty stderr: an operator who has it
// set in their shell would fail every ask on SDK log lines, so the child never inherits it.
const { TYPESAFE_LOG_LEVEL: _logLevel, ...parentEnv } = process.env;

const run = (args: string[]) =>
  spawnSync("node", ["bin/jevelry.js", ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...parentEnv, JEVELRY_HOME: home, JEVELRY_JEVELS: JEVELS },
  });

interface Answer {
  type: string;
  verdict: string;
  choice?: string;
  yes?: boolean;
  score?: number;
}

live("every shipped jevel answers its own example", () => {
  for (const name of names) {
    it(`answers ${name}`, () => {
      const r = run(["ask", name, "--state", `@${join("jevels", name, "example.json")}`]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout) as { answers: Record<string, Answer> };
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      // The example is the state the jevel's own `repeat` expands over, so the answer keys are the
      // expanded names: a question the API silently dropped, or one the example cannot expand,
      // shows up here as a missing key rather than as a quietly shorter document.
      const { jevel } = loadJevel(name, [JEVELS]);
      const state: unknown = JSON.parse(readFileSync(join(JEVELS, name, "example.json"), "utf8"));
      expect(Object.keys(doc.answers).sort()).toEqual(Object.keys(expandQuestions(jevel, state).questions).sort());
      for (const answer of Object.values(doc.answers)) expect(["act", "mark", "fall_back"]).toContain(answer.verdict);
    });
  }
});

// What the example.json test cannot tell you: whether the questions decide. One ask per case, and
// every answer is held to the value a person would give the same state, so a criteria rewrite that
// reads well and answers worse fails here rather than in somebody's queue.
live("every shipped jevel decides each of its cases", () => {
  for (const name of names) {
    for (const c of readCases(name)) {
      it(`${name}: ${c.name}`, () => {
        const r = run(["ask", name, "--state", JSON.stringify(c.state)]);
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        const doc = JSON.parse(r.stdout) as { answers: Record<string, Answer> };
        expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
        for (const [question, want] of Object.entries(c.expect)) {
          const answer = doc.answers[question];
          const where = `${name} case "${c.name}": ${question}`;
          expect(answer, where).toBeDefined();
          // A `null` says the case is one a colleague would ask a question back about, so the only
          // wrong answer is a confident one: the host has to fall back or flag it for a person.
          if (want === null) {
            expect(answer?.verdict, `${where} is meant to be unclear, so it must not reach act`).not.toBe("act");
            continue;
          }
          expect(answer?.verdict, `${where} is a clear case, so it must not fall back`).not.toBe("fall_back");
          if (typeof want === "string") expect(answer?.choice, where).toBe(want);
          else if (typeof want === "boolean") expect(answer?.yes, where).toBe(want);
          else expect(Math.round(answer?.score ?? Number.NaN), `${where} (score ${String(answer?.score)})`).toBe(want);
        }
      });
    }
  }
});

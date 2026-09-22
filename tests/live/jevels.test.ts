import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { expandQuestions, loadJevel } from "../../src/jevel.js";

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
      // Two jevels the README and the examples page quote by value: those two documents are the
      // ones a reader compares their own run against, so their answers are asserted, and every
      // other jevel is asserted on shape alone.
      if (name === "ticket-triage") {
        expect(doc.answers.team?.choice).toBe("billing");
        expect(doc.answers.urgent?.yes).toBe(true);
      }
      if (name === "duplicate-issue") {
        expect(doc.answers["same_as[0]"]?.yes).toBe(true);
        expect(doc.answers["same_as[1]"]?.yes).toBe(false);
      }
    });
  }
});

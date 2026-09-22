import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const key = process.env.TYPESAFE_API_KEY;
const haveKey = key !== undefined && key.trim() !== "";
if (!haveKey) process.stderr.write("jevelry live tests skipped: TYPESAFE_API_KEY is not set\n");
const live = haveKey ? describe : describe.skip;

const schema = JSON.parse(readFileSync("docs/protocol/ask.schema.json", "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
const home = mkdtempSync(join(tmpdir(), "jevelry-live-"));

// The SDK reads TYPESAFE_LOG_LEVEL and this suite asserts an empty stderr: an operator who has it
// set in their shell would fail the ask tests on SDK log lines, so the child never inherits it.
const { TYPESAFE_LOG_LEVEL: _logLevel, ...parentEnv } = process.env;

const run = (args: string[]) =>
  spawnSync("node", ["bin/jevelry.js", ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...parentEnv, JEVELRY_HOME: home, JEVELRY_JEVELS: join(process.cwd(), "jevels") },
  });

const REFERENCE_STATE = "Help! My payouts have been failing for 3 days.";

live("the real TypeSafe API", () => {
  it("lists the models the account may use", () => {
    const r = run(["models"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("jev-latest");
  });

  it("answers the reference noul in the documented shape", () => {
    const r = run(["ask", "--questions", JSON.stringify({ is_urgent: { type: "noul", instructions: "Does this convey urgency?", criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" } } }), "--state", JSON.stringify(REFERENCE_STATE)]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { model: string; answers: { is_urgent: { type: string; noul: number; yes: boolean } }; usage: { input_tokens: number } };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(doc.model).toMatch(/^jev-/);
    expect(doc.answers.is_urgent.type).toBe("noul");
    expect(doc.answers.is_urgent.noul).toBeGreaterThan(0.5);
    expect(doc.answers.is_urgent.yes).toBe(true);
    expect(doc.usage.input_tokens).toBeGreaterThan(0);
  });

  it("answers the shipped wake-gate jevel with all three answer types", () => {
    const state = {
      employee: { title: "COO", authority: ["read_readings", "set_model_policy"] },
      events: [{ kind: "task.submitted", actor: "implementer", subject: "task_1", summary: "the implementer handed in the readings task" }],
      filing: { title: "xAI credits are out again" },
      candidates: [{ title: "xAI credits out, 403 on every turn" }, { title: "the reaper reads a cause it cannot parse" }],
    };
    const r = run(["ask", "wake-gate", "--state", JSON.stringify(state)]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { answers: Record<string, { type: string; verdict: string; legend?: Record<string, unknown> }> };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(doc.answers)).toEqual(["worth_a_turn", "depth", "same_as[0]", "same_as[1]"]);
    expect(doc.answers.worth_a_turn?.type).toBe("noul");
    expect(doc.answers.depth?.type).toBe("score");
    expect(Object.keys(doc.answers.depth?.legend ?? {})).toEqual(["0", "1", "2"]);
    for (const answer of Object.values(doc.answers)) expect(["act", "mark", "fall_back"]).toContain(answer.verdict);
  });

  it("logged both asks and never the key", () => {
    const r = run(["report", "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ jevel: string; question: string; asks: number }>;
    expect(rows.some((row) => row.jevel === "wake-gate" && row.question === "worth_a_turn" && row.asks === 1)).toBe(true);
    expect(rows.some((row) => row.jevel === "(questions)" && row.question === "is_urgent")).toBe(true);
    const log = readFileSync(join(home, "log.jsonl"), "utf8");
    expect(log).not.toContain(key as string);
  });
});

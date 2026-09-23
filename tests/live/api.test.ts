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

  it("answers the shipped ticket-triage jevel with all three answer types", () => {
    const state = {
      ticket: {
        subject: "Charged twice",
        message: "I was charged twice for order A-104 and I need this fixed today, my accountant is waiting.",
        customer_since: "2024-03",
      },
    };
    const r = run(["ask", "ticket-triage", "--state", JSON.stringify(state)]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { answers: Record<string, { type: string; decision: string; choice?: string; yes?: boolean; legend?: Record<string, unknown> }> };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(doc.answers)).toEqual(["team", "urgent", "frustration"]);
    expect(doc.answers.team?.type).toBe("choice");
    expect(doc.answers.urgent?.type).toBe("noul");
    expect(doc.answers.frustration?.type).toBe("score");
    expect(doc.answers.team?.choice).toBe("billing");
    expect(doc.answers.urgent?.yes).toBe(true);
    expect(Object.keys(doc.answers.frustration?.legend ?? {})).toEqual(["0", "1", "2"]);
    for (const answer of Object.values(doc.answers)) expect(["act", "mark", "fall_back"]).toContain(answer.decision);
  });

  it("answers the shipped duplicate-issue jevel over its candidates", () => {
    const state = {
      issue: {
        title: "Export button does nothing on Safari",
        body: "Clicking Export on the reports page does nothing in Safari 17. Chrome works. Expected a CSV download.",
      },
      candidates: [
        { title: "Export fails in Safari 17", body: "The CSV export silently fails on Safari 17.2, works on Chrome." },
        { title: "Dark mode colours wrong on the settings page", body: "Labels are unreadable in dark mode." },
      ],
    };
    const r = run(["ask", "duplicate-issue", "--state", JSON.stringify(state)]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { answers: Record<string, { type: string; decision: string; yes?: boolean }> };
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(doc.answers)).toEqual(["same_as[0]", "same_as[1]", "actionable"]);
    expect(doc.answers["same_as[0]"]?.yes).toBe(true);
    expect(doc.answers["same_as[1]"]?.yes).toBe(false);
    expect(doc.answers.actionable?.yes).toBe(true);
    for (const answer of Object.values(doc.answers)) expect(["act", "mark", "fall_back"]).toContain(answer.decision);
  });

  it("logged every ask and never the key", () => {
    const r = run(["report", "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{ jevel: string; question: string; asks: number }>;
    expect(rows.some((row) => row.jevel === "ticket-triage" && row.question === "team" && row.asks === 1)).toBe(true);
    expect(rows.some((row) => row.jevel === "duplicate-issue" && row.question === "same_as" && row.asks === 2)).toBe(true);
    expect(rows.some((row) => row.jevel === "(questions)" && row.question === "is_urgent")).toBe(true);
    const log = readFileSync(join(home, "log.jsonl"), "utf8");
    expect(log).not.toContain(key as string);
  });
});

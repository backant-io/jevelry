import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jevel } from "../../src/decide.js";
import { readLog } from "../../src/log.js";

const key = process.env.TYPESAFE_API_KEY;
const haveKey = key !== undefined && key.trim() !== "";
if (!haveKey) process.stderr.write("jevelry live tests skipped: TYPESAFE_API_KEY is not set\n");
const live = haveKey ? describe : describe.skip;

live("jevel().decide() against the real API", () => {
  it("routes the ticket-triage example to billing with the default client", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-live-decide-"));
    const example: unknown = JSON.parse(readFileSync(join("jevels", "ticket-triage", "example.json"), "utf8"));
    const d = await jevel("ticket-triage", { home }).decide(example);
    expect(d.error).toBeNull();
    expect(d.team?.answer).toBe("billing");
    expect(["act", "mark", "fall_back"]).toContain(d.team?.decision);
    expect((await readLog(home)).map((l) => l.id)).toEqual([d.logId]);
  });
});

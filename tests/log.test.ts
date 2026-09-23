import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AskLine, appendLine, findAsk, jevelryHome, outcomeOf, readLog } from "../src/log.js";

const ask: AskLine = {
  kind: "ask",
  id: "11111111-1111-4111-8111-111111111111",
  at: "2026-09-22T10:00:00.000Z",
  jevel: { name: "wake-gate", version: 1 },
  model: "jev-1.13.0",
  state_hash: "sha256:" + "0".repeat(64),
  answers: {
    worth_a_turn: { type: "noul", noul: 0.08, yes: false, certainty: 0.92, decision: "act" },
    depth: { type: "score", score: 1.4, legend: { "0": "routine", "1": "judgment", "2": "hard" }, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 }, confidence: 0.4, certainty: 0.4, decision: "fall_back" },
    owner: { type: "choice", choice: "coo", probabilities: { coo: 0.9, cto: 0.1 }, confidence: 0.88, certainty: 0.88, decision: "mark" },
  },
  usage: { input_tokens: 10, output_tokens: 2 },
  cwd: "/w",
};

describe("jevelryHome", () => {
  it("prefers JEVELRY_HOME, else ~/.jevelry", () => {
    expect(jevelryHome({ JEVELRY_HOME: "/x" }, "/home/u")).toBe("/x");
    expect(jevelryHome({}, "/home/u")).toBe("/home/u/.jevelry");
  });
});

describe("append and read", () => {
  it("round-trips lines and creates the directory", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "jevelry-")), "nested", "home");
    await appendLine(home, ask);
    await appendLine(home, { kind: "outcome", id: ask.id, question: "worth_a_turn", outcome: "agree", value: null, note: null, at: "2026-09-22T10:07:00.000Z" });
    expect(readFileSync(join(home, "log.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    const lines = await readLog(home);
    expect(lines.map((l) => l.kind)).toEqual(["ask", "outcome"]);
    expect(findAsk(lines, ask.id)?.model).toBe("jev-1.13.0");
  });
  it("reads an empty list when there is no log yet and skips a broken line", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-"));
    expect(await readLog(home)).toEqual([]);
    writeFileSync(join(home, "log.jsonl"), `${JSON.stringify(ask)}\nnot json\n`);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await readLog(home)).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("jevelry: skipped line 2 of log.jsonl: not JSON\n");
    } finally {
      write.mockRestore();
    }
  });
  it("hands skipped lines to the caller's callback instead of stderr, so a TUI can count them", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-"));
    writeFileSync(join(home, "log.jsonl"), `${JSON.stringify(ask)}\nnot json\nnull\n`);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const skipped: string[] = [];
    try {
      expect(await readLog(home, (m) => skipped.push(m))).toHaveLength(1);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(skipped).toEqual(["skipped line 2 of log.jsonl: not JSON", "skipped line 3 of log.jsonl: not a log line"]);
  });
  it("skips a JSON line that is not an object, so findAsk cannot crash on it", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-"));
    writeFileSync(join(home, "log.jsonl"), `${JSON.stringify(ask)}\nnull\n`);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const lines = await readLog(home);
      expect(lines).toHaveLength(1);
      expect(findAsk(lines, ask.id)?.model).toBe("jev-1.13.0");
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("jevelry: skipped line 2 of log.jsonl: not a log line\n");
    } finally {
      write.mockRestore();
    }
  });
});

describe("outcomeOf", () => {
  it("takes agree and disagree verbatim", () => {
    expect(outcomeOf(ask, "depth", "agree")).toEqual({ outcome: "agree", value: null });
    expect(outcomeOf(ask, "depth", "disagree")).toEqual({ outcome: "disagree", value: null });
  });
  it("compares a noul to yes/no", () => {
    expect(outcomeOf(ask, "worth_a_turn", "no")).toEqual({ outcome: "agree", value: "no" });
    expect(outcomeOf(ask, "worth_a_turn", "yes")).toEqual({ outcome: "disagree", value: "yes" });
  });
  it("compares a choice to its option", () => {
    expect(outcomeOf(ask, "owner", "coo")).toEqual({ outcome: "agree", value: "coo" });
    expect(outcomeOf(ask, "owner", "cto")).toEqual({ outcome: "disagree", value: "cto" });
  });
  it("compares a score to the nearest level", () => {
    expect(outcomeOf(ask, "depth", "1")).toEqual({ outcome: "agree", value: "1" });
    expect(outcomeOf(ask, "depth", "2")).toEqual({ outcome: "disagree", value: "2" });
  });
  it("refuses a value that names nothing, and an unknown question", () => {
    expect(() => outcomeOf(ask, "owner", "ceo")).toThrow(/names no option/);
    expect(() => outcomeOf(ask, "depth", "9")).toThrow(/level/);
    expect(() => outcomeOf(ask, "nope", "agree")).toThrow(/no question named nope/);
  });
});

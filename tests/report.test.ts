import { describe, expect, it } from "vitest";
import type { AskLine, LogLine } from "../src/log.js";
import { renderReport, renderSpeed, report, speed } from "../src/report.js";

const askLine = (id: string, at: string, decision: "act" | "mark" | "fall_back", certainty: number, name = "wake-gate"): AskLine => ({
  kind: "ask",
  id,
  at,
  jevel: { name, version: 1 },
  model: "jev-1.13.0",
  state_hash: "sha256:" + "0".repeat(64),
  answers: {
    worth_a_turn: { type: "noul", noul: 1 - certainty, yes: false, certainty, decision },
    "same_as[0]": { type: "noul", noul: 0.9, yes: true, certainty: 0.9, decision: "act" },
  },
  usage: { input_tokens: 1, output_tokens: 1 },
  cwd: "/w",
});

const lines: LogLine[] = [
  askLine("a", "2026-09-22T10:00:00.000Z", "act", 0.95),
  askLine("b", "2026-09-22T11:00:00.000Z", "act", 0.91),
  askLine("c", "2026-09-22T12:00:00.000Z", "mark", 0.75),
  askLine("d", "2026-09-21T12:00:00.000Z", "fall_back", 0.55, "return-kind"),
  { kind: "outcome", id: "a", question: "worth_a_turn", outcome: "agree", value: null, note: null, at: "2026-09-22T10:05:00.000Z" },
  { kind: "outcome", id: "b", question: "worth_a_turn", outcome: "disagree", value: null, note: null, at: "2026-09-22T11:05:00.000Z" },
  { kind: "outcome", id: "c", question: "worth_a_turn", outcome: "agree", value: null, note: null, at: "2026-09-22T12:05:00.000Z" },
];

describe("report", () => {
  it("folds asks and outcomes per jevel and question, repeat answers under their question", () => {
    const rows = report(lines);
    expect(rows.map((r) => [r.jevel, r.question])).toEqual([
      ["return-kind", "same_as"],
      ["return-kind", "worth_a_turn"],
      ["wake-gate", "same_as"],
      ["wake-gate", "worth_a_turn"],
    ]);
    const w = rows.find((r) => r.jevel === "wake-gate" && r.question === "worth_a_turn");
    expect(w).toEqual({
      jevel: "wake-gate",
      question: "worth_a_turn",
      asks: 3,
      decisions: { act: 2, mark: 1, fall_back: 0 },
      outcomes: 3,
      agreement_act: 0.5,
      agreement_mark: 1,
      mean_certainty: (0.95 + 0.91 + 0.75) / 3,
      // Sure 87% of the time over the three reviewed answers, right in two of them.
      overconfidence: expect.closeTo(0.87 - 2 / 3, 6),
    });
    const s = rows.find((r) => r.jevel === "wake-gate" && r.question === "same_as");
    expect(s?.asks).toBe(3);
    expect(s?.agreement_act).toBeNull();
  });
  it("filters by jevel and since", () => {
    expect(report(lines, { jevel: "return-kind" }).every((r) => r.jevel === "return-kind")).toBe(true);
    const recent = report(lines, { since: "2026-09-22T10:30:00.000Z" });
    expect(recent.find((r) => r.jevel === "wake-gate" && r.question === "worth_a_turn")?.asks).toBe(2);
    expect(recent.some((r) => r.jevel === "return-kind")).toBe(false);
  });
  it("still counts log lines written before protocol 2, which carry the old field name", () => {
    const old = askLine("e", "2026-09-23T10:00:00.000Z", "mark", 0.8);
    const { decision, ...rest } = old.answers.worth_a_turn as { decision: string };
    old.answers = { worth_a_turn: { ...rest, verdict: decision } as unknown as AskLine["answers"][string] };
    expect(report([old])[0]?.decisions).toEqual({ act: 0, mark: 1, fall_back: 0 });
  });
  // Agreement alone does not say whether a threshold can be trusted: a model that is 90% sure and 70% right
  // acts on answers it should have marked. The gap is that, in points, over the answers a person reviewed.
  it("says by how many points the model's certainty ran ahead of how often it was right, and nothing without outcomes", () => {
    const rows = report(lines);
    expect(rows.find((r) => r.jevel === "wake-gate" && r.question === "same_as")?.overconfidence).toBeNull();
    const text = renderReport(rows);
    expect(text.split("\n")[0]).toMatch(/certainty\s+overconfident$/);
    expect(text.split("\n").find((l) => l.includes("worth_a_turn") && l.includes("wake-gate"))).toMatch(/0\.87\s+\+20 pts$/);
    expect(text.split("\n").find((l) => l.includes("same_as") && l.includes("wake-gate"))).toMatch(/\s-$/);
  });
  it("renders a table and a sentence for an empty log", () => {
    const text = renderReport(report(lines));
    expect(text.split("\n")[0]).toMatch(/jevel\s+question\s+asks\s+act\s+mark\s+fall_back\s+outcomes\s+agree\(act\)\s+agree\(mark\)\s+certainty/);
    expect(text).toContain("wake-gate");
    expect(renderReport([])).toBe("no asks in the log\n");
  });
});

describe("speed", () => {
  const timed = (id: string, ms: number | undefined, model = "local/a.gguf", at = "2026-09-22T10:00:00.000Z", name = "wake-gate"): AskLine => ({
    ...askLine(id, at, "act", 0.95, name),
    model,
    usage: { input_tokens: 500, output_tokens: 1 },
    ...(ms === undefined ? {} : { ms }),
  });
  // A hosted and a local model answer at different speeds: one row for both would describe neither.
  it("gives the median, the 95th percentile and tokens per second for each jevel and model", () => {
    const rows = speed([timed("a", 100), timed("b", 300), timed("c", 200), timed("d", 2000, "jev-1.13.0")]);
    expect(rows).toEqual([
      { jevel: "wake-gate", model: "jev-1.13.0", asks: 1, p50_ms: 2000, p95_ms: 2000, tokens_per_s: 250, cold_asks: 0, cold_p50_ms: null },
      { jevel: "wake-gate", model: "local/a.gguf", asks: 3, p50_ms: 200, p95_ms: 300, tokens_per_s: 2500, cold_asks: 0, cold_p50_ms: null },
    ]);
  });
  // The median says what an ask usually costs; the 95th percentile is where a model that had to load shows up.
  it("keeps the median steady and shows slow asks in the 95th percentile once more than one in twenty is slow", () => {
    const rows = speed([...Array.from({ length: 19 }, (_, i) => timed(`f${i}`, 100)), timed("slow", 9000)]);
    expect(rows[0]).toMatchObject({ asks: 20, p50_ms: 100, p95_ms: 100 });
    expect(speed([...Array.from({ length: 18 }, (_, i) => timed(`f${i}`, 100)), timed("s1", 9000), timed("s2", 9000)])[0]?.p95_ms).toBe(9000);
  });
  // A log written before durations were kept, and an ask Jev never answered, have no time to report: counted as instant they would flatter the median.
  it("leaves out asks without a duration and asks that got no answer", () => {
    const failed: AskLine = { ...timed("x", 50), model: null, usage: null };
    expect(speed([timed("old", undefined), failed])).toEqual([]);
    expect(speed([timed("old", undefined), timed("new", 400)])[0]).toMatchObject({ asks: 1, p50_ms: 400 });
  });
  it("takes the jevel and since filters of report", () => {
    const all = [timed("a", 100), timed("b", 100, "local/a.gguf", "2026-09-20T10:00:00.000Z"), timed("c", 100, "local/a.gguf", "2026-09-22T10:00:00.000Z", "return-kind")];
    expect(speed(all, { jevel: "wake-gate", since: "2026-09-21T00:00:00.000Z" })).toEqual([
      { jevel: "wake-gate", model: "local/a.gguf", asks: 1, p50_ms: 100, p95_ms: 100, tokens_per_s: 5000, cold_asks: 0, cold_p50_ms: null },
    ]);
  });
  // A model that had to load answers seconds late: in the warm percentiles it would hide what an ask usually costs.
  it("counts the asks that waited for the model to load apart from the warm ones", () => {
    const rows = speed([timed("a", 100), timed("b", 300), { ...timed("c", 9000), cold: true }, { ...timed("d", 7000), cold: true }]);
    expect(rows).toEqual([{ jevel: "wake-gate", model: "local/a.gguf", asks: 2, p50_ms: 100, p95_ms: 300, tokens_per_s: 2500, cold_asks: 2, cold_p50_ms: 7000 }]);
    // Only cold asks so far: there is no warm number to give, and none is made up.
    expect(speed([{ ...timed("c", 9000), cold: true }])).toEqual([{ jevel: "wake-gate", model: "local/a.gguf", asks: 0, p50_ms: null, p95_ms: null, tokens_per_s: null, cold_asks: 1, cold_p50_ms: 9000 }]);
    expect(renderSpeed(rows).split("\n")[0]).toMatch(/tokens\/s\s+cold\s+cold p50 ms$/);
    expect(renderSpeed(rows).split("\n")[1]).toMatch(/2500\s+2\s+7000$/);
  });
  it("renders a table and a sentence for a log without durations", () => {
    const text = renderSpeed(speed([timed("a", 123.4)]));
    expect(text.split("\n")[0]).toMatch(/jevel\s+model\s+asks\s+p50 ms\s+p95 ms\s+tokens\/s\s+cold\s+cold p50 ms/);
    expect(text.split("\n")[1]).toMatch(/wake-gate\s+local\/a\.gguf\s+1\s+123\s+123\s+4052\s+0\s+-/);
    expect(renderSpeed([])).toBe("no timed asks in the log\n");
  });
});

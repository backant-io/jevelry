import { readFileSync } from "node:fs";
import { type AskResult, isRecord } from "./ask.js";
import { JevelError } from "./jevel.js";
import type { Answer, Decision, ErrorBody } from "./protocol.js";
import { baseName, percentile, tableOf } from "./report.js";

/** What a person would answer: an option, yes or no, a level, or `null` for a case a colleague would ask a question back about. */
export type Expected = string | boolean | number | null;

/** One realistic state, and the answer a person would give to each question, by its answer name. */
export interface Case {
  name: string;
  state: unknown;
  expect: Record<string, Expected>;
}

/** The `cases.json` next to a JEVEL.md. A file that is not what the method describes is refused with the reason, never half read. */
export function readCases(path: string): Case[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new JevelError("cases", `no cases.json at ${path}; a jevel is proven by its cases, so write them first`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JevelError("cases", `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new JevelError("cases", `${path} must be a JSON array of cases`);
  if (parsed.length === 0) throw new JevelError("cases", `${path} holds no cases`);
  parsed.forEach((c: unknown, i) => {
    if (!isRecord(c) || typeof c.name !== "string" || !("state" in c)) throw new JevelError("cases", `case ${i + 1} of ${path} needs a name and a state`);
    if (!isRecord(c.expect)) throw new JevelError("cases", `case "${c.name}" needs an expect object`);
    for (const [question, want] of Object.entries(c.expect)) {
      if (want !== null && !["string", "boolean", "number"].includes(typeof want)) {
        throw new JevelError("cases", `case "${c.name}" expects ${question} as something other than an option, true or false, a level or null`);
      }
    }
  });
  return parsed as Case[];
}

/** What the answer says, in the form an expectation is written in: the option, yes or no, or the nearest level. */
const gotOf = (answer: Answer): string | boolean | number => (answer.type === "choice" ? answer.choice : answer.type === "noul" ? answer.yes : Math.round(answer.score));

/**
 * Whether an answer is the expected one, by the rules of the live suite. A clear case needs its value
 * and a decision that is not fall_back; an unclear one (`null`) has a single wrong answer, a confident
 * one. An expectation of another kind than the question is a mistake in cases.json, not a wrong answer.
 */
export function judge(want: Expected, answer: Answer): boolean {
  if (want === null) return answer.decision !== "act";
  const kind = typeof want === "string" ? "choice" : typeof want === "boolean" ? "noul" : "score";
  if (answer.type !== kind) throw new JevelError("cases", `${JSON.stringify(want)} is expected of a ${answer.type} question, which never answers a ${kind}`);
  return answer.decision !== "fall_back" && gotOf(answer) === want;
}

/**
 * Wilson's 95% interval for `right` of `n`. Shipped jevels have three to six cases, and four right of
 * four still allows an accuracy near one half: the interval is what keeps a short eval from reading as proof.
 */
export function wilson(right: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z2 = 1.96 ** 2;
  const p = right / n;
  const centre = p + z2 / (2 * n);
  const spread = 1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const scale = 1 + z2 / n;
  return [Math.max(0, (centre - spread) / scale), Math.min(1, (centre + spread) / scale)];
}

export interface Check {
  question: string;
  want: Expected;
  got: string | boolean | number;
  decision: Decision;
  right: boolean;
}

export interface QuestionEval {
  question: string;
  checks: number;
  right: number;
  accuracy: number;
  /** Wilson's 95% interval around `accuracy`. */
  interval: [number, number];
  /** The checks that expect a value, and how many of those were decided at `act`. */
  clear: number;
  act: number;
  /** Not the expected answer, and confident: the kind a host would have acted on. */
  wrong_at_act: number;
}

export interface Evaluation {
  jevel: { name: string; version: number } | null;
  model: string | null;
  cases: Array<{ name: string; ms: number; checks: Check[] }>;
  questions: QuestionEval[];
  checks: number;
  right: number;
  p50_ms: number | null;
}

export type EvalResult = { ok: true; evaluation: Evaluation } | { ok: false; case: string; error: ErrorBody };

/**
 * Asks every case and holds each answer to its expectation. A case Jev could not answer ends the eval
 * with that case named: half an eval reads like a result. A repeated question counts under its own name.
 */
export async function evaluate(cases: Case[], askCase: (state: unknown) => Promise<AskResult>): Promise<EvalResult> {
  const evaluated: Evaluation["cases"] = [];
  let jevel: Evaluation["jevel"] = null;
  let model: string | null = null;
  // ponytail: one case at a time, because a local model server answers one request at a time; ask hosted cases together if an eval ever takes minutes.
  for (const c of cases) {
    const result = await askCase(c.state);
    if (!result.ok) return { ok: false, case: c.name, error: result.error };
    ({ jevel, model } = result.document);
    const { answers } = result.document;
    const checks = Object.entries(c.expect).map(([question, want]): Check => {
      const answer = Object.hasOwn(answers, question) ? answers[question] : undefined;
      if (!answer) throw new JevelError("cases", `case "${c.name}" expects ${question}, which the jevel did not answer for that state`);
      try {
        return { question, want, got: gotOf(answer), decision: answer.decision, right: judge(want, answer) };
      } catch (error) {
        throw new JevelError("cases", `case "${c.name}", ${question}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    evaluated.push({ name: c.name, ms: result.ms, checks });
  }
  const tallies = new Map<string, Omit<QuestionEval, "accuracy" | "interval">>();
  for (const check of evaluated.flatMap((c) => c.checks)) {
    const question = baseName(check.question);
    let t = tallies.get(question);
    if (!t) {
      t = { question, checks: 0, right: 0, clear: 0, act: 0, wrong_at_act: 0 };
      tallies.set(question, t);
    }
    t.checks += 1;
    if (check.right) t.right += 1;
    if (check.want !== null) t.clear += 1;
    if (check.want !== null && check.decision === "act") t.act += 1;
    if (!check.right && check.decision === "act") t.wrong_at_act += 1;
  }
  const questions = [...tallies.values()].map((t) => ({ ...t, accuracy: t.right / t.checks, interval: wilson(t.right, t.checks) })).sort((a, b) => a.question.localeCompare(b.question));
  const sum = (key: "checks" | "right"): number => questions.reduce((total, q) => total + q[key], 0);
  const ms = evaluated.map((c) => c.ms).sort((a, b) => a - b);
  return { ok: true, evaluation: { jevel, model, cases: evaluated, questions, checks: sum("checks"), right: sum("right"), p50_ms: ms.length === 0 ? null : percentile(ms, 50) } };
}

const COLUMNS = ["question", "checks", "right", "accuracy (95%)", "act", "wrong at act"];

export function renderEval(e: Evaluation): string {
  const pct = (n: number): string => String(Math.round(n * 100));
  const table = e.questions.map((q) => [q.question, String(q.checks), String(q.right), `${pct(q.accuracy)}% (${pct(q.interval[0])}-${pct(q.interval[1])}%)`, `${q.act}/${q.clear}`, String(q.wrong_at_act)]);
  const summary = `${e.cases.length} cases, ${e.checks} checks, ${e.right} right against ${String(e.model)}; median ${e.p50_ms === null ? "-" : Math.round(e.p50_ms)} ms per case`;
  const wrong = e.cases.flatMap((c) =>
    c.checks.filter((k) => !k.right).map((k) => `wrong: "${c.name}": ${k.question} expected ${k.want === null ? "no confident answer" : String(k.want)}, got ${String(k.got)} at ${k.decision}`),
  );
  return `${[tableOf(COLUMNS, table), summary, ...wrong].join("\n")}\n`;
}

import type { AskLine, LogLine } from "./log.js";
import type { Answer, Decision, FallBackAnswer } from "./protocol.js";

export interface QuestionReport {
  jevel: string;
  question: string;
  asks: number;
  decisions: { act: number; mark: number; fall_back: number };
  outcomes: number;
  agreement_act: number | null;
  agreement_mark: number | null;
  mean_certainty: number;
}

const NO_JEVEL = "(questions)";
/** Log lines written before protocol 2 carry `verdict` where newer ones carry `decision`; the log on disk holds both. */
export const recordedDecision = (answer: Answer | FallBackAnswer): Decision => (answer.decision ?? (answer as { verdict?: Decision }).verdict) as Decision;
/** `same_as[3]` reports under `same_as`. */
export const baseName = (name: string): string => name.replace(/\[\d+\]$/, "");

interface Tally {
  asks: number;
  decisions: { act: number; mark: number; fall_back: number };
  certaintySum: number;
  outcomes: number;
  agreeBy: { act: number; mark: number };
  outcomesBy: { act: number; mark: number };
}

type Filter = { jevel?: string; since?: string };

/** The asks a report is about, `--jevel` and `--since`: one reading for the agreement table and the speed table. */
const wanted = (line: LogLine, filter: Filter): line is AskLine =>
  line.kind === "ask" && (filter.jevel === undefined || (line.jevel?.name ?? NO_JEVEL) === filter.jevel) && (filter.since === undefined || line.at >= filter.since);

export function report(lines: LogLine[], filter: Filter = {}): QuestionReport[] {
  const asks = new Map<string, AskLine>();
  for (const line of lines) {
    if (wanted(line, filter)) asks.set(line.id, line);
  }
  const tallies = new Map<string, Tally>();
  const tallyFor = (jevel: string, question: string): Tally => {
    const key = `${jevel}\n${question}`;
    let t = tallies.get(key);
    if (!t) {
      t = { asks: 0, decisions: { act: 0, mark: 0, fall_back: 0 }, certaintySum: 0, outcomes: 0, agreeBy: { act: 0, mark: 0 }, outcomesBy: { act: 0, mark: 0 } };
      tallies.set(key, t);
    }
    return t;
  };
  for (const ask of asks.values()) {
    const jevel = ask.jevel?.name ?? NO_JEVEL;
    for (const [name, answer] of Object.entries(ask.answers)) {
      const t = tallyFor(jevel, baseName(name));
      t.asks += 1;
      t.decisions[recordedDecision(answer)] += 1;
      t.certaintySum += answer.certainty;
    }
  }
  for (const line of lines) {
    if (line.kind !== "outcome") continue;
    const ask = asks.get(line.id);
    const answer = ask?.answers[line.question];
    if (!ask || !answer) continue;
    const t = tallyFor(ask.jevel?.name ?? NO_JEVEL, baseName(line.question));
    t.outcomes += 1;
    const band = recordedDecision(answer);
    if (band === "act" || band === "mark") {
      t.outcomesBy[band] += 1;
      if (line.outcome === "agree") t.agreeBy[band] += 1;
    }
  }
  const rows: QuestionReport[] = [];
  for (const [key, t] of tallies) {
    const [jevel, question] = key.split("\n") as [string, string];
    rows.push({
      jevel,
      question,
      asks: t.asks,
      decisions: { ...t.decisions },
      outcomes: t.outcomes,
      agreement_act: t.outcomesBy.act === 0 ? null : t.agreeBy.act / t.outcomesBy.act,
      agreement_mark: t.outcomesBy.mark === 0 ? null : t.agreeBy.mark / t.outcomesBy.mark,
      mean_certainty: t.asks === 0 ? 0 : t.certaintySum / t.asks,
    });
  }
  return rows.sort((a, b) => a.jevel.localeCompare(b.jevel) || a.question.localeCompare(b.question));
}

const COLUMNS = ["jevel", "question", "asks", "act", "mark", "fall_back", "outcomes", "agree(act)", "agree(mark)", "certainty"];
const pct = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);

export function renderReport(rows: QuestionReport[]): string {
  if (rows.length === 0) return "no asks in the log\n";
  const table = rows.map((r) => [
    r.jevel,
    r.question,
    String(r.asks),
    String(r.decisions.act),
    String(r.decisions.mark),
    String(r.decisions.fall_back),
    String(r.outcomes),
    pct(r.agreement_act),
    pct(r.agreement_mark),
    r.mean_certainty.toFixed(2),
  ]);
  return tableOf(COLUMNS, table);
}

export function tableOf(columns: string[], table: string[][]): string {
  const widths = columns.map((c, i) => Math.max(c.length, ...table.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(columns), ...table.map(line)].join("\n") + "\n";
}

export interface SpeedReport {
  jevel: string;
  model: string;
  /** The answered asks that carry a duration. */
  asks: number;
  p50_ms: number;
  p95_ms: number;
  /** Input tokens per second of waiting, the whole round trip; null when the asks took no measurable time. */
  tokens_per_s: number | null;
}

/** Nearest rank: the smallest duration that `percent` of them do not exceed, so it is always one that was measured. */
export const percentile = (sorted: number[], percent: number): number => sorted[Math.max(Math.ceil((percent * sorted.length) / 100), 1) - 1] as number;

/**
 * How long answered asks took, per jevel and model: a hosted and a local model answer at different
 * speeds, and one row for both would describe neither. A line without `ms` was written before
 * durations were kept, or is an ask Jev never answered; counted as instant it would flatter the median.
 */
export function speed(lines: LogLine[], filter: Filter = {}): SpeedReport[] {
  // ponytail: a local ask that waited for its model to load sits in the same percentiles as a warm one; split them once the log can tell the two apart.
  const groups = new Map<string, { ms: number[]; tokens: number }>();
  for (const line of lines) {
    if (!wanted(line, filter) || typeof line.ms !== "number" || line.model === null) continue;
    const key = `${line.jevel?.name ?? NO_JEVEL}\n${line.model}`;
    let group = groups.get(key);
    if (!group) {
      group = { ms: [], tokens: 0 };
      groups.set(key, group);
    }
    group.ms.push(line.ms);
    group.tokens += line.usage?.input_tokens ?? 0;
  }
  const rows: SpeedReport[] = [];
  for (const [key, group] of groups) {
    const [jevel, model] = key.split("\n") as [string, string];
    const sorted = group.ms.sort((a, b) => a - b);
    const total = sorted.reduce((sum, n) => sum + n, 0);
    rows.push({ jevel, model, asks: sorted.length, p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95), tokens_per_s: total > 0 ? (group.tokens * 1000) / total : null });
  }
  return rows.sort((a, b) => a.jevel.localeCompare(b.jevel) || a.model.localeCompare(b.model));
}

const SPEED_COLUMNS = ["jevel", "model", "asks", "p50 ms", "p95 ms", "tokens/s"];

export function renderSpeed(rows: SpeedReport[]): string {
  if (rows.length === 0) return "no timed asks in the log\n";
  const whole = (n: number | null): string => (n === null ? "-" : String(Math.round(n)));
  return tableOf(SPEED_COLUMNS, rows.map((r) => [r.jevel, r.model, String(r.asks), whole(r.p50_ms), whole(r.p95_ms), whole(r.tokens_per_s)]));
}

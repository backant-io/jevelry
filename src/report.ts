import type { AskLine, LogLine } from "./log.js";
import type { Verdict } from "./protocol.js";

export interface QuestionReport {
  jevel: string;
  question: string;
  asks: number;
  verdicts: { act: number; mark: number; fall_back: number };
  outcomes: number;
  agreement_act: number | null;
  agreement_mark: number | null;
  mean_certainty: number;
}

const NO_JEVEL = "(questions)";
/** `same_as[3]` reports under `same_as`. */
const baseName = (name: string): string => name.replace(/\[\d+\]$/, "");

interface Tally {
  asks: number;
  verdicts: { act: number; mark: number; fall_back: number };
  certaintySum: number;
  outcomes: number;
  agreeBy: { act: number; mark: number };
  outcomesBy: { act: number; mark: number };
}

export function report(lines: LogLine[], filter: { jevel?: string; since?: string } = {}): QuestionReport[] {
  const asks = new Map<string, AskLine>();
  for (const line of lines) {
    if (line.kind !== "ask") continue;
    const name = line.jevel?.name ?? NO_JEVEL;
    if (filter.jevel !== undefined && name !== filter.jevel) continue;
    if (filter.since !== undefined && line.at < filter.since) continue;
    asks.set(line.id, line);
  }
  const tallies = new Map<string, Tally>();
  const tallyFor = (jevel: string, question: string): Tally => {
    const key = `${jevel}\n${question}`;
    let t = tallies.get(key);
    if (!t) {
      t = { asks: 0, verdicts: { act: 0, mark: 0, fall_back: 0 }, certaintySum: 0, outcomes: 0, agreeBy: { act: 0, mark: 0 }, outcomesBy: { act: 0, mark: 0 } };
      tallies.set(key, t);
    }
    return t;
  };
  for (const ask of asks.values()) {
    const jevel = ask.jevel?.name ?? NO_JEVEL;
    for (const [name, answer] of Object.entries(ask.answers)) {
      const t = tallyFor(jevel, baseName(name));
      t.asks += 1;
      t.verdicts[answer.verdict] += 1;
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
    const band: Verdict = answer.verdict;
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
      verdicts: { ...t.verdicts },
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
    String(r.verdicts.act),
    String(r.verdicts.mark),
    String(r.verdicts.fall_back),
    String(r.outcomes),
    pct(r.agreement_act),
    pct(r.agreement_mark),
    r.mean_certainty.toFixed(2),
  ]);
  const widths = COLUMNS.map((c, i) => Math.max(c.length, ...table.map((row) => row[i]?.length ?? 0)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(COLUMNS), ...table.map(line)].join("\n") + "\n";
}

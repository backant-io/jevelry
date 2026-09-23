import type { AskLine, LogLine } from "../log.js";
import { recordedDecision } from "../report.js";

/** One question of one jevel, as the log has seen it. */
export interface Tally {
  jevel: string;
  question: string;
  act: number;
  mark: number;
  fallBack: number;
  /** Act decisions with an outcome, and how many of those were right. */
  actReviewed: number;
  actRight: number;
  markReviewed: number;
  markRight: number;
  /** The certainty of every answered decision, for the histogram. */
  certainties: number[];
  /** Act and mark decisions with an outcome: their certainty and whether the latest outcome said Jev was right. */
  reviewed: Array<{ certainty: number; right: boolean }>;
}

const NO_JEVEL = "(questions)";
export const tallyKey = (jevel: string, question: string): string => `${jevel}\n${question}`;

/** Per jevel and question (a `repeat` question under its base name): the mix, how often act and mark were right, and the certainties. */
export function tallies(lines: LogLine[]): Map<string, Tally> {
  const last = new Map<string, "agree" | "disagree">();
  for (const l of lines) if (l.kind === "outcome") last.set(`${l.id}\n${l.question}`, l.outcome);
  const out = new Map<string, Tally>();
  for (const ask of lines.filter((l): l is AskLine => l.kind === "ask")) {
    const jevel = ask.jevel?.name ?? NO_JEVEL;
    for (const [name, answer] of Object.entries(ask.answers)) {
      const question = name.replace(/\[\d+\]$/, "");
      const key = tallyKey(jevel, question);
      const t = out.get(key) ?? { jevel, question, act: 0, mark: 0, fallBack: 0, actReviewed: 0, actRight: 0, markReviewed: 0, markRight: 0, certainties: [], reviewed: [] };
      out.set(key, t);
      const d = recordedDecision(answer);
      if (d === "act") t.act += 1;
      else if (d === "mark") t.mark += 1;
      else t.fallBack += 1;
      if (ask.error) continue;
      t.certainties.push(answer.certainty);
      const outcome = last.get(`${ask.id}\n${name}`);
      if (outcome === undefined || d === "fall_back") continue;
      const right = outcome === "agree";
      t.reviewed.push({ certainty: answer.certainty, right });
      if (d === "act") { t.actReviewed += 1; if (right) t.actRight += 1; }
      else { t.markReviewed += 1; if (right) t.markRight += 1; }
    }
  }
  return out;
}

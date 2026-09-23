import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { JevelError } from "./jevel.js";
import type { Answer, ErrorBody, FallBackAnswer, Usage } from "./protocol.js";

export const LOG_FILE = "log.jsonl";

export function jevelryHome(env: NodeJS.ProcessEnv, homedir: string): string {
  const configured = env.JEVELRY_HOME;
  return configured && configured.trim() !== "" ? configured : join(homedir, ".jevelry");
}

export interface AskLine {
  kind: "ask";
  id: string;
  at: string;
  jevel: { name: string; version: number } | null;
  /** null only on a line with `error`: Jev could not answer, so no model did. */
  model: string | null;
  state_hash: string;
  /** On a line with `error`, every question is a FallBackAnswer. */
  answers: Record<string, Answer | FallBackAnswer>;
  usage: Usage | null;
  cwd: string;
  /** Set when a library `decide` got no answer from Jev. The CLI logs only answers. */
  error?: ErrorBody;
}

export interface OutcomeLine {
  kind: "outcome";
  id: string;
  question: string;
  outcome: "agree" | "disagree";
  value: string | null;
  note: string | null;
  at: string;
}

export type LogLine = AskLine | OutcomeLine;

/** Append-only. The state is never written, only its hash; the key is never written anywhere. */
export async function appendLine(home: string, line: LogLine): Promise<void> {
  await mkdir(home, { recursive: true });
  await appendFile(join(home, LOG_FILE), `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * One ask line with a fresh id. The answer is the product and the log is this runtime's own record,
 * never the host's truth: a log that cannot be written costs a warning and a null id, never the answer.
 */
export async function logAsk(
  home: string,
  fields: Pick<AskLine, "jevel" | "model" | "state_hash" | "answers" | "usage" | "error">,
  warn: (message: string) => void,
): Promise<string | null> {
  const id = randomUUID();
  const { error, ...rest } = fields;
  try {
    await appendLine(home, { kind: "ask", id, at: new Date().toISOString(), ...rest, cwd: process.cwd(), ...(error ? { error } : {}) });
    return id;
  } catch (e) {
    warn(`the ask was answered but could not be logged: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function readLog(home: string): Promise<LogLine[]> {
  let text: string;
  try {
    text = await readFile(join(home, LOG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines: LogLine[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stderr.write(`jevelry: skipped line ${index + 1} of ${LOG_FILE}: not JSON\n`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      process.stderr.write(`jevelry: skipped line ${index + 1} of ${LOG_FILE}: not a log line\n`);
      return;
    }
    lines.push(parsed as LogLine);
  });
  return lines;
}

export function findAsk(lines: LogLine[], id: string): AskLine | undefined {
  return lines.find((line): line is AskLine => line.kind === "ask" && line.id === id);
}

/** Spec section 6: agree/disagree verbatim, else compared to the recorded answer of its type. */
export function outcomeOf(ask: AskLine, question: string, given: string): { outcome: "agree" | "disagree"; value: string | null } {
  // Jev gave no answer on this line, so there is nothing an outcome could agree or disagree with.
  if (ask.error) throw new JevelError("log_id", `ask ${ask.id} got no answer from Jev (${ask.error.code}), so it takes no outcome`);
  const answer = ask.answers[question] as Answer | undefined;
  if (!answer) throw new JevelError("question", `no question named ${question} in ask ${ask.id}`);
  if (given === "agree" || given === "disagree") return { outcome: given, value: null };
  let agrees: boolean;
  if (answer.type === "noul") {
    if (given !== "yes" && given !== "no") throw new JevelError("value", `a noul outcome is yes or no, not ${given}`);
    agrees = (given === "yes") === answer.yes;
  } else if (answer.type === "choice") {
    if (!(given in answer.probabilities)) throw new JevelError("value", `${given} names no option of ${question}`);
    agrees = given === answer.choice;
  } else {
    if (!(given in answer.legend)) throw new JevelError("value", `${given} names no level of ${question}`);
    agrees = Number(given) === Math.round(answer.score);
  }
  return { outcome: agrees ? "agree" : "disagree", value: given };
}

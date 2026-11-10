import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JevelError } from "./jevel.js";
import type { Answer, ErrorBody, FallBackAnswer, RunReport, Usage } from "./protocol.js";

export const LOG_FILE = "log.jsonl";
/**
 * The requests the log holds a model's answer to, 32 bytes of hash each. An ask that is no repeat learns it from here
 * without reading the log. It only ever says "look" or "do not look": wrong either way, the cost is one ask of the model.
 */
export const REQUESTS_FILE = "requests.idx";
const hashBytes = (requestHash: string): Buffer => Buffer.from(requestHash.slice(requestHash.indexOf(":") + 1), "hex");

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
  /** The state as sent, only when state logging is on (`--log-state`, `logState`, `JEVELRY_LOG_STATE=1`). */
  state?: unknown;
  /** On a line with `error`, every question is a FallBackAnswer. */
  answers: Record<string, Answer | FallBackAnswer>;
  usage: Usage | null;
  /** How long the model took to answer, in ms. Absent on a line with `error` and on lines written before durations were kept. */
  ms?: number;
  /** `sha256:` of the state and the questions as they were asked: two asks with the same one put the same request to the model. */
  request_hash?: string;
  /** Set when the answer was read from the log: the id of the ask the model itself answered. */
  cached_from?: string;
  /** Set when the ask waited for the local model server to start or load, so its duration is not a warm one. */
  cold?: boolean;
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

/** What ran after an ask, under the ask's id. A library handler logs `command: null`. */
export interface RunLine extends RunReport {
  kind: "run";
  id: string;
  at: string;
}

export type LogLine = AskLine | OutcomeLine | RunLine;

/** Append-only. The state is written only when state logging is on; the key is never written anywhere. */
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
  fields: Pick<AskLine, "jevel" | "model" | "state_hash" | "state" | "answers" | "usage" | "ms" | "request_hash" | "cached_from" | "cold" | "error">,
  warn: (message: string) => void,
): Promise<string | null> {
  const id = randomUUID();
  const { error, state, ...rest } = fields;
  try {
    await appendLine(home, { kind: "ask", id, at: new Date().toISOString(), ...rest, cwd: process.cwd(), ...(state !== undefined ? { state } : {}), ...(error ? { error } : {}) });
    // Only an answer the model itself gave can be repeated. An index that cannot be written costs a later repeat its shortcut, never this ask.
    if (rest.request_hash !== undefined && !error && rest.cached_from === undefined) await appendFile(join(home, REQUESTS_FILE), hashBytes(rest.request_hash)).catch(() => {});
    return id;
  } catch (e) {
    warn(`the ask was answered but could not be logged: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Answering an exact repeat from the log is asked for, with `--cache`, `cache: true` or this. */
export const cacheFromEnv = (env: NodeJS.ProcessEnv): boolean => env.JEVELRY_CACHE === "1";

/** States often hold customer text, so the log keeps only their hash unless this is set. */
export const logStateFromEnv = (env: NodeJS.ProcessEnv): boolean => env.JEVELRY_LOG_STATE === "1";

/** Where a skipped line is reported; the default prints it to stderr, a TUI counts it instead of drawing over its screen. */
export type OnSkipped = (message: string) => void;
const skippedToStderr: OnSkipped = (message) => { process.stderr.write(`jevelry: ${message}\n`); };

export async function readLog(home: string, onSkipped: OnSkipped = skippedToStderr): Promise<LogLine[]> {
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
      onSkipped(`skipped line ${index + 1} of ${LOG_FILE}: not JSON`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      onSkipped(`skipped line ${index + 1} of ${LOG_FILE}: not a log line`);
      return;
    }
    lines.push(parsed as LogLine);
  });
  return lines;
}

/** The index as it is on disk, or built from the log when a log has none: asks logged before it was kept are found too. */
async function requestIndex(home: string): Promise<Buffer> {
  try {
    return await readFile(join(home, REQUESTS_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let text = "";
  try {
    text = await readFile(join(home, LOG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Buffer.alloc(0);
  }
  const index = Buffer.concat([...text.matchAll(/"request_hash":"sha256:([0-9a-f]{64})"/g)].map((match) => Buffer.from(match[1] as string, "hex")));
  await writeFile(join(home, REQUESTS_FILE), index).catch(() => {});
  return index;
}

/**
 * The latest answer the model itself gave to this exact request. A copy of an answer is never the source
 * of the next one, and an ask Jev never answered has nothing to give. A lookup that fails for any reason
 * answers "no repeat": the model is asked, and nothing is lost but the shortcut.
 */
export async function findRepeat(home: string, requestHash: string, model: string): Promise<AskLine | undefined> {
  try {
    const index = await requestIndex(home);
    const wanted = hashBytes(requestHash);
    let known = false;
    for (let at = index.indexOf(wanted); at !== -1 && !known; at = index.indexOf(wanted, at + 1)) known = at % 32 === 0;
    if (!known) return undefined;
    // Only the lines that carry this hash are parsed, newest first: reading a log is cheap next to parsing every line of it.
    // ponytail: a repeat still reads the whole log once, about 80 ms at 100,000 asks; keep byte offsets in the index if that ever costs more than it saves.
    const text = await readFile(join(home, LOG_FILE), "utf8");
    for (let from = text.length; ;) {
      const at = text.lastIndexOf(requestHash, from);
      if (at === -1) return undefined;
      const start = text.lastIndexOf("\n", at) + 1;
      const end = text.indexOf("\n", at);
      try {
        const line = JSON.parse(text.slice(start, end === -1 ? text.length : end)) as LogLine;
        if (line.kind === "ask" && line.request_hash === requestHash && line.model === model && !line.error && line.cached_from === undefined) return line;
      } catch {
        // Not a line of JSON: not an answer.
      }
      if (start === 0) return undefined;
      from = start - 1;
    }
  } catch {
    return undefined;
  }
}

export function findAsk(lines: LogLine[], id: string): AskLine | undefined {
  return lines.find((line): line is AskLine => line.kind === "ask" && line.id === id);
}

/** Spec section 6: agree/disagree verbatim, else compared to the recorded answer of its type. */
export function outcomeOf(ask: AskLine, question: string, given: string): { outcome: "agree" | "disagree"; value: string | null } {
  // Jev gave no answer on this line, so there is nothing an outcome could agree or disagree with.
  if (ask.error) throw new JevelError("log_id", `ask ${ask.id} got no answer from Jev (${ask.error.code}), so it takes no outcome`);
  const answer = (Object.hasOwn(ask.answers, question) ? ask.answers[question] : undefined) as Answer | undefined;
  if (!answer) throw new JevelError("question", `no question named ${question} in ask ${ask.id}`);
  if (given === "agree" || given === "disagree") return { outcome: given, value: null };
  let agrees: boolean;
  if (answer.type === "noul") {
    if (given !== "yes" && given !== "no") throw new JevelError("value", `a noul outcome is yes or no, not ${given}`);
    agrees = (given === "yes") === answer.yes;
  } else if (answer.type === "choice") {
    if (!Object.hasOwn(answer.probabilities, given)) throw new JevelError("value", `${given} names no option of ${question}`);
    agrees = given === answer.choice;
  } else {
    if (!Object.hasOwn(answer.legend, given)) throw new JevelError("value", `${given} names no level of ${question}`);
    agrees = Number(given) === Math.round(answer.score);
  }
  return { outcome: agrees ? "agree" : "disagree", value: given };
}

/** The one writer of outcome lines, for `jevelry outcome` and the TUI alike. Throws JevelError for an unknown id, question or value. */
export async function recordOutcome(home: string, logId: string, question: string, given: string, note: string | null, onSkipped?: OnSkipped): Promise<OutcomeLine> {
  const found = findAsk(await readLog(home, onSkipped), logId);
  if (!found) throw new JevelError("log_id", `no ask with id ${logId} in the log`);
  const { outcome, value } = outcomeOf(found, question, given);
  const line: OutcomeLine = { kind: "outcome", id: logId, question, outcome, value, note, at: new Date().toISOString() };
  await appendLine(home, line);
  return line;
}

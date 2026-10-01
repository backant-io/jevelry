import type { EntryType, Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { type AskInput, type AskResult, ask, errorBody, isRecord } from "./ask.js";
import { type Jevel, JevelError, loadJevel } from "./jevel.js";
import { logAsk } from "./log.js";
import { PROTOCOL } from "./protocol.js";

export interface LogOptions {
  home: string;
  log: boolean;
  logState: boolean;
  warn: (message: string) => void;
}

/** One ask and its log line, the same for `ask` and for every line of `ask --batch`. */
export async function askAndLog(input: AskInput, o: LogOptions): Promise<AskResult> {
  const result = await ask(input);
  if (result.ok && o.log) {
    const { jevel, model, state_hash, answers, usage } = result.document;
    result.document.log_id = await logAsk(o.home, { jevel, model, state_hash, ...(o.logState ? { state: input.state } : {}), answers, usage }, o.warn);
  }
  return result;
}

export interface BatchOptions extends LogOptions {
  client: TypeSafeClient;
  dirs: string[];
  /** The `--model` of the batch; a line's own `model` wins. */
  model?: string;
  concurrency: number;
  write: (line: Record<string, unknown>) => void;
}

/**
 * One NDJSON line in, one out: `{id, ...document}` or `{id, protocol, error}`. A line without a
 * usable id answers with `id: null` and its 1-based `line` number. Never throws.
 */
async function askLine(text: string, n: number, o: BatchOptions): Promise<Record<string, unknown>> {
  let tag: Record<string, unknown> = { id: null, line: n };
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JevelError("line", `line ${n} is not JSON`);
    }
    if (!isRecord(parsed)) throw new JevelError("line", `line ${n} is not a JSON object`);
    const { id, jevel: name, questions, state, model } = parsed;
    if (typeof id !== "string" && typeof id !== "number") throw new JevelError("id", `line ${n} has no id, a string or a number`);
    tag = { id };
    if (model !== undefined && typeof model !== "string") throw new JevelError("model", "model must be a string");
    let source: { jevel: Jevel } | { questions: Questions };
    if (typeof name === "string") {
      const loaded = loadJevel(name, o.dirs);
      for (const warning of loaded.warnings) o.warn(`${String(id)}: warning: ${warning}`);
      source = { jevel: loaded.jevel };
    } else if (isRecord(questions)) {
      source = { questions: questions as Questions };
    } else {
      throw new JevelError("jevel", "give a jevel name or questions");
    }
    const chosen = model ?? o.model;
    const result = await askAndLog({ client: o.client, state: state as EntryType, ...source, ...(chosen ? { model: chosen } : {}) }, o);
    return result.ok ? { ...tag, ...result.document } : { ...tag, protocol: PROTOCOL, error: result.error };
  } catch (error) {
    return { ...tag, protocol: PROTOCOL, error: errorBody(error) };
  }
}

/** Every line asked, at most `concurrency` at a time; each answer is written as it completes. */
export async function askBatch(lines: AsyncIterable<string>, o: BatchOptions): Promise<void> {
  const running = new Set<Promise<void>>();
  let n = 0;
  for await (const text of lines) {
    n += 1;
    if (text.trim() === "") continue;
    const pending: Promise<void> = askLine(text, n, o).then(o.write).finally(() => running.delete(pending));
    running.add(pending);
    if (running.size >= o.concurrency) await Promise.race(running);
  }
  await Promise.all(running);
}

import { createHash } from "node:crypto";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  type EntryType,
  InternalServerError,
  PermissionDeniedError,
  type Questions,
  RateLimitError,
  type TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import { checkBudgets } from "./budget.js";
import { type Jevel, JevelError, checkState, expandQuestions } from "./jevel.js";
import { type Answer, type AskDocument, EXIT, type ErrorBody, type ErrorCode, PROTOCOL } from "./protocol.js";
import { DEFAULT_THRESHOLDS, type Thresholds, certaintyOf, verdictOf } from "./verdict.js";

/** Keys sorted at every level, no whitespace: the same state hashes the same however a host built it. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function stateHash(state: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(state), "utf8").digest("hex")}`;
}

/** The API answered something this build cannot read. Never defaulted: exit 7 with the field named. */
export class UnreadableAnswer extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "UnreadableAnswer";
    this.field = field;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isProbabilities = (v: unknown): v is Record<string, number> => isRecord(v) && Object.values(v).every((n) => typeof n === "number");

/** A noul and a confidence are probabilities. Out of range is a defect, never something to clamp. */
function probabilityOf(field: string, value: unknown): number {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    throw new UnreadableAnswer(field, `${field} is not a probability in [0, 1]: ${String(value)}`);
  }
  return value;
}

export function shapeAnswer(name: string, raw: unknown, thresholds: Thresholds): Answer {
  const field = `answers.${name}`;
  if (!isRecord(raw)) throw new UnreadableAnswer(field, `${field} is not an object`);
  if (raw.type === "noul") {
    const noul = probabilityOf(`${field}.noul`, raw.noul);
    const certainty = certaintyOf({ type: "noul", noul });
    return { type: "noul", noul, yes: noul >= 0.5, certainty, verdict: verdictOf(certainty, thresholds) };
  }
  if (raw.type === "choice") {
    if (typeof raw.choice !== "string" || !isProbabilities(raw.probabilities)) {
      throw new UnreadableAnswer(field, `${field} lacks choice or probabilities`);
    }
    const confidence = probabilityOf(`${field}.confidence`, raw.confidence);
    const certainty = certaintyOf({ type: "choice", confidence });
    return { type: "choice", choice: raw.choice, probabilities: raw.probabilities, confidence, certainty, verdict: verdictOf(certainty, thresholds) };
  }
  if (raw.type === "score") {
    if (typeof raw.score !== "number" || !isRecord(raw.legend) || !isProbabilities(raw.probabilities)) {
      throw new UnreadableAnswer(field, `${field} lacks score, legend or probabilities`);
    }
    const confidence = probabilityOf(`${field}.confidence`, raw.confidence);
    const certainty = certaintyOf({ type: "score", confidence });
    return { type: "score", score: raw.score, legend: raw.legend, probabilities: raw.probabilities, confidence, certainty, verdict: verdictOf(certainty, thresholds) };
  }
  throw new UnreadableAnswer(field, `${field} has a type this build does not know: ${String(raw.type)}`);
}

export interface AskInput {
  client: TypeSafeClient;
  state: EntryType;
  jevel?: Jevel;
  questions?: Questions;
  model?: string;
}

export type AskResult = { ok: true; document: AskDocument } | { ok: false; error: ErrorBody };

export async function ask(input: AskInput): Promise<AskResult> {
  try {
    let questions: Questions;
    let thresholds: Record<string, Thresholds>;
    if (input.jevel) {
      checkState(input.jevel, input.state);
      ({ questions, thresholds } = expandQuestions(input.jevel, input.state));
    } else {
      questions = input.questions ?? {};
      thresholds = Object.fromEntries(Object.keys(questions).map((k) => [k, DEFAULT_THRESHOLDS]));
    }
    if (Object.keys(questions).length === 0) throw new JevelError("questions", "there are no questions to ask");
    const breach = checkBudgets(input.state, questions, input.jevel?.state.budget_tokens);
    if (breach) {
      return {
        ok: false,
        error: {
          exit: EXIT.over_budget,
          code: "over_budget",
          message: `the request is estimated at ${breach.estimate} tokens, over the ${breach.limit} ceiling of ${breach.ceiling}; filter the state before asking`,
        },
      };
    }
    const model = input.model ?? input.jevel?.model;
    const result = await input.client.systemOne(model === undefined ? { state: input.state, questions } : { state: input.state, questions, model });
    const answers: Record<string, Answer> = {};
    for (const name of Object.keys(questions)) {
      const raw = (result.answers as Record<string, unknown>)[name];
      if (raw === undefined) throw new UnreadableAnswer(`answers.${name}`, `the API returned no answer named ${name}`);
      answers[name] = shapeAnswer(name, raw, thresholds[name] ?? DEFAULT_THRESHOLDS);
    }
    const document: AskDocument = {
      protocol: PROTOCOL,
      log_id: null,
      jevel: input.jevel ? { name: input.jevel.name, version: input.jevel.version } : null,
      model: result.model,
      state_hash: stateHash(input.state),
      answers,
      usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
    };
    return { ok: true, document };
  } catch (error) {
    return { ok: false, error: errorBody(error) };
  }
}

/** `Retry-After` in seconds or an HTTP date, or `retry-after-ms`; the SDK parses it only for 429. */
function retryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+$/.test(ms.trim())) return Number(ms.trim());
  const after = headers.get("retry-after");
  if (after === null) return undefined;
  if (/^\d+$/.test(after.trim())) return Number(after.trim()) * 1000;
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const body = (code: ErrorCode, message: string, extra: { retry_after_ms?: number; field?: string } = {}): ErrorBody => {
  const out: ErrorBody = { exit: EXIT[code], code, message };
  if (extra.retry_after_ms !== undefined) out.retry_after_ms = extra.retry_after_ms;
  if (extra.field !== undefined) out.field = extra.field;
  return out;
};

export function errorBody(error: unknown): ErrorBody {
  if (error instanceof JevelError) return body("bad_input", error.message, { field: error.field });
  if (error instanceof UnreadableAnswer) return body("unreadable_answer", error.message, { field: error.field });
  if (error instanceof RateLimitError) {
    const retry = error.retryAfterMs ?? retryAfterMs(error.headers);
    return body("rate_limited", "TypeSafe answered 429 after the SDK's retries", retry === undefined ? {} : { retry_after_ms: retry });
  }
  if (error instanceof InternalServerError && error.status === 529) {
    const retry = retryAfterMs(error.headers);
    return body("overloaded", "TypeSafe answered 529 (overloaded) after the SDK's retries", retry === undefined ? {} : { retry_after_ms: retry });
  }
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return body("auth", `TypeSafe refused the key: ${error.message}; check TYPESAFE_API_KEY`);
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return body("bad_input", `TypeSafe refused the request: ${error.message}`);
  }
  if (error instanceof APIError) return body("transport", `TypeSafe answered ${error.status}: ${error.message}`);
  if (error instanceof APIConnectionError) return body("transport", error.message);
  if (error instanceof TypeSafeError) {
    return /api key/i.test(error.message) ? body("auth", error.message) : body("bad_input", error.message);
  }
  return body("transport", error instanceof Error ? error.message : String(error));
}

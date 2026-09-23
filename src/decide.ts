import { homedir } from "node:os";
import { type EntryType, TypeSafeClient } from "@typesafe-ai/sdk";
import { ask, errorBody, stateHash } from "./ask.js";
import { type Jevel, JevelError, type JevelQuestion, checkState, discoveryDirs, expandQuestions, isEntry, loadJevel } from "./jevel.js";
import { resolveKey } from "./key.js";
import { jevelryHome, logAsk } from "./log.js";
import type { Answer, ChoiceAnswer, ErrorBody, NoulAnswer, ScoreAnswer, Usage } from "./protocol.js";

/**
 * The SDK resolves its own `logLevel` from `TYPESAFE_LOG_LEVEL` and logs through `console` by
 * default, whose `debug` and `info` go to stdout: that would put SDK lines in front of the one
 * document a host parses (and at `debug` the request body, which is the state). Every level goes
 * to stderr instead, so the one-document protocol holds whatever the environment asks for.
 */
export function defaultClient(home: string): TypeSafeClient {
  // The SDK reads the key from the environment itself, so a key that lives in the keychain or in
  // `$JEVELRY_HOME/env` is put there before the client is built. A key the host exported wins.
  const key = resolveKey(process.env, home);
  if (key !== undefined && (process.env.TYPESAFE_API_KEY ?? "").trim() === "") process.env.TYPESAFE_API_KEY = key;
  const timeout = Number(process.env.JEVELRY_TIMEOUT_MS ?? 30000);
  const model = process.env.JEVELRY_MODEL;
  // An extra argument is usually an object: `String` would render it `[object Object]` and lose the
  // line's content, so it is JSON, and `String` only for what JSON cannot hold (a cycle, undefined).
  const render = (a: unknown): string => { try { return JSON.stringify(a) ?? String(a); } catch { return String(a); } };
  const toStderr = (m: string, ...a: unknown[]): void => { process.stderr.write(`jevelry: sdk: ${[m, ...a.map(render)].join(" ")}\n`); };
  const logger = { debug: toStderr, info: toStderr, warn: toStderr, error: toStderr };
  return new TypeSafeClient(model && model.trim() !== "" ? { timeout, defaultModel: model, logger } : { timeout, logger });
}

/** What Jev could not answer: the code takes its old path, so the type is all a caller needs. */
export interface FallBackAnswer<T extends Answer["type"] = Answer["type"]> {
  type: T;
  decision: "fall_back";
  answer: null;
  certainty: 0;
}

export type ChoiceDecision<O extends string = string> = (Omit<ChoiceAnswer, "choice"> & { choice: O; answer: O }) | FallBackAnswer<"choice">;
export type NoulDecision = (NoulAnswer & { answer: boolean }) | FallBackAnswer<"noul">;
export type ScoreDecision = (ScoreAnswer & { answer: number }) | FallBackAnswer<"score">;
export type DecisionAnswer = ChoiceDecision | NoulDecision | ScoreDecision;

export interface DecisionsMeta {
  logId: string | null;
  /** Set when Jev could not answer; every question is `fall_back` then. */
  error: ErrorBody | null;
  model: string | null;
  usage: Usage | null;
}

export type Decisions<Q = { [question: string]: DecisionAnswer }> = DecisionsMeta & Q;

export interface LoadedJevel<Q = { [question: string]: DecisionAnswer }> {
  readonly name: string;
  readonly version: number;
  decide(state: unknown): Promise<Decisions<Q>>;
}

/** Filled in by the file `jevelry types` writes: jevel name to its questions. Empty, every name gets the loose type. */
export interface JevelTypes {}

export interface JevelOptions {
  /** Extra directories searched first, like `--jevels`. */
  jevels?: string[];
  /** Overrides the jevel's pinned model. */
  model?: string;
  /** Where the log goes, and the last jevels directory searched. Default `$JEVELRY_HOME` or `~/.jevelry`. */
  home?: string;
  /** Default true. */
  log?: boolean;
  /** Default: built the way the CLI builds it. */
  client?: TypeSafeClient;
}

const META = ["logId", "error", "model", "usage"];

const withAnswer = (a: Answer): DecisionAnswer => {
  if (a.type === "choice") return { ...a, answer: a.choice };
  if (a.type === "noul") return { ...a, answer: a.yes };
  return { ...a, answer: Math.round(a.score) };
};

/**
 * Load once at startup, decide where the code decides. A missing or broken jevel throws `JevelError`
 * here; `decide` throws only for a state the jevel refuses, and returns every question `fall_back`
 * with `error` set when Jev cannot answer.
 */
export function jevel<N extends string>(
  name: N,
  options: JevelOptions = {},
): LoadedJevel<N extends keyof JevelTypes ? JevelTypes[N] : { [question: string]: DecisionAnswer }> {
  const home = options.home ?? jevelryHome(process.env, homedir());
  const env = process.env.JEVELRY_JEVELS;
  const { jevel: loaded } = loadJevel(name, discoveryDirs({ cli: options.jevels ?? [], ...(env ? { env } : {}), cwd: process.cwd(), home }));
  // The answers sit beside these four keys on one object, so a question with one of their names would be overwritten.
  for (const id of Object.keys(loaded.questions)) {
    if (META.includes(id)) throw new JevelError(`questions.${id}`, `a question named ${id} collides with the ${id} field of decide(); rename it`);
  }
  let client = options.client;
  return {
    name: loaded.name,
    version: loaded.version,
    async decide(state: unknown) {
      // The caller's own bugs: thrown, because no amount of retrying Jev fixes them.
      if (!isEntry(state)) throw new JevelError("state", "state must be a string, a JSON object or an array");
      checkState(loaded, state);
      const names = Object.keys(expandQuestions(loaded, state).questions);
      let result: Awaited<ReturnType<typeof ask>>;
      try {
        client ??= defaultClient(home);
        result = await ask({ client, state: state as EntryType, jevel: loaded, ...(options.model ? { model: options.model } : {}) });
      } catch (error) {
        result = { ok: false, error: errorBody(error) };
      }
      const jevelRef = { name: loaded.name, version: loaded.version };
      const warn = (m: string): void => { process.emitWarning(m); };
      if (result.ok) {
        const { model, state_hash, answers, usage } = result.document;
        const logId = options.log === false ? null : await logAsk(home, { jevel: jevelRef, model, state_hash, answers, usage }, warn);
        const decided = Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, withAnswer(a)]));
        return { logId, error: null, model, usage, ...decided } as never;
      }
      const error = result.error;
      // Every name came out of expandQuestions, so its base name is a question of this jevel.
      const typeOf = (q: string): Answer["type"] => loaded.questions[q.replace(/\[\d+\]$/, "")]!.type;
      const fallen = Object.fromEntries(names.map((q) => [q, { type: typeOf(q), decision: "fall_back", answer: null, certainty: 0 }]));
      const logId = options.log === false
        ? null
        : await logAsk(home, { jevel: jevelRef, model: null, state_hash: stateHash(state), answers: {}, usage: null, error }, warn);
      return { logId, error, model: null, usage: null, ...fallen } as never;
    },
  };
}

const pascal = (name: string): string => {
  const out = name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /^\d/.test(out) ? `_${out}` : out;
};

function answerType(q: JevelQuestion): string {
  if (q.type === "noul") return "NoulDecision";
  if (q.type === "score") return "ScoreDecision";
  return `ChoiceDecision<${Object.keys(q.criteria as Record<string, unknown>).map((o) => JSON.stringify(o)).join(" | ")}>`;
}

/** The declaration `jevelry types` writes: one interface per jevel and the map `jevel()` reads it through. */
export function renderTypes(jevels: Jevel[]): string {
  const lines = [
    "// Written by `jevelry types`. Run it again after you change a jevel.",
    'import type { ChoiceDecision, NoulDecision, ScoreDecision } from "jevelry";',
    "",
  ];
  for (const j of jevels) {
    lines.push(`export interface ${pascal(j.name)} {`);
    for (const [id, q] of Object.entries(j.questions)) {
      const key = q.repeat ? `[key: \`${id}[\${number}]\`]` : id;
      lines.push(`  ${key}: ${answerType(q)};`);
    }
    lines.push("}", "");
  }
  lines.push('declare module "jevelry" {', "  interface JevelTypes {");
  for (const j of jevels) lines.push(`    ${JSON.stringify(j.name)}: ${pascal(j.name)};`);
  lines.push("  }", "}", "");
  return lines.join("\n");
}

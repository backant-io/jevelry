import { homedir } from "node:os";
import { type EntryType, TypeSafeClient } from "@typesafe-ai/sdk";
import { ask, errorBody, stateHash } from "./ask.js";
import { type Jevel, JevelError, type JevelQuestion, checkState, discoveryDirs, expandQuestions, isEntry, loadJevel } from "./jevel.js";
import { resolveKey } from "./key.js";
import { jevelryHome, logAsk, logStateFromEnv } from "./log.js";
import type { Answer, ChoiceAnswer, ErrorBody, FallBackAnswer, NoulAnswer, ScoreAnswer, Usage } from "./protocol.js";
import { type Call, type RunArgs, dispatcherOf, execute, logRun, planCall } from "./run.js";

/**
 * The SDK resolves its own `logLevel` from `TYPESAFE_LOG_LEVEL` and logs through `console` by
 * default, whose `debug` and `info` go to stdout: that would put SDK lines in front of the one
 * document a host parses (and at `debug` the request body, which is the state). Every level goes
 * to stderr instead, so the one-document protocol holds whatever the environment asks for.
 */
export function defaultClient(home: string): TypeSafeClient {
  // The key goes to the client directly: writing it into `process.env` would hand it to every child
  // process the host program starts. A key the host exported wins, as `resolveKey` reads it first.
  const key = resolveKey(process.env, home);
  const timeout = Number(process.env.JEVELRY_TIMEOUT_MS ?? 30000);
  const model = process.env.JEVELRY_MODEL;
  // An extra argument is usually an object: `String` would render it `[object Object]` and lose the
  // line's content, so it is JSON, and `String` only for what JSON cannot hold (a cycle, undefined).
  const render = (a: unknown): string => { try { return JSON.stringify(a) ?? String(a); } catch { return String(a); } };
  const toStderr = (m: string, ...a: unknown[]): void => { process.stderr.write(`jevelry: sdk: ${[m, ...a.map(render)].join(" ")}\n`); };
  const logger = { debug: toStderr, info: toStderr, warn: toStderr, error: toStderr };
  return new TypeSafeClient({
    timeout,
    logger,
    ...(key !== undefined ? { apiKey: key } : {}),
    ...(model && model.trim() !== "" ? { defaultModel: model } : {}),
  });
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

/** Code to run per option in place of the jevel's shell commands. `fall_back` gets the decisions only. */
export interface RunHandlers<Q = { [question: string]: DecisionAnswer }> {
  [option: string]: ((args: RunArgs, d: Decisions<Q>) => unknown) | undefined;
  // `any` only so this fits the index signature above, whose first parameter is the arguments; it receives Decisions<Q>.
  fall_back?: (d: any) => unknown;
}

export interface RunOptions {
  /** Asked on mark; without it a mark runs nothing and `ran.confirmed` is false. */
  confirm?: (option: string, certainty: number) => boolean | Promise<boolean>;
  /** Run the jevel's own `run` commands for options that have no handler. Default false. */
  shell?: boolean;
}

export interface Ran {
  /** The picked option, null on fall_back. */
  option: string | null;
  decision: Answer["decision"];
  /** On mark: whether `confirm` said yes. Null when nobody was asked. */
  confirmed: boolean | null;
  /**
   * What the handler returned, `{ exit, ms }` for a shell command, undefined when nothing ran. When the
   * program gets SIGINT, SIGTERM or SIGHUP while a command runs, the command gets it too, the state file is
   * removed and `result` carries `signal`; `run` never ends the program, that is the host's call.
   */
  result: unknown;
}

export interface LoadedJevel<Q = { [question: string]: DecisionAnswer }> {
  readonly name: string;
  readonly version: number;
  decide(state: unknown): Promise<Decisions<Q>>;
  /** decide, then call the handler (or with `shell`, the command) for the dispatcher's decision. */
  run(state: unknown, handlers?: RunHandlers<Q>, options?: RunOptions): Promise<{ decisions: Decisions<Q>; ran: Ran | null }>;
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
  /** Write the state itself into the log line, not only its hash. Default false, or `JEVELRY_LOG_STATE=1`. */
  logState?: boolean;
  /** Default: built the way the CLI builds it. */
  client?: TypeSafeClient;
}

const META = ["logId", "error", "model", "usage"];

const withAnswer = (a: Answer): DecisionAnswer => {
  if (a.type === "choice") return { ...a, answer: a.choice };
  if (a.type === "noul") return { ...a, answer: a.yes };
  return { ...a, answer: Math.round(a.score) };
};

/** Every question `fall_back`, for an ask Jev could not answer. The state already passed expandQuestions. */
export function fallenAnswers(jevel: Jevel, state: unknown): Record<string, FallBackAnswer> {
  // Every name came out of expandQuestions, so its base name is a question of this jevel.
  const typeOf = (q: string): Answer["type"] => jevel.questions[q.replace(/\[\d+\]$/, "")]!.type;
  return Object.fromEntries(Object.keys(expandQuestions(jevel, state).questions).map((q) => [q, { type: typeOf(q), decision: "fall_back", answer: null, certainty: 0 }]));
}

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
  const warn = (m: string): void => { process.emitWarning(m); };
  const { jevel: loaded } = loadJevel(name, discoveryDirs({ cli: options.jevels ?? [], ...(env ? { env } : {}), cwd: process.cwd(), home }));
  // The answers sit beside these four keys on one object, so a question with one of their names would be overwritten.
  for (const id of Object.keys(loaded.questions)) {
    if (META.includes(id)) throw new JevelError(`questions.${id}`, `a question named ${id} collides with the ${id} field of decide(); rename it`);
  }
  let client = options.client;
  /**
   * `plan` runs on Jev's answers before anything is logged; when it throws, the ask is logged and
   * returned as a failure like any other, so the log never holds a clean decision nobody could act on.
   */
  const decideWith = async (state: unknown, plan?: (answers: Record<string, Answer>) => void): Promise<Decisions> => {
    // The caller's own bugs: thrown, because no amount of retrying Jev fixes them.
    if (!isEntry(state)) throw new JevelError("state", "state must be a string, a JSON object or an array");
    checkState(loaded, state);
    expandQuestions(loaded, state);
    let result: Awaited<ReturnType<typeof ask>>;
    try {
      client ??= defaultClient(home);
      result = await ask({ client, state: state as EntryType, jevel: loaded, ...(options.model ? { model: options.model } : {}) });
    } catch (error) {
      result = { ok: false, error: errorBody(error) };
    }
    if (result.ok && plan) {
      try {
        plan(result.document.answers);
      } catch (error) {
        result = { ok: false, error: errorBody(error) };
      }
    }
    const jevelRef = { name: loaded.name, version: loaded.version };
    const logged = (options.logState ?? logStateFromEnv(process.env)) ? { state } : {};
    if (result.ok) {
      const { model, state_hash, answers, usage } = result.document;
      const logId = options.log === false ? null : await logAsk(home, { jevel: jevelRef, model, state_hash, ...logged, answers, usage }, warn);
      const decided = Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, withAnswer(a)]));
      return { logId, error: null, model, usage, ...decided } as never;
    }
    const error = result.error;
    const fallen = fallenAnswers(loaded, state);
    // Logged per question like an answer, so `report` counts every decision point that fired, the failed ones as fall_back.
    const logId = options.log === false
      ? null
      : await logAsk(home, { jevel: jevelRef, model: null, state_hash: stateHash(state), ...logged, answers: fallen, usage: null, error }, warn);
    return { logId, error, model: null, usage: null, ...fallen } as never;
  };
  const decide = (state: unknown): Promise<Decisions> => decideWith(state);
  return {
    name: loaded.name,
    version: loaded.version,
    decide: decide as never,
    async run(state: unknown, handlers: RunHandlers = {}, runOptions: RunOptions = {}) {
      dispatcherOf(loaded);
      let planned: Call | null = null;
      const decisions = await decideWith(state, (answers) => { planned = planCall(loaded, answers); });
      const call = decisions.error ? planCall(loaded, null) : planned!;
      const key = call.decision === "fall_back" ? "fall_back" : call.option!;
      const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
      const command = runOptions.shell === true && !handler ? call.command : null;
      if (!handler && command === null) return { decisions, ran: null } as never;
      let confirmed: boolean | null = null;
      if (call.decision === "mark") confirmed = runOptions.confirm ? (await runOptions.confirm(call.option!, call.certainty)) === true : false;
      let result: unknown;
      let exit: number | null = null;
      let ms: number | null = null;
      let signal: string | undefined;
      if (confirmed !== false) {
        if (command !== null) {
          const done = await execute(command, state, { decision: call.decision, option: call.option, logId: decisions.logId });
          ({ exit, ms } = done);
          if (done.signal) signal = done.signal;
          result = { exit: done.exit, ms: done.ms, ...(signal ? { signal } : {}) };
        } else {
          const started = Date.now();
          result = call.decision === "fall_back" ? await handlers.fall_back!(decisions) : await handler!(call.args, decisions);
          ms = Date.now() - started;
        }
      }
      if (decisions.logId !== null) await logRun(home, decisions.logId, { option: call.option, command, decision: call.decision, exit, ms, confirmed, ...(signal ? { signal } : {}) }, warn);
      return { decisions, ran: { option: call.option, decision: call.decision, confirmed, result } } as never;
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
      const key = q.repeat ? `[key: \`${id}[\${number}]\`]` : JSON.stringify(id);
      lines.push(`  ${key}: ${answerType(q)};`);
    }
    lines.push("}", "");
  }
  lines.push('declare module "jevelry" {', "  interface JevelTypes {");
  for (const j of jevels) lines.push(`    ${JSON.stringify(j.name)}: ${pascal(j.name)};`);
  lines.push("  }", "}", "");
  return lines.join("\n");
}

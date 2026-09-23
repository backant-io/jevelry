import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { UnreadableAnswer } from "./ask.js";
import { decisionOf, mergeThresholds } from "./decision.js";
import { type Jevel, JevelError, PLACEHOLDER, SAFE_VALUE } from "./jevel.js";
import { appendLine } from "./log.js";
import type { Answer, Decision, RunReport } from "./protocol.js";

export type RunArgs = Record<string, string | boolean>;

/** The call the dispatcher's answer and its arguments add up to, before anything runs. */
export interface Call {
  /** The picked option, null on fall_back. */
  option: string | null;
  /** The command to run with every `{{x}}` filled in, the jevel's fall_back on fall_back, or null. */
  command: string | null;
  args: RunArgs;
  certainty: number;
  decision: Decision;
}

/** The one question with `run`; a jevel without one cannot run anything. */
export function dispatcherOf(jevel: Jevel): string {
  const id = Object.keys(jevel.questions).find((q) => jevel.questions[q]!.run);
  if (id === undefined) throw new JevelError("run", `${jevel.name} has no question with run, so there is no command to pick`);
  return id;
}

type Answers = Record<string, unknown>;

/** A real answer; decide() adds `answer` to each, and only a FallBackAnswer holds `answer: null`. */
const answered = (a: unknown): a is Answer =>
  typeof a === "object" && a !== null && "certainty" in a && !("answer" in a && (a as { answer: unknown }).answer === null);

/**
 * The function-calling rule: the dispatcher picks the command, every argument that command names is
 * one more judgement, and the call is only as certain as the least certain of them. Only picked option
 * names and true/false reach the command, and each is checked again here, because the answer came
 * over the network.
 */
export function planCall(jevel: Jevel, answers: Answers | null): Call {
  const id = dispatcherOf(jevel);
  const q = jevel.questions[id]!;
  const fallBack: Call = { option: null, command: jevel.fall_back ?? null, args: {}, certainty: 0, decision: "fall_back" };
  if (answers === null) return fallBack;
  // ask() already refuses an answer of the wrong type or naming no option; this is the second check,
  // keyed on the jevel's own types, right before a value goes into a command.
  const answerOf = (name: string): Answer => {
    const a = Object.hasOwn(answers, name) ? answers[name] : undefined;
    if (!answered(a) || a.type !== jevel.questions[name]!.type) throw new UnreadableAnswer(`answers.${name}`, `answers.${name} is no ${jevel.questions[name]!.type} answer`);
    if (a.type === "choice" && (!Object.hasOwn(jevel.questions[name]!.criteria as object, a.choice) || (name !== id && !SAFE_VALUE.test(a.choice)))) {
      throw new UnreadableAnswer(`answers.${name}.choice`, `answers.${name} picked a value that is no option of ${name}`);
    }
    return a;
  };
  const picked = answerOf(id) as Answer & { type: "choice" };
  const option = picked.choice;
  const template = Object.hasOwn(q.run!, option) ? q.run![option]! : null;
  const args: RunArgs = {};
  let certainty = picked.certainty;
  for (const [, name] of template?.matchAll(PLACEHOLDER) ?? []) {
    const a = answerOf(name!);
    args[name!] = a.type === "choice" ? a.choice : a.type === "noul" ? a.yes : String(a.score);
    certainty = Math.min(certainty, a.certainty);
  }
  const decision = decisionOf(certainty, mergeThresholds(jevel.thresholds, q.thresholds));
  if (decision === "fall_back") return { ...fallBack, certainty };
  const command = template === null ? null : template.replace(PLACEHOLDER, (_, name: string) => String(args[name]));
  return { option, command, args, certainty, decision };
}

/** Signals jevelry passes on to a running command, so the command stops and the state file is removed. */
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * `/bin/sh -c` with the fixed command. The state goes in only as data: JSON on stdin and in the file
 * `JEVELRY_STATE` names, removed afterwards. The command's output goes to stderr, so a caller's stdout
 * stays one document.
 */
export async function execute(
  command: string,
  state: unknown,
  meta: { decision: Decision; option: string | null; logId: string | null },
): Promise<{ exit: number; ms: number; signal?: string; interrupted?: NodeJS.Signals }> {
  const dir = mkdtempSync(join(tmpdir(), "jevelry-state-"));
  const file = join(dir, "state.json");
  const json = JSON.stringify(state);
  // A jevel command is arbitrary shell, so it gets the environment minus the TypeSafe key.
  const { TYPESAFE_API_KEY: _key, ...env } = process.env;
  const listeners: Array<[NodeJS.Signals, () => void]> = [];
  let interrupted: NodeJS.Signals | undefined;
  const started = Date.now();
  try {
    writeFileSync(file, json, { mode: 0o600 });
    const { exit, signal } = await new Promise<{ exit: number; signal?: string }>((resolve) => {
      // Same session and process group as jevelry, so the command keeps the terminal (sudo, ssh and git
      // prompts read /dev/tty) and a Ctrl-C in the terminal reaches it directly.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...env, JEVELRY_STATE: file, JEVELRY_DECISION: meta.decision, JEVELRY_OPTION: meta.option ?? "", JEVELRY_LOG_ID: meta.logId ?? "" },
      });
      for (const sig of FORWARDED) {
        // A signal sent to jevelry alone (kill <pid>) goes on to the shell; a process the shell started
        // in the background can outlive it, which is the cost of keeping the terminal.
        const forward = (): void => {
          interrupted = sig;
          child.kill(sig);
        };
        listeners.push([sig, forward]);
        process.on(sig, forward);
      }
      child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      // A command that never reads stdin closes it early; that is its business, never an error here.
      child.stdin.on("error", () => undefined);
      child.stdin.end(json);
      // The shell could not start at all: the shell's own code for a command that is not there.
      child.on("error", () => resolve({ exit: 127 }));
      // Killed by a signal: the shell's convention, 128 plus the signal number, and the name for the log.
      const settle = (code: number | null, sig: NodeJS.Signals | null): void => resolve(sig ? { exit: 128 + (constants.signals[sig] ?? 0), signal: sig } : { exit: code ?? 1 });
      child.on("close", settle);
      // Stopped by a forwarded signal: done when the shell is, even if a process it started still holds
      // the output pipes open, which would otherwise keep jevelry waiting for that process.
      child.on("exit", (code, sig) => {
        if (interrupted === undefined) return;
        child.stdout.destroy();
        child.stderr.destroy();
        settle(code, sig);
      });
    });
    return { exit, ms: Date.now() - started, ...(signal ? { signal } : {}), ...(interrupted ? { interrupted } : {}) };
  } finally {
    for (const [sig, forward] of listeners) process.off(sig, forward);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One run line under the ask's id; like an ask line, a failed write costs a warning, never the result. */
export async function logRun(home: string, logId: string, run: RunReport, warn: (message: string) => void): Promise<void> {
  try {
    await appendLine(home, { kind: "run", id: logId, at: new Date().toISOString(), ...run });
  } catch (e) {
    warn(`the run finished but could not be logged: ${e instanceof Error ? e.message : String(e)}`);
  }
}

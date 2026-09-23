import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const picked = answers?.[id];
  if (!answered(picked) || picked.type !== "choice") return fallBack;
  const option = picked.choice;
  if (!Object.hasOwn(q.criteria as object, option)) throw new UnreadableAnswer(`answers.${id}.choice`, `answers.${id} picked ${option}, which is no option of ${id}`);
  const template = Object.hasOwn(q.run!, option) ? q.run![option]! : null;
  const args: RunArgs = {};
  let certainty = picked.certainty;
  for (const [, name] of template?.matchAll(PLACEHOLDER) ?? []) {
    const a = answers?.[name!];
    if (!answered(a)) return fallBack;
    if (a.type === "choice") {
      const options = Object.keys(jevel.questions[name!]!.criteria as Record<string, unknown>);
      if (!options.includes(a.choice) || !SAFE_VALUE.test(a.choice)) throw new UnreadableAnswer(`answers.${name}.choice`, `answers.${name} picked a value that is no option of ${name}`);
      args[name!] = a.choice;
    } else if (a.type === "noul") {
      args[name!] = a.yes;
    }
    certainty = Math.min(certainty, a.certainty);
  }
  const decision = decisionOf(certainty, mergeThresholds(jevel.thresholds, q.thresholds));
  if (decision === "fall_back") return { ...fallBack, certainty };
  const command = template === null ? null : template.replace(PLACEHOLDER, (_, name: string) => String(args[name]));
  return { option, command, args, certainty, decision };
}

/**
 * `/bin/sh -c` with the fixed command. The state goes in only as data: JSON on stdin and in the file
 * `JEVELRY_STATE` names, removed afterwards. The command's output goes to stderr, so a caller's stdout
 * stays one document.
 */
export async function execute(command: string, state: unknown, meta: { decision: Decision; option: string | null; logId: string | null }): Promise<{ exit: number; ms: number }> {
  const dir = mkdtempSync(join(tmpdir(), "jevelry-state-"));
  const file = join(dir, "state.json");
  const json = JSON.stringify(state);
  writeFileSync(file, json, { mode: 0o600 });
  const started = Date.now();
  try {
    const exit = await new Promise<number>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, JEVELRY_STATE: file, JEVELRY_DECISION: meta.decision, JEVELRY_OPTION: meta.option ?? "", JEVELRY_LOG_ID: meta.logId ?? "" },
      });
      child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
      // A command that never reads stdin closes it early; that is its business, never an error here.
      child.stdin.on("error", () => undefined);
      child.stdin.end(json);
      child.on("error", reject);
      child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
    return { exit, ms: Date.now() - started };
  } finally {
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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { ask, errorBody, stateHash } from "./ask.js";
import { installSkill, knownAgents, promptForKey, unknownAgents, whereToPutTheKey } from "./install.js";
import { JevelError, checkState, discoveryDirs, expandQuestions, isEntry, listJevels, loadJevel } from "./jevel.js";
import { defaultClient, fallenAnswers, renderTypes } from "./decide.js";
import { resolveKey, storeKey } from "./key.js";
import { jevelryHome, logAsk, logStateFromEnv, readLog, recordOutcome } from "./log.js";
import { type AskDocument, EXIT, type ErrorBody, type ErrorDocument, PROTOCOL, type RunReport } from "./protocol.js";
import { type Call, dispatcherOf, execute, logRun, planCall } from "./run.js";
import { renderReport, report } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

const say = (line: string): void => { process.stderr.write(`jevelry: ${line}\n`); };
const out = (document: AskDocument | ErrorDocument | unknown): void => { process.stdout.write(`${JSON.stringify(document, null, 2)}\n`); };

function home(): string {
  return jevelryHome(process.env, homedir());
}

function dirs(cli: string[] | undefined): string[] {
  const env = process.env.JEVELRY_JEVELS;
  return discoveryDirs({ cli: cli ?? [], ...(env ? { env } : {}), cwd: process.cwd(), home: home() });
}

/**
 * One line per agent: where the skill went, or which agent this machine does not have. The agents
 * live under the person's home directory, not under `$JEVELRY_HOME`, which only holds the log.
 */
function installed(project: boolean, agents: string[] | undefined): void {
  const requested = agents ?? ["all"];
  const unknown = unknownAgents(requested);
  for (const name of unknown) say(`unknown agent ${name}; known: ${knownAgents().join(", ")}`);
  // Every name a typo: nothing was installed and nothing would have been. That is the host's
  // defect (exit 2), never the silent success a loop over an empty list used to report.
  if (unknown.length === requested.length) process.exit(2);
  for (const result of installSkill({ home: homedir(), cwd: process.cwd(), project, agents: requested })) {
    say(result.installed ? `installed the skill for ${result.agent} at ${result.dir}` : `no ${result.agent} directory found, skipped`);
  }
}

/**
 * `-` is stdin, `@path` is a file, anything else is inline JSON. A read that fails is the host's
 * mistake, not the transport's: it is bad_input with the field named, never a catch-all exit 6.
 */
function readSource(source: string, field: string): unknown {
  let text: string;
  if (source === "-" || source.startsWith("@")) {
    const from = source === "-" ? "standard input" : source.slice(1);
    try {
      text = readFileSync(source === "-" ? 0 : from, "utf8");
    } catch (error) {
      throw new JevelError(field, `${field} could not be read from ${from}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    text = source;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JevelError(field, `${field} is not JSON (a plain text state is written as a JSON string, for example '"text"')`);
  }
}

/** The one exit for a failed `ask`: the error document on stdout, the sentence on stderr, the code. */
function failAsk(error: ErrorBody): never {
  out({ protocol: PROTOCOL, error } satisfies ErrorDocument);
  say(error.message);
  process.exit(error.exit);
}

function failCommand(error: unknown): never {
  const body = errorBody(error);
  say(body.message);
  process.exit(body.exit);
}

/** A mark runs only when a person says y on a terminal; anywhere else it waits for --yes. */
async function confirmOnTty(call: Call, path: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const reply = await rl.question(`Jev picked ${call.option} at ${call.certainty.toFixed(2)}. Run: ${call.command} (from ${path})? [y/N] `);
    return /^y(es)?$/i.test(reply.trim());
  } catch {
    // Ctrl-C or Ctrl-D at the prompt: a no, so the document still prints and the exit is 9.
    process.stderr.write("\n");
    return false;
  } finally {
    rl.close();
  }
}

/** The commander program, built but never parsed here: `cli.ts` is the entry that parses it. */
export function buildProgram(): Command {
  const program = new Command("jevelry")
    .description("A runtime for Jev, TypeSafe's System One model: jevels in, decisions out")
    .version(pkg.version);

  program
    .command("ask [jevel]")
    .description("evaluate a state against a jevel (or --questions) and print one protocol document")
    .requiredOption("--state <source>", "@file, - for stdin, or inline JSON")
    .option("--questions <source>", "@file or inline JSON: the API's questions map, for a one-off ask")
    .option("--model <id>", "model id, overriding the jevel's pin and JEVELRY_MODEL")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .option("--no-log", "do not append this ask to the log")
    .option("--log-state", "write the state itself into the log line, not only its hash (or JEVELRY_LOG_STATE=1)")
    .action(async (jevelName: string | undefined, opts: { state: string; questions?: string; model?: string; jevels: string[]; log: boolean; logState?: boolean }) => {
      let jevel: ReturnType<typeof loadJevel>["jevel"] | undefined;
      let questions: Questions | undefined;
      let state: unknown;
      try {
        if (jevelName) {
          const loaded = loadJevel(jevelName, dirs(opts.jevels));
          jevel = loaded.jevel;
          for (const warning of loaded.warnings) say(`warning: ${warning}`);
        } else if (opts.questions) {
          questions = readSource(opts.questions, "questions") as Questions;
        } else {
          throw new JevelError("jevel", "give a jevel name or --questions");
        }
        state = readSource(opts.state, "state");
      } catch (error) {
        failAsk(errorBody(error));
      }
      let typesafe: TypeSafeClient;
      try {
        typesafe = defaultClient(home());
      } catch (error) {
        failAsk(errorBody(error));
      }
      const askInput = { client: typesafe, state: state as never, ...(jevel ? { jevel } : { questions: questions ?? {} }), ...(opts.model ? { model: opts.model } : {}) };
      const result = await ask(askInput);
      if (!result.ok) failAsk(result.error);
      const document = result.document;
      if (opts.log) {
        const { jevel: j, model, state_hash, answers, usage } = document;
        const logged = opts.logState === true || logStateFromEnv(process.env) ? { state } : {};
        document.log_id = await logAsk(home(), { jevel: j, model, state_hash, ...logged, answers, usage }, (m) => say(`warning: ${m}`));
      }
      out(document);
    });

  program
    .command("run <jevel>")
    .description("ask a jevel whose options are commands, then run the command for Jev's decision")
    .requiredOption("--state <source>", "@file, - for stdin, or inline JSON")
    .option("--yes", "run a mark without asking")
    .option("--dry-run", "print what would run and run nothing")
    .option("--model <id>", "model id, overriding the jevel's pin and JEVELRY_MODEL")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .option("--log-state", "write the state itself into the log line, not only its hash (or JEVELRY_LOG_STATE=1)")
    .action(async (name: string, opts: { state: string; yes?: boolean; dryRun?: boolean; model?: string; jevels: string[]; logState?: boolean }) => {
      let jevel!: ReturnType<typeof loadJevel>["jevel"];
      let state: unknown;
      try {
        const loaded = loadJevel(name, dirs(opts.jevels));
        jevel = loaded.jevel;
        for (const warning of loaded.warnings) say(`warning: ${warning}`);
        dispatcherOf(jevel);
        state = readSource(opts.state, "state");
        // The host's own mistakes stop here, before fall_back: fall_back is for when Jev cannot answer.
        if (!isEntry(state)) throw new JevelError("state", "state must be a string, a JSON object or an array");
        checkState(jevel, state);
        expandQuestions(jevel, state);
      } catch (error) {
        failAsk(errorBody(error));
      }
      let result: Awaited<ReturnType<typeof ask>>;
      try {
        result = await ask({ client: defaultClient(home()), state: state as never, jevel, ...(opts.model ? { model: opts.model } : {}) });
      } catch (error) {
        result = { ok: false, error: errorBody(error) };
      }
      // Planned before the ask is logged: an answer no command can be planned from is a failure like
      // any other, logged as one, and the jevel's fall_back runs.
      let call: Call | undefined;
      if (result.ok) {
        try {
          call = planCall(jevel, result.document.answers);
        } catch (error) {
          result = { ok: false, error: errorBody(error) };
        }
      }
      call ??= planCall(jevel, null);
      const warn = (m: string): void => say(`warning: ${m}`);
      const logged = opts.logState === true || logStateFromEnv(process.env) ? { state } : {};
      const ref = { name: jevel.name, version: jevel.version };
      const logId = result.ok
        ? await logAsk(home(), { jevel: ref, model: result.document.model, state_hash: result.document.state_hash, ...logged, answers: result.document.answers, usage: result.document.usage }, warn)
        : await logAsk(home(), { jevel: ref, model: null, state_hash: stateHash(state), ...logged, answers: fallenAnswers(jevel, state), usage: null, error: result.error }, warn);
      // A ./jevels folder in the project comes first in discovery, so the path says whose commands these are.
      const from = `${call.option ?? "fall_back"} from ${jevel.path}: ${call.command}`;
      let run: RunReport | null = null;
      let exit = 0;
      let killed: number | null = null;
      if (call.command !== null) {
        run = { option: call.option, command: call.command, decision: call.decision, exit: null, ms: null, confirmed: null };
        if (opts.dryRun) {
          say(`${call.decision}: would run ${from}`);
        } else {
          if (call.decision === "mark") run.confirmed = opts.yes === true || (await confirmOnTty(call, jevel.path));
          if (run.confirmed === false) {
            say(`Jev picked ${call.option} at ${call.certainty.toFixed(2)}, which is a mark, so nothing ran; run again with --yes to run: ${call.command}`);
            exit = EXIT.not_confirmed;
          } else {
            say(`running ${from}`);
            const done = await execute(call.command, state, { decision: call.decision, option: call.option, logId });
            run.exit = done.exit;
            run.ms = done.ms;
            if (done.signal) run.signal = done.signal;
            // jevelry itself got the signal: the command was stopped with it, and jevelry exits the way a killed process would.
            exit = done.exit;
            if (done.interrupted) killed = 128 + (constants.signals[done.interrupted] ?? 0);
          }
          if (logId !== null) await logRun(home(), logId, run, warn);
        }
      }
      if (!result.ok) {
        out({ protocol: PROTOCOL, error: result.error, run });
        say(result.error.message);
        process.exitCode = killed ?? result.error.exit;
        return;
      }
      out({ ...result.document, log_id: logId, run });
      process.exitCode = killed ?? exit;
    });

  program
    .command("outcome <log_id> <question> <value>")
    .description("record what later proved true: agree, disagree, an option, a level index, or yes/no")
    .option("--note <text>", "a sentence for the record")
    .action(async (logId: string, question: string, value: string, opts: { note?: string }) => {
      try {
        const { outcome } = await recordOutcome(home(), logId, question, value, opts.note ?? null);
        say(`${outcome}: ${question} on ${logId}`);
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("report")
    .description("agreement per jevel and question from the log")
    .option("--jevel <name>")
    .option("--since <iso>")
    .option("--json", "machine-readable rows")
    .action(async (opts: { jevel?: string; since?: string; json?: boolean }) => {
      try {
        const rows = report(await readLog(home()), { ...(opts.jevel ? { jevel: opts.jevel } : {}), ...(opts.since ? { since: opts.since } : {}) });
        if (opts.json) out(rows);
        else process.stdout.write(renderReport(rows));
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("tui")
    .description("browse the logged decisions in the terminal, review the marked ones and record whether Jev was right")
    .option("--jevel <name>")
    .option("--since <iso>")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .action(async (opts: { jevel?: string; since?: string; jevels: string[] }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        say("tui needs an interactive terminal; use jevelry report for plain text");
        process.exit(1);
      }
      try {
        const { runTui } = await import("./tui/app.js");
        await runTui({ home: home(), dirs: dirs(opts.jevels), version: pkg.version, ...(opts.jevel ? { jevel: opts.jevel } : {}), ...(opts.since ? { since: opts.since } : {}) });
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("list")
    .description("every jevel this runtime can find, first directory wins")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .action((opts: { jevels: string[] }) => {
      for (const j of listJevels(dirs(opts.jevels))) process.stdout.write(`${j.name}\t${j.dir}\n`);
    });

  program
    .command("show <jevel>")
    .description("the resolved frontmatter as JSON, then the body, then the example state when the jevel ships one")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .action((name: string, opts: { jevels: string[] }) => {
      try {
        const { jevel, warnings } = loadJevel(name, dirs(opts.jevels));
        for (const warning of warnings) say(`warning: ${warning}`);
        const { body, ...frontmatter } = jevel;
        process.stdout.write(`${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`);
        // The example state is the jevel's own fixture: it is what `check` cannot tell you, one
        // state the body's Example section names the answers for, so `show` hands it over too.
        const example = join(dirname(jevel.path), "example.json");
        if (existsSync(example)) process.stdout.write(`--- example.json\n${readFileSync(example, "utf8")}`);
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("check <jevel>")
    .description("refuse a defective jevel (exit 2) and warn on the smells the jaggedness page names")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .action((name: string, opts: { jevels: string[] }) => {
      try {
        const { jevel, warnings } = loadJevel(name, dirs(opts.jevels));
        for (const warning of warnings) say(`warning: ${warning}`);
        say(`${jevel.name} v${jevel.version}: ${Object.keys(jevel.questions).length} questions, ${warnings.length} warnings`);
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("types")
    .description("write a TypeScript declaration so jevel(name).decide() returns each jevel's own answer types")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .option("--out <file>", "write the declaration here instead of stdout")
    .action((opts: { jevels: string[]; out?: string }) => {
      try {
        const found = dirs(opts.jevels);
        const text = renderTypes(listJevels(found).map((j) => loadJevel(j.name, found).jevel));
        if (opts.out) writeFileSync(opts.out, text);
        else process.stdout.write(text);
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("models")
    .description("the model names the account may send, from GET /v1/models")
    .action(async () => {
      try {
        const models = await defaultClient(home()).models.list();
        for (const m of models) process.stdout.write(`${m.name}\t${m.release_date}\t${m.description}\n`);
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("install")
    .description("install the jevelry skill into the coding agents on this machine, then store a TypeSafe key")
    .option("--no-key", "install the skill only, asking for no key")
    .option("--project", "install into this project instead of this machine")
    .option("--agent <names...>", "only these agents, by name, instead of every one found")
    .action(async (opts: { key: boolean; project?: boolean; agent?: string[] }) => {
      installed(opts.project === true, opts.agent);
      if (!opts.key) return;
      // A key that is already reachable is left alone: the installer's job is a first key, not a
      // second copy of one in a place the host did not choose.
      if (resolveKey(process.env, home()) !== undefined) {
        say("a TypeSafe key is already available");
        return;
      }
      const value = await promptForKey(home());
      if (value === undefined) {
        say(whereToPutTheKey(home()));
        return;
      }
      const where = storeKey(value, process.env, home());
      say(where === "keychain" ? "key stored in the keychain" : `key stored in ${join(home(), "env")}`);
    });

  program
    .command("install-skill")
    .description("install the jevelry skill into the coding agents, and nothing else")
    .option("--project", "install into this project instead of this machine")
    .option("--agent <names...>", "only these agents, by name, instead of every one found")
    .action((opts: { project?: boolean; agent?: string[] }) => {
      installed(opts.project === true, opts.agent);
    });

  return program;
}

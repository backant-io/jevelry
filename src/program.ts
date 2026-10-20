import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { Command, InvalidArgumentError, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { ask, errorBody, stateHash } from "./ask.js";
import { askAndLog, askBatch } from "./batch.js";
import { type Choice, findModel, hfUrl, licenceLabel, listModels, rank, renderTable } from "./catalog.js";
import { configured, localModel } from "./config.js";
import { installSkill, knownAgents, promptForKey, unknownAgents, whereToPutTheKey } from "./install.js";
import { JevelError, checkState, discoveryDirs, expandQuestions, isEntry, listJevels, loadJevel } from "./jevel.js";
import { defaultClient, fallenAnswers, renderTypes } from "./decide.js";
import { type Machine, budgetBytes, detectMachine } from "./estimate.js";
import { resolveKey, storeKey } from "./key.js";
import { jevelryHome, logAsk, logStateFromEnv, readLog, recordOutcome } from "./log.js";
import { type AskDocument, EXIT, type ErrorBody, type ErrorDocument, PROTOCOL, type RunReport } from "./protocol.js";
import { type Call, dispatcherOf, execute, logRun, planCall } from "./run.js";
import { renderReport, report } from "./report.js";
import { stopServer } from "./server.js";
import { type SetupIO, installLocal, useTypesafe } from "./setup.js";

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

/** One line a person typed on the terminal, asked on stderr; undefined when there is no terminal to ask on. */
async function questionOnTty(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } catch {
    // Ctrl-C or Ctrl-D at the prompt: no answer, which every caller reads as a no.
    process.stderr.write("\n");
    return undefined;
  } finally {
    rl.close();
  }
}

/** A mark runs only when a person says y on a terminal; anywhere else it waits for --yes, and Ctrl-D still prints the document with exit 9. */
async function confirmOnTty(call: Call, path: string): Promise<boolean> {
  const reply = await questionOnTty(`Jev picked ${call.option} at ${call.certainty.toFixed(2)}. Run: ${call.command} (from ${path})? [y/N] `);
  return reply !== undefined && /^y(es)?$/i.test(reply.trim());
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * The installer's voice on the command line. On a terminal the ongoing step rewrites one line; in a
 * pipe or a CI log every step is one line and a download one line per 10%, so the log stays short.
 * A question nobody can answer is said with the way to answer it, since `--yes` is the only yes there.
 */
function cliSetupIO(yes: boolean): SetupIO {
  const tty = process.stderr.isTTY === true;
  let open = false;
  let last = "";
  // A rewritten line has no newline yet: anything said after it starts on a line of its own.
  const end = (): void => {
    if (open) process.stderr.write("\n");
    open = false;
  };
  return {
    say: (line) => {
      end();
      say(line);
    },
    progress: (step, done, total) => {
      const known = done !== undefined && total !== undefined && total > 0;
      const text = known ? `${step} ${Math.floor((done / total) * 100)}% (${(done / 1e9).toFixed(1)} of ${gb(total)})` : step;
      if (tty) {
        process.stderr.write(`\r\x1b[2Kjevelry: ${text}`);
        open = true;
        return;
      }
      const key = known ? `${step} ${Math.floor((done / total) * 10)}` : step;
      if (key === last) return;
      last = key;
      say(text);
    },
    confirm: async (question) => {
      end();
      if (yes) return true;
      if (!process.stdin.isTTY) {
        say(`${question} nobody can answer without a terminal; run again with --yes to answer yes`);
        return false;
      }
      const reply = await questionOnTty(`${question} [Y/n] `);
      return reply !== undefined && /^(y(es)?)?$/i.test(reply.trim());
    },
  };
}

/** The existing key flow: a key that is already reachable is left alone, else one is asked for on the terminal. */
async function storeAKey(): Promise<void> {
  // The installer's job is a first key, not a second copy of one in a place the host did not choose.
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
}

/**
 * The local half of `install`: the ranked list, the person's pick, then the installer. A pick that
 * names nothing is the host's mistake (exit 2, like any bad input); a setup that cannot finish is exit 1.
 */
async function installLocalModel(wanted: string | undefined, yes: boolean): Promise<void> {
  const io = cliSetupIO(yes);
  let machine: Machine;
  let choices: Choice[];
  try {
    machine = detectMachine(process.env);
    choices = rank(await listModels({ hfUrl: hfUrl(process.env) }), machine);
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (choices.length === 0) {
    say("Hugging Face lists no decision model this jevelry can run");
    process.exitCode = 1;
    return;
  }
  if (wanted === undefined) {
    process.stderr.write(renderTable(choices, machine));
    if (!process.stdin.isTTY) {
      say("choose a model: jevelry install --local <id>");
      process.exitCode = 2;
      return;
    }
    const reply = await questionOnTty(`Model (number or id, Enter for 1 ${choices[0]?.model.id}): `);
    if (reply === undefined) {
      say("nothing changed");
      return;
    }
    wanted = reply.trim() || "1";
  }
  const choice = findModel(choices, wanted, machine);
  if (!choice) {
    say(`unknown model ${wanted}; jevelry models --local lists them`);
    process.exitCode = 2;
    return;
  }
  // A tight fit leaves the rest of the machine little memory, so it is installed only after a yes.
  if (choice.fit === "tight" && !(await io.confirm(`${choice.model.name} ${choice.quant.quant} is a tight fit: it needs about ${gb(choice.need)} of the ${gb(budgetBytes(machine))} this machine has for models; install it anyway?`))) {
    say("nothing changed");
    process.exitCode = 1;
    return;
  }
  try {
    const local = await installLocal(choice, home(), io, process.env);
    io.say(`jevelry now asks ${local.name} on this machine (${local.alias})`);
  } catch (error) {
    io.say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
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
    .option("--state <source>", "@file, - for stdin, or inline JSON (required without --batch)")
    .option("--questions <source>", "@file or inline JSON: the API's questions map, for a one-off ask")
    .option("--model <id>", "model id, overriding the jevel's pin and JEVELRY_MODEL")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .option("--no-log", "do not append this ask to the log")
    .option("--log-state", "write the state itself into the log line, not only its hash (or JEVELRY_LOG_STATE=1)")
    .option("--batch", "NDJSON asks on stdin ({id, jevel or questions, state, model?}), one NDJSON answer per line on stdout as each completes")
    .option("--concurrency <n>", "with --batch, how many asks are in flight at once", (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("a whole number of at least 1");
      return n;
    }, 16)
    .action(async (jevelName: string | undefined, opts: { state?: string; questions?: string; model?: string; jevels: string[]; log: boolean; logState?: boolean; batch?: boolean; concurrency: number }, command: Command) => {
      const logOptions = { home: home(), log: opts.log, logState: opts.logState === true || logStateFromEnv(process.env), warn: (m: string) => say(`warning: ${m}`) };
      if (opts.batch) {
        if (jevelName || opts.questions || opts.state) failAsk(errorBody(new JevelError("batch", "with --batch every stdin line names its own jevel or questions and state")));
        let client: TypeSafeClient;
        try {
          client = defaultClient(home());
        } catch (error) {
          failAsk(errorBody(error));
        }
        try {
          await askBatch(createInterface({ input: process.stdin, crlfDelay: Infinity }), {
            ...logOptions,
            client,
            dirs: dirs(opts.jevels),
            ...(opts.model ? { model: opts.model } : {}),
            concurrency: opts.concurrency,
            write: (line) => { process.stdout.write(`${JSON.stringify(line)}\n`); },
          });
        } catch (error) {
          failCommand(error);
        }
        return;
      }
      if (opts.state === undefined) command.error("error: required option '--state <source>' not specified");
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
      const result = await askAndLog(askInput, logOptions);
      if (!result.ok) failAsk(result.error);
      out(result.document);
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
    .description("a full-screen view of your decisions: it opens on the start screen, d shows the dashboard, Review records whether Jev was right, Try asks a jevel live")
    .option("--dashboard", "opens on the dashboard")
    .option("--jevel <name>")
    .option("--since <iso>")
    .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
    .action(async (opts: { dashboard?: boolean; jevel?: string; since?: string; jevels: string[] }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        say("tui needs an interactive terminal; use jevelry report for plain text");
        process.exit(1);
      }
      try {
        const { runTui } = await import("./tui/app.js");
        await runTui({ home: home(), dirs: dirs(opts.jevels), version: pkg.version, ...(opts.jevel ? { jevel: opts.jevel } : {}), ...(opts.since ? { since: opts.since } : {}), ...(opts.dashboard ? { dashboard: true } : {}) });
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
    .description("the model names the account may send, from GET /v1/models; --local ranks the models this machine can run")
    .option("--local", "the decision models on Hugging Face, ranked, with what each needs and how fast it would answer here")
    .option("--json", "with --local, machine-readable rows")
    .action(async (opts: { local?: boolean; json?: boolean }) => {
      try {
        if (opts.local) {
          const machine = detectMachine(process.env);
          const choices = rank(await listModels({ hfUrl: hfUrl(process.env) }), machine);
          if (!opts.json) {
            process.stdout.write(renderTable(choices, machine));
            return;
          }
          out(choices.map((c) => ({
            id: c.model.id,
            repo: c.model.repo,
            name: c.model.name,
            quant: c.quant.quant,
            file: c.quant.file,
            download_bytes: c.quant.bytes,
            need_bytes: Math.round(c.need),
            fit: c.fit,
            score: c.model.score,
            seconds_per_question: c.seconds,
            licence: licenceLabel(c.model.licence),
            decision_type: c.model.decisionType,
          })));
          return;
        }
        // The same rule as defaultClient: a base URL in the environment wins over the local model.
        const local = localModel(home());
        if (local && (process.env.TYPESAFE_BASE_URL ?? "").trim() === "") {
          // The local server answers as its alias whatever is asked, so there is nothing to ask it.
          process.stdout.write(`${local.alias}\tlocal\t${local.name} on this machine\n`);
          return;
        }
        const models = await defaultClient(home()).models.list();
        for (const m of models) process.stdout.write(`${m.name}\t${m.release_date}\t${m.description}\n`);
      } catch (error) {
        failCommand(error);
      }
    });

  program
    .command("stop")
    .description("stop the local model server jevelry started")
    .action(() => {
      say(stopServer(home()) ? "stopped the local model server" : "no local model server was running");
    });

  program
    .command("install")
    .description("install the jevelry skill into the coding agents on this machine, then set up Jev: a TypeSafe key or a model on this machine")
    .option("--no-key", "install the skill only, asking for no key")
    .option("--project", "install into this project instead of this machine")
    .option("--agent <names...>", "only these agents, by name, instead of every one found")
    .addOption(new Option("--local [model]", "run a model on this machine: that one (an id or row from jevelry models --local), or choose from the list").conflicts("typesafe"))
    .option("--typesafe", "ask hosted Jev with a TypeSafe key")
    .option("--yes", "answer yes to the Homebrew and tight-fit questions (needed without a terminal)")
    .action(async (opts: { key: boolean; project?: boolean; agent?: string[]; local?: string | true; typesafe?: boolean; yes?: boolean }) => {
      installed(opts.project === true, opts.agent);
      if (!opts.key) return;
      if (opts.typesafe) {
        useTypesafe(home());
        await storeAKey();
        return;
      }
      if (opts.local !== undefined) {
        await installLocalModel(opts.local === true ? undefined : opts.local, opts.yes === true);
        return;
      }
      // A jevelry that already asks somewhere is left alone; switching is a deliberate flag.
      const now = configured(process.env, home());
      if (now !== null) {
        say(`jevelry asks ${now === "local" ? `${localModel(home())!.name} on this machine` : "hosted Jev with your TypeSafe key"}; jevelry install --local or --typesafe changes it`);
        return;
      }
      // A pipe or a CI job: nothing can be chosen, so both ways are named instead of waiting for a line.
      if (!process.stdin.isTTY) {
        say(whereToPutTheKey(home()));
        say("or run a model on this machine: jevelry models --local, then jevelry install --local <id>");
        return;
      }
      const reply = await questionOnTty("How should jevelry ask Jev?\n  1  TypeSafe, hosted: needs an API key\n  2  A model on this machine: free and private, downloads 1 to 30 GB\nChoose 1 or 2: ");
      if (reply?.trim() === "1") {
        useTypesafe(home());
        await storeAKey();
      } else if (reply?.trim() === "2") {
        await installLocalModel(undefined, opts.yes === true);
      } else {
        say("nothing changed");
      }
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { Command } from "commander";
import { ask, errorBody } from "./ask.js";
import { installSkill, knownAgents, promptForKey, unknownAgents, whereToPutTheKey } from "./install.js";
import { JevelError, discoveryDirs, listJevels, loadJevel } from "./jevel.js";
import { defaultClient } from "./decide.js";
import { resolveKey, storeKey } from "./key.js";
import { appendLine, findAsk, jevelryHome, logAsk, outcomeOf, readLog } from "./log.js";
import { type AskDocument, type ErrorBody, type ErrorDocument, PROTOCOL } from "./protocol.js";
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
    .action(async (jevelName: string | undefined, opts: { state: string; questions?: string; model?: string; jevels: string[]; log: boolean }) => {
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
        document.log_id = await logAsk(home(), { jevel: j, model, state_hash, answers, usage }, (m) => say(`warning: ${m}`));
      }
      out(document);
    });

  program
    .command("outcome <log_id> <question> <value>")
    .description("record what later proved true: agree, disagree, an option, a level index, or yes/no")
    .option("--note <text>", "a sentence for the record")
    .action(async (logId: string, question: string, value: string, opts: { note?: string }) => {
      try {
        const lines = await readLog(home());
        const found = findAsk(lines, logId);
        if (!found) throw new JevelError("log_id", `no ask with id ${logId} in the log`);
        const { outcome, value: recorded } = outcomeOf(found, question, value);
        await appendLine(home(), { kind: "outcome", id: logId, question, outcome, value: recorded, note: opts.note ?? null, at: new Date().toISOString() });
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

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { Command } from "commander";
import { ask, errorBody } from "./ask.js";
import { JevelError, discoveryDirs, listJevels, loadJevel } from "./jevel.js";
import { appendLine, findAsk, jevleryHome, outcomeOf, readLog } from "./log.js";
import { type AskDocument, type ErrorBody, type ErrorDocument, PROTOCOL } from "./protocol.js";
import { renderReport, report } from "./report.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };

const say = (line: string): void => { process.stderr.write(`jevlery: ${line}\n`); };
const out = (document: AskDocument | ErrorDocument | unknown): void => { process.stdout.write(`${JSON.stringify(document, null, 2)}\n`); };

function home(): string {
  return jevleryHome(process.env, homedir());
}

function dirs(cli: string[] | undefined): string[] {
  const env = process.env.JEVLERY_JEVELS;
  return discoveryDirs({ cli: cli ?? [], ...(env ? { env } : {}), cwd: process.cwd(), home: home() });
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

function client(): TypeSafeClient {
  const timeout = Number(process.env.JEVLERY_TIMEOUT_MS ?? 30000);
  const model = process.env.JEVLERY_MODEL;
  return new TypeSafeClient(model && model.trim() !== "" ? { timeout, defaultModel: model } : { timeout });
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

export const program = new Command("jevlery")
  .description("A runtime for Jev, TypeSafe's System One model: jevels in, verdicts out")
  .version(pkg.version);

program
  .command("ask [jevel]")
  .description("evaluate a state against a jevel (or --questions) and print one protocol document")
  .requiredOption("--state <source>", "@file, - for stdin, or inline JSON")
  .option("--questions <source>", "@file or inline JSON: the API's questions map, for a one-off ask")
  .option("--model <id>", "model id, overriding the jevel's pin and JEVLERY_MODEL")
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
      typesafe = client();
    } catch (error) {
      failAsk(errorBody(error));
    }
    const askInput = { client: typesafe, state: state as never, ...(jevel ? { jevel } : { questions: questions ?? {} }), ...(opts.model ? { model: opts.model } : {}) };
    const result = await ask(askInput);
    if (!result.ok) failAsk(result.error);
    const document = result.document;
    if (opts.log) {
      const id = randomUUID();
      // The answer is the product and the log is this runtime's own record, never the host's truth:
      // a log that cannot be written costs a warning and a null log_id, never the paid answer.
      try {
        await appendLine(home(), {
          kind: "ask",
          id,
          at: new Date().toISOString(),
          jevel: document.jevel,
          model: document.model,
          state_hash: document.state_hash,
          answers: document.answers,
          usage: document.usage,
          cwd: process.cwd(),
        });
        document.log_id = id;
      } catch (error) {
        say(`warning: the ask was answered but could not be logged: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    const rows = report(await readLog(home()), { ...(opts.jevel ? { jevel: opts.jevel } : {}), ...(opts.since ? { since: opts.since } : {}) });
    if (opts.json) out(rows);
    else process.stdout.write(renderReport(rows));
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
  .description("the resolved frontmatter as JSON, then the body")
  .option("--jevels <dir>", "a jevels directory searched first (repeatable)", (d: string, all: string[]) => [...all, d], [] as string[])
  .action((name: string, opts: { jevels: string[] }) => {
    try {
      const { jevel, warnings } = loadJevel(name, dirs(opts.jevels));
      for (const warning of warnings) say(`warning: ${warning}`);
      const { body, ...frontmatter } = jevel;
      process.stdout.write(`${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`);
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
      const models = await client().models.list();
      for (const m of models) process.stdout.write(`${m.name}\t${m.release_date}\t${m.description}\n`);
    } catch (error) {
      failCommand(error);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  say(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

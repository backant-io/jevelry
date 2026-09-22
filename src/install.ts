import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createInterface, type Interface, type ReadLineOptions } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_VARIABLE } from "./key.js";

export interface AgentDir {
  agent: string;
  dir: string;
}

export interface InstallResult {
  agent: string;
  dir: string;
  installed: boolean;
  reason?: string;
}

export interface InstallInput {
  home: string;
  cwd: string;
  project: boolean;
  agents: string[];
  source?: string;
}

/**
 * Where each coding agent keeps the skills it reads. The machine-wide directories are the ones an
 * agent loads for every project; `--project` writes into the repository instead, where the two
 * conventions a project can carry are Claude Code's own and the shared `.agents/` one.
 */
export function agentDirs(home: string, cwd: string, project: boolean): AgentDir[] {
  if (project) {
    return [
      { agent: "claude-code", dir: join(cwd, ".claude", "skills") },
      { agent: "agents", dir: join(cwd, ".agents", "skills") },
    ];
  }
  return [
    { agent: "claude-code", dir: join(home, ".claude", "skills") },
    { agent: "codex", dir: join(home, ".codex", "skills") },
    { agent: "cursor", dir: join(home, ".cursor", "skills") },
    { agent: "opencode", dir: join(home, ".config", "opencode", "skills") },
    { agent: "pi", dir: join(home, ".pi", "agent", "skills") },
  ];
}

/**
 * Every agent name `--agent` accepts, machine-wide ones first, read from `agentDirs` itself so the
 * list a mistyped name is measured against cannot drift from the list that is installed into.
 */
export function knownAgents(): string[] {
  return [...new Set([...agentDirs("", "", false), ...agentDirs("", "", true)].map(({ agent }) => agent))];
}

/** The names in `agents` that no agent answers to. `all` is the keyword for every one of them. */
export function unknownAgents(agents: string[]): string[] {
  const known = knownAgents();
  return agents.filter((name) => name !== "all" && !known.includes(name));
}

/**
 * The skill directory inside the installed package, resolved from this module's own location so it
 * is found from `dist/` in a tarball as well as from `src/` in the repository.
 */
export function packagedSkill(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "jevelry");
}

/**
 * Copies the skill for every agent asked for, replacing an older copy rather than merging into it,
 * so a file this version no longer ships stops being read. Machine-wide, an agent whose own
 * directory is absent is not installed for: creating `~/.cursor` would claim an agent is there.
 */
export function installSkill(input: InstallInput): InstallResult[] {
  const source = input.source ?? packagedSkill();
  const wanted = input.agents.length === 0 || input.agents.includes("all") ? undefined : new Set(input.agents);
  return agentDirs(input.home, input.cwd, input.project)
    .filter(({ agent }) => wanted === undefined || wanted.has(agent))
    .map(({ agent, dir }) => {
      const target = join(dir, "jevelry");
      if (!input.project && !existsSync(dirname(dir))) return { agent, dir: target, installed: false, reason: `no ${dirname(dir)} directory` };
      mkdirSync(dir, { recursive: true });
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });
      return { agent, dir: target, installed: true };
    });
}

export type ReadlineFactory = (options: ReadLineOptions) => Interface;

/**
 * Asks for the key on stderr and reads one line with the echo off, so the key is not on the screen
 * and not in a scrollback. Nothing to ask when stdin is not a terminal (a pipe, a CI job): the
 * caller says where to put the key instead of waiting for a line that will never come. The
 * readline factory is a parameter so a test can hand it an interface that is not this Node's.
 */
export async function promptForKey(home: string, makeInterface: ReadlineFactory = createInterface): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const question = `TypeSafe API key (Enter to skip): `;
  const rl = makeInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // Muting the echo means replacing `_writeToOutput`, which readline does not promise anybody. A
  // build that does not have it would echo the key to the screen, so nothing is read at all: a key
  // the person types into their scrollback is worse than a key they have to place themselves.
  if (typeof (rl as { _writeToOutput?: unknown })._writeToOutput !== "function") {
    rl.close();
    process.stderr.write(`jevelry: ${hiddenInputUnavailable(home)}\n`);
    return undefined;
  }
  // readline echoes what is typed; this writes the prompt once and nothing after it.
  let asked = false;
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {
    if (!asked) {
      asked = true;
      process.stderr.write(question);
    }
  };
  rl.on("SIGINT", () => {
    rl.close();
    process.stderr.write("\n");
    process.exit(130);
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
      // Ctrl-D, or a terminal that goes away mid-prompt: no line is ever delivered, and a promise
      // that never settles would end the command in silence instead of saying where to put a key.
      rl.on("close", () => resolve(""));
    });
    return answer.trim() === "" ? undefined : answer.trim();
  } finally {
    // Closing restores the terminal, whatever happened above; the newline ends the muted line.
    rl.close();
    process.stderr.write("\n");
  }
}

/** The sentence a host sees when no key was stored, naming every place jevelry will look. */
export function whereToPutTheKey(home: string): string {
  return `no key stored; put it in ${KEY_VARIABLE}, your keychain (service typesafe-api-key, account jevelry) or ${join(home, "env")}`;
}

/** The same places, for the build that cannot hide what a person types. */
export function hiddenInputUnavailable(home: string): string {
  return `hidden input is unavailable on this Node version; put the key in ${KEY_VARIABLE}, your keychain (service typesafe-api-key, account jevelry) or ${join(home, "env")}`;
}

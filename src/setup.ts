import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { ask } from "./ask.js";
import { type Choice, MIN_BUILD, hfUrl } from "./catalog.js";
import { type JevServer, type LocalModel, writeConfig } from "./config.js";
import { localClient, serverClient } from "./decide.js";
import { downloadFile, modelPath, remoteFile } from "./download.js";
import { budgetBytes, detectMachine, fitOf, needBytes, realMachine } from "./estimate.js";
import { WINDOWS, ensureServer, findOnPath, llamaServerPath, realHome, serverBuild, stopServer, stopServerAndWait } from "./server.js";

/** How the installer talks to a person; the CLI and the TUI each implement it, so this file draws nothing. */
export interface SetupIO {
  /** A finished step. */
  say: (line: string) => void;
  /** An ongoing step, with how far along it is when that is known. */
  progress: (step: string, done?: number, total?: number) => void;
  confirm: (question: string) => Promise<boolean>;
}

/** A setup that cannot go on, with a message a person can act on: the CLI prints it, the TUI shows it. */
export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * Whether the llama-server there can run `type`: there is one, and its build is new enough. An unknown
 * build (one made without git) is given the benefit of the doubt: the smoke ask after start tells.
 */
export function runtimeReady(type: string, env: NodeJS.ProcessEnv): boolean {
  const path = llamaServerPath(env);
  if (path === undefined) return false;
  const build = serverBuild(path);
  return build === null || build >= (MIN_BUILD[type] ?? 0);
}

/** The llama-server to run `type` with: the one there when it is new enough, else one Homebrew installs or upgrades after a yes. */
export async function installRuntime(type: string, io: SetupIO, env: NodeJS.ProcessEnv): Promise<string> {
  if (runtimeReady(type, env)) return llamaServerPath(env)!;
  const min = MIN_BUILD[type] ?? 0;
  const help = `llama.cpp is needed to run local models; install it with brew install llama.cpp or from https://github.com/ggml-org/llama.cpp/releases (build ${min} or newer)`;
  const brew = env.JEVELRY_BREW?.trim() || findOnPath("brew", env);
  if (!brew) throw new SetupError(help);
  const verb = llamaServerPath(env) ? "upgrade" : "install";
  if (!(await io.confirm(`install llama.cpp with Homebrew (brew ${verb} llama.cpp)?`))) throw new SetupError(help);
  const lines: string[] = [];
  const exit = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(brew, [verb, "llama.cpp"], { stdio: ["ignore", "pipe", "pipe"], env });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        lines.push(line);
        io.progress(`brew: ${line}`);
      });
    }
    child.on("error", reject);
    child.on("close", resolve);
  }).catch((error: unknown) => {
    throw new SetupError(`brew could not be started: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (exit !== 0) throw new SetupError(`brew ${verb} llama.cpp failed with exit ${exit}:\n${lines.slice(-5).join("\n")}`);
  if (runtimeReady(type, env)) return llamaServerPath(env)!;
  const path = llamaServerPath(env);
  if (!path) throw new SetupError(help);
  throw new SetupError(`llama.cpp build ${serverBuild(path)} is still older than build ${min}, which ${type} models need; install a newer one from https://github.com/ggml-org/llama.cpp/releases`);
}

/** A port nothing listens on now, picked by the system; it stays the model's port from here on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

/** The question every install asks once before it writes the config: a model that cannot answer it is not set up. */
const CHECK = { state: "jevelry setup check", questions: { ok: { type: "noul", instructions: "Is this a setup check?" } } } as const;

/**
 * Sets up `choice` end to end: llama.cpp, the verified download, the config, the server and one smoke
 * ask through the same client every jevelry ask uses. Every failure is a SetupError with its reason.
 */
export async function installLocal(choice: Choice, home: string, io: SetupIO, env: NodeJS.ProcessEnv): Promise<LocalModel> {
  const { model, quant } = choice;
  try {
    // Refused before any download: neither could ever start the model it would fetch.
    if (process.platform === "win32") throw new SetupError(WINDOWS);
    mkdirSync(home, { recursive: true });
    realHome(home);
    const budget = budgetBytes(detectMachine(env));
    // A model too big for the GPU's memory is what crashed this machine once: it is refused before any download.
    const tooBig = (need: number, have = budget): SetupError => new SetupError(`${model.name} needs about ${gb(need)} and this machine has about ${gb(have)} for models`);
    if (choice.fit === "won't fit") throw tooBig(choice.need);
    await installRuntime(model.decisionType, io, env);
    const hf = hfUrl(env);
    const remote = await remoteFile(model.repo, quant.file, { hfUrl: hf });
    // The catalog's size is an estimate; the exact one decides.
    const need = needBytes({ bytes: remote.bytes, params: model.params, decisionType: model.decisionType });
    // JEVELRY_MACHINE shows what another machine could run; what is installed must also fit this one.
    const have = Math.min(budget, budgetBytes(realMachine()));
    if (fitOf(need, have) === "won't fit") throw tooBig(need, have);
    const path = modelPath(home, model.repo, quant.file);
    // jevelry knows its server by the alias in the process table, which reads the same in every locale only in ASCII.
    const alias = `local/${quant.file.replace(/\.gguf$/i, "")}`;
    if (!/^local\/[A-Za-z0-9._-]+$/.test(alias)) throw new SetupError(`refusing a model file name that is not plain ASCII: ${quant.file}`);
    await downloadFile(remote, path, { hfUrl: hf, onProgress: (done, total) => io.progress("download", done, total) });
    const local: LocalModel = {
      repo: model.repo,
      file: quant.file,
      quant: quant.quant,
      name: model.name,
      decisionType: model.decisionType,
      path,
      port: await freePort(),
      alias,
      params: model.params,
    };
    // Two models in memory at once is how a GPU runs out: the old process has exited, not just left its port, before the new one loads.
    const { left } = await stopServerAndWait(home);
    if (left.length > 0) throw new SetupError(`the previous local model server (pid ${left.join(", ")}) did not stop; stop it and try again`);
    // Ctrl-C or a kill while the new model loads must not leave it holding the GPU's memory with no config naming it:
    // a signal exits with 130 or 143, and every exit, the TUI's process.exit too, sends the new server SIGTERM first.
    // An exit cannot wait, so its record stays until the server is gone, and an ask meanwhile loads nothing beside it.
    const stop = (): void => { stopServer(home); };
    const quit = (signal: NodeJS.Signals): void => process.exit(signal === "SIGINT" ? 130 : 143);
    process.on("SIGINT", quit).on("SIGTERM", quit).on("exit", stop);
    try {
      await ensureServer(home, local, env, { onWait: () => io.progress("loading the model") });
      const started = Date.now();
      // The new model's own client, not defaultClient: an exported TYPESAFE_BASE_URL would send the check elsewhere and pass it there.
      const result = await ask({ client: localClient(home, local, env), ...CHECK });
      if (!result.ok) throw new SetupError(`${model.name} did not answer the setup check: ${result.error.message}`);
      io.say(`${model.name} answered in ${Date.now() - started} ms on this machine`);
    } catch (error) {
      // The config is written only after the check passes, so a failed install leaves the setup that worked before,
      // and the new model is out of memory before the error reaches anyone who might ask the old one.
      await stopServerAndWait(home);
      throw error;
    } finally {
      process.off("SIGINT", quit).off("SIGTERM", quit).off("exit", stop);
    }
    writeConfig(home, { backend: "local", local });
    return local;
  } catch (error) {
    throw error instanceof SetupError ? error : new SetupError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Switches jevelry to a Jev server that already runs at `url`, after one smoke ask through the client every ask
 * will use. jevelry's own llama-server is stopped once the server answered, so no second model stays in memory.
 * Every failure is a SetupError and leaves the config as it was.
 */
export async function useServer(url: string, model: string, home: string, io: SetupIO, env: NodeJS.ProcessEnv): Promise<JevServer> {
  // A llama-server jevelry started is stopped below, and the config would then name a server that is gone.
  if (model.startsWith("local/")) throw new SetupError(`${url} is a llama-server jevelry started; jevelry install --local switches to its model`);
  const server = { url, model };
  const started = Date.now();
  const result = await ask({ client: serverClient(server, env), ...CHECK });
  if (!result.ok) throw new SetupError(`${model} did not answer the setup check: ${result.error.message}`);
  io.say(`${model} answered in ${Date.now() - started} ms at ${url}`);
  const { left } = await stopServerAndWait(home);
  if (left.length > 0) throw new SetupError(`the local model server (pid ${left.join(", ")}) did not stop; stop it and try again`);
  writeConfig(home, { backend: "server", server });
  return server;
}

/**
 * Choosing hosted Jev keeps the local model on disk and in the file, so switching back needs no download, and
 * stops its server, which gives the GPU's memory back by the time this returns.
 */
export async function useTypesafe(home: string): Promise<void> {
  writeConfig(home, { backend: "typesafe" });
  await stopServerAndWait(home);
}

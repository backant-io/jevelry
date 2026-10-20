import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LocalModel } from "./config.js";
import { budgetBytes, fitOf, needBytes, realMachine } from "./estimate.js";

/** `{ pid, port, path, alias }` of the server jevelry started, so `jevelry stop` stops that one and nothing else. */
export const SERVER_FILE = "server.json";
export const SERVER_LOG = "llama-server.log";

/** The first executable file of that name in `env.PATH`, the way a shell would find it. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory: try the next one.
    }
  }
  return undefined;
}

/** `JEVELRY_LLAMA_SERVER` wins, so a test never reaches a real llama-server; else the one on PATH. */
export function llamaServerPath(env: NodeJS.ProcessEnv): string | undefined {
  const given = env.JEVELRY_LLAMA_SERVER?.trim();
  if (given) return given;
  return findOnPath(process.platform === "win32" ? "llama-server.exe" : "llama-server", env);
}

/**
 * The build number from `llama-server --version`: "version: 0.7.0 (build 11669, commit 620d222)" on
 * new builds, "version: 7210 (2ba719519)" on old ones. Build 0 is a build made without git, as
 * unknown as no match at all.
 */
export function buildOf(versionText: string): number | null {
  const match = /\(build (\d+)/.exec(versionText) ?? /version: (\d+) \(/.exec(versionText);
  const build = match ? Number(match[1]) : 0;
  return build > 0 ? build : null;
}

/** llama-server prints its version to stderr, so both streams are read. */
export function serverBuild(path: string): number | null {
  const ran = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 5000 });
  return buildOf(`${ran.stdout ?? ""}${ran.stderr ?? ""}`);
}

/**
 * `-np 1` for every family because vllm-d3's answers change when requests share a batch; `-b` and
 * `-ub` hold a whole prompt because laya, clef, vllm-d3 and lfm2-d1-omni evaluate it in one ubatch;
 * `-c` is always given because the default is 262144; `--no-mmproj` because the file is given with
 * `-m`; and the model unloads after 300 idle seconds, so an idle jevelry gives the GPU memory back.
 */
export function launchArgs(local: LocalModel): string[] {
  return [
    "-m", local.path, "--host", "127.0.0.1", "--port", String(local.port), "--alias", local.alias,
    "--no-webui", "--no-mmproj", "-c", "8192", "-b", "4096", "-ub", "4096", "-np", "1", "--sleep-idle-seconds", "300",
  ];
}

/**
 * llama-server answers 503 while the model loads and 200 when it is ready. Only a refused connection
 * is "down": a timeout is a server too busy to answer in time, polled again rather than started twice.
 * Any other answer still means something listens and is not loading: "ok", and ensureServer then
 * checks it is ours.
 */
export async function health(port: number): Promise<"ok" | "loading" | "down"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    await response.text();
    return response.status === 503 ? "loading" : "ok";
  } catch (error) {
    return (error as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED" ? "down" : "loading";
  }
}

function record(home: string, pid: number, local: LocalModel): void {
  writeFileSync(join(home, SERVER_FILE), `${JSON.stringify({ pid, port: local.port, path: local.path, alias: local.alias })}\n`);
}

/** What SERVER_FILE says, unchecked: empty when it is missing or unreadable. */
function recorded(home: string): { pid?: unknown; port?: unknown; path?: unknown; alias?: unknown } {
  try {
    return { ...JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) };
  } catch {
    return {};
  }
}

/**
 * Runs `fn` holding `server.lock` in `home`, so jevelry processes that ask at once start one server
 * between them. A lock whose holder died is taken over. It is held around check-and-spawn only, never
 * while a model loads.
 */
async function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(home, "server.lock");
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: number;
    try {
      holder = Number(readFileSync(lock, "utf8"));
    } catch {
      continue; // Released in between: take it.
    }
    // An empty lock is one whose holder is still writing its pid: it counts as held.
    // ponytail: a dead holder's pid reused by another program keeps the lock held; compare the lock's age if that ever bites.
    if (holder > 0 && !alive(holder)) rmSync(lock, { force: true });
    else if (Date.now() >= deadline) throw new Error("another jevelry is starting the local model server; try again");
    else await sleep(100);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * Spawned detached with its output in the log, so it outlives the command that started it and serves
 * the next ask. A server on record that is ours is never joined by a second one: the same model is
 * waited for, and another model is refused, because two models at once is how a GPU runs out of memory.
 */
async function launch(home: string, local: LocalModel, env: NodeJS.ProcessEnv): Promise<number> {
  const bin = llamaServerPath(env);
  if (!bin) throw new Error("llama-server is not installed; run jevelry install --local");
  if (!existsSync(local.path)) throw new Error(`the model file is missing: ${local.path}; run jevelry install --local`);
  // A synced $JEVELRY_HOME or a config from a bigger machine must not load what this one cannot hold.
  const need = needBytes({ bytes: statSync(local.path).size, params: local.params ?? 0, decisionType: local.decisionType });
  const budget = budgetBytes(realMachine());
  if (fitOf(need, budget) === "won't fit") {
    throw new Error(`${local.alias} needs about ${gb(need)} and this machine has about ${gb(budget)} for models; run jevelry install --local to pick a smaller model`);
  }
  mkdirSync(home, { recursive: true });
  return withLock(home, async () => {
    const server = recorded(home);
    if (isOurs(server.pid, server.path, server.port)) {
      if (server.path === local.path && server.port === local.port) return server.pid;
      throw new Error(`a different local model is running (${String(server.alias)}); run jevelry stop first, or restart this program if jevelry was switched to another model`);
    }
    // ponytail: the log is appended to on every start and never rotated; truncate it at start if it ever grows large.
    const log = openSync(join(home, SERVER_LOG), "a");
    try {
      // The launch arguments alone decide what the server loads (llama-server also reads LLAMA_ARG_*),
      // and the hosted key never sits in a long-lived process.
      const serverEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "TYPESAFE_API_KEY" && !key.startsWith("LLAMA_")));
      const child = spawn(bin, launchArgs(local), { detached: true, stdio: ["ignore", log, log], env: serverEnv });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      // Recorded before the lock is released, so a launch in another process finds it and waits for it.
      record(home, child.pid!, local);
      return child.pid!;
    } finally {
      closeSync(log);
    }
  });
}

export async function startServer(home: string, local: LocalModel, env: NodeJS.ProcessEnv): Promise<void> {
  await launch(home, local, env);
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

function lastLines(file: string, count: number): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-count).join("\n");
  } catch {
    return "(no log)";
  }
}

async function servesAlias(port: number, alias: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { data: Array<{ id?: unknown; aliases?: unknown }> };
    return body.data.some((m) => m.id === alias || (Array.isArray(m.aliases) && m.aliases.includes(alias)));
  } catch {
    return false;
  }
}

async function waitReady(home: string, local: LocalModel, env: NodeJS.ProcessEnv, options: { timeoutMs?: number; onWait?: (state: "starting" | "loading") => void }): Promise<void> {
  const log = join(home, SERVER_LOG);
  const timeoutMs = options.timeoutMs ?? 300000;
  const deadline = Date.now() + timeoutMs;
  const another = `another server answers on port ${local.port}, not ${local.alias}; run jevelry install --local to pick a new port`;
  let pid: number | undefined;
  let told: "starting" | "loading" | undefined;
  let state = await health(local.port);
  for (;;) {
    // Checked before any request: another program on the port would be handed the state and its answer read as Jev's.
    if (state !== "down" && process.platform !== "win32") {
      const server = recorded(home);
      if (!isOurs(server.pid, local.path, local.port)) throw new Error(another);
    }
    if (state === "ok") break;
    if (state === "down") {
      if (pid === undefined) pid = await launch(home, local, env);
      // Down while ours is gone is a server that died; down while ours lives is one still starting.
      else if (!alive(pid)) throw new Error(`the local model server stopped while starting; the last lines of ${log}:\n${lastLines(log, 5)}`);
    }
    const waiting = state === "loading" ? "loading" : "starting";
    if (waiting !== told) {
      told = waiting;
      options.onWait?.(waiting);
    }
    if (Date.now() >= deadline) throw new Error(`the local model server did not become ready in ${Math.round(timeoutMs / 1000)} s; see ${log}`);
    await sleep(500);
    state = await health(local.port);
  }
  // Windows cannot tell whose process it is, so what the server says it serves is the only check there.
  if (process.platform === "win32" && !(await servesAlias(local.port, local.alias))) throw new Error(another);
}

/** One wait per port in this process, so a batch of concurrent asks starts one server, not one each. */
const waits = new Map<number, Promise<void>>();

/** Resolves once the server for `local` is ours and ready, starting it when nothing listens on its port. */
export function ensureServer(home: string, local: LocalModel, env: NodeJS.ProcessEnv, options: { timeoutMs?: number; onWait?: (state: "starting" | "loading") => void } = {}): Promise<void> {
  let wait = waits.get(local.port);
  if (!wait) {
    // Forgotten once settled: the next ask checks again, so a server stopped in the meantime is started again.
    wait = waitReady(home, local, env, options).finally(() => waits.delete(local.port));
    waits.set(local.port, wait);
  }
  return wait;
}

/**
 * Whether `pid` is a llama-server jevelry started for the model at `path` on `port`. A pid on record
 * may be stale, after a reboot for one, and belong to another program by now, and a port may be taken
 * by any program: only the command line tells. Pid 0 and below signal a whole process group or every
 * process. Windows has no cheap way to read a command line, so nothing there is ours.
 */
function isOurs(pid: unknown, path: unknown, port: unknown): pid is number {
  if (process.platform === "win32" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof path !== "string" || path === "" || !alive(pid)) return false;
  try {
    const command = process.platform === "linux"
      ? readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ")
      : (spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).stdout ?? "");
    return command.includes(path) && `${command.trim()} `.includes(`--port ${String(port)} `);
  } catch {
    return false;
  }
}

/** The pid of the server jevelry started when it was running and got SIGTERM, else null. The file goes either way: it named nothing alive after this. */
export function stopServer(home: string): number | null {
  const server = recorded(home);
  rmSync(join(home, SERVER_FILE), { force: true });
  if (!isOurs(server.pid, server.path, server.port)) return null;
  try {
    process.kill(server.pid, "SIGTERM");
    return server.pid;
  } catch {
    return null;
  }
}

/**
 * The SDK's fetch in local mode: every request first makes sure the server is up, so the first ask
 * starts it. The SDK's timeout and a caller's abort end the wait for a slow load too, and the wait
 * gives up 2 s before the SDK does, so the error a person reads names the log.
 */
export function localFetch(home: string, local: LocalModel, env: NodeJS.ProcessEnv, timeoutMs?: number): (input: string, init?: RequestInit) => Promise<Response> {
  // Never under 1 s: a shorter wait would give up the moment the server is spawned.
  const options = timeoutMs === undefined ? {} : { timeoutMs: Math.max(timeoutMs - 2000, 1000) };
  return async (input, init) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      ensureServer(home, local, env, options).then(resolve, reject);
    });
    return fetch(input, init);
  };
}

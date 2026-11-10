import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MIN_BUILD } from "./catalog.js";
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
 * `-np 1` for every family but kev and lev because vllm-d3's answers change when requests share a batch; `-b` and
 * `-ub` hold a whole prompt because laya, clef, vllm-d3, lfm2-d1-omni, lfm3-d1 and lfm3-d1-omni evaluate it in one
 * ubatch; `-c` is always given because the default is 262144; `--no-mmproj` because the file is given with
 * `-m`; and the model unloads after 300 idle seconds, so an idle jevelry gives the GPU memory back.
 *
 * For a family that evaluates a prompt in one ubatch, the ubatch is the longest state with one question it takes.
 * vllm-d3 and lfm3-d1 get 8192, the whole context. With 4096, vLLM-SR d3-nano 2B refused a question of 4,467 tokens
 * and Liquid d1 2B one of 5,364; with 8192 they answered 7,629 and 6,358. On both, all 267 answers to the shipped
 * prompts were the same bytes, and the 17 shipped examples took 75.4 s against 74.5 s on d1 2B, the two taken in turn
 * four times each. Memory grows only when a long state arrives: after its longest, d3-nano's server stood at 1,487 MB
 * instead of 725 MB, and vLLM-SR d3-flash 9B at 7.10 GiB resident against an estimate of 7.67 GiB.
 *
 * kev alone gets 512 tokens a ubatch. It keeps full-vocabulary logits for every token of a ubatch,
 * about 1 MB a token, and keeps them after the answer. Measured on Kev 0.8B (llama.cpp 0.9.0, M4 Pro):
 * one 2239-token prompt left the server at 2784 MB with 4096 and at 810 MB with 512, the median ask
 * was a tenth faster, and all 91 shipped examples and cases were answered the same, byte for byte.
 *
 * `-lv 2` keeps the server's warnings and errors and drops the three lines it writes for every question it
 * answers: about 1 KB an ask into a log nothing trims. Measured: 145 bytes at a start, none for an ask.
 *
 * Three slots instead of one were tried on vllm-d3 (llama.cpp 0.9.0): a jevel's questions then run side by side
 * and every answer stayed the same, byte for byte, but on a quiet machine it was no faster (15.5 s against 15.2 s).
 * A family that evaluates a prompt in one ubatch keeps nothing of the state that a second question could use.
 *
 * kev and lev get four slots that share one context. With one slot the server reads the whole state again for every
 * question; with a slot for each question it reads the state once and each question after it. Measured on Kev 0.8B
 * (llama.cpp 0.9.0, M4 Pro): over the 91 shipped examples and cases the server processed 80,970 tokens instead of
 * 100,923, by its own counter, and took about a fifth less time; three questions on a 2,000-token state took 2.3 s
 * instead of 5.1 s, and on a 7,300-token state 7.8 s instead of 22.7 s. The server grew from 840 MB to 900 MB.
 * Kev 4B: the same 80,970 against 100,923, and the 17 shipped examples in 25% less time, the two settings taken
 * in turn four times each. lev 4B: 132,106 tokens instead of 172,695, the examples in 24% less time taken the same
 * way, three questions on a long state in 11 s instead of 31 s, and a server of 1,100 MB instead of 840 MB.
 * `-kvu` is what lets the slots share the 8192 tokens: without it each slot gets 2048 and a longer question is
 * refused. With it the ceiling is where it was, 8192 tokens for the state and one question.
 *
 * lfm2-d1 keeps one slot. On Liquid d1 3B four slots made the server process 89,584 tokens instead of 113,344 and
 * no faster: the shipped prompts took 121 s against 109 s, and long states were 4 to 12% faster.
 *
 * What it costs: with one slot a prompt got the same bytes whatever came before it. With four, the fourth decimal of
 * a certainty depends on what the server was asked before, because that decides which slot leads. Asked in the same
 * order, the 91 prompts got the same bytes on every run; asked backwards, or 16 at a time, 81 to 200 of the 267
 * answers were the same bytes and the largest move was 0.0011. No value and no decision changed in any run, and
 * against one slot the largest move was 0.0007 (Kev 4B: 0.0006; lev 4B: 0.0014, with every value and decision the
 * same). Sending asks one at a time from jevelry was tried and changed neither that nor the time, so jevelry does
 * not queue them.
 */
export function launchArgs(local: LocalModel): string[] {
  // ponytail: the small ubatch is measured on kev alone; nimble and openjev are measured for neither flag, because their only models are a 9B and a 27B.
  // ponytail: four slots because no shipped jevel asks more than four questions; a jevel that asks more has its state read once for every four.
  // ponytail: the whole-context batch is measured on vllm-d3 and lfm3-d1; laya, clef, lfm2-d1-omni and lfm3-d1-omni read a prompt in one ubatch too and keep 4096 until they are.
  const kev = local.decisionType === "kev";
  const shared = kev || local.decisionType === "lev";
  const whole = local.decisionType === "vllm-d3" || local.decisionType === "lfm3-d1";
  return [
    "-m", local.path, "--host", "127.0.0.1", "--port", String(local.port), "--alias", local.alias,
    "--no-webui", "--no-mmproj", "-c", "8192", "-b", whole ? "8192" : "4096", "-ub", kev ? "512" : whole ? "8192" : "4096", "-np", shared ? "4" : "1", ...(shared ? ["-kvu"] : []),
    "--sleep-idle-seconds", "300", "-lv", "2",
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
    const response = await localRequest(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return response.status === 503 ? "loading" : "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "down" : "loading";
  }
}

/**
 * node:http through require, and only once a request is made. Imported as an ES module it loads Node's fetch
 * implementation too, about 18 ms at every start: its namespace carries WebSocket and friends as getters, and an
 * import reads them all. Measured: `jevelry --version` 61 ms without it, 79 ms with it at the top of this file.
 */
let httpRequest: typeof import("node:http").request | undefined;
const loadHttp = createRequire(import.meta.url);

/** What the SDK and jevelry read of an answer from the model server: that much of a Response, and no more. */
export interface LocalResponse {
  status: number;
  ok: boolean;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  /** The SDK drains a clone's body to buffer a streamed response; this one arrives whole, so there is nothing to drain. */
  clone: () => { body: undefined };
}

/**
 * One request to the model server on this machine, through node:http and not Node's fetch. fetch sets itself up the
 * first time a process uses it, and a jevelry command is a new process for every ask. Measured against a server that
 * answers at once: 32 ms for the first fetch, 4 ms for the same call here, 34 ms a whole ask before and 8 ms after.
 * A signal that fires ends the request with the signal's reason, and a refused connection keeps its `code`.
 */
export function localRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal | null } = {}): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const done = (): void => signal?.removeEventListener("abort", abort);
    const fail = (error: unknown): void => {
      done();
      reject(error);
    };
    httpRequest ??= (loadHttp("node:http") as typeof import("node:http")).request;
    const outgoing = httpRequest(url, { method: init.method ?? "GET", ...(init.headers ? { headers: init.headers } : {}) }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", fail);
      incoming.on("end", () => {
        done();
        const text = Buffer.concat(chunks).toString("utf8");
        const status = incoming.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: {
            get: (name) => {
              const value = incoming.headers[name.toLowerCase()];
              return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
            },
          },
          text: async () => text,
          json: async () => JSON.parse(text) as unknown,
          clone: () => ({ body: undefined }),
        });
      });
    });
    const abort = (): void => {
      outgoing.destroy();
      fail(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    outgoing.on("error", fail);
    outgoing.end(init.body);
  });
}

/**
 * Whether the server has unloaded its model after its idle time. /health answers 200 either way; only /props
 * says, and asking it does not wake the model. A build that does not say is taken as awake.
 */
export async function sleeping(port: number): Promise<boolean> {
  try {
    const response = await localRequest(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as { is_sleeping?: unknown } | null;
    return body !== null && typeof body === "object" && body.is_sleeping === true;
  } catch {
    return false;
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
    if (holder > 0 && !alive(holder)) takeOver(lock, holder);
    else if (Date.now() >= deadline) throw new Error("another jevelry is starting the local model server; try again");
    else await sleep(100);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Clears a lock whose holder `dead` died. Many waiting processes see the dead holder at once, and one that
 * deletes after another has already taken the lock would let two start a server. So takeovers go one at a
 * time behind a guard file, and the lock is deleted only while it still names the dead holder: nothing
 * else writes a lock whose holder is dead, and a live lock is never moved or deleted.
 */
export function takeOver(lock: string, dead: number): void {
  const guard = `${lock}.takeover`;
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch {
    // Another takeover is under way. A guard left by a taker that died is cleared once it is 10 s old.
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10000) rmSync(guard, { force: true });
    } catch {
      // Gone already.
    }
    return;
  }
  try {
    if (Number(readFileSync(lock, "utf8")) === dead) rmSync(lock, { force: true });
  } catch {
    // Released in between: nothing to clear.
  } finally {
    rmSync(guard, { force: true });
  }
}

export const WINDOWS = "local models run on macOS and Linux for now: on Windows jevelry cannot tell its own model server from another program";

/** Characters ps escapes in every locale; a home containing one could hide a running server from the stray check. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The home's real path. A home reached through a symlink is the same home, and its servers are found
 * by the one spelling the process table shows; a path ps cannot print as it is would hide them.
 */
export function realHome(home: string): string {
  const real = realpathSync.native(home);
  if (UNPRINTABLE.test(real)) throw new Error(`jevelry cannot run a local model from a home whose path has characters ps cannot print (${JSON.stringify(real)}); set JEVELRY_HOME to a plain path`);
  return real;
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** The signals a person or a terminal sends to stop jevelry, held back while a server is started but not yet recorded. */
const HELD = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Spawned detached with its output in the log, so it outlives the command that started it and serves
 * the next ask. A server on record that is ours is never joined by a second one: the same model is
 * waited for, and another model is refused, because two models at once is how a GPU runs out of memory.
 * A server of this home that no record names is refused too. `spawned` says whether this call started it.
 */
async function launch(home: string, local: LocalModel, env: NodeJS.ProcessEnv): Promise<{ pid: number; spawned: boolean }> {
  if (process.platform === "win32") throw new Error(WINDOWS);
  const bin = llamaServerPath(env);
  if (!bin) throw new Error("llama-server is not installed; run jevelry install --local");
  if (!existsSync(local.path)) throw new Error(`the model file is missing: ${local.path}; run jevelry install --local`);
  // A synced $JEVELRY_HOME or a config from a bigger machine must not load what this one cannot hold. What
  // the config does not say is taken at its worst: a config written before params were kept may be a 27B,
  // and a type this build does not know is started with a prompt-sized ubatch and may keep logits for all of it, as kev would.
  const need = needBytes({
    bytes: statSync(local.path).size,
    params: typeof local.params === "number" ? local.params : Infinity,
    decisionType: typeof local.decisionType === "string" && Object.hasOwn(MIN_BUILD, local.decisionType) ? local.decisionType : "unknown",
  });
  const budget = budgetBytes(realMachine());
  if (fitOf(need, budget) === "won't fit") {
    throw new Error(`${local.alias} needs about ${gb(need)} and this machine has about ${gb(budget)} for models; run jevelry install --local to pick a smaller model`);
  }
  mkdirSync(home, { recursive: true });
  realHome(home);
  let caught: NodeJS.Signals | undefined;
  let holding = true;
  const release = (): void => { for (const signal of HELD) process.off(signal, hold); };
  // Until the record is written a signal is remembered; after it, one that arrives is raised again at once, as if
  // jevelry had no handler. Node dispatches a signal on a later turn of the event loop, so a handler removed right
  // after the record could drop one already on its way, and Ctrl-C would be swallowed.
  const hold = (signal: NodeJS.Signals): void => {
    if (holding) {
      caught ??= signal;
      return;
    }
    release();
    process.kill(process.pid, signal);
  };
  try {
    return await withLock(home, async () => {
      const server = recorded(home);
      if (isOurs(server.pid, server)) {
        if (server.path === local.path && server.port === local.port) return { pid: server.pid, spawned: false };
        throw new Error(`a different local model is running (${String(server.alias)}); run jevelry stop first, or restart this program if jevelry was switched to another model`);
      }
      // Nothing of ours on record, so any server of this home is one whose jevelry was killed between spawn and record.
      const stray = strayServers(home)[0];
      if (stray !== undefined) throw new Error(`a local model server jevelry did not record is running (pid ${stray}); run jevelry stop`);
      // ponytail: the log is appended to on every start and never rotated; at `-lv 2` that is about 145 bytes a start. Truncate it at start if it ever grows large.
      const log = openSync(join(home, SERVER_LOG), "a");
      // A signal between spawn and record would leave a server that no record names: it is held until the
      // record is written, then raised again. Spawn and record are synchronous, so nothing runs between them.
      for (const signal of HELD) process.on(signal, hold);
      try {
        // The launch arguments alone decide what the server loads (llama-server also reads LLAMA_ARG_*),
        // and the hosted key never sits in a long-lived process.
        const serverEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== "TYPESAFE_API_KEY" && !key.startsWith("LLAMA_")));
        // The model's real path goes on the command line, so the stray check finds this server however the home was spelled.
        const child = spawn(bin, launchArgs({ ...local, path: realpathSync.native(local.path) }), { detached: true, stdio: ["ignore", log, log], env: serverEnv });
        // No pid is a spawn that failed, and its error follows.
        if (child.pid === undefined) throw await new Promise<Error>((resolve) => child.once("error", resolve));
        // Recorded before the lock is released, so a launch in another process finds it and waits for it.
        record(home, child.pid, local);
        child.unref();
        return { pid: child.pid, spawned: true };
      } finally {
        holding = false;
        // Long after any signal on its way has been dispatched; unref'd, so it never keeps jevelry running.
        setTimeout(release, 1000).unref();
        closeSync(log);
      }
    });
  } finally {
    // Raised once the lock is released: with no handler of its own, jevelry then ends the way the signal says.
    if (caught) {
      release();
      process.kill(process.pid, caught);
    }
  }
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

type WaitOptions = {
  timeoutMs?: number;
  onWait?: (state: "starting" | "loading") => void;
  /** Whether this model is still the one to run, asked right before a server is started. */
  still?: () => boolean;
};

/** Resolves `true` when the server was not ready at once, so the caller waited for a start or a load. */
async function waitReady(home: string, local: LocalModel, env: NodeJS.ProcessEnv, options: WaitOptions): Promise<boolean> {
  if (process.platform === "win32") throw new Error(WINDOWS);
  const log = join(home, SERVER_LOG);
  const timeoutMs = options.timeoutMs ?? 300000;
  const deadline = Date.now() + timeoutMs;
  let pid: number | undefined;
  let spawned = false;
  // A refusal never leaves behind a server this call started: nothing else would stop it.
  const refuse = (): never => {
    if (spawned && pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ended already.
      }
    }
    throw new Error(`another server answers on port ${local.port}, not ${local.alias}; run jevelry install --local to pick a new port`);
  };
  let told: "starting" | "loading" | undefined;
  let state = await health(local.port);
  for (;;) {
    // Checked before any request: another program on the port would be handed the state and its answer read as Jev's.
    if (state !== "down" && !isOurs(recorded(home).pid, local)) refuse();
    if (state === "ok") break;
    if (state === "down") {
      if (pid === undefined) {
        // An ask that began before jevelry was switched to another backend must not bring the old model back beside the new one.
        if (options.still?.() === false) throw new Error("jevelry was switched to another backend while this ask waited; ask again");
        ({ pid, spawned } = await launch(home, local, env));
      }
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
  // Ready at once is still a wait when the model was unloaded: the next request loads it again.
  return told !== undefined || (await sleeping(local.port));
}

/** One wait per port in this process, so a batch of concurrent asks starts one server, not one each. */
const waits = new Map<number, Promise<boolean>>();

/**
 * Resolves once the server for `local` is ours and ready, starting it when nothing listens on its port: `true` when
 * that took a start or a load. Asks that wait together share the one wait, and each of them learns it waited.
 */
export function ensureServer(home: string, local: LocalModel, env: NodeJS.ProcessEnv, options: WaitOptions = {}): Promise<boolean> {
  let wait = waits.get(local.port);
  if (!wait) {
    // Forgotten once settled: the next ask checks again, so a server stopped in the meantime is started again.
    wait = waitReady(home, local, env, options).finally(() => waits.delete(local.port));
    waits.set(local.port, wait);
  }
  return wait;
}

/**
 * `ps` in a UTF-8 locale, whatever jevelry was started with: in the C locale of a cron job or a launchd
 * agent it escapes every non-ASCII byte of a path, and a home like ~/Désktop would never match. A process
 * table it could not read fails loudly: read as empty, it would hide a running model.
 */
function ps(args: string[]): string {
  const ran = spawnSync("/bin/ps", ["-ww", ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 2 ** 20, env: { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" } });
  if (ran.error || ran.status !== 0) throw new Error(`could not read the process table: ${ran.error?.message ?? (ran.stderr.trim() || `ps exited ${ran.status}`)}`);
  return ran.stdout;
}

function commandLine(pid: number): string {
  try {
    return process.platform === "linux" ? readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ") : ps(["-o", "command=", "-p", String(pid)]);
  } catch {
    return "";
  }
}

/**
 * Whether `pid` is a llama-server jevelry started for `server`'s model, alias and port. A pid on record
 * may be stale, after a reboot for one, and belong to another program by now, and a port may be taken
 * by any program: only the command line tells. Only its ASCII parts are compared (the alias, the port
 * and the model's file name), because ps escapes what it cannot print, in any locale. Pid 0 and below
 * signal a whole process group or every process. Windows has no cheap way to read a command line, so
 * nothing there is ours.
 */
function isOurs(pid: unknown, server: { path?: unknown; port?: unknown; alias?: unknown }): pid is number {
  if (process.platform === "win32" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  const { path, port, alias } = server;
  if (typeof path !== "string" || path === "" || typeof alias !== "string" || alias === "" || !alive(pid)) return false;
  const command = ` ${commandLine(pid).trim()} `;
  return command.includes(` --alias ${alias} `) && command.includes(` --port ${String(port)} `) && command.includes(`/${basename(path)} `);
}

/**
 * The live llama-servers of this home, recorded or not: every process whose command line loads a model
 * from this home's models folder under a `local/` alias. A jevelry killed between spawn and record
 * leaves one that only this finds. Windows cannot read command lines, so it finds none there.
 */
export function strayServers(home: string): number[] {
  if (process.platform === "win32") return [];
  let real: string;
  try {
    real = realHome(home);
  } catch (error) {
    // A home that does not exist has no servers; one ps cannot print is refused wherever a server would start.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // jevelry starts its servers with the real path; the spelling the home was given is matched too.
  const models = [...new Set([home, real])].map((dir) => ` -m ${join(dir, "models")}/`);
  const commands: Array<[number, string]> = process.platform === "linux"
    ? readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map((name) => [Number(name), commandLine(Number(name))])
    : ps(["-A", "-o", "pid=,command="]).split("\n").map((line) => /^\s*(\d+) (.*)$/.exec(line)).filter((m) => m !== null).map((m) => [Number(m[1]), m[2]!]);
  return commands.filter(([pid, command]) => pid !== process.pid && command.includes(" --alias local/") && models.some((m) => command.includes(m))).map(([pid]) => pid);
}

/**
 * SIGTERM to the server jevelry started when it is running and ours, and its pid, else null. The record
 * is kept while that process lives, so a launch meanwhile finds it and loads nothing beside it; a record
 * naming nothing alive of ours is dropped.
 */
export function stopServer(home: string): number | null {
  const server = recorded(home);
  if (isOurs(server.pid, server)) {
    try {
      process.kill(server.pid, "SIGTERM");
      return server.pid;
    } catch {
      // Ended in between: forgotten below.
    }
  }
  rmSync(join(home, SERVER_FILE), { force: true });
  return null;
}

/** Whether every one of `pids` has exited within `ms`, checked every 200 ms. */
async function exited(pids: number[], ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; pids.some(alive) && Date.now() < end;) await sleep(200);
  return !pids.some(alive);
}

/**
 * Stops the recorded server and every stray of this home, and waits until they are gone: SIGTERM, then
 * SIGKILL after `killAfterMs`, then up to 5 s more. A model unloading still holds the GPU's memory, so
 * only an exited process counts, and only then is the record dropped. `found` is every server it
 * signalled and `left` the ones still running; nothing is left when everything is gone.
 */
export async function stopServerAndWait(home: string, { killAfterMs = 15000 }: { killAfterMs?: number } = {}): Promise<{ found: number[]; left: number[] }> {
  const first = stopServer(home);
  const strays = strayServers(home).filter((pid) => pid !== first);
  const found = [...(first === null ? [] : [first]), ...strays];
  const signal = (name: NodeJS.Signals) => (pid: number): void => {
    try {
      process.kill(pid, name);
    } catch {
      // Ended already.
    }
  };
  strays.forEach(signal("SIGTERM"));
  if (!(await exited(found, killAfterMs))) {
    found.forEach(signal("SIGKILL"));
    await exited(found, 5000);
  }
  // Only the record of what was stopped here: one written meanwhile names a server someone just started.
  if (first !== null && !alive(first) && recorded(home).pid === first) rmSync(join(home, SERVER_FILE), { force: true });
  return { found, left: found.filter(alive) };
}

/**
 * The SDK's fetch in local mode: every request first makes sure the server is up, so the first ask
 * starts it. The SDK's timeout and a caller's abort end the wait for a slow load too, and the wait
 * gives up 2 s before the SDK does, so the error a person reads names the log.
 */
export function localFetch(home: string, local: LocalModel, env: NodeJS.ProcessEnv, timeoutMs?: number, still?: () => boolean, onCold?: () => void): (input: string, init?: RequestInit) => Promise<Response> {
  // Never under 1 s: a shorter wait would give up the moment the server is spawned.
  const options: WaitOptions = { ...(timeoutMs === undefined ? {} : { timeoutMs: Math.max(timeoutMs - 2000, 1000) }), ...(still ? { still } : {}) };
  return async (input, init) => {
    const signal = init?.signal;
    signal?.throwIfAborted();
    const waited = await new Promise<boolean>((resolve, reject) => {
      if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      ensureServer(home, local, env, options).then(resolve, reject);
    });
    if (waited) onCold?.();
    // The SDK reads the status, the headers and the text of what comes back, which is what a LocalResponse has.
    return localRequest(input, init as { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal | null }) as unknown as Response;
  };
}

/**
 * Where a Jev server may already run on this machine: candle-jev's jevd listens on 8741 by default. Asking it
 * instead of downloading a model keeps one copy on disk and one model in the GPU's memory.
 */
export const KNOWN_SERVERS = ["http://127.0.0.1:8741"];

/** `JEVELRY_KNOWN_SERVERS`, comma-separated URLs, replaces the list, so a test points it at fakes and a person adds their own; empty means none. */
export function knownServers(env: NodeJS.ProcessEnv): string[] {
  const given = env.JEVELRY_KNOWN_SERVERS;
  return given === undefined ? KNOWN_SERVERS : given.split(",").map((url) => url.trim().replace(/\/+$/, "")).filter((url) => url !== "");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The models a Jev server at `url` lists at GET /v1/models: TypeSafe's `models[].name`, or OpenAI's `data[].id`
 * that llama-server answers too. Empty when nothing answers in a second or what answers is no Jev server.
 */
export async function serverModels(url: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const response = await fetchImpl(`${url}/v1/models`, { signal: AbortSignal.timeout(1000) });
    const body: unknown = response.status === 200 ? await response.json() : null;
    const pick = (list: unknown, key: string): string[] => (Array.isArray(list) ? list.map((m) => (isObject(m) ? m[key] : null)).filter((n): n is string => typeof n === "string" && n !== "") : []);
    if (!isObject(body)) return [];
    const named = pick(body.models, "name");
    return named.length > 0 ? named : pick(body.data, "id");
  } catch {
    return [];
  }
}

/**
 * The Jev servers already running at `urls`, one row per model, asked in parallel with GET /v1/models and
 * nothing else. A `local/` model is a llama-server jevelry started itself, not a server to adopt.
 */
export async function findRunningServers(urls: string[] = knownServers(process.env), fetchImpl: typeof fetch = fetch): Promise<Array<{ url: string; model: string }>> {
  const found = await Promise.all(urls.map(async (url) => (await serverModels(url, fetchImpl)).filter((model) => !model.startsWith("local/")).map((model) => ({ url, model }))));
  return found.flat();
}

/**
 * The SDK's fetch for a server jevelry did not start. A jevel pins a hosted model the server does not serve
 * (jevd answers 400 to any other id), so every request asks for the server's own model. Its answer's model
 * reads as `local/<model>`, so the log, the TUI's $0 cost and the error wording treat it as a model on this
 * machine. Everything else passes through.
 */
export function serverFetch(model: string, fetchImpl: typeof fetch = fetch): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let sent = init;
    if (typeof init?.body === "string") {
      try {
        const body: unknown = JSON.parse(init.body);
        if (isObject(body) && "model" in body) sent = { ...init, body: JSON.stringify({ ...body, model }) };
      } catch {
        // Not JSON: sent as it is.
      }
    }
    const response = await fetchImpl(input, sent);
    if (response.status !== 200) return response;
    const answer: unknown = await response.clone().json().catch(() => null);
    if (!isObject(answer) || typeof answer.model !== "string" || answer.model.startsWith("local/")) return response;
    return new Response(JSON.stringify({ ...answer, model: `local/${answer.model}` }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

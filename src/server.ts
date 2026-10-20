import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LocalModel } from "./config.js";

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
 * llama-server answers 503 while the model loads and 200 when it is ready. Any other answer still
 * means something listens and is not loading: "ok", and ensureServer then checks it is ours.
 */
export async function health(port: number): Promise<"ok" | "loading" | "down"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    await response.text();
    return response.status === 503 ? "loading" : "ok";
  } catch {
    return "down";
  }
}

function record(home: string, pid: number, local: LocalModel): void {
  writeFileSync(join(home, SERVER_FILE), `${JSON.stringify({ pid, port: local.port, path: local.path, alias: local.alias })}\n`);
}

/** Spawned detached with its output in the log, so it outlives the command that started it and serves the next ask. */
async function launch(home: string, local: LocalModel, env: NodeJS.ProcessEnv): Promise<number> {
  const bin = llamaServerPath(env);
  if (!bin) throw new Error("llama-server is not installed; run jevelry install --local");
  if (!existsSync(local.path)) throw new Error(`the model file is missing: ${local.path}; run jevelry install --local`);
  mkdirSync(home, { recursive: true });
  // ponytail: the log is appended to on every start and never rotated; truncate it at start if it ever grows large.
  const log = openSync(join(home, SERVER_LOG), "a");
  try {
    const child = spawn(bin, launchArgs(local), { detached: true, stdio: ["ignore", log, log], env });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    record(home, child.pid!, local);
    return child.pid!;
  } finally {
    closeSync(log);
  }
}

export async function startServer(home: string, local: LocalModel, env: NodeJS.ProcessEnv): Promise<void> {
  await launch(home, local, env);
}

const alive = (pid: number): boolean => {
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
  let pid: number | undefined;
  let told: "starting" | "loading" | undefined;
  let state = await health(local.port);
  while (state !== "ok") {
    if (state === "down") {
      if (pid === undefined) pid = await launch(home, local, env);
      // Down while ours is gone is a server that died. Down while ours lives is one still starting; and
      // when ours exited but the port answers, another jevelry started the same server first.
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
  if (!(await servesAlias(local.port, local.alias))) {
    throw new Error(`another server answers on port ${local.port}, not ${local.alias}; run jevelry install --local to pick a new port`);
  }
  // Two jevelry processes that start at once both launch, and the one that lost the port may have
  // written its pid last: the one that serves records itself again, so `jevelry stop` finds it.
  if (pid !== undefined && alive(pid)) record(home, pid, local);
}

/** One wait per port in this process, so a batch of concurrent asks starts one server, not one each. */
const waits = new Map<number, Promise<void>>();

/** Resolves once the server for `local` answers as `local.alias`, starting it when nothing listens on its port. */
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
 * The pid in SERVER_FILE may be stale, after a reboot for one, and by now belong to another program:
 * it gets SIGTERM only while its command line still names the model file. Windows has no cheap way
 * to read it.
 */
function isOurs(pid: number, path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    const command = process.platform === "linux"
      ? readFileSync(`/proc/${pid}/cmdline`, "utf8")
      : (spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).stdout ?? "");
    return command.includes(path);
  } catch {
    return false;
  }
}

/** True when a server jevelry started was running and got SIGTERM. The file goes either way: it named nothing alive after this. */
export function stopServer(home: string): boolean {
  let server: { pid?: unknown; path?: unknown } | undefined;
  try {
    server = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as typeof server;
  } catch {
    return false;
  }
  rmSync(join(home, SERVER_FILE), { force: true });
  const { pid, path } = server ?? {};
  if (typeof pid !== "number" || typeof path !== "string" || !alive(pid) || !isOurs(pid, path)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** The SDK's fetch in local mode: every request first makes sure the server is up, so the first ask starts it. */
export function localFetch(home: string, local: LocalModel, env: NodeJS.ProcessEnv): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => ensureServer(home, local, env).then(() => fetch(input, init));
}

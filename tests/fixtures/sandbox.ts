import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Machine } from "../../src/estimate.js";

export const FAKE_LLAMA = join(process.cwd(), "tests", "fixtures", "llama-server.mjs");
export const FAKE_BREW = join(process.cwd(), "tests", "fixtures", "brew.mjs");

/**
 * A PATH directory holding a link to this node and, unless `fakes` is false, the fake llama-server
 * and brew: a code path that forgets an override finds a fake or nothing, never this machine's real
 * brew or llama-server (one of which crashed its GPU).
 */
export function sandboxPath(fakes = true): string {
  const bin = mkdtempSync(join(tmpdir(), "jevelry-bin-"));
  symlinkSync(process.execPath, join(bin, "node"));
  chmodSync(FAKE_LLAMA, 0o755);
  chmodSync(FAKE_BREW, 0o755);
  if (fakes) {
    symlinkSync(FAKE_LLAMA, join(bin, "llama-server"));
    symlinkSync(FAKE_BREW, join(bin, "brew"));
  }
  return bin;
}

/**
 * The environment every local-model test runs with: fakes for every binary, the file key store, a temp
 * home, and every fake llama-server recorded in `argv.ndjson` there, so killFakes can end it.
 */
export function sandboxEnv(home: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PATH: sandboxPath(),
    HOME: home,
    JEVELRY_HOME: home,
    JEVELRY_KEY_STORE: "file",
    JEVELRY_LLAMA_SERVER: FAKE_LLAMA,
    JEVELRY_BREW: FAKE_BREW,
    FAKE_LLAMA_ARGV_FILE: join(home, "argv.ndjson"),
    ...extra,
  };
}

/**
 * Kills every fake llama-server recorded in `argvFile`, so no fake outlives its suite whatever the code
 * under test did or failed to do. A pid is killed only while its command line still ends in the
 * recorded arguments: a pid freed by a fake that already ended may belong to someone else's program now.
 */
export function killFakes(argvFile: string): void {
  if (!existsSync(argvFile)) return;
  for (const line of readFileSync(argvFile, "utf8").split("\n").filter(Boolean)) {
    const { pid, args } = JSON.parse(line) as { pid: number; args: string[] };
    const command = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
    try {
      if (command.trimEnd().endsWith(` ${args.join(" ")}`)) process.kill(pid, "SIGKILL");
    } catch {
      // Ended in between.
    }
  }
}

const GIB = 2 ** 30;

/** The machine this feature was built on, and whose GPU a too-big model crashed: 12 CPU cores, 24 GiB. */
export const M4_PRO_24: Machine = { os: "darwin", chip: "Apple M4 Pro", cpus: 12, ramBytes: 24 * GIB, darwinMajor: 24, gpu: null };
export const M2_16: Machine = { os: "darwin", chip: "Apple M2", cpus: 8, ramBytes: 16 * GIB, darwinMajor: 24, gpu: null };
export const LINUX_CPU: Machine = { os: "linux", chip: "AMD EPYC 7763 64-Core Processor", cpus: 16, ramBytes: 64 * GIB, darwinMajor: null, gpu: null };
export const RTX_4090: Machine = { os: "linux", chip: "AMD Ryzen 9 7950X", cpus: 32, ramBytes: 64 * GIB, darwinMajor: null, gpu: { name: "NVIDIA GeForce RTX 4090", vramBytes: 24564 * 2 ** 20 } };

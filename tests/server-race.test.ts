import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModel } from "../src/config.js";
import { stopServer } from "../src/server.js";
import { killFakes, sandboxEnv } from "./fixtures/sandbox.js";

const RACE_CHILD = join(process.cwd(), "tests", "fixtures", "race-child.mjs");

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

/** Every fake recorded in `home`, in the order they started. */
const starts = (home: string): Array<{ pid: number; args: string[] }> => {
  const argv = join(home, "argv.ndjson");
  return existsSync(argv) ? readFileSync(argv, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number; args: string[] }) : [];
};

/** A small model on file in `home`, outside its models folder, so only the lock and the record keep its servers apart, not the stray check. */
async function model(home: string, name: string): Promise<LocalModel> {
  const path = join(home, `${name}.gguf`);
  writeFileSync(path, "not a model");
  return { repo: `x/${name}`, file: `${name}.gguf`, quant: "Q8_0", name, decisionType: "vllm-d3", path, port: await freePort(), alias: `local/${name}`, params: 1e9 };
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    stopServer(home);
    killFakes(join(home, "argv.ndjson"));
  }
});

const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "jevelry-race-"));
  homes.push(home);
  return home;
};

describe("one local model server per home under contention", () => {
  // A jevelry killed while it held the lock leaves it behind, and every process waiting then sees a dead
  // holder at once. Two of them taking it over together is two models loading side by side, which is how
  // a GPU runs out of memory; one bad round in a hundred was enough to see it.
  it("starts at most one server per round when 24 processes ask for two models past a stale lock, 30 rounds", async () => {
    for (let round = 0; round < 30; round++) {
      const home = newHome();
      const env = sandboxEnv(home, { FAKE_LLAMA_LOAD_MS: "100", FAKE_LLAMA_LIFETIME_MS: "8000" });
      const models = [await model(home, "A"), await model(home, "B")];
      const dead = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout);
      writeFileSync(join(home, "server.lock"), String(dead));
      // Every child has loaded by then (about 250 ms for 24 on a laptop), so they ask on the same millisecond.
      const startAt = Date.now() + 500;
      const answers = await Promise.all(models.flatMap((local) => Array.from({ length: 12 }, () => new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [RACE_CHILD, home, JSON.stringify(local), String(startAt)], { env, stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        child.on("close", () => resolve(out.trim()));
      }))));
      const started = starts(home).map((s) => s.args[1]);
      expect(started.length, `round ${round} started ${started.join(" and ")}`).toBeLessThanOrEqual(1);
      // The race ran: someone was served, so a broken child cannot pass the round by starting nothing.
      expect(answers.some((a) => a.startsWith('{"ok"'))).toBe(true);
      stopServer(home);
      killFakes(join(home, "argv.ndjson"));
    }
  }, 180000);
});

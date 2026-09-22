import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("jevelry --version", () => {
  it("prints the package version and exits 0", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    // The file store, like every other suite here: no test of this package reads the real keychain.
    const run = spawnSync("node", ["bin/jevelry.js", "--version"], { encoding: "utf8", env: { ...process.env, JEVELRY_KEY_STORE: "file" } });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(pkg.version);
  });
});

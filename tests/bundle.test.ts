import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const BUNDLED = ["commander", "ink", "react", "yaml"];

// An install used to be 43 packages and 27 MB, 18 MB of it one package the terminal UI pulls in. The build
// now carries everything but the SDK, so what npm installs for a person is jevelry and the SDK.
describe("the published build", () => {
  it("leaves npm one package to install: the SDK, whose error classes a host's client and jevelry must share", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["@typesafe-ai/sdk"]);
    for (const name of BUNDLED) expect(pkg.devDependencies[name], name).toBeDefined();
  });
  it("imports none of the bundled packages by name, so it runs where they were never installed", () => {
    const chunks = readdirSync("dist").filter((file) => file.endsWith(".js"));
    expect(chunks.length).toBeGreaterThan(0);
    for (const file of chunks) {
      const code = readFileSync(join("dist", file), "utf8");
      for (const name of BUNDLED) expect(new RegExp(`^import [^\\n]*from "${name}";$`, "m").test(code), `${file} imports ${name}`).toBe(false);
    }
  });
  // The README's pictures are 814 KB, a quarter of what an install used to put on disk, and no command reads them:
  // npm's page and GitHub load them from the repository.
  it("leaves the README's pictures out of the package", () => {
    const { files } = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };
    expect(files.some((entry) => entry.startsWith("docs/assets"))).toBe(false);
    expect(files).toContain("docs/protocol");
  });
  // ink loads a bridge to React's devtools only when DEV=true, and with it a websocket library: 129 KB that no
  // command of jevelry ever reaches.
  it("carries no devtools bridge", () => {
    const files = readdirSync("dist");
    // What is left of the import is an empty chunk.
    for (const file of files.filter((name) => name.startsWith("devtools"))) expect(readFileSync(join("dist", file)).length, file).toBeLessThan(1024);
    // ink still names the devtools package where it asks whether it is installed; what must be gone is the bridge and its websocket library.
    for (const file of files.filter((name) => name.endsWith(".js"))) {
      const code = readFileSync(join("dist", file), "utf8");
      expect(code, file).not.toMatch(/^\/\/ node_modules\/(ws|ink\/build\/devtools)/m);
      expect(code, file).not.toMatch(/from\s*"react-devtools-core"/);
    }
    expect(readFileSync(join("dist", "THIRD-PARTY-LICENSES.txt"), "utf8")).not.toMatch(/^ws@/m);
  });
  // Node's fetch implementation takes about 18 ms to load, and a jevelry command is a new process every time. Importing
  // node:http as an ES module loads it without anyone asking: its namespace carries WebSocket and friends as getters.
  // That made every command 18 ms slower for a day (--version 61 ms to 79 ms).
  it("loads none of Node's fetch implementation just by starting", () => {
    const loaded = (entry: string): string => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)}); console.log(process.moduleLoadList.filter((m) => m.includes("undici")).length)`], { encoding: "utf8" }).stdout.trim();
    expect(loaded("./dist/index.js")).toBe("0");
    const version = spawnSync(process.execPath, ["--input-type=module", "-e", 'process.on("exit", () => console.log(`undici:${process.moduleLoadList.filter((m) => m.includes("undici")).length}`)); process.argv[2] = "--version"; await import("./dist/cli.js")'], { encoding: "utf8" });
    expect(version.stdout).toContain("undici:0");
  });
  // A copy of someone's code travels with their licence: MIT and ISC both ask for the notice in every copy.
  it("ships the licence of every package it carries", () => {
    const notices = readFileSync(join("dist", "THIRD-PARTY-LICENSES.txt"), "utf8");
    for (const name of BUNDLED) {
      const version = (JSON.parse(readFileSync(join("node_modules", name, "package.json"), "utf8")) as { version: string }).version;
      expect(notices, name).toContain(`${name}@${version}`);
    }
    expect(notices).toMatch(/Permission is hereby granted/);
  });
});

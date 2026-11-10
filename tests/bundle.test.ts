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

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill } from "../src/install.js";

const PACKAGE_SKILL = join(process.cwd(), "skills", "jevelry");
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

/** A home with three of the five agents present, so the installer has to choose. */
function homeWithAgents(): string {
  const home = mkdtempSync(join(tmpdir(), "jevelry-install-"));
  for (const parts of [[".claude", "skills"], [".codex", "skills"], [".pi", "agent", "skills"]]) mkdirSync(join(home, ...parts), { recursive: true });
  return home;
}

describe("installSkill", () => {
  it("installs into the agents that are on the machine and says which it skipped", () => {
    const home = homeWithAgents();
    const results = installSkill({ home, cwd: process.cwd(), project: false, agents: ["all"] });
    const installed = results.filter((r) => r.installed).map((r) => r.agent);
    expect(installed).toEqual(["claude-code", "codex", "pi"]);
    const skipped = results.filter((r) => !r.installed);
    expect(skipped.map((r) => r.agent)).toEqual(["cursor", "opencode"]);
    for (const r of skipped) expect(r.reason).toBeTruthy();
    // The installed copy is the package's own: an agent reading a drifted skill would follow
    // instructions this build does not implement.
    for (const [agent, ...parts] of [["claude-code", ".claude", "skills"], ["codex", ".codex", "skills"], ["pi", ".pi", "agent", "skills"]] as string[][]) {
      const dir = join(home, ...(parts as string[]), "jevelry");
      expect(read(dir, "SKILL.md"), agent).toBe(read(PACKAGE_SKILL, "SKILL.md"));
      expect(read(dir, "references", "writing-jevels.md"), agent).toBe(read(PACKAGE_SKILL, "references", "writing-jevels.md"));
    }
  });

  it("installs into the project when --project is given, whether or not the directories exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jevelry-project-"));
    const results = installSkill({ home: homeWithAgents(), cwd, project: true, agents: ["all"] });
    expect(results.map((r) => r.agent)).toEqual(["claude-code", "agents"]);
    expect(results.every((r) => r.installed)).toBe(true);
    expect(read(cwd, ".claude", "skills", "jevelry", "SKILL.md")).toBe(read(PACKAGE_SKILL, "SKILL.md"));
    expect(read(cwd, ".agents", "skills", "jevelry", "SKILL.md")).toBe(read(PACKAGE_SKILL, "SKILL.md"));
  });

  it("installs only the agents named", () => {
    const home = homeWithAgents();
    const results = installSkill({ home, cwd: process.cwd(), project: false, agents: ["codex"] });
    expect(results.map((r) => r.agent)).toEqual(["codex"]);
    expect(existsSync(join(home, ".codex", "skills", "jevelry", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "jevelry"))).toBe(false);
  });

  it("replaces an older copy instead of merging into it", () => {
    const home = homeWithAgents();
    installSkill({ home, cwd: process.cwd(), project: false, agents: ["codex"] });
    const stale = join(home, ".codex", "skills", "jevelry", "references", "gone-in-this-version.md");
    writeFileSync(stale, "a file from a version that had it");
    installSkill({ home, cwd: process.cwd(), project: false, agents: ["codex"] });
    expect(existsSync(stale)).toBe(false);
    expect(read(home, ".codex", "skills", "jevelry", "SKILL.md")).toBe(read(PACKAGE_SKILL, "SKILL.md"));
  });
});

/**
 * `install` reaches no server, so the synchronous spawn that would deadlock the ask tests is
 * exactly right here. Every env carries JEVELRY_KEY_STORE=file so the real keychain stays shut.
 */
const run = (args: string[], env: Record<string, string | undefined>) =>
  spawnSync("node", ["bin/jevelry.js", ...args], { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, JEVELRY_KEY_STORE: "file", ...env } });

describe("jevelry install", () => {
  it("prints one line per agent and exits 0 with --no-key", () => {
    const home = homeWithAgents();
    const r = run(["install", "--no-key"], { HOME: home, JEVELRY_HOME: home });
    expect(r.status).toBe(0);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(`jevelry: installed the skill for claude-code at ${join(home, ".claude", "skills", "jevelry")}`);
    expect(lines).toContain("jevelry: no cursor directory found, skipped");
    expect(lines).toContain("jevelry: no opencode directory found, skipped");
    expect(existsSync(join(home, ".pi", "agent", "skills", "jevelry", "SKILL.md"))).toBe(true);
  });

  it("says where to put a key and stores nothing when nobody can be asked", () => {
    const home = homeWithAgents();
    // stdin is a pipe here, never a terminal: the installer must not hang waiting for a line that
    // nothing will type, and it must not pretend a key was stored.
    const r = run(["install"], { HOME: home, JEVELRY_HOME: home });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`jevelry: no key stored; put it in TYPESAFE_API_KEY, your keychain (service typesafe-api-key, account jevelry) or ${join(home, "env")}`);
    expect(existsSync(join(home, "env"))).toBe(false);
  });
});

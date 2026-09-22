import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

// The owner writes no em dash; spelled by code point so this file holds none either.
const EM_DASH = String.fromCharCode(0x2014);
const SKILL_DIR = join(process.cwd(), "skills", "jevelry");
const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

describe("the skill a coding agent reads", () => {
  it("has the frontmatter an agent loads it by", () => {
    const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(skill) ?? [];
    expect(frontmatter, "SKILL.md must open with YAML frontmatter").toBeDefined();
    const front = parse(frontmatter ?? "") as { name?: string; description?: string };
    expect(front.name).toBe("jevelry");
    // The description is what the agent matches a task against: an empty one is a skill nobody loads.
    expect(front.description?.trim()).toBeTruthy();
  });

  it("documents every command this build registers", () => {
    // A command the skill does not name is a command the agent will not use, and a skill that
    // names a command this build does not have is one the agent runs and gets exit 1 from.
    for (const name of buildProgram().commands.map((c) => c.name())) {
      expect(skill, name).toMatch(new RegExp("`npx jevelry " + name + "[`\\s]"));
    }
  });

  it("ships the references it points the agent at, in the owner's punctuation", () => {
    for (const file of ["writing-jevels.md", "protocol.md"]) {
      const text = readFileSync(join(SKILL_DIR, "references", file), "utf8");
      expect(text.trim(), file).toBeTruthy();
      expect(text, file).not.toContain(EM_DASH);
    }
    expect(skill).not.toContain(EM_DASH);
  });
});

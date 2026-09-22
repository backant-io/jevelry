import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JevelError, discoveryDirs, findJevel, listJevels, loadJevel, parseJevel } from "../src/jevel.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");

const minimal = (frontmatter: string, body = "## When to use\n\n## State\n\n## Verdicts\n\n## Example\n") =>
  `---\n${frontmatter}\n---\n${body}`;

const good = minimal(`name: t
version: 1
model: jev-1.13.0
questions:
  q:
    type: noul
    instructions: "Is it?"`);

describe("parseJevel", () => {
  it("parses the shipped fixture with no warnings", () => {
    const { jevel, warnings } = loadJevel("wake-gate", [FIXTURES]);
    expect(warnings).toEqual([]);
    expect(jevel.name).toBe("wake-gate");
    expect(jevel.version).toBe(1);
    expect(jevel.format).toBe(1);
    expect(jevel.model).toBe("jev-1.13.0");
    expect(jevel.state).toEqual({ required: ["employee", "events", "candidates", "filing"], budget_tokens: 12000 });
    expect(jevel.verdict).toEqual({ act: 0.9, mark: 0.7 });
    expect(Object.keys(jevel.questions)).toEqual(["worth_a_turn", "depth", "same_as"]);
    expect(jevel.questions.same_as?.repeat).toEqual({ over: "candidates", as: "candidate" });
    expect(jevel.body).toContain("## When to use");
  });

  const refuses = (frontmatter: string, field: string) => {
    expect(() => parseJevel(minimal(frontmatter), "t")).toThrowError(
      expect.objectContaining({ field }) as unknown as Error,
    );
  };

  it("refuses a file with no frontmatter", () => {
    expect(() => parseJevel("# no frontmatter\n", "t")).toThrow(JevelError);
  });
  it("refuses a name that does not match the directory", () => {
    refuses(`name: other\nversion: 1\nquestions:\n  q: { type: noul, instructions: x }`, "name");
  });
  it("refuses a missing or non-integer version", () => {
    refuses(`name: t\nquestions:\n  q: { type: noul, instructions: x }`, "version");
    refuses(`name: t\nversion: 1.5\nquestions:\n  q: { type: noul, instructions: x }`, "version");
  });
  it("refuses an unknown question type", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: rank, instructions: x }`, "questions.q.type");
  });
  it("refuses a choice with fewer than 2 or more than 255 options", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: choice, instructions: x, criteria: { a: null } }`, "questions.q.criteria");
    const many = Array.from({ length: 256 }, (_, i) => `o${i}: null`).join(", ");
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: choice, instructions: x, criteria: { ${many} } }`, "questions.q.criteria");
  });
  it("refuses a score with fewer than 2 or more than 10 levels", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: score, instructions: x, criteria: [one] }`, "questions.q.criteria");
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: score, instructions: x, criteria: [a,b,c,d,e,f,g,h,i,j,k] }`, "questions.q.criteria");
  });
  it("refuses a threshold outside [0, 1] and mark over act", () => {
    refuses(`name: t\nversion: 1\nverdict: { act: 1.2 }\nquestions:\n  q: { type: noul, instructions: x }`, "verdict");
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: noul, instructions: x, verdict: { act: 0.5, mark: 0.8 } }`, "questions.q.verdict");
  });
  it("refuses a repeat without over and as", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: noul, instructions: x, repeat: { over: items } }`, "questions.q.repeat");
  });
  it("refuses a question id outside [a-z0-9_]", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  "Q-1": { type: noul, instructions: x }`, "questions.Q-1");
  });
  it("refuses a question without instructions", () => {
    refuses(`name: t\nversion: 1\nquestions:\n  q: { type: noul }`, "questions.q.instructions");
  });

  it("warns on a noul whose true reads as a negation", () => {
    const { warnings } = parseJevel(
      minimal(`name: t\nversion: 1\nmodel: jev-1.13.0\nquestions:\n  q: { type: noul, instructions: "Is it?", criteria: { true: "Not present", false: "Present" } }`),
      "t",
    );
    expect(warnings.some((w) => w.includes("questions.q.criteria.true") && w.includes("negation"))).toBe(true);
  });
  it("warns on a double negative in instructions", () => {
    const { warnings } = parseJevel(
      minimal(`name: t\nversion: 1\nmodel: jev-1.13.0\nquestions:\n  q: { type: noul, instructions: "Is it not true that no refund was asked?" }`),
      "t",
    );
    expect(warnings.some((w) => w.includes("double negative"))).toBe(true);
  });
  it("warns on a missing conventional heading and on an unpinned model", () => {
    const { warnings } = parseJevel(`---\nname: t\nversion: 1\nquestions:\n  q: { type: noul, instructions: "Is it?" }\n---\n## When to use\n`, "t");
    expect(warnings.filter((w) => w.includes("heading"))).toHaveLength(3);
    expect(warnings.some((w) => w.includes("unpinned"))).toBe(true);
  });
  it("is clean on a good jevel", () => {
    expect(parseJevel(good, "t").warnings).toEqual([]);
  });
});

describe("discovery", () => {
  it("orders cli, env, ./jevels, home/jevels and drops duplicates", () => {
    const dirs = discoveryDirs({ cli: ["/a", "/b"], env: "/c:/a", cwd: "/w", home: "/h" });
    expect(dirs).toEqual(["/a", "/b", "/c", "/w/jevels", "/h/jevels"]);
  });
  it("finds the first directory holding the jevel and lists every jevel once", () => {
    const root = mkdtempSync(join(tmpdir(), "jevelry-"));
    const first = join(root, "first");
    const second = join(root, "second");
    for (const dir of [first, second]) {
      mkdirSync(join(dir, "t"), { recursive: true });
      writeFileSync(join(dir, "t", "JEVEL.md"), good);
    }
    mkdirSync(join(second, "u"));
    writeFileSync(join(second, "u", "JEVEL.md"), good.replace("name: t", "name: u"));
    expect(findJevel("t", [first, second])).toBe(join(first, "t", "JEVEL.md"));
    expect(findJevel("nope", [first, second])).toBeNull();
    expect(listJevels([first, second]).map((j) => [j.name, j.dir])).toEqual([["t", first], ["u", second]]);
    expect(() => loadJevel("nope", [first])).toThrow(/no jevel named nope/);
  });
});

describe("review rulings", () => {
  it("refuses a threshold that is not a finite number", () => {
    expect(() =>
      parseJevel(minimal(`name: t\nversion: 1\nverdict: { act: .nan }\nquestions:\n  q: { type: noul, instructions: x }`), "t"),
    ).toThrowError(expect.objectContaining({ field: "verdict" }) as unknown as Error);
  });
  it("resolves a relative discovery dir against the injected cwd, not the process cwd", () => {
    expect(discoveryDirs({ cli: ["rel"], cwd: "/w", home: "/h" })).toEqual(["/w/rel", "/w/jevels", "/h/jevels"]);
  });
  it("refuses a jevel name that could escape the discovery dirs", () => {
    expect(() => loadJevel("../x", [FIXTURES])).toThrowError(
      expect.objectContaining({ field: "name", message: expect.stringContaining("not a jevel name") }) as unknown as Error,
    );
  });
  it("warns when a repeat `as` is also a required state key", () => {
    const { warnings } = parseJevel(
      minimal(
        `name: t\nversion: 1\nmodel: jev-1.13.0\nstate: { required: [employee] }\nquestions:\n  q: { type: noul, instructions: x, repeat: { over: items, as: employee } }`,
      ),
      "t",
    );
    expect(warnings.some((w) => w.includes("questions.q.repeat.as") && w.includes("also a required state key"))).toBe(true);
  });
});

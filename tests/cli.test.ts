import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestServer, startServer } from "./fixtures/server.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
const schema = JSON.parse(readFileSync("docs/protocol/ask.schema.json", "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

let server: TestServer;
let home: string;
/**
 * Spawned asynchronously, never with spawnSync: the test server answers on this process's own event
 * loop, which a synchronous wait would block, so the binary would hang on its first request forever.
 */
const run = (args: string[], options: { input?: string; env?: Record<string, string | undefined> } = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("node", ["bin/jevlery.js", ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TYPESAFE_API_KEY: "test-key",
        TYPESAFE_BASE_URL: server.url,
        JEVLERY_HOME: join(home, ".jevlery"),
        JEVLERY_JEVELS: FIXTURES,
        ...options.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
const state = { employee: { title: "COO", authority: ["read_readings"] }, events: [{ kind: "task.submitted" }], filing: {}, candidates: [{}, {}] };

beforeAll(async () => {
  server = await startServer();
  home = mkdtempSync(join(tmpdir(), "jevlery-cli-"));
});
afterAll(async () => server.close());

describe("check, list, show", () => {
  it("check passes the fixture with no warnings", async () => {
    const r = await run(["check", "wake-gate"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("warning:");
    expect(r.stderr).toContain("wake-gate v1: 3 questions, 0 warnings");
  });
  it("check exits 2 naming the field for a defective jevel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jevlery-bad-"));
    mkdirSync(join(dir, "bad"));
    writeFileSync(join(dir, "bad", "JEVEL.md"), "---\nname: bad\nversion: 1\nquestions:\n  q: { type: rank, instructions: x }\n---\n");
    const r = await run(["check", "bad", "--jevels", dir]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("questions.q.type");
  });
  it("list names the fixture and show prints its frontmatter as JSON", async () => {
    expect((await run(["list"])).stdout).toContain("wake-gate");
    const shown = JSON.parse((await run(["show", "wake-gate"])).stdout.split("\n---\n")[0] ?? "") as { name: string };
    expect(shown.name).toBe("wake-gate");
  });
});

describe("ask", () => {
  it("answers from a file, validates against the schema, and logs one line with the log_id", async () => {
    const file = join(home, "state.json");
    writeFileSync(file, JSON.stringify(state));
    const r = await run(["ask", "wake-gate", "--state", `@${file}`]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout) as { log_id: string; answers: Record<string, { verdict: string }> };
    expect(validate(doc)).toBe(true);
    expect(doc.log_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.answers.worth_a_turn?.verdict).toBe("act");
    const log = readFileSync(join(home, ".jevlery", "log.jsonl"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0] ?? "")).toMatchObject({ kind: "ask", id: doc.log_id, jevel: { name: "wake-gate", version: 1 } });
  });
  it("reads the state from stdin with --state -", async () => {
    const r = await run(["ask", "wake-gate", "--state", "-"], { input: JSON.stringify(state) });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).protocol).toBe(1);
  });
  it("asks one-off questions without a jevel", async () => {
    const r = await run(["ask", "--questions", JSON.stringify({ urgent: { type: "noul", instructions: "Is it urgent?" } }), "--state", '"Help!"']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).jevel).toBeNull();
  });
  it("exits 5 over budget with an error document and no request", async () => {
    const before = server.requests.length;
    const r = await run(["ask", "wake-gate", "--state", JSON.stringify({ ...state, events: ["x".repeat(12001 * 3)] })]);
    expect(r.status).toBe(5);
    expect(JSON.parse(r.stdout)).toMatchObject({ protocol: 1, error: { exit: 5, code: "over_budget" } });
    expect(server.requests.length).toBe(before);
  });
  it("exits 3 with retry_after_ms on 429 and 4 on a missing key", async () => {
    const limited = await run(["ask", "wake-gate", "--state", JSON.stringify({ ...state, fail: 429 })]);
    expect(limited.status).toBe(3);
    expect(JSON.parse(limited.stdout)).toMatchObject({ error: { code: "rate_limited", retry_after_ms: 10 } });
    const before = server.requests.length;
    const noKey = await run(["ask", "wake-gate", "--state", JSON.stringify(state)], { env: { TYPESAFE_API_KEY: undefined } });
    expect(noKey.status).toBe(4);
    expect(JSON.parse(noKey.stdout)).toMatchObject({ error: { code: "auth" } });
    expect(noKey.stderr).toContain("TYPESAFE_API_KEY");
    expect(server.requests.length).toBe(before);
  });
  it("exits 2 on a state that is not JSON, naming the field", async () => {
    const r = await run(["ask", "wake-gate", "--state", "not json"]);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { code: "bad_input", field: "state" } });
  });
});

describe("outcome and report", () => {
  it("records an outcome and reports agreement", async () => {
    const asked = JSON.parse((await run(["ask", "wake-gate", "--state", JSON.stringify(state)])).stdout) as { log_id: string };
    const o = await run(["outcome", asked.log_id, "worth_a_turn", "no"]);
    expect(o.status).toBe(0);
    const table = await run(["report", "--jevel", "wake-gate"]);
    expect(table.status).toBe(0);
    expect(table.stdout).toContain("worth_a_turn");
    const rows = JSON.parse((await run(["report", "--json"])).stdout) as Array<{ question: string; outcomes: number; agreement_act: number | null }>;
    const row = rows.find((r) => r.question === "worth_a_turn");
    expect(row?.outcomes).toBeGreaterThanOrEqual(1);
    expect(row?.agreement_act).toBe(1);
  });
  it("refuses an unknown log id and a value that names nothing", async () => {
    expect((await run(["outcome", "nope", "worth_a_turn", "agree"])).status).toBe(2);
    const asked = JSON.parse((await run(["ask", "wake-gate", "--state", JSON.stringify(state)])).stdout) as { log_id: string };
    const r = await run(["outcome", asked.log_id, "worth_a_turn", "maybe"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("yes or no");
  });
});

describe("models", () => {
  it("prints the account's model names", async () => {
    const r = await run(["models"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("jev-latest");
  });
});

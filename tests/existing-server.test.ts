import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ask } from "../src/ask.js";
import { type LocalModel, readConfig, writeConfig } from "../src/config.js";
import { defaultClient, serverClient } from "../src/decide.js";
import { SERVER_FILE, findRunningServers, stopServer } from "../src/server.js";
import { type FakeHf, startHf } from "./fixtures/hf.js";
import { type FakeJevd, startJevd } from "./fixtures/jevd.js";
import { M4_PRO_24, killFakes, sandboxEnv } from "./fixtures/sandbox.js";

/** Spawned asynchronously, because the fakes answer on this process's event loop; stdin is a pipe, never a terminal. */
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/jevelry.js", ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end("");
  });

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createNetServer().listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** An HTTP server in this process that answers every request with `status`, `type` and `body`, and records what it was asked. */
async function serve(status: number, type: string, body: string): Promise<{ url: string; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": type });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, server };
}

let jevd: FakeJevd;
let hf: FakeHf;
beforeAll(async () => {
  jevd = await startJevd();
  hf = await startHf();
});
afterAll(async () => {
  await jevd.close();
  await hf.close();
});

// A fake llama-server started by a spawned jevelry outlives that process by design: every home's is stopped and killed.
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    stopServer(home);
    killFakes(join(home, "argv.ndjson"));
  }
});

/** A temp home whose known servers are the fake jevd alone, never the Jev server that may run on this machine. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "jevelry-existing-server-"));
  homes.push(home);
  const env = sandboxEnv(home, { JEVELRY_KNOWN_SERVERS: jevd.url, JEVELRY_HF_URL: hf.url, JEVELRY_MACHINE: JSON.stringify(M4_PRO_24), FAKE_LLAMA_LOAD_MS: "100" });
  return { home, env };
}

const useJevd = (home: string): void => writeConfig(home, { backend: "server", server: { url: jevd.url, model: jevd.id } });

describe("findRunningServers", () => {
  // Only a server that answers like Jev may be offered, and probing must never send a state anywhere: jevd on
  // this machine serves a live trading system, and jevelry's own llama-server is not a second server to adopt.
  it("finds the fake jevd, ignores jevelry's own llama-server, a closed port and a non-Jev server, and sends only GET /v1/models", async () => {
    const managed = await serve(200, "application/json", JSON.stringify({
      models: [{ name: "local/vllm-d3-flash-Q8_0", model: "local/vllm-d3-flash-Q8_0" }],
      object: "list",
      data: [{ id: "local/vllm-d3-flash-Q8_0", aliases: ["local/vllm-d3-flash-Q8_0"] }],
    }));
    const web = await serve(200, "text/html", "<html>a web page</html>");
    const before = jevd.requests.length;
    try {
      const found = await findRunningServers([jevd.url, managed.url, `http://127.0.0.1:${await freePort()}`, web.url]);
      expect(found).toEqual([{ url: jevd.url, model: "jevk5-v0.3-mlx8" }]);
      expect(jevd.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
      expect([...managed.seen, ...web.seen]).toEqual(["GET /v1/models", "GET /v1/models"]);
    } finally {
      managed.server.close();
      web.server.close();
    }
  });
});

describe("asking a Jev server that already runs", () => {
  // The jevels pin hosted models jevd does not serve, and jevd's live lane belongs to the program it runs for:
  // jevelry must ask for the server's own model, send no lane header, and log the answer as a free local one.
  it("asks a shipped jevel through the fake jevd with its own model and no lane header, and logs local/<id>", async () => {
    const { home, env } = fixture();
    useJevd(home);
    const before = jevd.requests.length;
    const r = await run(["ask", "log-triage", "--state", "@jevels/log-triage/example.json"], env);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { model: string }).model).toBe("local/jevk5-v0.3-mlx8");
    const sent = jevd.requests.slice(before);
    expect(sent.map((q) => [q.method, q.path, q.body.model, q.lane])).toEqual([["POST", "/v1/systemone", "jevk5-v0.3-mlx8", undefined]]);
    const logged = JSON.parse(readFileSync(join(home, "log.jsonl"), "utf8").trim().split("\n").at(-1)!) as { model: string };
    expect(logged.model).toBe("local/jevk5-v0.3-mlx8");
    // Nothing of jevelry's own was started for it.
    expect(existsSync(join(home, "argv.ndjson"))).toBe(false);
  });

  // A failure of a server jevelry did not start is that server's: it has no llama-server.log in $JEVELRY_HOME to point at.
  it("names the server at its URL when it refuses an ask, and never points at llama-server.log", async () => {
    const refused = await ask({ client: serverClient({ url: jevd.url, model: "jevk5-v0.2" }, {}), state: "x", questions: { ok: { type: "noul", instructions: "Is it?" } } });
    expect(refused).toEqual({ ok: false, error: { exit: 2, code: "bad_input", message: `the local Jev server at ${jevd.url} refused the request: 400 model 'jevk5-v0.2' is not served here; use jevk5-v0.3-mlx8` } });
    const down = await ask({ client: serverClient({ url: `http://127.0.0.1:${await freePort()}`, model: jevd.id }, {}), state: "x", questions: { ok: { type: "noul", instructions: "Is it?" } } });
    expect(down).toMatchObject({ ok: false, error: { code: "transport" } });
    // Named, so the person knows which program to start again; jevelry never starts it.
    expect(down.ok ? "" : down.error.message).toMatch(/^the local Jev server at http:\/\/127\.0\.0\.1:\d+ did not answer: /);
    expect(JSON.stringify(down)).not.toContain("llama-server.log");
  });
});

describe("jevelry install --local-url", () => {
  // The point of the flag: the model that already runs answers jevelry with no download, from one command.
  it("writes the config, prints the smoke answer and says jevelry does not manage the server", async () => {
    const { home, env } = fixture();
    const r = await run(["install", "--local-url", `${jevd.url}/`], env);
    expect(r.status).toBe(0);
    expect(readConfig(home)).toEqual({ backend: "server", server: { url: jevd.url, model: "jevk5-v0.3-mlx8" } });
    expect(r.stderr).toMatch(new RegExp(`^jevelry: jevk5-v0\\.3-mlx8 answered in \\d+ ms at ${jevd.url}$`, "m"));
    expect(r.stderr).toContain(`jevelry: jevelry now asks jevk5-v0.3-mlx8 at ${jevd.url}; jevelry does not start or stop that server\n`);
  });

  // A typo in the URL must not switch jevelry to a server that is not there: the setup that worked stays.
  it("exits 1 and changes nothing when no Jev server answers at the URL", async () => {
    const { home, env } = fixture();
    writeConfig(home, { backend: "typesafe" });
    const url = `http://127.0.0.1:${await freePort()}`;
    const r = await run(["install", "--local-url", url], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`jevelry: no Jev server answers at ${url}\n`);
    expect(readConfig(home)).toEqual({ backend: "typesafe" });
  });

  // A server that lists a model but cannot answer must not become jevelry's backend: the setup that worked stays.
  it("exits 1 and changes nothing when the server lists a model but fails the setup check", async () => {
    const { home, env } = fixture();
    writeConfig(home, { backend: "typesafe" });
    const bad = await serve(200, "application/json", JSON.stringify({ models: [{ name: "m" }] }));
    try {
      const r = await run(["install", "--local-url", bad.url], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("jevelry: m did not answer the setup check: ");
      expect(readConfig(home)).toEqual({ backend: "typesafe" });
    } finally {
      bad.server.close();
    }
  });

  // jevelry's own llama-server is stopped by a switch to a running server, so adopting it would leave a config
  // naming a server that is gone; jevelry install --local is the way to its model.
  it("refuses the URL of a llama-server jevelry started", async () => {
    const { home, env } = fixture();
    writeConfig(home, { backend: "typesafe" });
    const own = await serve(200, "application/json", JSON.stringify({ models: [{ name: "local/vllm-d3-flash-Q8_0" }] }));
    try {
      const r = await run(["install", "--local-url", own.url], env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`jevelry: ${own.url} is a llama-server jevelry started; jevelry install --local switches to its model\n`);
      expect(own.seen.filter((s) => s.startsWith("POST"))).toEqual([]);
      expect(readConfig(home)).toEqual({ backend: "typesafe" });
    } finally {
      own.server.close();
    }
  });

  // Two models at once is how a GPU runs out of memory: switching to a running server stops jevelry's own.
  it("stops the local model server jevelry runs once the server answered", async () => {
    const { home, env } = fixture();
    const path = join(home, "vllm-d3-flash-Q8_0.gguf");
    writeFileSync(path, "not a model");
    const local: LocalModel = {
      repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B",
      decisionType: "vllm-d3", path, port: await freePort(), alias: "local/vllm-d3-flash-Q8_0",
    };
    writeConfig(home, { backend: "local", local });
    expect((await run(["ask", "--questions", '{"ok":{"type":"noul","instructions":"Is it?"}}', "--state", '"x"'], env)).status).toBe(0);
    const { pid } = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number };
    expect(alive(pid)).toBe(true);
    expect((await run(["install", "--local-url", jevd.url], env)).status).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(home, SERVER_FILE))).toBe(false);
    // The downloaded model stays on file, so jevelry install --local switches back without a download.
    expect(readConfig(home)).toEqual({ backend: "server", local, server: { url: jevd.url, model: jevd.id } });
  });
});

describe("the other commands with a Jev server running", () => {
  // A person about to download gigabytes learns first that a model already runs here and how to use it.
  it("names the running server above the table of jevelry models --local, and install --local offers it", async () => {
    const { env } = fixture();
    const r = await run(["models", "--local"], env);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe(`Already running here: jevk5-v0.3-mlx8 at ${jevd.url}; jevelry install --local-url ${jevd.url} uses it with no download`);
    expect(lines[1]).toMatch(/^This machine: /);
    const install = await run(["install", "--local"], env);
    expect(install.stderr).toContain(`jevelry: A Jev server already runs on this machine: jevk5-v0.3-mlx8 at ${jevd.url} (no download, no second model in memory)\n`);
    expect(install.stderr).toContain(`jevelry: use it with jevelry install --local-url ${jevd.url}\n`);
  });

  // The server answers as its one model whatever is asked, and listing it must send it nothing.
  it("prints the server's model for jevelry models without asking it", async () => {
    const { home, env } = fixture();
    useJevd(home);
    const before = jevd.requests.length;
    const r = await run(["models"], env);
    expect(r.stdout).toBe(`local/jevk5-v0.3-mlx8\tlocal\tjevk5-v0.3-mlx8 at ${jevd.url}\n`);
    expect(jevd.requests.length).toBe(before);
  });

  // jevd serves a live program too: jevelry stop must say so and leave it running, while still stopping jevelry's own.
  it("leaves the server running on jevelry stop and says where to stop it", async () => {
    const { home, env } = fixture();
    useJevd(home);
    const r = await run(["stop"], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(`jevelry: jevelry does not manage the server at ${jevd.url}; stop it where it was started\n`);
    expect((await fetch(`${jevd.url}/v1/models`)).status).toBe(200);
    const install = await run(["install"], env);
    expect(install.stderr).toContain(`jevelry: jevelry asks jevk5-v0.3-mlx8 at ${jevd.url}; jevelry install --local or --typesafe changes it\n`);
  });

  // A model of jevelry's own still loaded after a switch to the server is a second model in memory: stop finds it.
  it("still stops jevelry's own llama-server under the server backend", async () => {
    const { home, env } = fixture();
    writeConfig(home, { backend: "local", local: await managedModel(home) });
    expect((await run(["ask", "--questions", '{"ok":{"type":"noul","instructions":"Is it?"}}', "--state", '"x"'], env)).status).toBe(0);
    const { pid } = JSON.parse(readFileSync(join(home, SERVER_FILE), "utf8")) as { pid: number };
    useJevd(home);
    const r = await run(["stop"], env);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`jevelry: jevelry does not manage the server at ${jevd.url}; stop it where it was started\n`);
    expect(r.stderr).toContain("jevelry: stopped the local model server\n");
    expect(alive(pid)).toBe(false);
  });

  // An ask that began on jevelry's own model and outlives a switch to the running server must not start that model
  // again beside the server's: it fails and starts nothing.
  it("does not start jevelry's own model again for an ask made before a switch", async () => {
    const { home } = fixture();
    writeConfig(home, { backend: "local", local: await managedModel(home) });
    vi.stubEnv("TYPESAFE_BASE_URL", "");
    try {
      const client = defaultClient(home);
      useJevd(home);
      const result = await ask({ client, state: "x", questions: { ok: { type: "noul", instructions: "Is it?" } } });
      expect(result.ok ? "" : result.error.message).toContain("jevelry was switched to another backend while this ask waited; ask again");
      expect(existsSync(join(home, "argv.ndjson"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** A model jevelry runs itself, on a free port, with a stand-in file. */
async function managedModel(home: string): Promise<LocalModel> {
  const path = join(home, "vllm-d3-flash-Q8_0.gguf");
  writeFileSync(path, "not a model");
  return {
    repo: "ggml-org/vllm-d3-flash-GGUF", file: "vllm-d3-flash-Q8_0.gguf", quant: "Q8_0", name: "vLLM-SR d3-flash 9B",
    decisionType: "vllm-d3", path, port: await freePort(), alias: "local/vllm-d3-flash-Q8_0",
  };
}

#!/usr/bin/env node
// A fake llama-server for the tests: it loads no model and never touches a GPU. It answers the
// endpoints jevelry uses the way llama-server does, with deterministic answers like server.ts.
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stderr.write(`version: 0.7.0 (build ${process.env.FAKE_LLAMA_BUILD ?? 11669}, commit 620d222)\n`);
  process.exit(0);
}
// One JSON line per start, so a test can assert the launch args, count the starts, kill what started
// whatever the code under test did, and see which secrets and LLAMA_ settings reached the server.
if (process.env.FAKE_LLAMA_ARGV_FILE) {
  const env = Object.keys(process.env).filter((key) => key === "TYPESAFE_API_KEY" || key.startsWith("LLAMA_"));
  appendFileSync(process.env.FAKE_LLAMA_ARGV_FILE, `${JSON.stringify({ pid: process.pid, args, env })}\n`);
}
const arg = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const port = Number(arg("--port"));
const alias = arg("--alias");
const model = arg("-m");
process.stdout.write(`main: fake llama-server for ${model}\n`);
if (!model || !existsSync(model)) {
  process.stderr.write(`llama_model_load: error loading model: failed to open ${model}\n`);
  process.exit(1);
}
if (process.env.FAKE_LLAMA_FAIL) {
  process.stderr.write(`${process.env.FAKE_LLAMA_FAIL}\n`);
  process.exit(1);
}
// A safety net: a fake a test forgot to stop ends by itself instead of outliving the suite.
setTimeout(() => process.exit(0), Number(process.env.FAKE_LLAMA_LIFETIME_MS ?? 30000));
process.on("SIGTERM", () => process.exit(0));

const loadMs = Number(process.env.FAKE_LLAMA_LOAD_MS ?? 300);
const started = Date.now();

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") {
      if (Date.now() - started < loadMs) return json(503, { error: { code: 503, message: "Loading model", type: "unavailable_error" } });
      return json(200, { status: "ok" });
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      return json(200, {
        models: [{ name: alias, model: alias }],
        object: "list",
        data: [{ id: alias, aliases: [alias], architecture: { input_modalities: ["text"], output_modalities: ["decisions"] } }],
      });
    }
    if (req.method !== "POST" || req.url !== "/v1/systemone") return json(404, { error: { code: 404, message: "File Not Found", type: "not_found_error" } });
    if (process.env.FAKE_LLAMA_ANSWER_STATUS) return json(Number(process.env.FAKE_LLAMA_ANSWER_STATUS), { error: { message: "fake failure" } });
    const body = JSON.parse(raw);
    const answers = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", noul: 0.97 };
      else if (q.type === "choice") {
        const options = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / Math.max(1, options.length - 1)]));
        answers[name] = { type: "choice", choice: options[0], probabilities, confidence: 0.88 };
      } else {
        const legend = Object.fromEntries(q.criteria.map((l, i) => [String(i), l]));
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 0.75 : 0.25 / Math.max(1, q.criteria.length - 1)]));
        answers[name] = { type: "score", score: 0.3, legend, probabilities, confidence: 0.72 };
      }
    }
    json(200, { model: alias, answers, usage: { input_tokens: 42, output_tokens: 3 } });
  });
});
server.on("error", (error) => {
  process.stderr.write(`main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: ${port}: ${error.message}\n`);
  process.exit(1);
});
// A delay before listening is a server still starting: the port refuses every connection until then.
setTimeout(() => {
  server.listen(port, "127.0.0.1", () => { process.stdout.write(`main: server is listening on http://127.0.0.1:${port}\n`); });
}, Number(process.env.FAKE_LLAMA_LISTEN_DELAY_MS ?? 0));

import { createServer, type Server } from "node:http";

export interface TestServer { server: Server; url: string; requests: unknown[]; close: () => Promise<void> }

export async function startServer(): Promise<TestServer> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/v1/models") {
        return json(200, { models: [{ name: "jev-latest", description: "the latest", release_date: "2026-09-01" }] });
      }
      if (req.method !== "POST" || req.url !== "/v1/systemone") return json(404, { error: "not found" });
      // Counted before the auth check: a `requests.length` guard must tell "no request was made"
      // from "a request was made and refused", which a push after the 401 could not.
      const body = JSON.parse(raw) as { state: unknown; questions: Record<string, { type: string; criteria?: unknown }> };
      requests.push(body);
      if (req.headers.authorization !== "Bearer test-key") return json(401, { error: "bad key" });
      const fail = (body.state as { fail?: number } | null)?.fail;
      if (fail === 429) return json(429, { error: "slow down" }, { "retry-after-ms": "10" });
      if (fail !== undefined) return json(fail, { error: `failing with ${fail}` });
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === "noul") answers[name] = { type: "noul", noul: name.startsWith("worth") ? 0.08 : 0.97 };
        else if (q.type === "choice") {
          const options = Object.keys(q.criteria as Record<string, unknown>);
          const probabilities = Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / Math.max(1, options.length - 1)]));
          answers[name] = { type: "choice", choice: options[0], probabilities, confidence: 0.88 };
        } else {
          const levels = q.criteria as string[];
          const legend = Object.fromEntries(levels.map((l, i) => [String(i), l]));
          const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 0.75 : 0.25 / Math.max(1, levels.length - 1)]));
          answers[name] = { type: "score", score: 0.3, legend, probabilities, confidence: 0.72 };
        }
      }
      json(200, { model: "jev-1.13.0", answers, usage: { input_tokens: 123, output_tokens: 12 } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

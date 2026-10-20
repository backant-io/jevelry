import { createServer } from "node:http";

export interface JevdRequest { method: string; path: string; lane: string | undefined; body: any }
export interface FakeJevd { url: string; id: string; requests: JevdRequest[]; close: () => Promise<void> }

/**
 * A fake of candle-jev's jevd in this process: it loads no model, and nothing of it outlives the suite. Like
 * jevd it lists its one model in TypeSafe's shape only, answers 400 in jevd's words to any other model id, and
 * records every request with its x-jev-lane header, so a test sees what jevelry sent.
 */
export async function startJevd(id = "jevk5-v0.3-mlx8"): Promise<FakeJevd> {
  const requests: JevdRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const lane = req.headers["x-jev-lane"];
      const body = raw === "" ? undefined : JSON.parse(raw);
      requests.push({ method: req.method ?? "", path: req.url ?? "", lane: typeof lane === "string" ? lane : undefined, body });
      if (req.method === "GET" && req.url === "/v1/models") return json(200, { models: [{ name: id, release_date: "2026-10-01", description: "JevK5 v0.3 on MLX (local jevd)" }] });
      if (req.method !== "POST" || req.url !== "/v1/systemone") return json(404, { detail: "not found" });
      if (body.model !== id) return json(400, { detail: `model '${body.model}' is not served here; use ${id}` });
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(body.questions as Record<string, { type: string; criteria: any }>)) {
        if (q.type === "noul") answers[name] = { type: "noul", noul: 0.97 };
        else if (q.type === "choice") {
          const options = Object.keys(q.criteria);
          answers[name] = { type: "choice", choice: options[0], probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (options.length - 1)])), confidence: 0.88 };
        } else {
          const levels = q.criteria as string[];
          answers[name] = { type: "score", score: 0.3, legend: Object.fromEntries(levels.map((l, i) => [String(i), l])), probabilities: Object.fromEntries(levels.map((_, i) => [String(i), i === 0 ? 0.75 : 0.25 / (levels.length - 1)])), confidence: 0.72 };
        }
      }
      json(200, { model: id, answers, usage: { input_tokens: 42, output_tokens: 0 } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, id, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

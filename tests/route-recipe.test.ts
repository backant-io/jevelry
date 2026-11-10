import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jevel } from "../src/decide.js";
import { type TestServer, startServer } from "./fixtures/server.js";

let server: TestServer;
beforeAll(async () => { server = await startServer(); });
afterAll(async () => server.close());

const load = (baseURL = server.url) =>
  jevel("request-route", {
    jevels: [join(process.cwd(), "jevels")],
    home: mkdtempSync(join(tmpdir(), "jevelry-route-")),
    client: new TypeSafeClient({ apiKey: "test-key", baseURL, retry: { maxRetries: 0 }, defaultModel: "jev-1.13.0" }),
  });

/** The function of docs/examples.md, "Routing a request to a small or a large model"; `reply` is what the test server answers. */
async function modelFor(route: ReturnType<typeof load>, reply?: Record<string, unknown>): Promise<"small" | "large"> {
  const d = await route.decide({ request: { prompt: "Translate into German: thank you.", context: "first message", tools: "none" }, ...(reply ? { reply } : {}) });
  const oneStep = d.complexity?.decision === "act" && d.complexity.answer === 0;
  const selfContained = d.needs_tools?.decision === "act" && d.needs_tools.answer === false;
  return oneStep && selfContained ? "small" : "large";
}

const legend = { "0": "one step", "1": "a condition", "2": "several conditions" };
const complexity = (score: number, confidence: number) => ({ type: "score", score, legend, probabilities: { "0": 0.9, "1": 0.08, "2": 0.02 }, confidence });
const tools = (noul: number) => ({ type: "noul", noul });

// A wrong "easy" costs the person a bad answer and a wrong "hard" costs one call to the large model, so only a sure
// answer may move a request down, and a decision model that is down must not stop the request.
describe("the routing recipe", () => {
  it("sends a request to the small model only when it is surely one step and surely needs nothing fetched or run", async () => {
    const route = load();
    expect(await modelFor(route, { complexity: complexity(0.1, 0.95), needs_tools: tools(0.03) })).toBe("small");
    // A level above the first, however sure.
    expect(await modelFor(route, { complexity: complexity(1.1, 0.95), needs_tools: tools(0.03) })).toBe("large");
    // The first level, but under the jevel's act threshold of 0.8: a mark.
    expect(await modelFor(route, { complexity: complexity(0.1, 0.7), needs_tools: tools(0.03) })).toBe("large");
    // One step, but it needs a tool.
    expect(await modelFor(route, { complexity: complexity(0.1, 0.95), needs_tools: tools(0.97) })).toBe("large");
    // One step, and whether it needs a tool is a coin toss.
    expect(await modelFor(route, { complexity: complexity(0.1, 0.95), needs_tools: tools(0.55) })).toBe("large");
  });
  it("fails open to the large model when the decision model cannot answer", async () => {
    // Nothing answers /v1/systemone under this path: decide hands every question back as fall_back and does not throw.
    expect(await modelFor(load(`${server.url}/nowhere`))).toBe("large");
  });
});

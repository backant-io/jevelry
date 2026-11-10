import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { ask } from "../src/ask.js";
import { type AskLine, REQUESTS_FILE, appendLine, findRepeat, logAsk } from "../src/log.js";
import { speed } from "../src/report.js";
import { jsonResponse, scriptedFetch } from "./fixtures/responses.js";

const QUESTIONS = { urgent: { type: "noul", instructions: "Is it urgent?" } } as never;
const LOCAL = "local/a.gguf";
const client = (fetch: (url: string, init?: RequestInit) => Promise<Response>, defaultModel = LOCAL) =>
  new TypeSafeClient({ apiKey: "local", baseURL: "http://127.0.0.1:9", defaultModel, retry: { maxRetries: 0 }, fetch });
const never = async (): Promise<Response> => { throw new Error("the model was asked"); };
const body = (model: string) => jsonResponse(200, { model, answers: { urgent: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 40, output_tokens: 1 } });

const logged = (extra: Partial<AskLine> = {}): AskLine => ({
  kind: "ask", id: "original", at: "2026-11-10T10:00:00.000Z", jevel: null, model: LOCAL, state_hash: "sha256:s", request_hash: "sha256:r",
  answers: { urgent: { type: "noul", noul: 0.99, yes: true, certainty: 0.99, decision: "act" } }, usage: { input_tokens: 40, output_tokens: 1 }, ms: 1500, cwd: "/w",
  ...extra,
});

// Measured on jevelry's own llama-server: the same prompt asked again takes as long as the first time, and the answer
// is the same byte for byte. So an exact repeat can be answered from the log, with no model time and no model loaded.
describe("an exact repeat answered from the log", () => {
  it("gives the logged answer without asking the model, and says which ask it came from", async () => {
    let asked: [string, string] | undefined;
    const result = await ask({ client: client(never), state: "Help!", questions: QUESTIONS, repeat: async (hash, model) => { asked = [hash, model]; return logged(); } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(asked?.[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(asked?.[1]).toBe(LOCAL);
    expect(result.request_hash).toBe(asked?.[0]);
    expect(result.cached_from).toBe("original");
    expect(result.document.model).toBe(LOCAL);
    expect(result.document.answers).toEqual(logged().answers);
    // Nothing was processed now, and the document says so.
    expect(result.document.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
  // Thresholds may move without a question changing: the decision is today's reading of the logged certainty.
  it("judges the logged answer by today's thresholds, not by the decision written back then", async () => {
    const strict = logged({ answers: { urgent: { type: "noul", noul: 0.99, yes: true, certainty: 0.99, decision: "fall_back" } } });
    const result = await ask({ client: client(never), state: "Help!", questions: QUESTIONS, repeat: async () => strict });
    expect(result.ok && result.document.answers.urgent?.decision).toBe("act");
  });
  // Only jevelry's own local model is known to answer the same every time; hosted Jev is never measured, because asking it costs money.
  it("never consults the log for hosted Jev", async () => {
    const { fetch, calls } = scriptedFetch([() => body("jev-1.13.0")]);
    const result = await ask({ client: client(fetch, "jev-1.13.0"), state: "Help!", questions: QUESTIONS, repeat: async () => { throw new Error("the log was consulted"); } });
    expect(result.ok && result.cached_from).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
  it("asks the model when the log holds nothing for the request, or an answer that does not fit its questions", async () => {
    for (const found of [undefined, logged({ answers: { other: { type: "noul", noul: 0.9, yes: true, certainty: 0.9, decision: "act" } } })]) {
      const { fetch, calls } = scriptedFetch([() => body(LOCAL)]);
      const result = await ask({ client: client(fetch), state: "Help!", questions: QUESTIONS, repeat: async () => found });
      expect(result.ok && result.cached_from).toBeUndefined();
      expect(result.ok && result.document.usage.input_tokens).toBe(40);
      expect(calls).toHaveLength(1);
    }
  });
  // The hash is of what was asked, so a reworded question is a new request even under the same jevel version.
  it("hashes the state and the questions together, whatever order their keys came in", async () => {
    const hashOf = async (state: unknown, questions: unknown): Promise<string> => {
      const { fetch } = scriptedFetch([() => body(LOCAL)]);
      const result = await ask({ client: client(fetch), state: state as never, questions: questions as never });
      if (!result.ok) throw new Error(result.error.message);
      return result.request_hash;
    };
    const base = await hashOf({ a: 1, b: 2 }, { urgent: { type: "noul", instructions: "Is it urgent?" } });
    expect(await hashOf({ b: 2, a: 1 }, { urgent: { instructions: "Is it urgent?", type: "noul" } })).toBe(base);
    expect(await hashOf({ a: 1, b: 2 }, { urgent: { type: "noul", instructions: "Is it really urgent?" } })).not.toBe(base);
    expect(await hashOf({ a: 1, b: 3 }, { urgent: { type: "noul", instructions: "Is it urgent?" } })).not.toBe(base);
  });
});

describe("findRepeat", () => {
  it("finds the latest answer the model itself gave to this request, by this model", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-cache-"));
    await appendLine(home, logged({ id: "first" }));
    await appendLine(home, logged({ id: "other-model", model: "local/b.gguf" }));
    await appendLine(home, logged({ id: "other-request", request_hash: "sha256:x" }));
    await appendLine(home, logged({ id: "second" }));
    // A copy of an answer is never the source of the next one, and an ask Jev never answered has nothing to give.
    await appendLine(home, logged({ id: "copy", cached_from: "second" }));
    await appendLine(home, logged({ id: "failed", model: null, error: { exit: 6, code: "transport", message: "down" } }));
    expect((await findRepeat(home, "sha256:r", LOCAL))?.id).toBe("second");
    expect((await findRepeat(home, "sha256:r", "local/b.gguf"))?.id).toBe("other-model");
    expect(await findRepeat(home, "sha256:nothing", LOCAL)).toBeUndefined();
    expect(await findRepeat(mkdtempSync(join(tmpdir(), "jevelry-cache-")), "sha256:r", LOCAL)).toBeUndefined();
  });
});

// Reading and parsing a whole log to learn that an ask is no repeat cost 270 ms on a log of 100,000 asks, on every
// ask. The index holds 32 bytes per answered request, and can only ever cost a model call, never a wrong answer.
describe("the index of answered requests", () => {
  const H = (n: number): string => `sha256:${String(n).repeat(64).slice(0, 64)}`;
  const fields = (n: number, extra: Partial<AskLine> = {}) => ({ jevel: null, model: LOCAL, state_hash: "sha256:s", request_hash: H(n), answers: logged().answers, usage: { input_tokens: 40, output_tokens: 1 }, ms: 1500, ...extra });
  const warn = (): void => {};
  it("gains 32 bytes for every ask the model answered, and none for a copy or an ask Jev never answered", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-index-"));
    await logAsk(home, fields(1), warn);
    await logAsk(home, fields(2), warn);
    await logAsk(home, fields(1, { cached_from: "x" }), warn);
    await logAsk(home, fields(3, { model: null, usage: null, error: { exit: 6, code: "transport", message: "down" } }), warn);
    const index = readFileSync(join(home, REQUESTS_FILE));
    expect(index.length).toBe(64);
    expect(index.subarray(0, 32).toString("hex")).toBe(H(1).slice(7));
    expect((await findRepeat(home, H(2), LOCAL))?.request_hash).toBe(H(2));
    expect(await findRepeat(home, H(3), LOCAL)).toBeUndefined();
  });
  it("is built from the log when a log has none, so asks logged before it was kept are still found", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-index-"));
    await appendLine(home, logged({ id: "old", request_hash: H(4) }));
    expect(existsSync(join(home, REQUESTS_FILE))).toBe(false);
    expect((await findRepeat(home, H(4), LOCAL))?.id).toBe("old");
    expect(readFileSync(join(home, REQUESTS_FILE)).length).toBe(32);
  });
  // The index only ever says "look" or "do not look". Wrong either way, the worst that happens is one more ask of the model.
  it("costs a model call and never a wrong answer when it and the log disagree", async () => {
    const home = mkdtempSync(join(tmpdir(), "jevelry-index-"));
    await logAsk(home, fields(5), warn);
    // The index names a request the log no longer holds.
    rmSync(join(home, "log.jsonl"));
    expect(await findRepeat(home, H(5), LOCAL)).toBeUndefined();
    // The log holds a request the index never got.
    await appendLine(home, logged({ id: "unindexed", request_hash: H(6) }));
    expect(await findRepeat(home, H(6), LOCAL)).toBeUndefined();
    // A state that happens to carry a hash in its text is not an answer to that request.
    await logAsk(home, fields(7, { state: { note: H(8) } }), warn);
    expect(await findRepeat(home, H(8), LOCAL)).toBeUndefined();
  });
});

describe("speed with repeats in the log", () => {
  // The speed table says how long the model takes: an answer copied from the log in a few ms would flatter it.
  it("leaves out asks answered from the log", () => {
    const named = (extra: Partial<AskLine>): AskLine => logged({ jevel: { name: "gate", version: 1 }, ...extra });
    const rows = speed([named({ id: "a", ms: 1500 }), named({ id: "b", ms: 3, cached_from: "a", usage: { input_tokens: 0, output_tokens: 0 } })]);
    expect(rows).toEqual([{ jevel: "gate", model: LOCAL, asks: 1, p50_ms: 1500, p95_ms: 1500, tokens_per_s: (40 * 1000) / 1500, cold_asks: 0, cold_p50_ms: null }]);
  });
});

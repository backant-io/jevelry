import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { ask, canonicalJson, stateHash } from "../src/ask.js";
import { loadJevel } from "../src/jevel.js";
import { CHOICE_BODY, CHOICE_QUESTIONS, NOUL_BODY, NOUL_QUESTIONS, REFERENCE_STATE, SCORE_BODY, SCORE_QUESTIONS, jsonResponse, scriptedFetch } from "./fixtures/responses.js";

const client = (fetch: (url: string, init?: RequestInit) => Promise<Response>, retry = { maxRetries: 0 }) =>
  new TypeSafeClient({ apiKey: "test-key", fetch, retry, defaultModel: "jev-1.13.0" });

describe("canonicalJson and stateHash", () => {
  it("sorts keys at every level and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  });
  it("hashes the canonical form, so key order does not change the hash", () => {
    expect(stateHash({ a: 1, b: 2 })).toBe(stateHash({ b: 2, a: 1 }));
    expect(stateHash("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("ask with one-off questions", () => {
  for (const [name, questions, body] of [
    ["noul", NOUL_QUESTIONS, NOUL_BODY],
    ["choice", CHOICE_QUESTIONS, CHOICE_BODY],
    ["score", SCORE_QUESTIONS, SCORE_BODY],
  ] as const) {
    it(`renders the reference ${name} answer byte for byte as docs/protocol/example-${name}.json`, async () => {
      const { fetch, calls } = scriptedFetch([() => jsonResponse(200, body)]);
      const result = await ask({ client: client(fetch), state: REFERENCE_STATE, questions: questions as never });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(calls[0]?.body).toEqual({ state: REFERENCE_STATE, questions, model: "jev-1.13.0" });
      const expected = readFileSync(join("docs", "protocol", `example-${name}.json`), "utf8");
      expect(`${JSON.stringify(result.document, null, 2)}\n`).toBe(expected);
    });
  }
  it("refuses a probability outside [0, 1] instead of passing it into the document", async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse(200, { ...CHOICE_BODY, answers: { department: { ...CHOICE_BODY.answers.department, probabilities: { billing: 1.5, technical: -0.5 } } } }),
    ]);
    const result = await ask({ client: client(fetch), state: REFERENCE_STATE, questions: CHOICE_QUESTIONS as never });
    expect(result).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "answers.department.probabilities.billing" } });
  });
  it("refuses a non-finite score, which JSON prints as null", async () => {
    // Number.NaN survives the fixture only as far as JSON.stringify, which puts `null` on the wire:
    // exactly where the protocol declares a number, so the guard has to fire on it.
    const { fetch } = scriptedFetch([() => jsonResponse(200, { ...SCORE_BODY, answers: { frustration: { ...SCORE_BODY.answers.frustration, score: Number.NaN } } })]);
    const result = await ask({ client: client(fetch), state: REFERENCE_STATE, questions: SCORE_QUESTIONS as never });
    expect(result).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "answers.frustration.score" } });
  });
  it("refuses an empty question map before any call", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const result = await ask({ client: client(fetch), state: "x", questions: {} });
    expect(result).toEqual({ ok: false, error: { exit: 2, code: "bad_input", message: expect.stringContaining("questions"), field: "questions" } });
    expect(calls).toHaveLength(0);
  });
});

describe("ask with a jevel", () => {
  const FIXTURES = join(process.cwd(), "tests", "fixtures", "jevels");
  const { jevel } = loadJevel("wake-gate", [FIXTURES]);
  const state = { employee: { title: "COO", authority: [] }, events: [{ kind: "task.submitted" }], filing: {}, candidates: [{}, {}] };
  const answers = {
    worth_a_turn: { type: "noul", noul: 0.08 },
    depth: { type: "score", score: 0.3, legend: { "0": "routine", "1": "judgment", "2": "hard" }, probabilities: { "0": 0.75, "1": 0.2, "2": 0.05 }, confidence: 0.72 },
    "same_as[0]": { type: "noul", noul: 0.97 },
    "same_as[1]": { type: "noul", noul: 0.4 },
  };
  it("expands, sends the pinned model, and applies per-question thresholds", async () => {
    const { fetch, calls } = scriptedFetch([() => jsonResponse(200, { model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 40 } })]);
    const result = await ask({ client: client(fetch), state, jevel });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]?.body.model).toBe("jev-1.13.0");
    expect(Object.keys(calls[0]?.body.questions)).toEqual(["worth_a_turn", "depth", "same_as[0]", "same_as[1]"]);
    expect(result.document.jevel).toEqual({ name: "wake-gate", version: 1 });
    expect(result.document.answers.worth_a_turn).toEqual({ type: "noul", noul: 0.08, yes: false, certainty: 0.92, verdict: "act" });
    expect(result.document.answers.depth?.verdict).toBe("act");
    expect(result.document.answers["same_as[0]"]?.verdict).toBe("act");
    expect(result.document.answers["same_as[1]"]?.verdict).toBe("fall_back");
  });
  it("lets --model override the jevel's pin", async () => {
    const { fetch, calls } = scriptedFetch([() => jsonResponse(200, { model: "jev-1.14.0", answers, usage: { input_tokens: 1, output_tokens: 1 } })]);
    const result = await ask({ client: client(fetch), state, jevel, model: "jev-1.14.0" });
    expect(result.ok && result.document.model).toBe("jev-1.14.0");
    expect(calls[0]?.body.model).toBe("jev-1.14.0");
  });
  it("refuses a state missing a required key before any call", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const result = await ask({ client: client(fetch), state: { employee: {} }, jevel });
    expect(result).toMatchObject({ ok: false, error: { exit: 2, code: "bad_input", field: "state.required" } });
    expect(calls).toHaveLength(0);
  });
  it("refuses an over-budget state before any call", async () => {
    const { fetch, calls } = scriptedFetch([]);
    const big = { ...state, events: ["x".repeat(12001 * 3)] };
    const result = await ask({ client: client(fetch), state: big, jevel });
    expect(result).toMatchObject({ ok: false, error: { exit: 5, code: "over_budget", message: expect.stringContaining("jevel") } });
    expect(calls).toHaveLength(0);
  });
  it("names an answer the API left out or shaped unreadably", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(200, { model: "jev-1.13.0", answers: { ...answers, depth: { type: "rank", rank: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } })]);
    const result = await ask({ client: client(fetch), state, jevel });
    expect(result).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "answers.depth" } });
  });
  it("refuses a noul outside [0, 1] instead of clamping it", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(200, { model: "jev-1.13.0", answers: { ...answers, worth_a_turn: { type: "noul", noul: 1.5 } }, usage: { input_tokens: 1, output_tokens: 1 } })]);
    const result = await ask({ client: client(fetch), state, jevel });
    expect(result).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "answers.worth_a_turn.noul" } });
  });
});

describe("error mapping", () => {
  const state = "x";
  const questions = NOUL_QUESTIONS as never;
  it("maps 429 to rate_limited with the server delay, after the SDK's retries", async () => {
    const { fetch, calls } = scriptedFetch([
      () => jsonResponse(429, { error: "slow down" }, { "retry-after": "2" }),
      () => jsonResponse(429, { error: "slow down" }, { "retry-after": "2" }),
    ]);
    // respectRetryAfter off so the test does not sleep the two seconds the header asks for; the
    // delay is still parsed onto the error, which is what the mapping reads.
    const result = await ask({ client: client(fetch, { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 1, respectRetryAfter: false } as never), state, questions });
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, error: { exit: 3, code: "rate_limited", retry_after_ms: 2000 } });
  });
  it("maps 529 to overloaded", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(529, { error: "overloaded" }, { "retry-after-ms": "750" })]);
    const result = await ask({ client: client(fetch), state, questions });
    expect(result).toMatchObject({ ok: false, error: { exit: 3, code: "overloaded", retry_after_ms: 750 } });
  });
  it("ignores a Retry-After that is neither seconds nor an HTTP date, rather than reporting no delay as zero", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(529, { error: "overloaded" }, { "retry-after": "2.5" })]);
    const result = await ask({ client: client(fetch), state, questions });
    expect(result).toEqual({ ok: false, error: { exit: 3, code: "overloaded", message: expect.stringContaining("529") } });
  });
  it("reads a Retry-After given as an HTTP date", async () => {
    const at = new Date(Date.now() + 3000).toUTCString();
    const { fetch } = scriptedFetch([() => jsonResponse(529, { error: "overloaded" }, { "retry-after": at })]);
    const result = await ask({ client: client(fetch), state, questions });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retry_after_ms).toBeGreaterThanOrEqual(0);
    expect(result.error.retry_after_ms).toBeLessThanOrEqual(3000);
  });
  it("refuses a 200 whose envelope carries no answers", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(200, { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 } })]);
    expect(await ask({ client: client(fetch), state, questions })).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "answers" } });
  });
  it("refuses a 200 that names no model, rather than dropping the document's model key", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(200, { answers: NOUL_BODY.answers, usage: NOUL_BODY.usage })]);
    expect(await ask({ client: client(fetch), state, questions })).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "model" } });
  });
  it("refuses a 200 whose usage is missing a count", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(200, { model: "jev-1.13.0", answers: NOUL_BODY.answers, usage: { input_tokens: 307 } })]);
    expect(await ask({ client: client(fetch), state, questions })).toMatchObject({ ok: false, error: { exit: 7, code: "unreadable_answer", field: "usage.output_tokens" } });
  });
  it("maps 401 and 403 to auth", async () => {
    for (const status of [401, 403]) {
      const { fetch } = scriptedFetch([() => jsonResponse(status, { error: "nope" })]);
      expect(await ask({ client: client(fetch), state, questions })).toMatchObject({ ok: false, error: { exit: 4, code: "auth" } });
    }
  });
  it("maps 422 to bad_input carrying the API's message", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(422, { detail: [{ loc: ["body", "questions", "x", "criteria"], msg: "field required" }] })]);
    expect(await ask({ client: client(fetch), state, questions })).toMatchObject({ ok: false, error: { exit: 2, code: "bad_input", message: expect.stringContaining("questions.x.criteria") } });
  });
  it("maps 500 and a connection failure to transport", async () => {
    const { fetch } = scriptedFetch([() => jsonResponse(500, "boom")]);
    expect(await ask({ client: client(fetch), state, questions })).toMatchObject({ ok: false, error: { exit: 6, code: "transport" } });
    const failing = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    expect(await ask({ client: client(failing), state, questions })).toMatchObject({ ok: false, error: { exit: 6, code: "transport" } });
  });
});

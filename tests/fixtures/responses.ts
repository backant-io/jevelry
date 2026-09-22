export const REFERENCE_STATE = "Help! My payouts have been failing for 3 days.";

export const NOUL_QUESTIONS = {
  is_urgent: { type: "noul", instructions: "Does this convey urgency?", criteria: { true: "Explicitly time-sensitive", false: "No urgency expressed" } },
} as const;
export const NOUL_BODY = { model: "jev-1.13.0", answers: { is_urgent: { type: "noul", noul: 0.95 } }, usage: { input_tokens: 307, output_tokens: 20 } };

export const CHOICE_QUESTIONS = {
  department: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments, invoicing, refunds", technical: "Bugs, outages, integrations", sales: "Pricing, upgrades, new accounts" } },
} as const;
export const CHOICE_BODY = {
  model: "jev-1.13.0",
  answers: { department: { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 }, confidence: 0.81 } },
  usage: { input_tokens: 318, output_tokens: 34 },
};

export const SCORE_QUESTIONS = {
  frustration: { type: "score", instructions: "How frustrated is the customer?", criteria: ["Calm", "Frustrated", "Very angry"] },
} as const;
export const SCORE_BODY = {
  model: "jev-1.13.0",
  answers: { frustration: { type: "score", score: 1.05, legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" }, probabilities: { "0": 0.0, "1": 0.95, "2": 0.05 }, confidence: 0.92 } },
  usage: { input_tokens: 304, output_tokens: 18 },
};

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that answers from a queue and records every request it saw. */
export function scriptedFetch(responses: Array<() => Response>) {
  /** `body` is the parsed request payload, read field by field in the tests. */
  const calls: Array<{ url: string; init: RequestInit | undefined; body: any }> = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift();
    if (!next) throw new Error("scriptedFetch: no response left");
    return next();
  };
  return { fetch, calls };
}

/** Documented on https://docs.typesafe.ai/models.md for jev-1.13: 64k per request, 32k for state plus the longest question. */
export const MODEL_TOTAL_TOKENS = 64_000;
export const MODEL_STATE_PLUS_QUESTION_TOKENS = 32_000;
/** Deliberately pessimistic: a real tokenizer averages nearer 4 bytes per token on English. */
export const BYTES_PER_TOKEN = 3;

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export interface BudgetBreach {
  limit: "total" | "state_plus_question" | "jevel";
  estimate: number;
  ceiling: number;
}

/** The first ceiling the request would pass, or null. Checked before any call is made. */
export function checkBudgets(
  state: unknown,
  questions: Record<string, unknown>,
  jevelBudget?: number,
): BudgetBreach | null {
  const stateTokens = estimateTokens(state);
  if (jevelBudget !== undefined && stateTokens > jevelBudget) {
    return { limit: "jevel", estimate: stateTokens, ceiling: jevelBudget };
  }
  const questionTokens = Object.values(questions).map(estimateTokens);
  const longest = questionTokens.length > 0 ? Math.max(...questionTokens) : 0;
  if (stateTokens + longest > MODEL_STATE_PLUS_QUESTION_TOKENS) {
    return {
      limit: "state_plus_question",
      estimate: stateTokens + longest,
      ceiling: MODEL_STATE_PLUS_QUESTION_TOKENS,
    };
  }
  const total = stateTokens + questionTokens.reduce((sum, n) => sum + n, 0);
  if (total > MODEL_TOTAL_TOKENS) {
    return { limit: "total", estimate: total, ceiling: MODEL_TOTAL_TOKENS };
  }
  return null;
}

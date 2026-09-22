/** The stdout document of `jevelry ask`. Fields are added, never renamed or removed, while PROTOCOL is 1. */
export const PROTOCOL = 1 as const;

export type Verdict = "act" | "mark" | "fall_back";

export interface NoulAnswer {
  type: "noul";
  noul: number;
  yes: boolean;
  certainty: number;
  verdict: Verdict;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  certainty: number;
  verdict: Verdict;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
  certainty: number;
  verdict: Verdict;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface AskDocument {
  protocol: typeof PROTOCOL;
  log_id: string | null;
  jevel: { name: string; version: number } | null;
  model: string;
  state_hash: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

export type ErrorCode =
  | "bad_input"
  | "rate_limited"
  | "overloaded"
  | "auth"
  | "over_budget"
  | "transport"
  | "unreadable_answer";

export interface ErrorBody {
  exit: number;
  code: ErrorCode;
  message: string;
  retry_after_ms?: number;
  field?: string;
}

export interface ErrorDocument {
  protocol: typeof PROTOCOL;
  error: ErrorBody;
}

/** The exit code a host branches on, per error code. */
export const EXIT: Record<ErrorCode, number> = {
  bad_input: 2,
  rate_limited: 3,
  overloaded: 3,
  auth: 4,
  over_budget: 5,
  transport: 6,
  unreadable_answer: 7,
};

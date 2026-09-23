/** The stdout document of `jevelry ask`. Fields are added, never renamed or removed, while PROTOCOL is 2. */
export const PROTOCOL = 2 as const;

export type Decision = "act" | "mark" | "fall_back";

export interface NoulAnswer {
  type: "noul";
  noul: number;
  yes: boolean;
  certainty: number;
  decision: Decision;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  certainty: number;
  decision: Decision;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
  certainty: number;
  decision: Decision;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** What Jev could not answer: the code takes its old path, so the type is all a caller needs. */
export interface FallBackAnswer<T extends Answer["type"] = Answer["type"]> {
  type: T;
  decision: "fall_back";
  answer: null;
  certainty: 0;
}

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
  | "unreadable_answer"
  | "not_confirmed";

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
  /** `jevelry run`: Jev marked the call and nobody confirmed it, so nothing ran. */
  not_confirmed: 9,
};

/** What `jevelry run` did with the dispatcher's decision. `exit` and `ms` are null when nothing ran. */
export interface RunReport {
  option: string | null;
  command: string | null;
  decision: Decision;
  exit: number | null;
  ms: number | null;
  /** On mark: whether a person, `--yes` or `confirm` said yes. Null when nobody was asked. */
  confirmed: boolean | null;
}

import type { Decision } from "./protocol.js";

export interface Thresholds {
  act: number;
  mark: number;
}

/** Conservative, as the confidence page advises; a jevel lowers them per question. */
export const DEFAULT_THRESHOLDS: Thresholds = { act: 0.9, mark: 0.7 };

/**
 * Choice and score answers carry the API's confidence. A noul carries none, so its certainty
 * is how far the probability sits from 0.5: a 0.08 is as certain a no as a 0.92 is a yes.
 */
export function certaintyOf(
  answer: { type: "noul"; noul: number } | { type: "choice" | "score"; confidence: number },
): number {
  if (answer.type === "noul") return Math.max(answer.noul, 1 - answer.noul);
  return answer.confidence;
}

export function decisionOf(certainty: number, thresholds: Thresholds): Decision {
  if (certainty >= thresholds.act) return "act";
  if (certainty >= thresholds.mark) return "mark";
  return "fall_back";
}

/** Later layers win field by field: runtime defaults, then the jevel's, then the question's. */
export function mergeThresholds(...layers: Array<Partial<Thresholds> | undefined>): Thresholds {
  let merged: Thresholds = { ...DEFAULT_THRESHOLDS };
  for (const layer of layers) {
    if (!layer) continue;
    merged = {
      act: layer.act ?? merged.act,
      mark: layer.mark ?? merged.mark,
    };
  }
  return merged;
}

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shipped jevels that carry a `cases.json`. The offline suite holds this list to the folders on
 * disk, and the live suite asks every case in it. Once every jevel has cases the constant goes away.
 */
export const WITH_CASES = [
  "alert-cause",
  "change-risk",
  "checklist-compliance",
  "duplicate-issue",
  "escalation-route",
  "issue-readiness",
  "log-triage",
  "meeting-notes",
  "ticket-triage",
];

/** One realistic state, and what a correct answer to it looks like question by question. */
export interface Case {
  name: string;
  state: unknown;
  expect: Record<string, string | boolean | number | null>;
}

/** The file as it is on disk. The offline suite is what proves the shape; nothing is checked here. */
export const readCases = (name: string): Case[] =>
  JSON.parse(readFileSync(join(process.cwd(), "jevels", name, "cases.json"), "utf8")) as Case[];

/** `same_as[1]` and `same_as[0]` are one question repeated: the value coverage rules count them together. */
export const baseName = (question: string): string => question.replace(/\[\d+\]$/, "");

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EntryType, Question, Questions } from "@typesafe-ai/sdk";
import { parse as parseYaml } from "yaml";
import { mergeThresholds, type Thresholds } from "./verdict.js";

/** A defect in a jevel or in the state a host sent. `field` names the offending path. */
export class JevelError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "JevelError";
    this.field = field;
  }
}

export interface Repeat {
  over: string;
  as: string;
}

export interface JevelQuestion {
  type: "noul" | "choice" | "score";
  instructions: EntryType;
  criteria?: unknown;
  verdict?: Partial<Thresholds>;
  repeat?: Repeat;
}

export interface Jevel {
  name: string;
  version: number;
  format: number;
  model?: string;
  state: { required: string[]; budget_tokens?: number };
  verdict: Partial<Thresholds>;
  questions: Record<string, JevelQuestion>;
  body: string;
  path: string;
}

export interface Parsed {
  jevel: Jevel;
  warnings: string[];
}

/** Names that move when TypeSafe ships a release (https://docs.typesafe.ai/models.md#aliases). */
export const ALIASES = ["jev-latest", "jev-preview"];

const NAME = /^[a-z0-9-]+$/;
const QUESTION_ID = /^[a-z0-9_]+$/;
const HEADINGS = ["When to use", "State", "Verdicts", "Example"];
const NEGATION_FIRST_WORD = /^\s*(not|no|never)\b/i;
const DOUBLE_NEGATIVE = /\b(not|never|no)\b[^.?!]*\b(not|never|no)\b/i;
/** The API's own limits: https://docs.typesafe.ai/api.md */
const CHOICE_OPTIONS = { min: 2, max: 255 };
const SCORE_LEVELS = { min: 2, max: 10 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEntry = (value: unknown): boolean =>
  typeof value === "string" || Array.isArray(value) || isRecord(value);

function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") throw new JevelError("frontmatter", "a jevel starts with a `---` frontmatter block");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new JevelError("frontmatter", "the frontmatter block is never closed with `---`");
  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function thresholdsOf(value: unknown, field: string): Partial<Thresholds> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new JevelError(field, `${field} must be an object with act and/or mark`);
  const out: Partial<Thresholds> = {};
  for (const key of ["act", "mark"] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw new JevelError(field, `${field}.${key} must be a number in [0, 1]`);
    out[key] = n;
  }
  return out;
}

function checkMarkUnderAct(layers: Array<Partial<Thresholds>>, field: string): void {
  const merged = mergeThresholds(...layers);
  if (merged.mark > merged.act) throw new JevelError(field, `${field}: mark (${merged.mark}) must not exceed act (${merged.act})`);
}

function questionOf(id: string, raw: unknown, jevelVerdict: Partial<Thresholds>): JevelQuestion {
  const field = `questions.${id}`;
  if (!QUESTION_ID.test(id)) throw new JevelError(field, `question id \`${id}\` must match [a-z0-9_]+`);
  if (!isRecord(raw)) throw new JevelError(field, `${field} must be an object`);
  const type = raw.type;
  if (type !== "noul" && type !== "choice" && type !== "score") {
    throw new JevelError(`${field}.type`, `${field}.type must be noul, choice or score`);
  }
  if (!isEntry(raw.instructions)) {
    throw new JevelError(`${field}.instructions`, `${field}.instructions is required: a string, object or array`);
  }
  const criteria = raw.criteria;
  if (type === "choice") {
    if (!isRecord(criteria)) throw new JevelError(`${field}.criteria`, `${field}.criteria must map each option to a description or null`);
    const n = Object.keys(criteria).length;
    if (n < CHOICE_OPTIONS.min || n > CHOICE_OPTIONS.max) {
      throw new JevelError(`${field}.criteria`, `${field}.criteria must have ${CHOICE_OPTIONS.min} to ${CHOICE_OPTIONS.max} options, has ${n}`);
    }
    for (const [option, description] of Object.entries(criteria)) {
      if (description !== null && !isEntry(description)) {
        throw new JevelError(`${field}.criteria.${option}`, `${field}.criteria.${option} must be a description or null`);
      }
    }
  } else if (type === "score") {
    if (!Array.isArray(criteria)) throw new JevelError(`${field}.criteria`, `${field}.criteria must be an ordered list of level descriptions`);
    if (criteria.length < SCORE_LEVELS.min || criteria.length > SCORE_LEVELS.max) {
      throw new JevelError(`${field}.criteria`, `${field}.criteria must have ${SCORE_LEVELS.min} to ${SCORE_LEVELS.max} levels, has ${criteria.length}`);
    }
  } else if (criteria !== undefined) {
    if (!isRecord(criteria) || Object.keys(criteria).some((k) => k !== "true" && k !== "false")) {
      throw new JevelError(`${field}.criteria`, `${field}.criteria for a noul holds only true and false`);
    }
  }
  const verdict = thresholdsOf(raw.verdict, `${field}.verdict`);
  checkMarkUnderAct([jevelVerdict, verdict], `${field}.verdict`);
  let repeat: Repeat | undefined;
  if (raw.repeat !== undefined) {
    const r = raw.repeat;
    if (!isRecord(r) || typeof r.over !== "string" || r.over === "" || typeof r.as !== "string" || !QUESTION_ID.test(r.as)) {
      throw new JevelError(`${field}.repeat`, `${field}.repeat needs \`over\` (a path in the state) and \`as\` (a name matching [a-z0-9_]+)`);
    }
    repeat = { over: r.over, as: r.as };
  }
  const question: JevelQuestion = { type, instructions: raw.instructions as EntryType };
  if (criteria !== undefined) question.criteria = criteria;
  if (raw.verdict !== undefined) question.verdict = verdict;
  if (repeat) question.repeat = repeat;
  return question;
}

function warningsOf(jevel: Jevel): string[] {
  const warnings: string[] = [];
  for (const [id, q] of Object.entries(jevel.questions)) {
    if (q.type === "noul" && isRecord(q.criteria) && typeof q.criteria.true === "string" && NEGATION_FIRST_WORD.test(q.criteria.true)) {
      warnings.push(`questions.${id}.criteria.true reads as a negation; a noul answers best when true means yes`);
    }
    const text = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
    if (DOUBLE_NEGATIVE.test(text)) warnings.push(`questions.${id}.instructions may contain a double negative; ask it the direct way`);
    if (q.repeat && jevel.state.required.includes(q.repeat.as)) {
      warnings.push(
        `questions.${id}.repeat.as \`${q.repeat.as}\` is also a required state key; the rewriter would rewrite every reference to it`,
      );
    }
  }
  for (const heading of HEADINGS) {
    const present = new RegExp(`^#+\\s*${heading}\\s*$`, "im").test(jevel.body);
    if (!present) warnings.push(`body is missing the conventional heading: ${heading}`);
  }
  if (jevel.model === undefined || ALIASES.includes(jevel.model)) {
    warnings.push("model is unpinned: an alias moves when a release ships, and thresholds tuned against one version may not hold on the next");
  }
  return warnings;
}

export function parseJevel(markdown: string, dirName: string, path = "<inline>"): Parsed {
  const { frontmatter, body } = splitFrontmatter(markdown);
  let raw: unknown;
  try {
    raw = parseYaml(frontmatter);
  } catch (error) {
    throw new JevelError("frontmatter", `the frontmatter is not YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new JevelError("frontmatter", "the frontmatter must be a YAML mapping");
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) throw new JevelError("name", "name is required and must match [a-z0-9-]+");
  if (raw.name !== dirName) throw new JevelError("name", `name \`${raw.name}\` must equal the directory name \`${dirName}\``);
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1) throw new JevelError("version", "version is required and must be a positive integer");
  const format = raw.format === undefined ? 1 : raw.format;
  if (format !== 1) throw new JevelError("format", "format 1 is the only JEVEL.md format this build reads");
  if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model === "")) throw new JevelError("model", "model must be a model id such as jev-1.13.0");
  const state: Jevel["state"] = { required: [] };
  if (raw.state !== undefined) {
    if (!isRecord(raw.state)) throw new JevelError("state", "state must be an object");
    if (raw.state.required !== undefined) {
      if (!Array.isArray(raw.state.required) || raw.state.required.some((k) => typeof k !== "string")) {
        throw new JevelError("state.required", "state.required must be a list of top-level key names");
      }
      state.required = raw.state.required as string[];
    }
    if (raw.state.budget_tokens !== undefined) {
      if (!Number.isInteger(raw.state.budget_tokens) || (raw.state.budget_tokens as number) < 1) {
        throw new JevelError("state.budget_tokens", "state.budget_tokens must be a positive integer");
      }
      state.budget_tokens = raw.state.budget_tokens as number;
    }
  }
  const verdict = thresholdsOf(raw.verdict, "verdict");
  checkMarkUnderAct([verdict], "verdict");
  if (!isRecord(raw.questions) || Object.keys(raw.questions).length === 0) {
    throw new JevelError("questions", "questions must be a non-empty map");
  }
  const questions: Record<string, JevelQuestion> = {};
  for (const [id, q] of Object.entries(raw.questions)) questions[id] = questionOf(id, q, verdict);
  const jevel: Jevel = { name: raw.name, version: raw.version as number, format: 1, state, verdict, questions, body, path };
  if (typeof raw.model === "string") jevel.model = raw.model;
  return { jevel, warnings: warningsOf(jevel) };
}

/** First match wins: --jevels dirs, then JEVLERY_JEVELS entries, then ./jevels, then $JEVLERY_HOME/jevels. */
export function discoveryDirs(input: { cli?: string[]; env?: string; cwd: string; home: string }): string[] {
  const ordered = [
    ...(input.cli ?? []),
    ...(input.env ? input.env.split(":").filter((d) => d !== "") : []),
    join(input.cwd, "jevels"),
    join(input.home, "jevels"),
  ].map((d) => resolve(input.cwd, d));
  return ordered.filter((dir, i) => ordered.indexOf(dir) === i);
}

export function findJevel(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const path = join(dir, name, "JEVEL.md");
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadJevel(name: string, dirs: string[]): Parsed {
  if (!NAME.test(name)) throw new JevelError("name", `${name} is not a jevel name: [a-z0-9-]+`);
  const path = findJevel(name, dirs);
  if (!path) throw new JevelError("name", `no jevel named ${name} in: ${dirs.join(", ")}`);
  return parseJevel(readFileSync(path, "utf8"), name, path);
}

export function listJevels(dirs: string[]): Array<{ name: string; dir: string; path: string }> {
  const seen = new Map<string, { name: string; dir: string; path: string }>();
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name, "JEVEL.md");
      if (!seen.has(name) && existsSync(path)) seen.set(name, { name, dir, path });
    }
  }
  return [...seen.values()];
}

export function checkState(jevel: Jevel, state: unknown): void {
  if (jevel.state.required.length === 0) return;
  if (!isRecord(state)) {
    throw new JevelError("state.required", `this jevel requires the keys ${jevel.state.required.join(", ")}, so the state must be an object`);
  }
  for (const key of jevel.state.required) {
    if (!(key in state)) throw new JevelError("state.required", `state is missing the required key \`${key}\``);
  }
}

/** `a.b[0].c` into the value, or undefined at the first missing step. */
export function getPath(value: unknown, path: string): unknown {
  const steps = path.match(/[^.[\]]+/g) ?? [];
  let current: unknown = value;
  for (const step of steps) {
    if (Array.isArray(current)) {
      const index = Number(step);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[step];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

export interface Expanded {
  questions: Questions;
  thresholds: Record<string, Thresholds>;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite every backticked path that starts with `as` to start with `over[i]`, through any JSON structure. */
function rewritePaths(value: EntryType, as: string, replacement: string): EntryType {
  const pattern = new RegExp(`\`${escapeRegExp(as)}(?=[\`.\\[])`, "g");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(pattern, `\`${replacement}`);
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as EntryType;
}

function toSdkQuestion(q: JevelQuestion, instructions: EntryType, criteria: unknown): Question {
  if (q.type === "noul") {
    return criteria === undefined
      ? { type: "noul", instructions }
      : { type: "noul", instructions, criteria: criteria as { true?: EntryType; false?: EntryType } };
  }
  if (q.type === "choice") return { type: "choice", instructions, criteria: criteria as Record<string, EntryType> };
  return { type: "score", instructions, criteria: criteria as [EntryType, EntryType, ...EntryType[]] };
}

/** One SDK question per jevel question, or per element for a `repeat`; thresholds merged per name. */
export function expandQuestions(jevel: Jevel, state: unknown): Expanded {
  const questions: Questions = {};
  const thresholds: Record<string, Thresholds> = {};
  for (const [id, q] of Object.entries(jevel.questions)) {
    const merged = mergeThresholds(jevel.verdict, q.verdict);
    if (!q.repeat) {
      questions[id] = toSdkQuestion(q, q.instructions, q.criteria);
      thresholds[id] = merged;
      continue;
    }
    const items = getPath(state, q.repeat.over);
    if (!Array.isArray(items)) {
      throw new JevelError(`questions.${id}.repeat.over`, `questions.${id} repeats over \`${q.repeat.over}\`, which is not an array in the state`);
    }
    for (let i = 0; i < items.length; i++) {
      const element = `${q.repeat.over}[${i}]`;
      const name = `${id}[${i}]`;
      const criteria = q.criteria === undefined ? undefined : rewritePaths(q.criteria as EntryType, q.repeat.as, element);
      questions[name] = toSdkQuestion(q, rewritePaths(q.instructions, q.repeat.as, element), criteria);
      thresholds[name] = merged;
    }
  }
  return { questions, thresholds };
}

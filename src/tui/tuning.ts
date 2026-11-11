import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Node, type YAMLMap, isMap, isScalar, parseDocument } from "yaml";
import type { Thresholds } from "../decision.js";
import { SHIPPED_JEVELS, parseJevel, thresholdsFor } from "../jevel.js";
import type { AskLine, LogLine } from "../log.js";
import { recordedDecision } from "../report.js";

/** One question of one jevel, as the log shows it for the model that answered the jevel last. */
export interface Tally {
  jevel: string;
  question: string;
  /** The name of that model as its answers give it. Null when no model answered this jevel. */
  model: string | null;
  act: number;
  mark: number;
  fallBack: number;
  /** Act decisions with an outcome, and how many of those were right. */
  actReviewed: number;
  actRight: number;
  markReviewed: number;
  markRight: number;
  /** The certainty of every answered decision, for the histogram. */
  certainties: number[];
  /** Act and mark decisions with an outcome: their certainty and whether the latest outcome said Jev was right. */
  reviewed: Array<{ certainty: number; right: boolean }>;
}

const NO_JEVEL = "(questions)";
export const tallyKey = (jevel: string, question: string): string => `${jevel}\n${question}`;

/**
 * For each jevel and question (a `repeat` question under its base name): the mix, how often act and mark were right, and
 * the certainties. The count is for one model, the model that answered the jevel last. Two models have different
 * certainties for the same answers, so one count for the two models describes neither.
 */
export function tallies(lines: LogLine[]): Map<string, Tally> {
  const last = new Map<string, "agree" | "disagree">();
  for (const l of lines) if (l.kind === "outcome") last.set(`${l.id}\n${l.question}`, l.outcome);
  const asks = lines.filter((l): l is AskLine => l.kind === "ask");
  const latest = new Map<string, { at: string; model: string }>();
  for (const ask of asks) {
    const jevel = ask.jevel?.name ?? NO_JEVEL;
    if (ask.model !== null && !((latest.get(jevel)?.at ?? "") > ask.at)) latest.set(jevel, { at: ask.at, model: ask.model });
  }
  const out = new Map<string, Tally>();
  for (const ask of asks) {
    const jevel = ask.jevel?.name ?? NO_JEVEL;
    const model = latest.get(jevel)?.model ?? null;
    // An ask with no answer has no model. It stays as a fall_back of the model in use.
    if (ask.model !== null && ask.model !== model) continue;
    for (const [name, answer] of Object.entries(ask.answers)) {
      const question = name.replace(/\[\d+\]$/, "");
      const key = tallyKey(jevel, question);
      const t = out.get(key) ?? { jevel, question, model, act: 0, mark: 0, fallBack: 0, actReviewed: 0, actRight: 0, markReviewed: 0, markRight: 0, certainties: [], reviewed: [] };
      out.set(key, t);
      const d = recordedDecision(answer);
      if (d === "act") t.act += 1;
      else if (d === "mark") t.mark += 1;
      else t.fallBack += 1;
      if (ask.error) continue;
      t.certainties.push(answer.certainty);
      const outcome = last.get(`${ask.id}\n${name}`);
      if (outcome === undefined || d === "fall_back") continue;
      const right = outcome === "agree";
      t.reviewed.push({ certainty: answer.certainty, right });
      if (d === "act") { t.actReviewed += 1; if (right) t.actRight += 1; }
      else { t.markReviewed += 1; if (right) t.markRight += 1; }
    }
  }
  return out;
}

export interface Proposal {
  /** The lower act threshold. */
  act: number;
  /** How often the reviewed decisions at or above it were right. */
  agreement: number;
  /** How often they are right at the current act threshold. */
  current: number;
  /** The share of all this question's decisions that sit between the new and the current act threshold, and would act. */
  more: number;
  reviewed: number;
}

/** Fewer reviewed act-or-mark decisions than this and the numbers say nothing. */
export const MIN_REVIEWED = 20;
const EPS = 1e-9;

/** A proposal stays at least this far above the mark threshold, so the mark band never closes. */
export const MARK_GAP = 0.05;

/**
 * The threshold tuning rule. Among the reviewed act and mark decisions, the lowest certainty of a reviewed decision,
 * at least 0.05 above the mark threshold and below the current act threshold, at which the decisions at or above it
 * were right at least as often as they are at the current act threshold minus two points, and never less than 90% of
 * the time. A certainty Jev actually gave and a person checked, so no unreviewed stretch hides under the new threshold.
 * null when there are fewer than 20 reviewed decisions, none at the current threshold, or no lower threshold holds.
 */
export function proposeAct(t: Pick<Tally, "reviewed" | "certainties">, thresholds: Thresholds): Proposal | null {
  if (t.reviewed.length < MIN_REVIEWED) return null;
  const agreementAt = (x: number): number | null => {
    const above = t.reviewed.filter((r) => r.certainty >= x - EPS);
    return above.length === 0 ? null : above.filter((r) => r.right).length / above.length;
  };
  const current = agreementAt(thresholds.act);
  if (current === null) return null;
  const target = Math.max(current - 0.02, 0.9);
  const candidates = [...new Set(t.reviewed.map((r) => r.certainty))]
    .filter((c) => c >= thresholds.mark + MARK_GAP - EPS && c < thresholds.act - EPS)
    .sort((a, b) => a - b);
  for (const act of candidates) {
    const agreement = agreementAt(act)!;
    if (agreement < target - EPS) continue;
    const between = t.certainties.filter((c) => c >= act - EPS && c < thresholds.act - EPS).length;
    return { act, agreement, current, more: t.certainties.length === 0 ? 0 : between / t.certainties.length, reviewed: t.reviewed.length };
  }
  return null;
}

/** One edit to the file, by position: the line before and after, for the confirm dialog. New lines have an empty `before`. */
export interface Change {
  line: number;
  before: string;
  after: string;
}

const lineAt = (text: string, offset: number): { number: number; start: number; end: number } => {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  return { number: text.slice(0, start).split("\n").length, start, end: newline === -1 ? text.length : newline };
};

/** A key that YAML reads back as the same string: plain for a simple name, quoted for all others. */
const yamlKey = (key: string): string => (/^[A-Za-z_][A-Za-z0-9._/-]*$/.test(key) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(key) ? key : JSON.stringify(key));

/**
 * Sets `tuned.<model>.<question>.act` to `act` and raises `version` by one. The threshold is for the model that gave the
 * reviewed answers, so the thresholds that the author wrote stay. The function edits each value in its position and adds
 * a missing `tuned` block at the end of the frontmatter, so all other bytes of the file stay. It throws when the file has
 * no question of that name, when the result does not read back as the new threshold, or when it cannot edit the frontmatter.
 */
export function setActThreshold(text: string, model: string, question: string, act: number): { text: string; changes: Change[]; version: number } {
  const open = /^---\r?\n/.exec(text);
  if (!open) throw new Error("the file does not start with a --- frontmatter block");
  const close = /\r?\n---(\r?\n|$)/.exec(text.slice(open[0].length - 1));
  if (!close) throw new Error("the frontmatter block is never closed with ---");
  const base = open[0].length;
  const end = open[0].length - 1 + close.index;
  const doc = parseDocument(text.slice(base, end));
  if (doc.errors.length > 0) throw new Error(`the frontmatter is not YAML: ${doc.errors[0]!.message}`);
  const value = String(act);
  // An inserted line takes the file's own line end.
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  // Edits as [offset in the file, length to replace, new text], applied from the end so the earlier offsets hold.
  const edits: Array<[number, number, string]> = [];
  const q = doc.getIn(["questions", question], true) as Node | undefined;
  if (!isMap(q) || q.items.length === 0) throw new Error(`no question named ${question} in this file`);
  const indentAt = (offset: number): string => " ".repeat(offset - (text.lastIndexOf("\n", offset - 1) + 1));
  // The text to add at each depth: below `tuned`, below the model, and in the entry of the question.
  const tails = (indent: string, flow: boolean): string[] => [
    flow ? `${yamlKey(model)}: { ${question}: { act: ${value} } }` : `${yamlKey(model)}:${eol}${indent}  ${question}: { act: ${value} }`,
    `${question}: { act: ${value} }`,
    `act: ${value}`,
  ];
  let node = doc.get("tuned", true) as Node | undefined;
  if (node === undefined) {
    edits.push([end, 0, `${eol}tuned:${eol}  ${tails("  ", false)[0]}`]);
  } else {
    // Go down through `tuned`, the model and the question as far as the file has them.
    const path = [model, question, "act"];
    let depth = 0;
    let at = "tuned";
    let map: YAMLMap | undefined;
    for (; depth < path.length; depth++) {
      if (!isMap(node) || node.items.length === 0) throw new Error(`${at} is not a map with entries; write this threshold there by hand`);
      map = node;
      const next = node.get(path[depth]!, true) as Node | undefined;
      if (next === undefined) break;
      node = next;
      at += `.${path[depth]}`;
    }
    if (depth === path.length) {
      if (!isScalar(node)) throw new Error(`${at} is not a number; write this threshold there by hand`);
      edits.push([base + node.range![0], node.range![1] - node.range![0], value]);
    } else {
      // Add the entry above the entries that are there, in their style: in the line of a flow map, or on a new line.
      const first = base + (map!.items[0]!.key as Node).range![0];
      const indent = indentAt(first);
      edits.push([first, 0, map!.flow ? `${tails(indent, true)[depth]}, ` : `${tails(indent, false)[depth]}${eol}${indent}`]);
    }
  }
  const version = doc.get("version", true) as Node | undefined;
  if (!isScalar(version) || !Number.isInteger(version.value)) throw new Error("the file has no integer version");
  const next = (version.value as number) + 1;
  edits.push([base + version.range![0], version.range![1] - version.range![0], String(next)]);

  let out = text;
  for (const [at, length, insert] of [...edits].sort((a, b) => b[0] - a[0])) out = out.slice(0, at) + insert + out.slice(at + length);
  // Each change as the line it sits on, before and after, in file order.
  const changes: Change[] = [];
  let shift = 0;
  for (const [at, length, insert] of [...edits].sort((a, b) => a[0] - b[0])) {
    const was = lineAt(text, at);
    const now = lineAt(out, at + shift);
    if (insert.includes("\n")) {
      // New lines go after the line at the edit position or above it. They show as new, without the adjacent line.
      const after = insert.startsWith(eol);
      const lines = after ? out.slice(at + shift + eol.length, at + shift + insert.length) : out.slice(now.start, at + shift + insert.length - eol.length - (at - was.start));
      changes.push({ line: was.number + (after ? 1 : 0), before: "", after: lines });
    } else {
      changes.push({ line: was.number, before: text.slice(was.start, was.end), after: out.slice(now.start, now.end) });
    }
    shift += insert.length - length;
  }
  // Read the file back: it must parse and give this model the new act threshold for this question.
  const parsed = parseJevel(out, String(doc.get("name")));
  if (thresholdsFor(parsed.jevel, question, model).act !== act || parsed.jevel.version !== next) {
    throw new Error("the edited file does not read back with the new threshold");
  }
  return { text: out, changes, version: next };
}

/**
 * Where a jevel file sits, as far as tuning is concerned. `source` is a shipped jevel of a git checkout of jevelry,
 * run from inside that checkout: that file is the one to change, so it is edited in place like a project's own.
 */
export type Place = { kind: "project" } | { kind: "shipped" } | { kind: "home" } | { kind: "source" };

/** The folder that holds the shipped jevels is a git working tree of the jevelry package, so not an installed copy. */
export function isSource(shipped: string): boolean {
  const root = dirname(shipped);
  try {
    return existsSync(join(root, ".git")) && (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name === "jevelry";
  } catch {
    return false;
  }
}

export function placeOf(path: string, dirs: { shipped?: string; home: string; cwd?: string }): Place {
  const shipped = dirs.shipped ?? SHIPPED_JEVELS;
  const under = (dir: string, p = path): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  // A checkout linked into another project (npm link, or its bin run from elsewhere) is still jevelry's to ship: copy there.
  if (under(shipped)) return isSource(shipped) && under(dirname(shipped), resolve(dirs.cwd ?? process.cwd())) ? { kind: "source" } : { kind: "shipped" };
  if (under(join(dirs.home, "jevels"))) return { kind: "home" };
  return { kind: "project" };
}

/** Copies the jevel's folder into `projectJevels`, refusing to overwrite; the path of the copied JEVEL.md. */
export function copyJevel(path: string, projectJevels: string): string {
  const from = dirname(path);
  const to = join(projectJevels, basename(from));
  if (existsSync(to)) throw new Error(`${to} already exists`);
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  return join(to, "JEVEL.md");
}

/** Reads the file, edits it and writes it back. */
export function writeActThreshold(path: string, model: string, question: string, act: number): { changes: Change[]; version: number } {
  const edited = setActThreshold(readFileSync(path, "utf8"), model, question, act);
  writeFileSync(path, edited.text);
  return { changes: edited.changes, version: edited.version };
}

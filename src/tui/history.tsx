import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { type Thresholds, mergeThresholds } from "../decision.js";
import { type JevelQuestion, loadJevel } from "../jevel.js";
import type { AskLine, LogLine, OutcomeLine, RunLine } from "../log.js";
import type { Answer, FallBackAnswer } from "../protocol.js";
import { recordedDecision, report } from "../report.js";
import { moves, useChrome } from "./dialog.js";
import { decisionColor, useTheme } from "./theme.js";

export interface Filters {
  decision: "all" | "act" | "mark" | "fall_back";
  jevel: string | null;
  noOutcome: boolean;
  /** Only asks Jev could not answer (a line with `error`). */
  failed: boolean;
  since: string | null;
  /** One question of the jevel, as the Jevel screen opens it (a `repeat` question under its base name). */
  question?: string;
}

export const ALL: Filters = { decision: "all", jevel: null, noOutcome: false, failed: false, since: null };

export interface Row {
  ask: AskLine;
  question: string;
  answer: Answer | FallBackAnswer;
  outcomes: OutcomeLine[];
  /** What `jevelry run` or `run()` did after this ask, when it did anything. */
  run?: RunLine;
}

const DECISIONS: Filters["decision"][] = ["all", "act", "mark", "fall_back"];
export const NO_JEVEL = "(questions)";
export const jevelOf = (ask: AskLine): string => ask.jevel?.name ?? NO_JEVEL;
const baseName = (name: string): string => name.replace(/\[\d+\]$/, "");

/** Newest ask first, one row per question, every outcome recorded for it attached. */
export function rowsOf(lines: LogLine[], filters: Filters): Row[] {
  const outcomes = new Map<string, OutcomeLine[]>();
  const runs = new Map<string, RunLine>();
  for (const line of lines) {
    if (line.kind === "run") runs.set(line.id, line);
    if (line.kind !== "outcome") continue;
    const key = `${line.id}\n${line.question}`;
    outcomes.set(key, [...(outcomes.get(key) ?? []), line]);
  }
  const asks = lines.filter((l): l is AskLine => l.kind === "ask").reverse();
  asks.sort((a, b) => b.at.localeCompare(a.at));
  const rows: Row[] = [];
  for (const ask of asks) {
    if (filters.jevel !== null && jevelOf(ask) !== filters.jevel) continue;
    if (filters.since !== null && ask.at < filters.since) continue;
    if (filters.failed && ask.error === undefined) continue;
    for (const [question, answer] of Object.entries(ask.answers)) {
      if (filters.question !== undefined && baseName(question) !== filters.question) continue;
      const run = runs.get(ask.id);
      const row = { ask, question, answer, outcomes: outcomes.get(`${ask.id}\n${question}`) ?? [], ...(run ? { run } : {}) };
      if (filters.decision !== "all" && recordedDecision(answer) !== filters.decision) continue;
      if (filters.noOutcome && row.outcomes.length > 0) continue;
      rows.push(row);
    }
  }
  return rows;
}

export function jevelNames(lines: LogLine[]): string[] {
  return [...new Set(lines.filter((l): l is AskLine => l.kind === "ask").map(jevelOf))].sort();
}

export const hasAnswer = (a: Answer | FallBackAnswer): a is Answer => !("answer" in a && a.answer === null);

export function answerWord(a: Answer | FallBackAnswer): string {
  if (!hasAnswer(a)) return "error";
  if (a.type === "choice") return a.choice;
  if (a.type === "noul") return a.yes ? "yes" : "no";
  return `level ${Math.round(a.score)}`;
}

const cell = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width));
const pad = (n: number): string => String(n).padStart(2, "0");
/** `09-23 13:17` in the terminal's own time zone, the same clock Home counts "today" by. */
export const time = (iso: string): string => {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** `2026-09-23 13:17:31 (local)`. */
export const fullTime = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${time(iso)}:${pad(d.getSeconds())} (local)`;
};
const lastOutcome = (row: Row): string => row.outcomes.at(-1)?.outcome ?? "-";
const next = <T,>(list: T[], current: T): T => list[(list.indexOf(current) + 1) % list.length] as T;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Column widths for a list `width` wide: time, answer, certainty, decision and outcome are fixed, jevel and question share the rest. */
function columns(width: number): number[] {
  // The screen's side padding and the cursor column come off first.
  const rest = Math.max(20, width - 4 - (11 + 10 + 4 + 9 + 8) - 6);
  const jevel = Math.min(22, Math.ceil(rest * 0.45));
  return [11, jevel, Math.min(26, rest - jevel), 10, 4, 9, 8];
}
const listCells = (cells: string[], widths: number[]): string[] => cells.map((c, i) => (i === cells.length - 1 ? c : cell(c, widths[i]!)));

function cycleJevel(lines: LogLine[], filters: Filters): Filters {
  return { ...filters, jevel: next<string | null>([null, ...jevelNames(lines)], filters.jevel) };
}

function Chip(props: { label: string; value: string; on: boolean }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text>
      <Text color={theme.muted}>{`${props.label} `}</Text>
      <Text color={props.on ? theme.accent : theme.text} bold={props.on}>{props.value}</Text>
      <Text>{"   "}</Text>
    </Text>
  );
}

export function DecisionsView(props: {
  lines: LogLine[];
  filters: Filters;
  height?: number;
  width?: number;
  active?: boolean;
  /** Log lines readLog could not read, shown in the header so nothing prints over the screen. */
  skipped?: number;
  /** Held by App, so coming back from a detail lands on the same row. */
  cursor?: number;
  /** Takes an update, so two moves in one tick both count. */
  onCursor?: (update: (cursor: number) => number) => void;
  onFilters: (f: Filters) => void;
  onOpen: (row: Row) => void;
  onReport: () => void;
  onBack?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { lines, filters } = props;
  const rows = useMemo(() => rowsOf(lines, filters), [lines, filters]);
  const setCursor = props.onCursor ?? ((): void => undefined);
  const at = Math.min(props.cursor ?? 0, Math.max(rows.length - 1, 0));
  const width = props.width ?? 80;
  // Title, filters, blank, column header and the "more below" line; the footer belongs to the shell.
  const height = Math.max((props.height ?? 23) - 5, 3);
  const top = Math.max(0, Math.min(at - Math.floor(height / 2), rows.length - height));
  const below = Math.max(0, rows.length - top - height);
  const widths = columns(width);
  const last = Math.max(rows.length - 1, 0);
  useChrome([["j/k", "move"], ["enter", "open"], ["esc", "back"], ["f", "decision"], ["J", "jevel"], ["o", "no outcome"], ["x", "failed only"], ["r", "report"]]);
  useInput((input, key) => {
    const step = moves(input, key);
    if (step !== 0) setCursor((c) => Math.max(0, Math.min(Math.min(c, last) + step, last)));
    else if (key.return && rows[at]) props.onOpen(rows[at]);
    else if (input === "f") props.onFilters({ ...filters, decision: next(DECISIONS, filters.decision) });
    else if (input === "J") props.onFilters(cycleJevel(lines, filters));
    else if (input === "o") props.onFilters({ ...filters, noOutcome: !filters.noOutcome });
    // Turning it off also drops the "since midnight" that Home's failed-asks entry set with it.
    else if (input === "x") props.onFilters({ ...filters, failed: !filters.failed, ...(filters.failed ? { since: null } : {}) });
    else if (input === "r") props.onReport();
    else if (key.escape) props.onBack?.();
  }, { isActive: props.active ?? true });
  const title = filters.decision === "mark" && filters.noOutcome ? plural(rows.length, "marked decision") + " to review"
    : filters.failed ? plural(rows.length, "failed decision") : plural(rows.length, "decision");
  const filtered = filters.decision !== "all" || filters.jevel !== null || filters.noOutcome || filters.failed || filters.since !== null || filters.question !== undefined;
  const empty = !lines.some((l) => l.kind === "ask");
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>History  </Text>
        <Text bold color={theme.text}>{title}</Text>
        {props.skipped ? <Text color={theme.error}>{`   ${plural(props.skipped, "unreadable log line")} skipped`}</Text> : null}
        {filtered ? null : <Text color={theme.muted}>{"   every logged decision, newest first"}</Text>}
      </Text>
      <Text wrap="truncate">
        <Chip label="decision" value={filters.decision} on={filters.decision !== "all"} />
        <Chip label="jevel" value={filters.jevel ?? "all"} on={filters.jevel !== null} />
        {filters.question !== undefined ? <Chip label="question" value={filters.question} on /> : null}
        <Chip label="outcome" value={filters.noOutcome ? "none yet" : "any"} on={filters.noOutcome} />
        {filters.failed ? <Chip label="failed" value="only" on /> : null}
        {filters.since ? <Chip label="since" value={time(filters.since)} on /> : null}
      </Text>
      <Text> </Text>
      <Text color={theme.muted} wrap="truncate">{`  ${listCells(["time", "jevel", "question", "answer", "cert", "decision", "outcome"], widths).join(" ")}`}</Text>
      {rows.length === 0 ? <Text color={theme.muted}>{empty ? "  No decisions yet. Every ask your code or agent makes shows up here." : "  no decisions match these filters"}</Text> : null}
      {rows.slice(top, top + height).map((row, i) => {
        const d = recordedDecision(row.answer);
        const c = listCells([time(row.ask.at), jevelOf(row.ask), row.question, answerWord(row.answer), row.answer.certainty.toFixed(2), d, lastOutcome(row)], widths);
        const selected = top + i === at;
        const bg = selected ? theme.element : theme.background;
        return (
          <Box key={`${row.ask.id}\n${row.question}`} backgroundColor={bg}>
            <Text wrap="truncate">
              <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
              <Text color={theme.muted}>{`${c[0]} `}</Text>
              <Text color={theme.text}>{`${c[1]} ${c[2]} ${c[3]} ${c[4]} `}</Text>
              <Text color={decisionColor(theme, d)}>{`${c[5]} `}</Text>
              <Text color={row.outcomes.length > 0 ? theme.text : theme.muted}>{c[6]}</Text>
            </Text>
          </Box>
        );
      })}
      {below > 0 ? <Text color={theme.muted}>{`  ↓ ${below} more below   row ${at + 1} of ${rows.length}`}</Text> : null}
    </Box>
  );
}

export const label = (v: unknown): string => (typeof v === "string" ? v : typeof v === "object" && v !== null && typeof (v as { what?: unknown }).what === "string" ? (v as { what: string }).what : JSON.stringify(v));

/** What the toast says once an outcome is written: plain words, which question, and the right value when it was given. */
export function savedMessage(line: OutcomeLine, row: Row): string {
  const where = `${jevelOf(row.ask)} ${row.question}`;
  if (line.outcome === "agree") return `Saved: Jev was right on ${where}`;
  if (line.value === null) return `Saved: Jev was wrong on ${where}`;
  const value = row.answer.type === "score" ? `level ${line.value}` : line.value;
  return `Saved: Jev was wrong on ${where}, it was ${value}`;
}

/** The values a person can say were right instead: every option or level but the one Jev picked. */
export function otherValues(a: Answer): string[] {
  if (a.type === "noul") return [a.yes ? "no" : "yes"];
  if (a.type === "choice") return Object.keys(a.probabilities).filter((o) => o !== a.choice);
  return Object.keys(a.legend).filter((l) => Number(l) !== Math.round(a.score));
}

export function runLine(r: RunLine): string {
  const what = r.command ?? "a handler in the program";
  const confirmed = r.confirmed === null ? "" : r.confirmed ? ", confirmed" : ", not confirmed";
  const result = r.exit !== null ? `exit ${r.exit}${r.signal ? ` (${r.signal})` : ""} in ${r.ms} ms` : r.ms !== null ? `took ${r.ms} ms` : "did not run";
  return `run: ${r.option ?? "fall_back"}: ${what}, ${result}${confirmed}`;
}

/** Long lines (a customer message in the state, an error message) wrap at spaces, so a reviewer reads all of it. */
export function wrapLine(line: string, width: number): string[] {
  const out: string[] = [];
  const lead = /^\s*/.exec(line)?.[0] ?? "";
  // A continuation indent under half the width, so every pass cuts at least half a line and the loop ends.
  const indent = lead.length + 2 < width / 2 ? `${lead}  ` : "";
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= indent.length) cut = width;
    out.push(rest.slice(0, cut));
    rest = indent + rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

const pct = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);
const reportLine = (c: string[]): string =>
  [cell(c[0] ?? "", 14), cell(c[1] ?? "", 14), ...[4, 4, 4, 4, 4, 6, 7].map((w, i) => (c[i + 2] ?? "").padStart(w)), (c[9] ?? "").padStart(4)].join(" ");

export function ReportView(props: { lines: LogLine[]; filters: Filters; height?: number; active?: boolean; onFilters: (f: Filters) => void; onBack: () => void }): React.JSX.Element {
  const theme = useTheme();
  const { lines, filters } = props;
  const rows = report(lines, { ...(filters.jevel !== null ? { jevel: filters.jevel } : {}), ...(filters.since !== null ? { since: filters.since } : {}) });
  // Title, filter line, column header and the legend stay put; the footer belongs to the shell.
  const height = Math.max((props.height ?? 23) - 4, 3);
  const [scroll, setScroll] = useState(0);
  const top = Math.min(scroll, Math.max(rows.length - height, 0));
  useChrome([["j/k", "scroll"], ["J", "jevel"], ["esc", "back"]]);
  useInput((input, key) => {
    if (key.escape) props.onBack();
    else if (input === "J") props.onFilters(cycleJevel(lines, filters));
    else if (moves(input, key) !== 0) {
      const step = moves(input, key);
      setScroll((s) => Math.max(0, Math.min(Math.min(s, Math.max(rows.length - height, 0)) + step, Math.max(rows.length - height, 0))));
    }
  }, { isActive: props.active ?? true });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
        <Text bold color={theme.text}>Report</Text>
        <Text color={theme.muted}>{`  how often Jev was right, per question   jevel ${filters.jevel ?? "all"}${filters.since ? `   since ${filters.since}` : ""}`}</Text>
        {rows.length > height ? <Text color={theme.muted}>{`   rows ${top + 1}-${Math.min(top + height, rows.length)} of ${rows.length}`}</Text> : null}
      </Text>
      <Text color={theme.muted} wrap="truncate">{reportLine(["jevel", "question", "asks", "act", "mark", "fb", "outc", "act ok", "mark ok", "cert"])}</Text>
      {rows.length === 0 ? <Text color={theme.muted}>no asks in the log</Text> : null}
      {rows.slice(top, top + height).map((r) => (
        <Text key={`${r.jevel}\n${r.question}`} wrap="truncate" color={theme.text}>
          {reportLine([r.jevel, r.question, String(r.asks), String(r.decisions.act), String(r.decisions.mark), String(r.decisions.fall_back), String(r.outcomes), pct(r.agreement_act), pct(r.agreement_mark), r.mean_certainty.toFixed(2)])}
        </Text>
      ))}
      <Text color={theme.muted} wrap="truncate">fb fall_back, outc outcomes, act ok and mark ok how often Jev was right</Text>
    </Box>
  );
}

/** What the jevel file says about a decision's question now: its thresholds, the jevel's version and the question as written. */
export interface Found {
  thresholds: Thresholds;
  version: number;
  question?: JevelQuestion;
}

/** Thresholds of the jevel as it is found now, per question; null when the jevel is not found. */
export function thresholdsLookup(dirs: string[]): (row: Row) => Found | null {
  const cache = new Map<string, ReturnType<typeof loadJevel>["jevel"] | null>();
  return (row) => {
    const name = row.ask.jevel?.name;
    if (!name) return null;
    if (!cache.has(name)) {
      try { cache.set(name, loadJevel(name, dirs).jevel); } catch { cache.set(name, null); }
    }
    const j = cache.get(name);
    if (!j) return null;
    const base = baseName(row.question);
    const question = Object.hasOwn(j.questions, base) ? j.questions[base] : undefined;
    return { thresholds: mergeThresholds(j.thresholds, question?.thresholds), version: j.version, ...(question ? { question } : {}) };
  };
}

import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { type Thresholds, mergeThresholds } from "../decision.js";
import { loadJevel } from "../jevel.js";
import { type AskLine, type LogLine, type OutcomeLine, type RunLine, recordOutcome } from "../log.js";
import type { Answer, FallBackAnswer } from "../protocol.js";
import { recordedDecision, report } from "../report.js";
import { bar } from "./charts.js";
import { useChrome } from "./dialog.js";
import { decisionColor, useTheme } from "./theme.js";

export interface Filters {
  decision: "all" | "act" | "mark" | "fall_back";
  jevel: string | null;
  noOutcome: boolean;
  since: string | null;
}

export const ALL: Filters = { decision: "all", jevel: null, noOutcome: false, since: null };

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
    for (const [question, answer] of Object.entries(ask.answers)) {
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

const hasAnswer = (a: Answer | FallBackAnswer): a is Answer => !("answer" in a && a.answer === null);

function answerWord(a: Answer | FallBackAnswer): string {
  if (!hasAnswer(a)) return "error";
  if (a.type === "choice") return a.choice;
  if (a.type === "noul") return a.yes ? "yes" : "no";
  return `level ${Math.round(a.score)}`;
}

const cell = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width));
const time = (iso: string): string => iso.slice(5, 16).replace("T", " ");
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
  onCursor?: (cursor: number) => void;
  onFilters: (f: Filters) => void;
  onOpen: (row: Row) => void;
  onReport: () => void;
  onBack?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { lines, filters } = props;
  const rows = rowsOf(lines, filters);
  const setCursor = props.onCursor ?? ((): void => undefined);
  const at = Math.min(props.cursor ?? 0, Math.max(rows.length - 1, 0));
  const width = props.width ?? 80;
  // Title, filters, blank, column header; the footer belongs to the shell.
  const height = Math.max((props.height ?? 23) - 4, 3);
  const top = Math.max(0, Math.min(at - Math.floor(height / 2), rows.length - height));
  const widths = columns(width);
  useChrome([["j/k", "move"], ["enter", "open"], ["f", "decision"], ["J", "jevel"], ["o", "no outcome"], ["r", "report"]]);
  useInput((input, key) => {
    if (key.downArrow || input === "j") setCursor(Math.min(at + 1, rows.length - 1));
    else if (key.upArrow || input === "k") setCursor(Math.max(at - 1, 0));
    else if (key.return && rows[at]) props.onOpen(rows[at]);
    else if (input === "f") props.onFilters({ ...filters, decision: next(DECISIONS, filters.decision) });
    else if (input === "J") props.onFilters(cycleJevel(lines, filters));
    else if (input === "o") props.onFilters({ ...filters, noOutcome: !filters.noOutcome });
    else if (input === "r") props.onReport();
    else if (key.escape) props.onBack?.();
  }, { isActive: props.active ?? true });
  const title = filters.decision === "mark" && filters.noOutcome ? plural(rows.length, "marked decision") + " to review" : plural(rows.length, "decision");
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>History  </Text>
        <Text bold color={theme.text}>{title}</Text>
        {props.skipped ? <Text color={theme.error}>{`   ${plural(props.skipped, "unreadable log line")} skipped`}</Text> : null}
        <Text color={theme.muted}>{"   every logged decision, newest first"}</Text>
      </Text>
      <Text wrap="truncate">
        <Chip label="decision" value={filters.decision} on={filters.decision !== "all"} />
        <Chip label="jevel" value={filters.jevel ?? "all"} on={filters.jevel !== null} />
        <Chip label="outcome" value={filters.noOutcome ? "none yet" : "any"} on={filters.noOutcome} />
        {filters.since ? <Chip label="since" value={filters.since} on /> : null}
      </Text>
      <Text> </Text>
      <Text color={theme.muted} wrap="truncate">{`  ${listCells(["time", "jevel", "question", "answer", "cert", "decision", "outcome"], widths).join(" ")}`}</Text>
      {rows.length === 0 ? <Text color={theme.muted}>{"  no decisions match these filters"}</Text> : null}
      {rows.slice(top, top + height).map((row, i) => {
        const d = recordedDecision(row.answer);
        const c = listCells([time(row.ask.at), jevelOf(row.ask), row.question, answerWord(row.answer), row.answer.certainty.toFixed(2), d, lastOutcome(row)], widths);
        const selected = top + i === at;
        const bg = selected ? theme.element : theme.background;
        return (
          <Text key={`${row.ask.id}\n${row.question}`} wrap="truncate" backgroundColor={bg}>
            <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
            <Text color={theme.muted}>{`${c[0]} `}</Text>
            <Text color={theme.text}>{`${c[1]} ${c[2]} ${c[3]} ${c[4]} `}</Text>
            <Text color={decisionColor(theme, d)}>{`${c[5]} `}</Text>
            <Text color={row.outcomes.length > 0 ? theme.text : theme.muted}>{c[6]}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

const label = (v: unknown): string => (typeof v === "string" ? v : typeof v === "object" && v !== null && typeof (v as { what?: unknown }).what === "string" ? (v as { what: string }).what : JSON.stringify(v));

function probabilityLines(a: Answer): string[] {
  const line = (name: string, p: number, picked: boolean, legend = ""): string =>
    `  ${picked ? "*" : " "} ${cell(name, 12)} ${p.toFixed(2)} ${bar(p, 10)} ${picked ? "picked" : "      "}${legend}`.trimEnd();
  if (a.type === "noul") return [line("yes", a.noul, a.yes), line("no", 1 - a.noul, !a.yes)];
  const picked = a.type === "choice" ? a.choice : String(Math.round(a.score));
  return Object.entries(a.probabilities).map(([name, p]) =>
    line(a.type === "score" ? `level ${name}` : name, p, name === picked, a.type === "score" && a.legend[name] !== undefined ? `  ${label(a.legend[name])}` : ""));
}

/** The values a person can say were right instead: every option or level but the one Jev picked. */
export function otherValues(a: Answer): string[] {
  if (a.type === "noul") return [a.yes ? "no" : "yes"];
  if (a.type === "choice") return Object.keys(a.probabilities).filter((o) => o !== a.choice);
  return Object.keys(a.legend).filter((l) => Number(l) !== Math.round(a.score));
}

function runLine(r: RunLine): string {
  const what = r.command ?? "a handler in the program";
  const confirmed = r.confirmed === null ? "" : r.confirmed ? ", confirmed" : ", not confirmed";
  const result = r.exit !== null ? `exit ${r.exit}${r.signal ? ` (${r.signal})` : ""} in ${r.ms} ms` : r.ms !== null ? `took ${r.ms} ms` : "did not run";
  return `run: ${r.option ?? "fall_back"}: ${what}, ${result}${confirmed}`;
}

export function detailLines(row: Row, thresholds: { thresholds: Thresholds; version: number } | null, note: string): string[] {
  const { ask, question, answer } = row;
  const out = [
    `${jevelOf(ask)} v${ask.jevel?.version ?? "-"}   ${ask.at}   model ${ask.model ?? "-"}`,
    `question: ${question}`,
  ];
  const certainty = answer.certainty.toFixed(2);
  const bands = thresholds
    ? ` (act ${thresholds.thresholds.act.toFixed(2)}, mark ${thresholds.thresholds.mark.toFixed(2)}${thresholds.version === ask.jevel?.version ? "" : `, from v${thresholds.version}`})`
    : " (thresholds unknown: the jevel is not found here)";
  if (hasAnswer(answer)) {
    out.push(`answer: ${answerWord(answer)}${answer.type === "score" ? ` (score ${answer.score.toFixed(2)})` : ""}`, ...probabilityLines(answer));
  } else {
    out.push("answer: none, Jev could not answer");
  }
  out.push(`certainty: ${certainty}${bands}`, `decision: ${recordedDecision(answer)}`);
  if (ask.error) out.push(`error: ${ask.error.code} (exit ${ask.error.exit}): ${ask.error.message}`);
  if (row.run) out.push(runLine(row.run));
  out.push("", "outcomes:");
  if (row.outcomes.length === 0) out.push("  none yet");
  for (const o of row.outcomes) out.push(`  ${time(o.at)} ${o.outcome}${o.value !== null ? ` ${o.value}` : ""}${o.note ? `  note: ${o.note}` : ""}`);
  if (note !== "") out.push(`note for the next outcome: ${note}`);
  out.push("", "state:");
  if (ask.state === undefined) {
    out.push("  not logged. To log it next time: jevelry ask --log-state,", "  jevel(name, { logState: true }) or JEVELRY_LOG_STATE=1");
  } else {
    out.push(...JSON.stringify(ask.state, null, 2).split("\n").map((l) => `  ${l}`));
  }
  return out;
}

/** Long lines (a customer message in the state, an error message) wrap at spaces, so a reviewer reads all of it. */
function wrapLine(line: string, width: number): string[] {
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

const HEADINGS = /^(question|answer|certainty|decision|error|run|outcomes|state|note for the next outcome):/;

export function DetailView(props: {
  row: Row;
  home: string;
  thresholds: { thresholds: Thresholds; version: number } | null;
  height?: number;
  width?: number;
  active?: boolean;
  onBack: () => void;
  /** Called once per visit: the detail closes after one outcome, so a second key press cannot write a second line. */
  onRecorded: (message: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { row } = props;
  const [scroll, setScroll] = useState(0);
  const [mode, setMode] = useState<"view" | "pick" | "note">("view");
  const [pick, setPick] = useState(0);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const choices = hasAnswer(row.answer) ? otherValues(row.answer) : [];
  // Set on the first key press, before the write resolves, so a fast second press is ignored too.
  const recording = useRef(false);
  const record = (value: string): void => {
    if (recording.current) return;
    recording.current = true;
    recordOutcome(props.home, row.ask.id, row.question, value, note === "" ? null : note, () => undefined)
      .then((line) => props.onRecorded(`recorded ${line.outcome}${line.value !== null ? ` ${line.value}` : ""} on ${row.question}`))
      .catch((error: unknown) => {
        recording.current = false;
        setMessage(`not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  useChrome(
    mode === "pick" ? [["j/k", "move"], ["enter", "record"], ["esc", "cancel"]]
      : mode === "note" ? [["enter", "keep note"], ["esc", "drop note"]]
        : [["a", "Jev was right"], ["d", "Jev was wrong"], ["n", "note"], ["j/k", "scroll"], ["esc", "back"]],
    mode === "note",
  );
  useInput((input, key) => {
    if (mode === "note") {
      if (key.escape) { setNote(""); setMode("view"); }
      else if (key.return) setMode("view");
      else if (key.backspace || key.delete) setNote((n) => n.slice(0, -1));
      else if (!key.ctrl && !key.meta && input) setNote((n) => n + input);
      return;
    }
    if (mode === "pick") {
      if (key.escape) setMode("view");
      else if (key.downArrow || input === "j") setPick(Math.min(pick + 1, choices.length - 1));
      else if (key.upArrow || input === "k") setPick(Math.max(pick - 1, 0));
      else if (key.return && choices[pick] !== undefined) { setMode("view"); record(choices[pick]); }
      return;
    }
    if (key.escape) props.onBack();
    else if (key.downArrow || input === "j") setScroll(scroll + 1);
    else if (key.upArrow || input === "k") setScroll(Math.max(scroll - 1, 0));
    else if (input === "a") record("agree");
    else if (input === "d") {
      if (choices.length === 0) record("disagree");
      else { setPick(0); setMode("pick"); }
    } else if (input === "n") setMode("note");
  }, { isActive: props.active ?? true });
  const width = Math.min(Math.max(props.width ?? 80, 40), 100) - 3;
  const lines = detailLines(row, props.thresholds, mode === "note" ? "" : note).flatMap((l) => wrapLine(l, width));
  const bottom = mode === "pick"
    ? ["What was right? j/k to move, enter to record, esc to cancel", ...choices.map((c, i) => `${i === pick ? ">" : " "} ${c}`)]
    : mode === "note"
      ? [`note: ${note}_`, "enter keeps the note for the next a or d, esc drops it"]
      : message === "" ? [] : wrapLine(message, width);
  // The title line plus the bottom lines; the footer belongs to the shell.
  const height = Math.max((props.height ?? 23) - 1 - bottom.length, 3);
  const top = Math.min(scroll, Math.max(lines.length - height, 0));
  const d = recordedDecision(row.answer);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate">
        <Text bold color={theme.text}>Decision</Text>
        <Text color={theme.muted}>{"  what Jev saw and decided, and whether it was right   "}</Text>
        <Text color={decisionColor(theme, d)} bold>{d}</Text>
      </Text>
      {lines.slice(top, top + height).map((l, i) => {
        const heading = HEADINGS.exec(l);
        if (heading) {
          return (
            <Text key={i} wrap="truncate">
              <Text color={theme.muted}>{heading[0]}</Text>
              <Text color={l.startsWith("decision:") ? decisionColor(theme, d) : l.startsWith("error:") ? theme.error : theme.text}>{l.slice(heading[0].length)}</Text>
            </Text>
          );
        }
        return <Text key={i} wrap="truncate" color={l.startsWith("  * ") ? theme.accent : theme.text}>{l === "" ? " " : l}</Text>;
      })}
      {bottom.map((l, i) => (
        <Text key={`b${i}`} wrap="truncate" color={mode === "view" ? theme.error : i === 0 ? theme.accent : theme.text} backgroundColor={mode === "pick" && i > 0 && i - 1 === pick ? theme.element : theme.background}>
          {l === "" ? " " : l}
        </Text>
      ))}
    </Box>
  );
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
    else if (key.downArrow || input === "j") setScroll(Math.min(top + 1, Math.max(rows.length - height, 0)));
    else if (key.upArrow || input === "k") setScroll(Math.max(top - 1, 0));
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

/** Thresholds of the jevel as it is found now, per question; null when the jevel is not found. */
export function thresholdsLookup(dirs: string[]): (row: Row) => { thresholds: Thresholds; version: number } | null {
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
    return { thresholds: mergeThresholds(j.thresholds, Object.hasOwn(j.questions, base) ? j.questions[base]!.thresholds : undefined), version: j.version };
  };
}

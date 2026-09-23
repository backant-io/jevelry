import { watch } from "node:fs";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { type Thresholds, mergeThresholds } from "./decision.js";
import { loadJevel } from "./jevel.js";
import { type AskLine, LOG_FILE, type LogLine, type OutcomeLine, type RunLine, readLog, recordOutcome } from "./log.js";
import type { Answer, FallBackAnswer } from "./protocol.js";
import { recordedDecision, report } from "./report.js";

/** The one module that imports ink and react: `jevelry tui` loads it with a dynamic import, so no other command pays for them. */

export interface Filters {
  decision: "all" | "act" | "mark" | "fall_back";
  jevel: string | null;
  noOutcome: boolean;
  since: string | null;
}

export interface Row {
  ask: AskLine;
  question: string;
  answer: Answer | FallBackAnswer;
  outcomes: OutcomeLine[];
  /** What `jevelry run` or `run()` did after this ask, when it did anything. */
  run?: RunLine;
}

const DECISIONS: Filters["decision"][] = ["all", "act", "mark", "fall_back"];
const NO_JEVEL = "(questions)";
const jevelOf = (ask: AskLine): string => ask.jevel?.name ?? NO_JEVEL;
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

/** Fits 80 columns: 2 + 11 + 13 + 14 + 10 + 4 + 9 + 8 plus the gaps. */
const listLine = (cells: [string, string, string, string, string, string, string]): string =>
  [cell(cells[0], 11), cell(cells[1], 13), cell(cells[2], 14), cell(cells[3], 10), cell(cells[4], 4), cell(cells[5], 9), cells[6]].join(" ");

const filterLine = (f: Filters): string =>
  `decision: ${f.decision}   jevel: ${f.jevel ?? "all"}   outcome: ${f.noOutcome ? "none yet" : "any"}${f.since ? `   since ${f.since}` : ""}`;

function cycleJevel(lines: LogLine[], filters: Filters): Filters {
  return { ...filters, jevel: next<string | null>([null, ...jevelNames(lines)], filters.jevel) };
}

export function DecisionsView(props: {
  lines: LogLine[];
  filters: Filters;
  height?: number;
  /** Log lines readLog could not read, shown in the header so nothing prints over the screen. */
  skipped?: number;
  /** Set when the log could not be re-read, or after an outcome was recorded. */
  notice?: string;
  /** Held by App, so coming back from a detail lands on the same row. */
  cursor?: number;
  onCursor?: (cursor: number) => void;
  onFilters: (f: Filters) => void;
  onOpen: (row: Row) => void;
  onReport: () => void;
  onQuit: () => void;
}): React.JSX.Element {
  const { lines, filters } = props;
  const rows = rowsOf(lines, filters);
  const setCursor = props.onCursor ?? ((): void => undefined);
  const at = Math.min(props.cursor ?? 0, Math.max(rows.length - 1, 0));
  const height = Math.max((props.height ?? 24) - 5, 3);
  const top = Math.max(0, Math.min(at - Math.floor(height / 2), rows.length - height));
  useInput((input, key) => {
    if (key.downArrow || input === "j") setCursor(Math.min(at + 1, rows.length - 1));
    else if (key.upArrow || input === "k") setCursor(Math.max(at - 1, 0));
    else if (key.return && rows[at]) props.onOpen(rows[at]);
    else if (input === "f") props.onFilters({ ...filters, decision: next(DECISIONS, filters.decision) });
    else if (input === "J") props.onFilters(cycleJevel(lines, filters));
    else if (input === "o") props.onFilters({ ...filters, noOutcome: !filters.noOutcome });
    else if (input === "r") props.onReport();
    else if (input === "q") props.onQuit();
  });
  const title = filters.decision === "mark" && filters.noOutcome
    ? `${rows.length} marked decision${rows.length === 1 ? "" : "s"} to review`
    : `${rows.length} decision${rows.length === 1 ? "" : "s"}`;
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">
        {[title, props.skipped ? `${props.skipped} unreadable log line${props.skipped === 1 ? "" : "s"} skipped` : "", props.notice ?? ""].filter((t) => t !== "").join("   ")}
      </Text>
      <Text>{filterLine(filters)}</Text>
      <Text dimColor>{`  ${listLine(["time", "jevel", "question", "answer", "cert", "decision", "outcome"])}`}</Text>
      {rows.length === 0 ? <Text>no decisions match these filters</Text> : null}
      {rows.slice(top, top + height).map((row, i) => {
        const d = recordedDecision(row.answer);
        const line = listLine([time(row.ask.at), jevelOf(row.ask), row.question, answerWord(row.answer), row.answer.certainty.toFixed(2), d, lastOutcome(row)]);
        const selected = top + i === at;
        return (
          <Text key={`${row.ask.id}\n${row.question}`} wrap="truncate" inverse={selected} color={d === "act" ? "green" : d === "mark" ? "yellow" : "red"}>
            {`${selected ? ">" : " "} ${line}`}
          </Text>
        );
      })}
      <Text dimColor>j/k move  enter open  f decision  J jevel  o no outcome  r report  q quit</Text>
    </Box>
  );
}

const label = (v: unknown): string => (typeof v === "string" ? v : typeof v === "object" && v !== null && typeof (v as { what?: unknown }).what === "string" ? (v as { what: string }).what : JSON.stringify(v));

function probabilityLines(a: Answer): string[] {
  if (a.type === "noul") {
    return [["yes", a.noul, a.yes], ["no", 1 - a.noul, !a.yes] as const].map(([name, p, picked]) => `  ${picked ? "*" : " "} ${cell(String(name), 12)} ${(p as number).toFixed(2)}${picked ? "  picked" : ""}`);
  }
  const picked = a.type === "choice" ? a.choice : String(Math.round(a.score));
  return Object.entries(a.probabilities).map(([name, p]) => {
    const text = a.type === "score" ? `level ${name}` : name;
    const legend = a.type === "score" && a.legend[name] !== undefined ? `  ${label(a.legend[name])}` : "";
    return `  ${name === picked ? "*" : " "} ${cell(text, 12)} ${p.toFixed(2)}${name === picked ? "  picked" : ""}${legend}`;
  });
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

export function DetailView(props: {
  row: Row;
  home: string;
  thresholds: { thresholds: Thresholds; version: number } | null;
  height?: number;
  onBack: () => void;
  /** Called once per visit: the detail closes after one outcome, so a second key press cannot write a second line. */
  onRecorded: (message: string) => void;
}): React.JSX.Element {
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
  });
  const { stdout } = useStdout();
  const width = Math.min(Math.max(stdout.columns || 80, 40), 100) - 1;
  const lines = detailLines(row, props.thresholds, mode === "note" ? "" : note).flatMap((l) => wrapLine(l, width));
  const footer = mode === "pick"
    ? ["What was right? up/down, enter to record, esc to cancel", ...choices.map((c, i) => `${i === pick ? ">" : " "} ${c}`)]
    : mode === "note"
      ? [`note: ${note}_`, "enter keeps the note for the next a or d, esc drops it"]
      : [...wrapLine(message, width), "a agree (Jev was right)  d disagree  n note  up/down scroll  esc back"];
  const height = Math.max((props.height ?? 24) - footer.length, 3);
  const top = Math.min(scroll, Math.max(lines.length - height, 0));
  return (
    <Box flexDirection="column">
      {lines.slice(top, top + height).map((l, i) => <Text key={i} wrap="truncate">{l === "" ? " " : l}</Text>)}
      {footer.map((l, i) => <Text key={`f${i}`} wrap="truncate" dimColor={i === footer.length - 1}>{l === "" ? " " : l}</Text>)}
    </Box>
  );
}

const pct = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);
const reportLine = (c: string[]): string =>
  [cell(c[0] ?? "", 14), cell(c[1] ?? "", 14), ...[4, 4, 4, 4, 4, 6, 7].map((w, i) => (c[i + 2] ?? "").padStart(w)), (c[9] ?? "").padStart(4)].join(" ");

export function ReportView(props: { lines: LogLine[]; filters: Filters; height?: number; onFilters: (f: Filters) => void; onBack: () => void }): React.JSX.Element {
  const { lines, filters } = props;
  const rows = report(lines, { ...(filters.jevel !== null ? { jevel: filters.jevel } : {}), ...(filters.since !== null ? { since: filters.since } : {}) });
  // Title, filter line, column header and two footer lines stay put; one spare line keeps Ink off the last row.
  const height = Math.max((props.height ?? 24) - 6, 3);
  const [scroll, setScroll] = useState(0);
  const top = Math.min(scroll, Math.max(rows.length - height, 0));
  useInput((input, key) => {
    if (key.escape) props.onBack();
    else if (input === "J") props.onFilters(cycleJevel(lines, filters));
    else if (key.downArrow || input === "j") setScroll(Math.min(top + 1, Math.max(rows.length - height, 0)));
    else if (key.upArrow || input === "k") setScroll(Math.max(top - 1, 0));
  });
  return (
    <Box flexDirection="column">
      <Text bold>report</Text>
      <Text>{`jevel: ${filters.jevel ?? "all"}${filters.since ? `   since ${filters.since}` : ""}`}</Text>
      <Text dimColor>{reportLine(["jevel", "question", "asks", "act", "mark", "fb", "outc", "act ok", "mark ok", "cert"])}</Text>
      {rows.length === 0 ? <Text>no asks in the log</Text> : null}
      {rows.slice(top, top + height).map((r) => (
        <Text key={`${r.jevel}\n${r.question}`} wrap="truncate">
          {reportLine([r.jevel, r.question, String(r.asks), String(r.decisions.act), String(r.decisions.mark), String(r.decisions.fall_back), String(r.outcomes), pct(r.agreement_act), pct(r.agreement_mark), r.mean_certainty.toFixed(2)])}
        </Text>
      ))}
      <Text dimColor>fb fall_back, outc outcomes, act ok and mark ok how often Jev was right</Text>
      <Text dimColor>{`j/k scroll  J jevel  esc back${rows.length > height ? `   rows ${top + 1}-${Math.min(top + height, rows.length)} of ${rows.length}` : ""}`}</Text>
    </Box>
  );
}

/** Thresholds of the jevel as it is found now, per question; null when the jevel is not found. */
function thresholdsLookup(dirs: string[]): (row: Row) => { thresholds: Thresholds; version: number } | null {
  const cache = new Map<string, ReturnType<typeof loadJevel>["jevel"] | null>();
  return (row) => {
    const name = row.ask.jevel?.name;
    if (!name) return null;
    if (!cache.has(name)) {
      try { cache.set(name, loadJevel(name, dirs).jevel); } catch { cache.set(name, null); }
    }
    const j = cache.get(name);
    if (!j) return null;
    return { thresholds: mergeThresholds(j.thresholds, j.questions[baseName(row.question)]?.thresholds), version: j.version };
  };
}

/** The log and how many of its lines could not be read, counted instead of printed. */
async function readCounted(home: string): Promise<{ lines: LogLine[]; skipped: number }> {
  let skipped = 0;
  const lines = await readLog(home, () => { skipped += 1; });
  return { lines, skipped };
}

export function App(props: { home: string; dirs: string[]; lines: LogLine[]; skipped?: number; filters: Filters }): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [lines, setLines] = useState(props.lines);
  const [filters, setFilters] = useState(props.filters);
  const [view, setView] = useState<"list" | "detail" | "report">("list");
  const [open, setOpen] = useState<{ id: string; question: string } | null>(null);
  const [lookup] = useState(() => thresholdsLookup(props.dirs));
  const [skipped, setSkipped] = useState(props.skipped ?? 0);
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState("");
  const reload = (): void => {
    readCounted(props.home).then(
      (read) => { setLines(read.lines); setSkipped(read.skipped); setNotice((n) => (n.startsWith("log could not be read") ? "" : n)); },
      (error: unknown) => setNotice(`log could not be read: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  useEffect(() => {
    // The directory, not the file: the file may not exist yet, and an append can replace its inode on some editors.
    let timer: NodeJS.Timeout | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(props.home, (_event, file) => {
        if (file !== null && file !== LOG_FILE) return;
        clearTimeout(timer);
        timer = setTimeout(reload, 150);
      });
    } catch {
      // No home directory yet: nothing to watch, the list stays as read.
    }
    return () => { clearTimeout(timer); watcher?.close(); };
  }, [props.home]);
  // A terminal that reports no size (0 or undefined) is drawn as the 80x24 the TUI is built for.
  const height = stdout.rows || 24;
  const row = open ? rowsOf(lines, { decision: "all", jevel: null, noOutcome: false, since: null }).find((r) => r.ask.id === open.id && r.question === open.question) : undefined;
  if (view === "detail" && row) {
    return <DetailView row={row} home={props.home} thresholds={lookup(row)} height={height} onBack={() => setView("list")} onRecorded={(message) => { setNotice(message); setView("list"); reload(); }} />;
  }
  if (view === "report") return <ReportView lines={lines} filters={filters} height={height} onFilters={setFilters} onBack={() => setView("list")} />;
  return (
    <DecisionsView
      lines={lines}
      filters={filters}
      height={height}
      skipped={skipped}
      notice={notice}
      cursor={cursor}
      onCursor={setCursor}
      onFilters={(f) => { setFilters(f); setCursor(0); }}
      onOpen={(r) => { setNotice(""); setOpen({ id: r.ask.id, question: r.question }); setView("detail"); }}
      onReport={() => setView("report")}
      onQuit={exit}
    />
  );
}

export async function runTui(input: { home: string; dirs: string[]; jevel?: string; since?: string }): Promise<void> {
  const { lines, skipped } = await readCounted(input.home);
  const filters: Filters = { decision: "all", jevel: input.jevel ?? null, noOutcome: false, since: input.since ?? null };
  const app = render(<App home={input.home} dirs={input.dirs} lines={lines} skipped={skipped} filters={filters} />);
  await app.waitUntilExit();
}

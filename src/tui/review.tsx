import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { type LogLine, recordOutcome } from "../log.js";
import type { Answer } from "../protocol.js";
import { recordedDecision } from "../report.js";
import { bar } from "./charts.js";
import { type Hint, moves, useChrome } from "./dialog.js";
import { ALL, type Found, type Row, answerWord, fullTime, hasAnswer, jevelOf, label, otherValues, rowsOf, runLine, savedMessage, time, wrapLine } from "./history.js";
import { decisionColor, useTheme } from "./theme.js";
import { type Tally, tallyKey } from "./tuning.js";

/**
 * The state as a person reads it: `key: value` lines, nested objects and lists indented two spaces under their key,
 * strings without quotes, long values wrapped at spaces to `width`.
 */
export function stateLines(state: unknown, width: number): string[] {
  const out: string[] = [];
  const leaf = (v: unknown): boolean => v === null || typeof v !== "object" || Object.keys(v).length === 0;
  const text = (v: unknown): string =>
    typeof v === "string" ? v : v === null ? "null" : Array.isArray(v) ? "[]" : typeof v === "object" ? "{}" : String(v);
  const put = (indent: string, head: string, v: unknown): void => {
    if (leaf(v)) {
      text(v).split("\n").forEach((part, i) => out.push(...wrapLine(`${indent}${i === 0 ? head : " ".repeat(head.length)}${part}`, width)));
      return;
    }
    out.push(`${indent}${head.trimEnd()}`);
    walk(v, indent.length + 2 <= width / 2 ? `${indent}  ` : indent);
  };
  const walk = (v: unknown, indent: string): void => {
    if (Array.isArray(v)) for (const x of v) put(indent, "- ", x);
    else for (const [k, x] of Object.entries(v as Record<string, unknown>)) put(indent, `${k}: `, x);
  };
  if (leaf(state)) put("", "", state);
  else walk(state, "");
  return out;
}

const MEANING = { act: "Jev was sure", mark: "fairly sure, check it", fall_back: "your code decided" } as const;
const labelOf = (v: unknown): string | null => (v === undefined || v === null ? null : label(v));
const questionText = (found: Found | null): string | null => {
  const i = found?.question?.instructions;
  if (typeof i === "string") return i;
  if (i && typeof i === "object" && !Array.isArray(i) && typeof (i as { question?: unknown }).question === "string") return (i as { question: string }).question;
  return null;
};

/** What the picked value means, from the jevel's criteria (a choice or a noul) or the score's own legend. */
function meaningOf(a: Answer, found: Found | null): string | null {
  const criteria = found?.question?.criteria as Record<string, unknown> | undefined;
  if (a.type === "score") return labelOf(a.legend[String(Math.round(a.score))]);
  if (a.type === "choice") return criteria && Object.hasOwn(criteria, a.choice) ? labelOf(criteria[a.choice]) : null;
  return criteria ? labelOf(criteria[a.yes ? "true" : "false"]) : null;
}

type Line = { text: string; tone: "text" | "muted" | "accent" | "error" | "act" | "mark" | "fall_back"; bold?: boolean };

/** The right half of a card: the question, every option with its probability, what the pick means, the decision and what happened since. */
export function decidedLines(row: Row, found: Found | null, width: number, room: number, sofar?: Tally): Line[] {
  const { answer, ask } = row;
  const d = recordedDecision(answer);
  const out: Line[] = [{ text: `question  ${row.question}  (${answer.type})`, tone: "text", bold: true }];
  const asked = questionText(found);
  if (asked) out.push(...wrapLine(asked, width).slice(0, 2).map((text): Line => ({ text, tone: "muted" })));
  out.push({ text: " ", tone: "text" });
  if (hasAnswer(answer)) {
    let options: Array<[name: string, p: number, picked: boolean]>;
    if (answer.type === "noul") options = [["yes", answer.noul, answer.yes], ["no", 1 - answer.noul, !answer.yes]];
    else {
      const picked = answer.type === "choice" ? answer.choice : String(Math.round(answer.score));
      // A score's level words go next to the number when they are short; long ones are the meaning line under the bars.
      const short = answer.type === "score" && Object.values(answer.legend).every((l) => (labelOf(l) ?? "").length <= 10);
      options = Object.entries(answer.probabilities).map(([name, p]) => [
        answer.type === "score" ? (short ? `${name} ${labelOf(answer.legend[name]) ?? ""}`.trim() : `level ${name}`) : name, p, name === picked,
      ]);
    }
    // A choice with more options than rows shows the likeliest ones.
    const fits = Math.max(2, room - out.length - 8);
    let more = 0;
    if (options.length > fits) {
      more = options.length - (fits - 1);
      options = [...options].sort((x, y) => Number(y[2]) - Number(x[2]) || y[1] - x[1]).slice(0, fits - 1);
    }
    const nameWidth = Math.min(14, Math.max(...options.map(([n]) => n.length)));
    const barWidth = Math.max(4, Math.min(20, width - nameWidth - 9));
    for (const [name, p, picked] of options) {
      const n = name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}~` : name.padEnd(nameWidth);
      out.push({ text: `${picked ? ">" : " "} ${n} ${bar(p, barWidth)} ${p.toFixed(2)}`, tone: picked ? "accent" : "text", bold: picked });
    }
    if (more > 0) out.push({ text: `  +${more} less likely`, tone: "muted" });
    const meaning = meaningOf(answer, found);
    if (meaning) {
      const lines = wrapLine(`${answerWord(answer)}: ${meaning}`, width);
      const shown = lines.slice(0, 3);
      if (lines.length > 3) shown[2] = `${shown[2]!.slice(0, width - 3)}...`;
      out.push(...shown.map((text): Line => ({ text, tone: "muted" })));
    }
  } else {
    out.push({ text: "Jev could not answer", tone: "error", bold: true });
  }
  out.push({ text: " ", tone: "text" });
  const t = found?.thresholds;
  const bands = t
    ? `(act ${t.act.toFixed(2)}, mark ${t.mark.toFixed(2)}${found.version === ask.jevel?.version ? "" : `, from v${found.version}`})`
    : "(thresholds unknown: the jevel is not found here)";
  out.push(...wrapLine(`certainty ${answer.certainty.toFixed(2)}  ${bands}`, width).map((text): Line => ({ text, tone: "text" })));
  out.push({ text: `decision  ${d}  ${MEANING[d]}`, tone: d, bold: true });
  if (ask.error) out.push(...wrapLine(`error     ${ask.error.code}: ${ask.error.message}`, width).map((text): Line => ({ text, tone: "error" })));
  if (row.run) out.push(...wrapLine(runLine(row.run), width).map((text): Line => ({ text, tone: "text" })));
  if (row.outcomes.length === 0) out.push({ text: "outcome   none yet", tone: "muted" });
  for (const o of row.outcomes) {
    const said = o.outcome === "agree" ? "Jev was right" : `Jev was wrong${o.value !== null ? `, it was ${o.value}` : ""}`;
    out.push(...wrapLine(`outcome   ${said} (${time(o.at)})${o.note ? `, note: ${o.note}` : ""}`, width).map((text): Line => ({ text, tone: "text" })));
  }
  // How this question has done so far, last, so a short terminal drops it first.
  if (sofar) {
    const n = sofar.act + sofar.mark + sofar.fallBack;
    const pc = (x: number, of: number): string => `${Math.round((x / of) * 100)}%`;
    const right = (ok: number, of: number): string => (of === 0 ? "-" : `${pc(ok, of)} of ${of}`);
    out.push(
      { text: " ", tone: "text" },
      ...wrapLine(`so far    ${n} decision${n === 1 ? "" : "s"}: act ${pc(sofar.act, n)}, mark ${pc(sofar.mark, n)}, fall_back ${pc(sofar.fallBack, n)}`, width).map((text): Line => ({ text, tone: "muted" })),
      ...wrapLine(`          act right ${right(sofar.actRight, sofar.actReviewed)}, mark right ${right(sofar.markRight, sofar.markReviewed)}`, width).map((text): Line => ({ text, tone: "muted" })),
    );
  }
  return out;
}

/** The left half: what Jev was given. */
function sawLines(row: Row, width: number): string[] {
  if (row.ask.state === undefined) {
    return wrapLine("state not logged; set JEVELRY_LOG_STATE=1", width).concat(
      " ",
      ...wrapLine("or ask with --log-state, or jevel(name, { logState: true }), and the next asks show what Jev saw.", width),
    );
  }
  return stateLines(row.ask.state, width);
}

/**
 * One decision as a card: what Jev saw on the left, what it decided on the right, and a for right, d for wrong.
 * Review shows the queue through it and History opens any decision in it. One outcome per card: after the first
 * a or d nothing more is written, and the caller moves on.
 */
export function Card(props: {
  row: Row;
  home: string;
  found: Found | null;
  /** The title on the first line, left. */
  title: React.ReactNode;
  width: number;
  height: number;
  active: boolean;
  /** How this jevel's question has done so far, from the whole log. */
  sofar?: Tally;
  /** Keys the caller handles (skip, the marks and acts toggle), shown after a and d. */
  keys?: Hint[];
  onKey?: (input: string) => void;
  onBack: () => void;
  onRecorded: (message: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { row } = props;
  const [scroll, setScroll] = useState(0);
  const [mode, setMode] = useState<"view" | "pick" | "note">("view");
  const [pick, setPick] = useState(0);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const answered = hasAnswer(row.answer);
  const choices = answered ? otherValues(row.answer as Answer) : [];
  // Set on the first key press, before the write resolves, so a fast second press is ignored too.
  const recording = useRef(false);
  const record = (value: string): void => {
    if (recording.current) return;
    recording.current = true;
    recordOutcome(props.home, row.ask.id, row.question, value, noteRef.current === "" ? null : noteRef.current, () => undefined)
      .then((line) => props.onRecorded(savedMessage(line, row)))
      .catch((error: unknown) => {
        recording.current = false;
        setMessage(`not recorded: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  const pickName = (v: string): string => (row.answer.type === "score" ? `level ${v}${hasAnswer(row.answer) && row.answer.type === "score" && row.answer.legend[v] !== undefined ? ` ${label(row.answer.legend[v])}` : ""}` : v);
  useChrome(
    mode === "pick" ? [["j/k", "move"], ["enter", "record"], ["esc", "cancel"]]
      : mode === "note" ? [["enter", "keep note"], ["esc", "drop note"]]
        : answered ? [["a", "Jev was right"], ["d", "Jev was wrong"], ...(props.keys ?? []), ["n", "note"], ["j/k", "scroll"], ["esc", "back"]]
          : [...(props.keys ?? []).filter(([k]) => k !== "s"), ["j/k", "scroll"], ["esc", "back"]],
    mode === "note",
  );
  // The handler reads the mode from a ref: keys typed right after n or d arrive before the next render,
  // and must already count as note text or a pick, never as a or d.
  const modeRef = useRef<"view" | "pick" | "note">("view");
  const noteRef = useRef("");
  const edit = (f: (n: string) => string): void => { noteRef.current = f(noteRef.current); setNote(noteRef.current); };
  const pickRef = useRef(0);
  const to = (m: "view" | "pick" | "note"): void => { modeRef.current = m; setMode(m); };
  const pickAt = (i: number): void => { pickRef.current = i; setPick(i); };
  useInput((input, key) => {
    if (modeRef.current === "note") {
      if (key.escape) { edit(() => ""); to("view"); }
      else if (key.return) to("view");
      else if (key.backspace || key.delete) edit((n) => n.slice(0, -1));
      else if (!key.ctrl && !key.meta && input) edit((n) => n + input);
      return;
    }
    if (modeRef.current === "pick") {
      if (key.escape) to("view");
      else if (key.downArrow || input === "j") pickAt(Math.min(pickRef.current + 1, choices.length - 1));
      else if (key.upArrow || input === "k") pickAt(Math.max(pickRef.current - 1, 0));
      else if (key.return && choices[pickRef.current] !== undefined) { to("view"); record(choices[pickRef.current]!); }
      return;
    }
    if (key.escape) props.onBack();
    else if (moves(input, key) !== 0) { const step = moves(input, key); setScroll((s) => Math.max(s + step, 0)); }
    else if (input === "a" && answered) record("agree");
    else if (input === "d" && answered) {
      if (choices.length === 0) record("disagree");
      else { pickAt(0); to("pick"); }
    } else if (input === "n" && answered) to("note");
    else props.onKey?.(input);
  }, { isActive: props.active });

  const inner = props.width - 2;
  const right = Math.max(34, Math.min(56, Math.floor(inner / 2)));
  const left = Math.max(20, inner - 3 - right);
  const bottom: Line[] = mode === "pick"
    ? [{ text: "What was right? j/k to move, enter to record, esc to cancel", tone: "accent" }, ...choices.map((c, i): Line => ({ text: `${i === pick ? ">" : " "} ${pickName(c)}`, tone: i === pick ? "accent" : "text", bold: i === pick }))]
    : mode === "note"
      ? [{ text: `note: ${note}_`, tone: "text" }, { text: "enter keeps the note for the next a or d, esc drops it", tone: "muted" }]
      : [
        ...(note !== "" ? [{ text: `note for the next a or d: ${note}`, tone: "muted" } as Line] : []),
        ...(message !== "" ? wrapLine(message, inner).map((text): Line => ({ text, tone: "error" })) : []),
      ];
  // Title, meta line, blank and the column headings; the footer belongs to the shell.
  const room = Math.max(3, props.height - 5 - bottom.length);
  const saw = sawLines(row, left);
  const top = Math.min(scroll, Math.max(saw.length - room, 0));
  const below = saw.length - top - room;
  const shownSaw = below > 0 ? saw.slice(top, top + room - 1) : saw.slice(top, top + room);
  const decided = decidedLines(row, props.found, right, room, props.sofar).slice(0, room);
  const tone = (t: Line["tone"]): string => (t === "act" || t === "mark" || t === "fall_back" ? decisionColor(theme, t) : theme[t]);
  // The question the screen asks, with its keys, right above the footer: the one line a reviewer needs.
  const ask: Hint[] = answered ? [["a", "yes"], ["d", "no, pick the right one"], ...(props.keys ?? [])] : (props.keys ?? []).filter(([k]) => k !== "s");
  const prompt = mode !== "view" ? null : (
    <Box width={inner} backgroundColor={theme.panel}>
      <Text wrap="truncate">
        <Text color={answered ? theme.text : theme.muted} bold>{answered ? " Was Jev right? " : " Jev could not answer, so there is nothing to judge. "}</Text>
        {ask.map(([k, what]) => (
          <Text key={k}><Text color={theme.accent} bold>{`  ${k}`}</Text><Text color={theme.text}>{` ${what}`}</Text></Text>
        ))}
      </Text>
    </Box>
  );
  return (
    <Box flexDirection="column" paddingX={1} height={props.height}>
      <Text wrap="truncate">
        {props.title}
      </Text>
      <Text wrap="truncate">
        <Text color={theme.text} bold>{`${jevelOf(row.ask)} ${row.question}`}</Text>
        <Text color={theme.muted}>{`  v${row.ask.jevel?.version ?? "-"} · ${fullTime(row.ask.at)} · ${row.ask.model ?? "no model"}`}</Text>
      </Text>
      <Text> </Text>
      <Box gap={3} height={room + 1}>
        <Box flexDirection="column" width={left}>
          <Text bold color={theme.accent}>What Jev saw</Text>
          {shownSaw.map((l, i) => <Text key={i} wrap="truncate" color={row.ask.state === undefined ? theme.muted : theme.text}>{l === "" ? " " : l}</Text>)}
          {below > 0 ? <Text color={theme.muted}>{`↓ ${below + 1} more lines, j/k scrolls`}</Text> : null}
        </Box>
        <Box flexDirection="column" width={right}>
          <Text bold color={theme.accent}>What Jev decided</Text>
          {decided.map((l, i) => <Text key={i} wrap="truncate" color={tone(l.tone)} bold={l.bold ?? false}>{l.text}</Text>)}
        </Box>
      </Box>
      {bottom.map((l, i) => (
        <Text key={`b${i}`} wrap="truncate" color={tone(l.tone)} bold={l.bold ?? false} backgroundColor={mode === "pick" && i > 0 && i - 1 === pick ? theme.element : theme.background}>
          {l.text}
        </Text>
      ))}
      {prompt}
    </Box>
  );
}

/** Any decision from History or Home's feed, in the card. */
export function DetailView(props: {
  row: Row;
  home: string;
  thresholds: Found | null;
  height?: number;
  width?: number;
  active?: boolean;
  tallies?: Map<string, Tally>;
  onBack: () => void;
  onRecorded: (message: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const sofar = props.tallies?.get(tallyKey(jevelOf(props.row.ask), props.row.question.replace(/\[\d+\]$/, "")));
  return (
    <Card row={props.row} home={props.home} found={props.thresholds} width={props.width ?? 80} height={props.height ?? 23} active={props.active ?? true} {...(sofar ? { sofar } : {})}
      title={<Text bold color={theme.text}>Decision</Text>} onBack={props.onBack} onRecorded={props.onRecorded} />
  );
}

export type ReviewMode = "mark" | "act";
const keyOf = (r: Row): string => `${r.ask.id}\n${r.question}`;

/**
 * The queue: marked decisions without an outcome, newest first, one card at a time. `m` switches to acts without an outcome,
 * because how often act is right is only known when some acts get reviewed too.
 */
export function ReviewView(props: {
  lines: LogLine[];
  home: string;
  lookup: (row: Row) => Found | null;
  tallies?: Map<string, Tally>;
  width: number;
  height: number;
  active: boolean;
  onBack: () => void;
  /** Called with the toast text once an outcome is written; the app reloads the log. */
  onRecorded: (message: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [mode, setMode] = useState<ReviewMode>("mark");
  // Recorded or skipped on this visit: they leave the queue at once, before the log is read again.
  const [recorded, setRecorded] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const queue = useMemo(() => rowsOf(props.lines, { ...ALL, decision: mode, noOutcome: true }).filter((r) => !r.ask.error), [props.lines, mode]);
  const open = queue.filter((r) => !recorded.has(keyOf(r)) && !skipped.has(keyOf(r)));
  const done = recorded.size + skipped.size;
  const current = open[0];
  const other: ReviewMode = mode === "mark" ? "act" : "mark";
  const toggle = (): void => { setMode(other); setRecorded(new Set()); setSkipped(new Set()); };
  // The next card slides in from the right: drawn a few columns in, then in place.
  const [slide, setSlide] = useState(0);
  const currentKey = current ? keyOf(current) : "";
  useEffect(() => {
    if (done === 0) return undefined;
    setSlide(4);
    const timer = setTimeout(() => setSlide(0), 50);
    return () => clearTimeout(timer);
  }, [currentKey]);
  const noun = mode === "mark" ? "marked decisions" : "act decisions";
  const sofar = current ? props.tallies?.get(tallyKey(jevelOf(current.ask), current.question.replace(/\[\d+\]$/, ""))) : undefined;

  if (!current) {
    return <ReviewEnd mode={mode} other={other} done={done} recorded={recorded.size} skipped={skipped.size} width={props.width} height={props.height} active={props.active}
      onToggle={toggle} onAgain={() => setSkipped(new Set())} onBack={props.onBack} noun={noun} />;
  }
  return (
    <Box paddingLeft={slide} height={props.height}>
      <Card key={currentKey} row={current} home={props.home} found={props.lookup(current)} width={props.width - slide} height={props.height} active={props.active}
        {...(sofar ? { sofar } : {})}
        title={(
          <Text>
            <Text bold color={theme.accent}>Review </Text>
            <Text bold color={theme.text}>{`${done + 1} of ${done + open.length}`}</Text>
            <Text color={theme.muted}>{`  ${noun} without an outcome, newest first`}</Text>
          </Text>
        )}
        keys={[["s", "skip"], ["m", mode === "mark" ? "review acts" : "review marks"]]}
        onKey={(input) => {
          if (input === "s") setSkipped((s) => new Set([...s, currentKey]));
          else if (input === "m") toggle();
        }}
        onBack={props.onBack}
        onRecorded={(message) => { setRecorded((s) => new Set([...s, currentKey])); props.onRecorded(message); }} />
    </Box>
  );
}

function ReviewEnd(props: {
  mode: ReviewMode;
  other: ReviewMode;
  noun: string;
  done: number;
  recorded: number;
  skipped: number;
  width: number;
  height: number;
  active: boolean;
  onToggle: () => void;
  onAgain: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const keys: Hint[] = [["m", props.mode === "mark" ? "review acts" : "review marks"], ...(props.skipped > 0 ? [["s", "show skipped"] as Hint] : []), ["esc", "home"]];
  useChrome(keys);
  useInput((input, key) => {
    if (input === "m") props.onToggle();
    else if (input === "s" && props.skipped > 0) props.onAgain();
    else if (key.escape) props.onBack();
  }, { isActive: props.active });
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const title = props.done === 0 ? `No ${props.noun} to review` : "All reviewed";
  const said = props.done === 0
    ? props.mode === "mark" ? "Every marked decision has an outcome." : "Every act decision has an outcome."
    : `${plural(props.recorded, "outcome")} recorded${props.skipped > 0 ? `, ${props.skipped} skipped` : ""} on this visit.`;
  const why = props.mode === "mark"
    ? "m reviews act decisions: how often act is right is only known when some acts get an outcome too."
    : "m goes back to the marked decisions.";
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height={props.height}>
      <Box flexDirection="column" backgroundColor={theme.panel} paddingX={3} paddingY={1} width={Math.min(64, props.width - 4)}>
        <Text bold color={theme.accent}>{title}</Text>
        <Text color={theme.text}>{said}</Text>
        {props.skipped > 0 ? <Text color={theme.muted}>s shows the skipped ones again.</Text> : null}
        <Text> </Text>
        <Text color={theme.muted}>{why}</Text>
        <Text color={theme.muted}>esc goes home.</Text>
      </Box>
    </Box>
  );
}

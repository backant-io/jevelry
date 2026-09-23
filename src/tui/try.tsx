import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { Box, type Key, Text, useInput, usePaste } from "ink";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Decisions, jevel as loadDecider } from "../decide.js";
import { type Jevel, checkState, expandQuestions, isEntry, loadJevel } from "../jevel.js";
import { resolveKey } from "../key.js";
import type { Answer, FallBackAnswer } from "../protocol.js";
import { bar } from "./charts.js";
import { ChromeContext, type Hint, moves, useChrome } from "./dialog.js";
import { answerWord, hasAnswer, wrapLine } from "./history.js";
import { PRICE_PER_MTOK, formatCost } from "./home.js";
import { optionsOf } from "./review.js";
import { decisionColor, useTheme } from "./theme.js";

/** The state a jevel ships as its example, as the file writes it; `{}` when it ships none. */
export function exampleOf(j: Jevel): string {
  const file = join(dirname(j.path), "example.json");
  return existsSync(file) ? readFileSync(file, "utf8").trimEnd() : "{}";
}

/** What the text under the editor says: the state to send, or why it cannot be sent yet. */
export function checkDraft(text: string, j: Jevel): { state: unknown } | { error: string } {
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON yet: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    if (!isEntry(state)) return { error: "the state must be a string, a JSON object or an array" };
    checkState(j, state);
    expandQuestions(j, state);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { state };
}

/**
 * The text cut into screen rows at most `width` wide, at the last space that fits when there is one:
 * each row is where it starts in the text, how long it is, and whether it ends its line.
 */
export function layout(text: string, width: number): Array<{ start: number; len: number; last: boolean }> {
  const rows: Array<{ start: number; len: number; last: boolean }> = [];
  let start = 0;
  for (const line of text.split("\n")) {
    let at = 0;
    do {
      const space = line.length - at > width ? line.lastIndexOf(" ", at + width - 1) : -1;
      const len = space > at ? space - at + 1 : Math.min(width, line.length - at);
      rows.push({ start: start + at, len, last: at + len >= line.length });
      at += len;
    } while (at < line.length);
    start += line.length + 1;
  }
  return rows;
}

/** The row the cursor is on: a cursor right after a full row belongs to the next row of the same line. */
export function rowOf(rows: ReturnType<typeof layout>, at: number): number {
  const i = rows.findIndex((r) => at >= r.start && (at < r.start + r.len || (r.last && at === r.start + r.len)));
  return i === -1 ? rows.length - 1 : i;
}

export interface Draft { text: string; at: number }

/** One key on the text: typing, arrows, backspace, home and end. The same draft back for any other key. */
export function editDraft(d: Draft, input: string, key: Partial<Key>, width: number): Draft {
  const { text, at } = d;
  const rows = layout(text, width);
  const row = rowOf(rows, at);
  const toRow = (r: number): number => {
    const target = rows[Math.max(0, Math.min(r, rows.length - 1))]!;
    const col = at - rows[row]!.start;
    // The end of a row that is not a line's end is the next row's start, so stop one short there.
    return target.start + Math.min(col, target.last ? target.len : Math.max(0, target.len - 1));
  };
  if (key.leftArrow) return { text, at: Math.max(0, at - 1) };
  if (key.rightArrow) return { text, at: Math.min(text.length, at + 1) };
  if (key.upArrow) return row === 0 ? { text, at: 0 } : { text, at: toRow(row - 1) };
  if (key.downArrow) return row === rows.length - 1 ? { text, at: text.length } : { text, at: toRow(row + 1) };
  if (key.home) return { text, at: text.lastIndexOf("\n", at - 1) + 1 };
  if (key.end) { const end = text.indexOf("\n", at); return { text, at: end === -1 ? text.length : end }; }
  if (key.backspace || key.delete) return at === 0 ? d : { text: text.slice(0, at - 1) + text.slice(at), at: at - 1 };
  if (key.tab) return { text: `${text.slice(0, at)}  ${text.slice(at)}`, at: at + 2 };
  if (key.ctrl || key.meta || key.escape || key.return || input === "") return d;
  // Typed text, or a paste the terminal sent without brackets: its line ends become newlines, other control characters go.
  const clean = input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  return { text: text.slice(0, at) + clean + text.slice(at), at: at + clean.length };
}

type Line = { text: string; color: string; bold?: boolean };
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Every question's answer as bars, with the decision in words and colour. */
function answerLines(d: Decisions, ms: number, width: number, theme: ReturnType<typeof useTheme>): Line[] {
  const out: Line[] = [];
  const tokens = d.usage ? `${d.usage.input_tokens + d.usage.output_tokens} tokens · ` : "";
  const price = d.model === null ? undefined : PRICE_PER_MTOK[d.model];
  const cost = d.usage && price !== undefined ? `${formatCost({ dollars: (d.usage.input_tokens / 1_000_000) * price, noUsage: 0, noPrice: 0 })} · ` : "";
  out.push(...wrapLine(`${d.model ?? "no model"} · ${(ms / 1000).toFixed(1)}s · ${tokens}${cost}${d.logId !== null ? "logged" : "not logged"}`, width).map((text) => ({ text, color: theme.muted })));
  if (d.error) {
    out.push({ text: " ", color: theme.text });
    out.push(...wrapLine(`Jev could not answer: ${d.error.code}`, width).map((text) => ({ text, color: theme.error, bold: true })));
    out.push(...wrapLine(d.error.message, width).map((text) => ({ text, color: theme.error })));
    if (d.error.code === "auth") out.push(...wrapLine("Store a key with npx jevelry install, or export TYPESAFE_API_KEY. Get one at https://docs.typesafe.ai.", width).map((text) => ({ text, color: theme.text })));
    out.push(...wrapLine("Every question is fall_back, so your code decides. r asks again.", width).map((text) => ({ text, color: theme.muted })));
    return out;
  }
  const answers = Object.entries(d).filter(([k]) => !["logId", "error", "model", "usage"].includes(k)) as Array<[string, Answer | FallBackAnswer]>;
  for (const [name, a] of answers) {
    out.push({ text: " ", color: theme.text });
    const head = `${name} = ${answerWord(a)}   ${a.decision} ${a.certainty.toFixed(2)}`;
    out.push({ text: head.length > width ? `${head.slice(0, width - 1)}~` : head, color: decisionColor(theme, a.decision), bold: true });
    if (!hasAnswer(a)) continue;
    const options = optionsOf(a);
    const nameWidth = Math.min(14, Math.max(...options.map(([n]) => n.length)));
    const barWidth = Math.max(4, Math.min(20, width - nameWidth - 9));
    for (const [n, p, picked] of options) {
      const cut = n.length > nameWidth ? `${n.slice(0, nameWidth - 1)}~` : n.padEnd(nameWidth);
      out.push({ text: `${picked ? ">" : " "} ${cut} ${bar(p, barWidth)} ${p.toFixed(2)}`, color: picked ? theme.accent : theme.text, bold: picked });
    }
  }
  return out;
}

/**
 * Try: a jevel's example state in a text area, enter asks Jev live through decide(), and the answer comes back as bars.
 * The ask is logged like any other, so it shows up on Home and in History.
 */
export function TryView(props: {
  name: string;
  dirs: string[];
  home: string;
  /** Tests pass one that talks to the local test server; the CLI's own client otherwise. */
  client?: TypeSafeClient;
  /** The text as last left, so a visit to another screen keeps the edit. */
  draft?: string;
  onDraft: (text: string, edited: boolean) => void;
  width: number;
  height: number;
  active: boolean;
  onPick: () => void;
  onBack: () => void;
  onAsked: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const chrome = useContext(ChromeContext);
  const loaded = useMemo((): { jevel: Jevel; example: string } | { error: string } => {
    try {
      const j = loadJevel(props.name, props.dirs).jevel;
      return { jevel: j, example: exampleOf(j) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [props.name]);
  const example = "jevel" in loaded ? loaded.example : "";
  const [draft, setDraftState] = useState<Draft>(() => {
    const text = props.draft ?? example;
    return { text, at: text.length };
  });
  const draftRef = useRef(draft);
  const [mode, setModeState] = useState<"edit" | "view" | "asking">("jevel" in loaded ? "edit" : "view");
  const modeRef = useRef(mode);
  const setMode = (m: "edit" | "view" | "asking"): void => { modeRef.current = m; setModeState(m); chrome.captureNow(m === "edit"); };
  const [result, setResult] = useState<{ d: Decisions; ms: number } | null>(null);
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [scroll, setScroll] = useState(0);
  // Read on open and again on each enter (the keychain lookup starts a process): a key stored meanwhile counts at once.
  const hasKey = (): boolean => props.client !== undefined || resolveKey(process.env, props.home) !== undefined;
  const [noKey, setNoKey] = useState(() => !hasKey());

  useEffect(() => {
    if (mode !== "asking") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(timer);
  }, [mode]);

  const inner = props.width - 2;
  const right = Math.max(34, Math.min(56, Math.floor(inner / 2)));
  const left = Math.max(20, inner - 3 - right);
  const edit = (next: Draft): void => {
    draftRef.current = next;
    setDraftState(next);
    props.onDraft(next.text, next.text !== example);
  };
  const checked = "jevel" in loaded ? checkDraft(draft.text, loaded.jevel) : { error: loaded.error };

  const ask = (): void => {
    if (!("jevel" in loaded)) return;
    const c = checkDraft(draftRef.current.text, loaded.jevel);
    if (!("state" in c)) return;
    const missing = !hasKey();
    setNoKey(missing);
    if (missing) return;
    const t0 = Date.now();
    setStarted(t0);
    setNow(t0);
    setScroll(0);
    setMode("asking");
    // decide() throws only for a jevel or a state it refuses, which the check above already ruled out; said, if it happens.
    Promise.resolve()
      .then(() => loadDecider(props.name, { jevels: props.dirs, home: props.home, ...(props.client ? { client: props.client } : {}) }).decide(c.state))
      .then(
        (d) => { setResult({ d: d as Decisions, ms: Date.now() - t0 }); setMode("view"); props.onAsked(); },
        (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          setResult({ d: { logId: null, model: null, usage: null, error: { exit: 2, code: "bad_input", message } } as never, ms: Date.now() - t0 });
          setMode("view");
        },
      );
  };

  useInput((input, key) => {
    const m = modeRef.current;
    if (m === "asking") return;
    if (m === "edit") {
      if (key.escape) setMode("view");
      else if (key.return) ask();
      else edit(editDraft(draftRef.current, input, key, left));
      return;
    }
    if (key.escape) props.onBack();
    else if (key.return || input === "r") ask();
    else if (input === "e" && "jevel" in loaded) setMode("edit");
    else if (input === "p") props.onPick();
    else if (moves(input, key as Key) !== 0) { const step = moves(input, key as Key); setScroll((s) => Math.max(0, s + step)); }
  }, { isActive: props.active });
  usePaste((text) => { if (modeRef.current === "edit") edit(editDraft(draftRef.current, text, {}, left)); }, { isActive: props.active && mode === "edit" });

  const hints: Hint[] = mode === "edit"
    ? [["enter", "ask"], ["esc", "stop editing"], ["arrows", "move"]]
    : mode === "asking" ? []
      : [[result ? "r" : "enter", result ? "ask again" : "ask"], ["e", "edit"], ["p", "other jevel"], ...(result ? [["j/k", "scroll"] as Hint] : []), ["esc", "home"]];
  useChrome(hints, mode === "edit");

  // The title, a blank and the column headings; the footer belongs to the shell.
  const room = Math.max(3, props.height - 3);
  const status: Line[] = "error" in checked
    ? wrapLine(checked.error, left).slice(0, 3).map((text) => ({ text, color: theme.error }))
    : noKey
      ? wrapLine("No TypeSafe key yet. Run npx jevelry install in another terminal, then press enter here.", left).slice(0, 3).map((text) => ({ text, color: theme.mark }))
      : [{ text: "valid state · enter asks Jev", color: theme.muted }];
  const editorRows = Math.max(1, room - status.length - 1);
  const rows = layout(draft.text, left);
  const cursorRow = rowOf(rows, draft.at);
  // The cursor stays in view: the window follows it, and otherwise starts at the top.
  const top = Math.max(0, Math.min(cursorRow - Math.floor(editorRows / 2), rows.length - editorRows));
  const shownRows = rows.slice(top, top + editorRows);

  let answer: Line[];
  if (mode === "asking") {
    const s = SPIN[Math.floor((now - started) / 80) % SPIN.length]!;
    answer = [{ text: " ", color: theme.text }, { text: `${s} Asking Jev ${((now - started) / 1000).toFixed(1)}s`, color: theme.accent, bold: true }, { text: "One request for all its questions.", color: theme.muted }];
  } else if (result) {
    answer = answerLines(result.d, result.ms, right, theme);
  } else if ("jevel" in loaded) {
    const qs = Object.entries(loaded.jevel.questions).map(([n, q]) => `${n} (${q.type})`).join(", ");
    answer = [
      ...wrapLine("Press enter and Jev answers this jevel's questions about the state on the left, live. You see how sure Jev is, and the decision your code gets.", right).map((text) => ({ text, color: theme.text })),
      { text: " ", color: theme.text },
      ...wrapLine(`questions: ${qs}`, right).map((text) => ({ text, color: theme.muted })),
      { text: " ", color: theme.text },
      ...wrapLine("The ask is logged like any other, so it shows up on Home and in History.", right).map((text) => ({ text, color: theme.muted })),
    ];
  } else answer = [];
  const answerTop = Math.min(scroll, Math.max(0, answer.length - room));
  const below = answer.length - answerTop - room;
  const shownAnswer = below > 0 ? answer.slice(answerTop, answerTop + room - 1) : answer.slice(answerTop, answerTop + room);

  const version = "jevel" in loaded ? `  v${loaded.jevel.version} · asks Jev live, and logs the ask` : "";
  return (
    <Box flexDirection="column" paddingX={1} height={props.height}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>Try </Text>
        <Text bold color={theme.text}>{props.name}</Text>
        <Text color={theme.muted}>{version}</Text>
      </Text>
      <Text> </Text>
      <Box gap={3} height={room + 1}>
        <Box flexDirection="column" width={left}>
          <Text wrap="truncate">
            <Text bold color={theme.accent}>State</Text>
            <Text color={theme.muted}>{mode === "edit" ? "  editing" : "  e edits"}</Text>
          </Text>
          <Box flexDirection="column" height={editorRows} backgroundColor={mode === "edit" ? theme.element : theme.panel}>
            {shownRows.map((r, i) => {
              const text = draft.text.slice(r.start, r.start + r.len);
              if (mode !== "edit" || top + i !== cursorRow) return <Text key={i} color={mode === "asking" ? theme.muted : theme.text}>{text === "" ? " " : text}</Text>;
              const col = draft.at - r.start;
              return (
                <Text key={i} color={theme.text}>
                  {text.slice(0, col)}
                  <Text backgroundColor={theme.accent} color={theme.background}>{text.slice(col, col + 1) || " "}</Text>
                  {text.slice(col + 1)}
                </Text>
              );
            })}
          </Box>
          {status.map((l, i) => <Text key={`s${i}`} wrap="truncate" color={l.color}>{l.text}</Text>)}
        </Box>
        <Box flexDirection="column" width={right}>
          <Text bold color={theme.accent}>What Jev decided</Text>
          {shownAnswer.map((l, i) => <Text key={i} wrap="truncate" color={l.color} bold={l.bold ?? false}>{l.text}</Text>)}
          {below > 0 ? <Text color={theme.muted}>{`↓ ${below + 1} more lines, j/k scrolls`}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
}

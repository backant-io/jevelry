import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { mergeThresholds, type Thresholds } from "../decision.js";
import type { Jevel } from "../jevel.js";
import { histogram, mix } from "./charts.js";
import { Dialog, moves, useChrome } from "./dialog.js";
import { wrapLine } from "./history.js";
import { type Theme, decisionColor, useTheme } from "./theme.js";
import { MIN_REVIEWED, type Place, type Proposal, type Tally, copyJevel, proposeAct, setActThreshold, writeActThreshold } from "./tuning.js";

/** A path as short as it reads: relative under the working directory, with `~` for the home directory elsewhere. */
export function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  if (rel !== "" && !rel.startsWith("..")) return rel;
  return path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
}
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const rightOf = (right: number, of: number): string => (of === 0 ? "-" : `${pct(right / of)} of ${of}`);

/** One question of the jevel on screen: what the file says and what the log saw. */
export interface QuestionView {
  name: string;
  type: string | null;
  thresholds: Thresholds | null;
  tally: Tally | null;
  proposal: Proposal | null;
}

/** The questions in the file's order, then any the log has that the file no longer does. */
export function questionViews(jevel: Jevel | null, name: string, tallies: Map<string, Tally>): QuestionView[] {
  const logged = [...tallies.values()].filter((t) => t.jevel === name);
  const names = [...Object.keys(jevel?.questions ?? {}), ...logged.map((t) => t.question).filter((q) => !jevel || !Object.hasOwn(jevel.questions, q))];
  return names.map((q) => {
    const tally = logged.find((t) => t.question === q) ?? null;
    const question = jevel && Object.hasOwn(jevel.questions, q) ? jevel.questions[q]! : null;
    const thresholds = jevel && question ? mergeThresholds(jevel.thresholds, question.thresholds) : null;
    return { name: q, type: question?.type ?? null, thresholds, tally, proposal: tally && thresholds ? proposeAct(tally, thresholds) : null };
  });
}

/** The tuning line: the suggestion, or why there is none. */
export function tuningLine(v: QuestionView): { text: string; suggest: boolean } {
  if (v.proposal) {
    const p = v.proposal;
    return { text: `act would still be right ${pct(p.agreement)} at ${p.act.toFixed(2)}, and ${pct(p.more)} more decisions would act. T to set it.`, suggest: true };
  }
  if (!v.thresholds) return { text: "thresholds unknown: the jevel file is not found here", suggest: false };
  const reviewed = v.tally?.reviewed.length ?? 0;
  if (reviewed < MIN_REVIEWED) return { text: `${reviewed} of ${MIN_REVIEWED} reviewed decisions needed to suggest a threshold`, suggest: false };
  return { text: `act ${v.thresholds.act.toFixed(2)} holds: no lower threshold keeps act as right`, suggest: false };
}

function MixLine(props: { t: Tally | null; width: number; theme: Theme }): React.JSX.Element {
  const { t, theme } = props;
  const total = t ? t.act + t.mark + t.fallBack : 0;
  if (!t || total === 0) return <Text color={theme.muted}>no decisions yet</Text>;
  const text = mix(t.act, t.mark, t.fallBack, props.width);
  return (
    <Text wrap="truncate">
      {(text.match(/█+|▓+|░+/g) ?? []).map((p, i) => <Text key={i} color={p[0] === "█" ? theme.act : p[0] === "▓" ? theme.mark : theme.fallBack}>{p}</Text>)}
      <Text color={theme.act}>{`  act ${pct(t.act / total)}`}</Text>
      <Text color={theme.mark}>{`  mark ${pct(t.mark / total)}`}</Text>
      <Text color={theme.fallBack}>{`  fall_back ${pct(t.fallBack / total)}`}</Text>
    </Text>
  );
}

/** Rows one question takes: name, mix, right, the histogram's two rows, the tuning line (two when it wraps) and a blank. */
const BLOCK = 7;

/** One jevel, question by question: how it decides, how often it was right, where its certainties fall, and whether act could come down. */
export function JevelView(props: {
  name: string;
  jevel: Jevel | null;
  place: Place | null;
  views: QuestionView[];
  width: number;
  height: number;
  active: boolean;
  onOpen: (question: string) => void;
  onTune: (question: QuestionView) => void;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { views } = props;
  const [at, setAt] = useState(0);
  const cursor = Math.min(at, Math.max(views.length - 1, 0));
  const current = views[cursor];
  useChrome([["j/k", "move"], ["enter", "its decisions"], ...(current?.proposal ? [["T", "set threshold"] as [string, string]] : []), ["esc", "home"]]);
  useInput((input, key) => {
    const step = moves(input, key);
    if (step !== 0) setAt((a) => Math.max(0, Math.min(Math.min(a, views.length - 1) + step, views.length - 1)));
    else if (key.return && current) props.onOpen(current.name);
    else if (input === "T" && current?.proposal) props.onTune(current);
    else if (key.escape) props.onBack();
  }, { isActive: props.active });

  const inner = props.width - 4;
  // Title, the file line and a blank; the rest holds whole question blocks.
  const fits = Math.max(1, Math.floor((props.height - 4) / BLOCK));
  const top = Math.max(0, Math.min(cursor - fits + 1, views.length - fits));
  const visible = views.slice(top, top + fits);
  const below = views.length - top - visible.length;
  const histWidth = Math.max(20, Math.min(50, inner - 30));
  const where = props.jevel ? shown(props.jevel.path) : null;
  const whose = props.place?.kind === "shipped" ? "ships with jevelry" : props.place?.kind === "home" ? "in JEVELRY_HOME, shared by every project" : "your project's file";
  // ponytail: the path goes last so a long one is what gets cut at the right edge.
  const totals = views.reduce((n, v) => n + (v.tally ? v.tally.act + v.tally.mark + v.tally.fallBack : 0), 0);
  return (
    <Box flexDirection="column" paddingX={1} height={props.height}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>Jevel </Text>
        <Text bold color={theme.text}>{props.name}</Text>
        <Text color={theme.muted}>{`  ${props.jevel ? `v${props.jevel.version} · ` : ""}${plural(views.length, "question")} · ${plural(totals, "decision")}`}</Text>
      </Text>
      <Text color={theme.muted} wrap="truncate">{where ? `${whose}: ${where}` : "The jevel file is not found in the jevels folders; these numbers come from the log alone."}</Text>
      <Text> </Text>
      {views.length === 0 ? <Text color={theme.muted}>No questions and no decisions for this jevel yet.</Text> : null}
      {visible.map((v, i) => {
        const selected = top + i === cursor;
        const t = v.tally;
        const [bars, marks] = histogram(t?.certainties ?? [], histWidth, v.thresholds ? [v.thresholds.mark, v.thresholds.act] : []).split("\n") as [string, string];
        const line = tuningLine(v);
        const decisions = t ? t.act + t.mark + t.fallBack : 0;
        return (
          <Box key={v.name} flexDirection="column" height={BLOCK}>
            <Text wrap="truncate" {...(selected ? { backgroundColor: theme.element } : {})}>
              <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
              <Text color={theme.text} bold>{v.name}</Text>
              <Text color={theme.muted}>{`  ${v.type ?? "not in the file"}`}</Text>
              <Text color={theme.muted}>{v.thresholds ? `  act ≥ ${v.thresholds.act.toFixed(2)}  mark ≥ ${v.thresholds.mark.toFixed(2)}` : ""}</Text>
              <Text color={theme.muted}>{`  ${plural(decisions, "decision")}`}</Text>
            </Text>
            <Box paddingLeft={2}><MixLine t={t} width={Math.min(30, inner - 36)} theme={theme} /></Box>
            <Text wrap="truncate">
              <Text>{"  "}</Text>
              <Text color={theme.muted}>act right </Text>
              <Text color={t && t.actReviewed >= 10 ? theme.text : theme.muted}>{t ? rightOf(t.actRight, t.actReviewed) : "-"}</Text>
              <Text color={theme.muted}>{"   mark right "}</Text>
              <Text color={t && t.markReviewed >= 10 ? theme.text : theme.muted}>{t ? rightOf(t.markRight, t.markReviewed) : "-"}</Text>
            </Text>
            <Text wrap="truncate">
              <Text color={theme.muted}>{"  0 "}</Text>
              <Text color={theme.accent}>{bars}</Text>
              <Text color={theme.muted}>{" 1  certainty of each answer"}</Text>
            </Text>
            <Text wrap="truncate">
              <Text>{"    "}</Text>
              {[...marks.padEnd(histWidth)].map((c, k) => {
                const isMark = v.thresholds !== null && c === "│";
                const isAct = isMark && Math.min(histWidth - 1, Math.floor(v.thresholds!.act * histWidth)) === k;
                return <Text key={k} color={isAct ? decisionColor(theme, "act") : isMark ? decisionColor(theme, "mark") : theme.muted}>{c}</Text>;
              })}
              <Text color={theme.muted}>{v.thresholds ? `   │ mark ${v.thresholds.mark.toFixed(2)}  │ act ${v.thresholds.act.toFixed(2)}` : ""}</Text>
            </Text>
            {wrapLine(line.text, inner - 2).slice(0, 2).map((l, k) => <Text key={k} wrap="truncate" color={line.suggest ? theme.accent : theme.muted} bold={line.suggest}>{`  ${l}`}</Text>)}
          </Box>
        );
      })}
      {below > 0 ? <Text color={theme.muted}>{`  ↓ ${plural(below, "more question")}`}</Text> : null}
    </Box>
  );
}

/**
 * The confirm for `T`: the file, the exact lines that change, and enter to write them. A jevel that ships with jevelry
 * or sits in JEVELRY_HOME is not the project's to change, so enter copies it into the project's jevels folder first.
 */
export function TuneDialog(props: {
  jevel: Jevel;
  place: Place;
  view: QuestionView;
  project: string;
  columns: number;
  rows: number;
  onDone: (message: string, error?: boolean) => void;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const p = props.view.proposal!;
  const q = props.view.name;
  const copy = props.place.kind !== "project";
  const target = join(props.project, props.jevel.name);
  const plan = useMemo(() => {
    try {
      return { edited: setActThreshold(readFileSync(props.jevel.path, "utf8"), q, p.act), error: null };
    } catch (e) {
      return { edited: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [props.jevel.path, q, p.act]);
  const self = copy && resolve(target) === resolve(dirname(props.jevel.path));
  const blocked = plan.error ?? (self ? "this folder is jevelry's own copy; run jevelry tui in your project to copy and tune it" : null);
  const rel = shown;
  useInput((_input, key) => {
    if (key.escape) props.onClose();
    else if (key.return && blocked === null) {
      try {
        const path = copy ? copyJevel(props.jevel.path, props.project) : props.jevel.path;
        writeActThreshold(path, q, p.act);
        props.onDone(`threshold set to ${p.act.toFixed(2)} in ${rel(path)}`);
      } catch (e) {
        props.onDone(`threshold not set: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  });
  const lines: Array<{ text: string; color: string; bold?: boolean }> = [
    { text: `${props.jevel.name} ${q}: act ${props.view.thresholds!.act.toFixed(2)} → ${p.act.toFixed(2)}`, color: theme.text, bold: true },
    { text: `act would still be right ${pct(p.agreement)} (now ${pct(p.current)}), from ${p.reviewed} reviewed.`, color: theme.muted },
    { text: " ", color: theme.text },
  ];
  if (copy) {
    lines.push(
      { text: props.place.kind === "shipped" ? `${props.jevel.name} ships with jevelry, so tune your own copy.` : `${props.jevel.name} is in JEVELRY_HOME, shared by every project.`, color: theme.text },
      { text: `enter copies its folder to ${rel(target)}, then:`, color: theme.text },
    );
  }
  lines.push({ text: `in ${copy ? rel(join(target, "JEVEL.md")) : rel(props.jevel.path)}`, color: theme.muted });
  for (const c of plan.edited?.changes ?? []) {
    lines.push({ text: `line ${c.line}`, color: theme.muted });
    lines.push({ text: `- ${c.before.trim()}`, color: theme.fallBack });
    for (const after of c.after.split("\n")) lines.push({ text: `+ ${after.trim()}`, color: theme.act });
  }
  lines.push({ text: "Every other byte of the file stays as it is.", color: theme.muted });
  if (blocked !== null) lines.push({ text: " ", color: theme.text }, { text: blocked, color: theme.error });
  const width = Math.min(72, props.columns - 4);
  return (
    <Dialog title={copy ? "Copy the jevel and set its threshold" : "Set the act threshold"} width={width} columns={props.columns} rows={props.rows} height={8 + lines.length}>
      <Text> </Text>
      {lines.map((l, i) => <Text key={i} wrap="truncate" color={l.color} bold={l.bold ?? false}>{l.text}</Text>)}
      <Text> </Text>
      <Text>
        {blocked === null ? <Text><Text color={theme.accent} bold>enter</Text><Text color={theme.text}>{copy ? " copy and set   " : " set it   "}</Text></Text> : null}
        <Text color={theme.accent} bold>esc</Text><Text color={theme.text}> cancel</Text>
      </Text>
    </Dialog>
  );
}

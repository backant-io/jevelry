import { Box, Text, useInput } from "ink";
import { useMemo, useRef } from "react";
import type { AskLine, LogLine } from "../log.js";
import { recordedDecision } from "../report.js";
import { mix, spark } from "./charts.js";
import { type Hint, moves, useChrome } from "./dialog.js";
import { ALL, type Filters, answerWord, jevelOf, rowsOf, time } from "./history.js";
import { MEANINGS, type Theme, decisionColor, useTheme } from "./theme.js";

const WORD_LINES: Array<["act" | "mark" | "fall_back", string]> = (["act", "mark", "fall_back"] as const).map((d) => [d, `: ${MEANINGS[d]}`]);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const fit = (text: string, width: number): string => (text.length > width ? `${text.slice(0, width - 1)}~` : text.padEnd(width));

/** Dollars per million input tokens, from https://docs.typesafe.ai/models.md. Output tokens are free. */
export const PRICE_PER_MTOK: Record<string, number> = { "jev-1.13.0": 0.042 };

export interface JevelStats {
  name: string;
  decisions: number;
  /** How often an act decision was right, from the outcomes recorded on acts; null when no act has an outcome. */
  actRight: number | null;
  /** How many act decisions have an outcome, the number `actRight` rests on. */
  actOutcomes: number;
  /** The same for mark decisions. */
  markRight: number | null;
  mix: { act: number; mark: number; fallBack: number };
  /** Per question, in the order they were first logged: the same numbers, for the side column. */
  questions: QuestionStats[];
  /** Decisions per day for the last 14 days, today last. */
  trend: number[];
}

export interface QuestionStats {
  name: string;
  mix: { act: number; mark: number; fallBack: number };
  actRight: number | null;
  actOutcomes: number;
}

export interface HomeStats {
  today: { asks: number; decisions: number; act: number; mark: number; fallBack: number; cost: Cost };
  /** Decisions per hour for the last 24 hours, the current hour last. */
  hourly: number[];
  /** Marked decisions nobody has recorded an outcome for yet, from the whole log. */
  toReview: number;
  /** Every marked decision in the log, with an outcome or not. */
  marks: number;
  failedToday: { count: number; topError: string | null };
  jevels: JevelStats[];
  empty: boolean;
}

const HOUR = 3_600_000;
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** What the priced asks cost, and how many answered asks could not be priced. */
export interface Cost {
  dollars: number;
  /** Answered asks that logged no usage. */
  noUsage: number;
  /** Answered asks on a model without a known price. */
  noPrice: number;
}

/**
 * What the input tokens of these asks cost, summing the asks that can be priced and counting the ones that cannot.
 * An ask Jev could not answer was not charged.
 */
export function costOf(asks: AskLine[]): Cost {
  const cost: Cost = { dollars: 0, noUsage: 0, noPrice: 0 };
  for (const ask of asks) {
    if (ask.error) continue;
    const price = ask.model === null ? undefined : PRICE_PER_MTOK[ask.model];
    if (!ask.usage) cost.noUsage += 1;
    else if (price === undefined) cost.noPrice += 1;
    else cost.dollars += (ask.usage.input_tokens / 1_000_000) * price;
  }
  return cost;
}

/** Two significant digits for the small sums a day of asks costs, `$0.000017`, `$0.42`, then what could not be priced. */
export function formatCost(cost: Cost): string {
  const { dollars } = cost;
  // Nothing priced at all: a sum of $0 would read as free.
  if (dollars === 0 && cost.noUsage + cost.noPrice > 0) return "cost unknown";
  const sum = dollars === 0 ? "$0" : dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(Math.min(10, 1 - Math.floor(Math.log10(dollars))))}`;
  const unknown = [
    cost.noUsage > 0 ? `${plural(cost.noUsage, "ask")} without usage` : "",
    cost.noPrice > 0 ? `${plural(cost.noPrice, "ask")} on an unpriced model` : "",
  ].filter((x) => x !== "");
  return [sum, ...unknown].join(", ");
}

export function homeStats(lines: LogLine[], now: Date): HomeStats {
  const asks = lines.filter((l): l is AskLine => l.kind === "ask");
  const midnight = startOfDay(now);
  const today = asks.filter((a) => Date.parse(a.at) >= midnight && Date.parse(a.at) <= now.getTime());
  const count = { act: 0, mark: 0, fallBack: 0 };
  for (const ask of today) {
    for (const answer of Object.values(ask.answers)) {
      const d = recordedDecision(answer);
      if (d === "act") count.act += 1;
      else if (d === "mark") count.mark += 1;
      else count.fallBack += 1;
    }
  }
  const hourly = new Array<number>(24).fill(0);
  for (const ask of asks) {
    const back = Math.floor((now.getTime() - Date.parse(ask.at)) / HOUR);
    if (back >= 0 && back < 24) hourly[23 - back]! += Object.keys(ask.answers).length;
  }
  const outcomes = new Map<string, "agree" | "disagree">();
  for (const l of lines) if (l.kind === "outcome") outcomes.set(`${l.id}\n${l.question}`, l.outcome);
  let toReview = 0;
  let marks = 0;
  type Tally = { acts: number; actsAgreed: number };
  const byJevel = new Map<string, JevelStats & Tally & { marks: number; marksAgreed: number; perQuestion: Map<string, QuestionStats & Tally> }>();
  for (const ask of asks) {
    const name = jevelOf(ask);
    const s = byJevel.get(name) ?? {
      name, decisions: 0, actRight: null, actOutcomes: 0, markRight: null, mix: { act: 0, mark: 0, fallBack: 0 }, questions: [], trend: new Array<number>(14).fill(0),
      acts: 0, actsAgreed: 0, marks: 0, marksAgreed: 0, perQuestion: new Map(),
    };
    byJevel.set(name, s);
    const day = Math.round((midnight - startOfDay(new Date(ask.at))) / (24 * HOUR));
    for (const [question, answer] of Object.entries(ask.answers)) {
      s.decisions += 1;
      if (day >= 0 && day < 14) s.trend[13 - day]! += 1;
      const d = recordedDecision(answer);
      const outcome = outcomes.get(`${ask.id}\n${question}`);
      if (d === "mark" && !ask.error) { marks += 1; if (outcome === undefined) toReview += 1; }
      const base = question.replace(/\[\d+\]$/, "");
      const q = s.perQuestion.get(base) ?? { name: base, mix: { act: 0, mark: 0, fallBack: 0 }, actRight: null, actOutcomes: 0, acts: 0, actsAgreed: 0 };
      s.perQuestion.set(base, q);
      for (const m of [s.mix, q.mix]) {
        if (d === "act") m.act += 1;
        else if (d === "mark") m.mark += 1;
        else m.fallBack += 1;
      }
      if (d === "act" && outcome !== undefined) {
        for (const t of [s, q]) { t.acts += 1; if (outcome === "agree") t.actsAgreed += 1; }
      }
      if (d === "mark" && outcome !== undefined) { s.marks += 1; if (outcome === "agree") s.marksAgreed += 1; }
    }
  }
  const failed = today.filter((a) => a.error);
  const errors = new Map<string, number>();
  for (const a of failed) errors.set(a.error!.code, (errors.get(a.error!.code) ?? 0) + 1);
  const topError = [...errors].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return {
    today: { asks: today.length, decisions: count.act + count.mark + count.fallBack, ...count, cost: costOf(today) },
    hourly,
    toReview,
    marks,
    failedToday: { count: failed.length, topError },
    jevels: [...byJevel.values()]
      .map(({ acts, actsAgreed, marks, marksAgreed, perQuestion, ...s }) => ({
        ...s,
        actRight: acts === 0 ? null : actsAgreed / acts,
        actOutcomes: acts,
        markRight: marks === 0 ? null : marksAgreed / marks,
        questions: [...perQuestion.values()].map(({ acts: n, actsAgreed: ok, ...q }) => ({ ...q, actRight: n === 0 ? null : ok / n, actOutcomes: n })),
      }))
      .sort((a, b) => b.decisions - a.decisions || a.name.localeCompare(b.name)),
    empty: asks.length === 0,
  };
}

const LOGO = {
  jev: ["   █ █▀▀▀ █   █", "█  █ █▀▀  ▀▄ ▄▀", "▀▀▀▀ ▀▀▀▀   ▀  "],
  elry: ["█▀▀▀ █    █▀▀█ ▀▄ ▄▀", "█▀▀  █    █▀▀▄   █  ", "▀▀▀▀ ▀▀▀▀ ▀  ▀   ▀  "],
};

/** `◆ JEVELRY` with the tagline and version; the block form when the terminal has room for it. */
export function Logo(props: { big: boolean; version: string; center?: boolean }): React.JSX.Element {
  const theme = useTheme();
  const tagline = <Text color={theme.muted}>Use Jev everywhere to make &amp; track decisions</Text>;
  if (!props.big) {
    return (
      <Text wrap="truncate">
        <Text color={theme.accent}>◆ </Text>
        <Text color={theme.accent} bold>JEV</Text>
        <Text color={theme.text} bold>ELRY</Text>
        <Text>{"  "}</Text>
        {tagline}
        <Text color={theme.muted}>{`  v${props.version}`}</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column" alignItems={props.center ? "center" : "flex-start"}>
      {LOGO.jev.map((row, i) => (
        <Text key={i}>
          <Text color={theme.accent}>{i === 1 ? "◆  " : "   "}</Text>
          <Text color={theme.accent}>{row}</Text>
          <Text> </Text>
          <Text color={theme.text} bold>{LOGO.elry[i]}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text>{tagline}<Text color={theme.muted}>{`   v${props.version}`}</Text></Text>
    </Box>
  );
}

const pct = (part: number, total: number): string => `${total === 0 ? 0 : Math.round((part / total) * 100)}%`;

/** The mix bar in three colours, each part also its own glyph so it reads without colour. */
function MixBar(props: { act: number; mark: number; fallBack: number; width: number; theme: Theme }): React.JSX.Element {
  const { theme } = props;
  const text = mix(props.act, props.mark, props.fallBack, props.width);
  const parts = text.match(/█+|▓+|░+/g) ?? [];
  if (parts.length === 0) return <Text color={theme.border}>{"░".repeat(props.width)}</Text>;
  return (
    <Text>
      {parts.map((p, i) => <Text key={i} color={p[0] === "█" ? theme.act : p[0] === "▓" ? theme.mark : theme.fallBack}>{p}</Text>)}
    </Text>
  );
}

export type Target =
  | { kind: "review" }
  | { kind: "history"; filters: Partial<Filters> }
  | { kind: "jevel"; name: string; question?: string }
  | { kind: "decision"; id: string; question: string };

function Panel(props: { title: string; note?: string; width?: number; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} {...(props.width !== undefined ? { width: props.width } : { flexGrow: 1 })}>
      <Text wrap="truncate">
        <Text bold color={theme.text}>{props.title}</Text>
        {props.note ? <Text color={theme.muted}>{`  ${props.note}`}</Text> : null}
      </Text>
      {props.children}
    </Box>
  );
}

/** The legend under the mix bar, split so every line fits `width`. */
function legendLines(width: number): Array<Array<[word: "act" | "mark" | "fall_back", text: string]>> {
  const act: ["act", string] = ["act", `: ${MEANINGS.act}`];
  const mark: ["mark", string] = ["mark", `: ${MEANINGS.mark}`];
  const fb: ["fall_back", string] = ["fall_back", `: ${MEANINGS.fall_back}`];
  if (width >= 83) return [[act, mark, fb]];
  if (width >= 47) return [[act, mark], [fb]];
  return [[act], [mark], [fb]];
}

const midnight = (now: Date): string => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
const rightOf = (n: number | null, of: number): string => (n === null ? "-" : `${Math.round(n * 100)}% of ${of}`);

export function HomeView(props: {
  lines: LogLine[];
  now: Date;
  version: string;
  width: number;
  /** Rows for this screen, the footer already taken off. */
  height: number;
  /** The terminal's own rows, which decide the block logo. */
  rows?: number;
  active?: boolean;
  /** Asks that arrived in the last few seconds, marked in the feed. */
  fresh?: ReadonlySet<string>;
  /** Questions whose act threshold the tuning rule would lower. */
  worth?: Array<{ jevel: string; question: string }>;
  cursor: number;
  onCursor: (update: (cursor: number) => number) => void;
  onOpen: (target: Target) => void;
  onTry: (jevel: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const minute = Math.floor(props.now.getTime() / 60_000);
  const s = useMemo(() => homeStats(props.lines, props.now), [props.lines, minute]);
  const feed = useMemo(() => rowsOf(props.lines, ALL), [props.lines]);
  const jevelTopRef = useRef(0);
  const wide = props.width >= 100;
  const side = props.width >= 120;
  const big = props.width >= 100 && (props.rows ?? props.height + 1) >= 30;
  const needs: Array<{ text: string; key: string; target: Target; tone: string }> = [];
  if (s.toReview > 0) needs.push({ text: `${plural(s.toReview, "marked decision")} to review`, key: "review", target: { kind: "review" }, tone: theme.mark });
  const worth = props.worth ?? [];
  if (worth.length > 0) {
    const first = worth[0]!;
    needs.push({ text: `${plural(worth.length, "threshold")} worth moving`, key: "tune", target: { kind: "jevel", name: first.jevel, question: first.question }, tone: theme.accent });
  }
  if (s.failedToday.count > 0) {
    needs.push({ text: `${plural(s.failedToday.count, "ask")} failed today (${s.failedToday.topError})`, key: "failed", target: { kind: "history", filters: { failed: true, since: midnight(props.now) } }, tone: theme.error });
  }

  // Rows: the logo, a blank, the Today and Needs you panels, a blank; the rest is the jevels table and the feed.
  const panelWidth = wide ? Math.floor((props.width - 4) / 2) : props.width - 2;
  const inner = panelWidth - 4;
  const legend = legendLines(inner);
  const todayHeight = 3 + legend.length;
  const needsHeight = 1 + Math.max(1, needs.length);
  const topRows = (big ? 5 : 1) + 1 + (wide ? Math.max(todayHeight, needsHeight) : todayHeight + 1 + needsHeight) + 1;
  const rest = Math.max(0, props.height - topRows);
  // The table's title and header, a "more" line, a blank, the feed's title and header, and at least three feed rows.
  const jevelRoom = Math.min(s.jevels.length, Math.max(1, rest - 9));
  const jevelMore = s.jevels.length > jevelRoom ? 1 : 0;
  const feedRoom = Math.max(0, rest - 2 - jevelRoom - jevelMore - 1 - 2);
  const feedShown = Math.min(feedRoom, feed.length);

  const items: Target[] = [
    ...needs.map((n) => n.target),
    ...s.jevels.map((j) => ({ kind: "jevel", name: j.name }) as const),
    ...feed.slice(0, feedShown).map((r) => ({ kind: "decision", id: r.ask.id, question: r.question }) as const),
  ];
  const last = Math.max(items.length - 1, 0);
  const at = Math.min(props.cursor, last);
  const hints: Hint[] = s.empty ? [["enter", "try ticket-triage"], ["t", "try"]] : [["j/k", "move"], ["enter", "open"]];
  useChrome(hints);
  useInput((input, key) => {
    if (s.empty) { if (key.return) props.onTry("ticket-triage"); return; }
    const step = moves(input, key);
    if (step !== 0) props.onCursor((c) => Math.max(0, Math.min(Math.min(c, last) + step, last)));
    else if (key.return && items[at]) props.onOpen(items[at]);
  }, { isActive: props.active ?? true });

  if (s.empty) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" height={props.height}>
        <Logo big={big} version={props.version} center />
        <Box marginTop={2} backgroundColor={theme.panel} paddingX={3} paddingY={1} flexDirection="column" alignItems="center">
          <Text bold color={theme.text}>No decisions yet.</Text>
          <Text>
            <Text color={theme.text}>Try ticket-triage with a sample ticket </Text>
            <Text color={theme.accent} bold>⏎</Text>
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text color={theme.muted}>Every ask from your code or your agent shows up here as it happens.</Text>
          <Text color={theme.muted}>Each one ends in a decision:</Text>
          {WORD_LINES.map(([word, text]) => (
            <Text key={word}><Text color={decisionColor(theme, word)} bold>{word}</Text><Text color={theme.muted}>{text}</Text></Text>
          ))}
        </Box>
      </Box>
    );
  }

  const t = s.today;
  const peakHour = Math.max(0, ...s.hourly);
  const today = (
    <Panel title="Today" note={`${plural(t.decisions, "decision")} · ${plural(t.asks, "ask")} · ${formatCost(t.cost)}`} {...(wide ? {} : { width: panelWidth })}>
      <Text wrap="truncate">
        <MixBar act={t.act} mark={t.mark} fallBack={t.fallBack} width={Math.max(8, inner - 32)} theme={theme} />
        <Text color={theme.act}>{` act ${pct(t.act, t.decisions)}`}</Text>
        <Text color={theme.mark}>{` mark ${pct(t.mark, t.decisions)}`}</Text>
        <Text color={theme.fallBack}>{` fall_back ${pct(t.fallBack, t.decisions)}`}</Text>
      </Text>
      {legend.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line.map(([word, text], j) => (
            <Text key={word}>
              <Text color={theme.muted}>{j > 0 ? " · " : ""}</Text>
              <Text color={decisionColor(theme, word)}>{word}</Text>
              <Text color={theme.muted}>{text}</Text>
            </Text>
          ))}
        </Text>
      ))}
      <Text wrap="truncate">
        <Text color={theme.accent}>{spark(s.hourly, 24)}</Text>
        <Text color={theme.muted}>{`  24h · peak ${peakHour}/h`}</Text>
      </Text>
    </Panel>
  );
  const needsYou = (
    <Panel title="Needs you" {...(wide ? {} : { width: panelWidth })}>
      {needs.length === 0 ? <Text color={theme.muted}>{s.marks === 0 ? "No marked decisions yet." : "Nothing. Every marked decision has an outcome."}</Text> : null}
      {needs.map((n, i) => {
        const selected = i === at;
        return (
          <Text key={n.key} wrap="truncate" {...(selected ? { backgroundColor: theme.element } : {})}>
            <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
            <Text color={n.tone}>● </Text>
            <Text color={theme.text}>{n.text}</Text>
            <Text color={theme.accent}>{selected ? "  ⏎" : ""}</Text>
          </Text>
        );
      })}
    </Panel>
  );

  const firstJevel = needs.length;
  const firstFeed = firstJevel + s.jevels.length;
  // The table keeps its own scroll: it follows the cursor only while the cursor is on a jevel, and stays put when it is in the feed.
  let jevelTop = Math.max(0, Math.min(jevelTopRef.current, s.jevels.length - jevelRoom));
  const onJevel = at - firstJevel;
  if (onJevel >= 0 && onJevel < s.jevels.length) {
    if (onJevel < jevelTop) jevelTop = onJevel;
    else if (onJevel >= jevelTop + jevelRoom) jevelTop = onJevel - jevelRoom + 1;
  }
  jevelTopRef.current = jevelTop;
  const jevelBelow = s.jevels.length - jevelTop - jevelRoom;
  const mainWidth = side ? props.width - 2 - 42 : props.width - 2;
  // The mix column moves into the side column when there is one.
  const mixColumn = wide && !side;
  const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
  const nameWidth = clamp(mainWidth - 4 - 55 - (mixColumn ? 14 : 0), 14, 22);
  const header = `${"jevel".padEnd(nameWidth)} ${"decisions".padStart(9)}  ${"act right".padStart(12)}  ${mixColumn ? `${"mix".padEnd(12)}  ` : ""}last 14 days`;
  const jevels = (
    <Panel title="Jevels" note="how each one decides; enter opens its questions">
      <Text color={theme.muted} wrap="truncate">{`  ${header}`}</Text>
      {s.jevels.slice(jevelTop, jevelTop + jevelRoom).map((j, i) => {
        const selected = firstJevel + jevelTop + i === at;
        const name = j.name.length > nameWidth ? `${j.name.slice(0, nameWidth - 1)}~` : j.name.padEnd(nameWidth);
        return (
          <Text key={j.name} wrap="truncate" {...(selected ? { backgroundColor: theme.element } : {})}>
            <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
            <Text color={theme.text}>{`${name} ${String(j.decisions).padStart(9)}  `}</Text>
            <Text color={j.actOutcomes < 10 ? theme.muted : theme.text}>{rightOf(j.actRight, j.actOutcomes).padStart(12)}</Text>
            <Text>{"  "}</Text>
            {mixColumn ? <Text><MixBar act={j.mix.act} mark={j.mix.mark} fallBack={j.mix.fallBack} width={12} theme={theme} /><Text>{"  "}</Text></Text> : null}
            <Text color={theme.accent}>{spark(j.trend, 14)}</Text>
            <Text color={theme.muted}>{`  peak ${Math.max(0, ...j.trend)}/day`}</Text>
          </Text>
        );
      })}
      {jevelMore ? <Text color={theme.muted}>{`  ${[jevelTop > 0 ? `↑ ${jevelTop} above` : "", jevelBelow > 0 ? `↓ ${jevelBelow} more below` : ""].filter((x) => x !== "").join("   ")}`}</Text> : null}
    </Panel>
  );
  const feedName = clamp(mainWidth - 4 - 58, 10, 18);
  const latest = feedShown === 0 ? null : (
    <Panel title="Latest decisions" note="newest first, live as your code asks">
      <Text color={theme.muted} wrap="truncate">{`  ${"time".padEnd(11)} ${"jevel".padEnd(feedName)} ${"question".padEnd(14)} ${"answer".padEnd(10)} ${"decision".padEnd(9)} outcome`}</Text>
      {feed.slice(0, feedShown).map((r, i) => {
        const selected = firstFeed + i === at;
        const d = recordedDecision(r.answer);
        const fresh = props.fresh?.has(r.ask.id) ?? false;
        return (
          <Text key={`${r.ask.id}\n${r.question}`} wrap="truncate" {...(selected ? { backgroundColor: theme.element } : {})}>
            <Text color={theme.accent}>{selected ? "> " : fresh ? "● " : "  "}</Text>
            <Text color={fresh ? theme.accent : theme.muted}>{`${time(r.ask.at)} `}</Text>
            <Text color={theme.text}>{`${fit(jevelOf(r.ask), feedName)} ${fit(r.question, 14)} ${fit(answerWord(r.answer), 10)} `}</Text>
            <Text color={decisionColor(theme, d)}>{`${d.padEnd(9)} `}</Text>
            <Text color={theme.muted}>{r.outcomes.at(-1)?.outcome ?? "-"}</Text>
          </Text>
        );
      })}
    </Panel>
  );
  const focus = items[at];
  const picked = s.jevels.find((j) => focus && ((focus.kind === "jevel" && focus.name === j.name) || (focus.kind === "decision" && feed.find((r) => r.ask.id === focus.id && jevelOf(r.ask) === j.name)))) ?? s.jevels[0];
  const sideColumn = side && picked ? (
    <Panel title={picked.name} note="per question" width={40}>
      <Text color={theme.muted} wrap="truncate">{`${"question".padEnd(12)} ${"mix".padEnd(10)} act right`}</Text>
      {picked.questions.map((q) => (
        <Text key={q.name} wrap="truncate">
          <Text color={theme.text}>{`${fit(q.name, 12)} `}</Text>
          <MixBar act={q.mix.act} mark={q.mix.mark} fallBack={q.mix.fallBack} width={10} theme={theme} />
          <Text color={q.actOutcomes < 10 ? theme.muted : theme.text}>{` ${rightOf(q.actRight, q.actOutcomes)}`}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text color={theme.muted} wrap="wrap">{`${plural(picked.decisions, "decision")}, ${pct(picked.mix.act, picked.decisions)} act. Enter on the jevel opens all of it.`}</Text>
    </Panel>
  ) : null;
  const lower = (
    <Box flexDirection="column" width={mainWidth}>
      {jevels}
      {latest ? <Text> </Text> : null}
      {latest}
    </Box>
  );
  return (
    <Box flexDirection="column" paddingX={1} height={props.height}>
      <Logo big={big} version={props.version} center={wide} />
      <Text> </Text>
      {wide ? (
        <Box gap={2}>{today}{needsYou}</Box>
      ) : (
        <Box flexDirection="column">{today}<Text> </Text>{needsYou}</Box>
      )}
      <Text> </Text>
      {side ? <Box gap={2}>{lower}{sideColumn}</Box> : lower}
    </Box>
  );
}

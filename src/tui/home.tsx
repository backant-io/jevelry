import { Box, Text, useInput } from "ink";
import type { AskLine, LogLine } from "../log.js";
import { recordedDecision } from "../report.js";
import { mix, spark } from "./charts.js";
import { type Hint, useChrome } from "./dialog.js";
import { type Filters, jevelOf } from "./history.js";
import { type Theme, useTheme } from "./theme.js";

/** Dollars per million input tokens, from https://docs.typesafe.ai/models.md. Output tokens are free. */
export const PRICE_PER_MTOK: Record<string, number> = { "jev-1.13.0": 0.042 };

export interface JevelStats {
  name: string;
  decisions: number;
  /** How often an act decision was right, from the outcomes recorded on acts; null when no act has an outcome. */
  actRight: number | null;
  /** The same for mark decisions. */
  markRight: number | null;
  mix: { act: number; mark: number; fallBack: number };
  /** Decisions per day for the last 14 days, today last. */
  trend: number[];
}

export interface HomeStats {
  today: { asks: number; decisions: number; act: number; mark: number; fallBack: number; cost: number | null };
  /** Decisions per hour for the last 24 hours, the current hour last. */
  hourly: number[];
  /** Marked decisions nobody has recorded an outcome for yet, from the whole log. */
  toReview: number;
  failedToday: { count: number; topError: string | null };
  jevels: JevelStats[];
  empty: boolean;
}

const HOUR = 3_600_000;
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * What the input tokens of these asks cost, or null when an answered ask has no usage or a model without a known price.
 * An ask Jev could not answer was not charged.
 */
export function costOf(asks: AskLine[]): number | null {
  let dollars = 0;
  for (const ask of asks) {
    if (ask.error) continue;
    const price = ask.model === null ? undefined : PRICE_PER_MTOK[ask.model];
    if (!ask.usage || price === undefined) return null;
    dollars += (ask.usage.input_tokens / 1_000_000) * price;
  }
  return dollars;
}

/** Two significant digits for the small sums a day of asks costs: `$0.000017`, `$0.42`. */
export function formatCost(dollars: number | null): string {
  if (dollars === null) return "cost unknown";
  if (dollars === 0) return "$0";
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(Math.min(10, 1 - Math.floor(Math.log10(dollars))))}`;
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
  const byJevel = new Map<string, JevelStats & { acts: number; actsAgreed: number; marks: number; marksAgreed: number }>();
  for (const ask of asks) {
    const name = jevelOf(ask);
    const s = byJevel.get(name) ?? {
      name, decisions: 0, actRight: null, markRight: null, mix: { act: 0, mark: 0, fallBack: 0 }, trend: new Array<number>(14).fill(0), acts: 0, actsAgreed: 0, marks: 0, marksAgreed: 0,
    };
    byJevel.set(name, s);
    const day = Math.round((midnight - startOfDay(new Date(ask.at))) / (24 * HOUR));
    for (const [question, answer] of Object.entries(ask.answers)) {
      s.decisions += 1;
      if (day >= 0 && day < 14) s.trend[13 - day]! += 1;
      const d = recordedDecision(answer);
      const outcome = outcomes.get(`${ask.id}\n${question}`);
      if (d === "mark" && outcome === undefined && !ask.error) toReview += 1;
      if (d === "act") s.mix.act += 1;
      else if (d === "mark") s.mix.mark += 1;
      else s.mix.fallBack += 1;
      if (d === "act" && outcome !== undefined) { s.acts += 1; if (outcome === "agree") s.actsAgreed += 1; }
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
    failedToday: { count: failed.length, topError },
    jevels: [...byJevel.values()]
      .map(({ acts, actsAgreed, marks, marksAgreed, ...s }) => ({ ...s, actRight: acts === 0 ? null : actsAgreed / acts, markRight: marks === 0 ? null : marksAgreed / marks }))
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
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

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

type Target = { kind: "review" } | { kind: "history"; filters: Partial<Filters> } | { kind: "jevel"; name: string };

function Panel(props: { title: string; note?: string; width?: number | string; grow?: boolean; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} {...(props.width !== undefined ? { width: props.width } : {})} {...(props.grow ? { flexGrow: 1 } : {})}>
      <Text wrap="truncate">
        <Text bold color={theme.text}>{props.title}</Text>
        {props.note ? <Text color={theme.muted}>{`  ${props.note}`}</Text> : null}
      </Text>
      {props.children}
    </Box>
  );
}

export function HomeView(props: {
  lines: LogLine[];
  now: Date;
  version: string;
  width: number;
  height: number;
  active?: boolean;
  cursor: number;
  onCursor: (cursor: number) => void;
  onOpen: (target: Target) => void;
  onTry: (jevel: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const s = homeStats(props.lines, props.now);
  const wide = props.width >= 100;
  const big = props.width >= 100 && props.height >= 30;
  const needs: Array<{ text: string; hint: string; target: Target; tone: string }> = [];
  if (s.toReview > 0) needs.push({ text: `${plural(s.toReview, "marked decision")} to review`, hint: "review", target: { kind: "review" }, tone: theme.mark });
  if (s.failedToday.count > 0) {
    needs.push({ text: `${plural(s.failedToday.count, "ask")} failed today, mostly ${s.failedToday.topError}`, hint: "history", target: { kind: "history", filters: { decision: "fall_back" } }, tone: theme.error });
  }
  const items: Target[] = [...needs.map((n) => n.target), ...s.jevels.map((j) => ({ kind: "jevel", name: j.name }) as const)];
  const at = Math.min(props.cursor, Math.max(items.length - 1, 0));
  const hints: Hint[] = s.empty ? [["enter", "try ticket-triage"], ["t", "try"]] : [["j/k", "move"], ["enter", "open"], ["v", "review"], ["y", "history"]];
  useChrome(hints);
  useInput((input, key) => {
    if (s.empty) { if (key.return) props.onTry("ticket-triage"); return; }
    if (key.downArrow || input === "j") props.onCursor(Math.min(at + 1, items.length - 1));
    else if (key.upArrow || input === "k") props.onCursor(Math.max(at - 1, 0));
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
        <Box marginTop={1}>
          <Text color={theme.muted}>Every ask from your code or your agent shows up here as it happens.</Text>
        </Box>
      </Box>
    );
  }

  const inner = wide ? Math.floor((props.width - 2) / 2) - 5 : props.width - 6;
  const barWidth = Math.max(10, inner - 36);
  const t = s.today;
  const today = (
    <Panel title="Today" note={`${plural(t.decisions, "decision")} in ${plural(t.asks, "ask")}   ${t.cost === null ? "" : "cost "}${formatCost(t.cost)}`} grow={wide}>
      <Text wrap="truncate">
        <MixBar act={t.act} mark={t.mark} fallBack={t.fallBack} width={barWidth} theme={theme} />
        <Text color={theme.act}>{` act ${pct(t.act, t.decisions)}`}</Text>
        <Text color={theme.mark}>{` mark ${pct(t.mark, t.decisions)}`}</Text>
        <Text color={theme.fallBack}>{` fall_back ${pct(t.fallBack, t.decisions)}`}</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={theme.accent}>{spark(s.hourly, 24)}</Text>
        <Text color={theme.muted}>  per hour, last 24h</Text>
      </Text>
    </Panel>
  );
  const needsYou = (
    <Panel title="Needs you" grow={wide}>
      {needs.length === 0 ? <Text color={theme.muted}>Nothing. Every marked decision has an outcome.</Text> : null}
      {needs.map((n, i) => {
        const selected = i === at;
        return (
          <Text key={n.hint} wrap="truncate" {...(selected ? { backgroundColor: theme.element } : {})}>
            <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
            <Text color={n.tone}>● </Text>
            <Text color={theme.text}>{n.text}</Text>
            <Text color={theme.accent}>{selected ? "  ⏎" : ""}</Text>
          </Text>
        );
      })}
    </Panel>
  );
  // Logo, a blank line, the two panels, a blank line, the table's title and header; the footer belongs to the shell.
  const used = (big ? 5 : 1) + 1 + (wide ? Math.max(3, needs.length + 1, 1) : 3 + 1 + Math.max(2, needs.length + 1)) + 1 + 2;
  const room = Math.max(1, props.height - used);
  const firstJevel = needs.length;
  const jevelAt = at - firstJevel;
  const top = Math.max(0, Math.min(jevelAt - room + 1, s.jevels.length - room));
  const nameWidth = wide ? 24 : Math.max(14, Math.min(24, props.width - 52));
  const header = `${"jevel".padEnd(nameWidth)} ${"decisions".padStart(9)}  ${"act right".padStart(9)}  ${wide ? `${"mark right".padStart(10)}  ${"mix".padEnd(16)}  ` : ""}last 14 days`;
  const right = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);
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
      <Panel title="Jevels" note="how each one decides; enter opens its questions" grow>
        <Text color={theme.muted} wrap="truncate">{`  ${header}`}</Text>
        {s.jevels.slice(top, top + room).map((j, i) => {
          const selected = firstJevel + top + i === at;
          const name = j.name.length > nameWidth ? `${j.name.slice(0, nameWidth - 1)}~` : j.name.padEnd(nameWidth);
          return (
            <Text key={j.name} wrap="truncate" {...(selected ? { backgroundColor: theme.element } : {})}>
              <Text color={theme.accent}>{selected ? "> " : "  "}</Text>
              <Text color={theme.text}>{`${name} ${String(j.decisions).padStart(9)}  `}</Text>
              <Text color={j.actRight === null ? theme.muted : theme.text}>{right(j.actRight).padStart(9)}</Text>
              <Text>{"  "}</Text>
              {wide ? (
                <Text>
                  <Text color={j.markRight === null ? theme.muted : theme.text}>{right(j.markRight).padStart(10)}</Text>
                  <Text>{"  "}</Text>
                  <MixBar act={j.mix.act} mark={j.mix.mark} fallBack={j.mix.fallBack} width={16} theme={theme} />
                  <Text>{"  "}</Text>
                </Text>
              ) : null}
              <Text color={theme.accent}>{spark(j.trend, 14)}</Text>
            </Text>
          );
        })}
      </Panel>
    </Box>
  );
}

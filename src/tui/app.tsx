import { watch } from "node:fs";
import { homedir } from "node:os";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { listJevels } from "../jevel.js";
import { LOG_FILE, type LogLine, readLog } from "../log.js";
import { ChromeContext, Dialog, type Hint, SelectDialog, type SelectItem, useChrome } from "./dialog.js";
import { ALL, DecisionsView, type Filters, NO_JEVEL, ReportView, jevelNames, rowsOf, thresholdsLookup } from "./history.js";
import { DetailView, ReviewView } from "./review.js";
import { tallies } from "./tuning.js";
import { HomeView } from "./home.js";
import { THEMES, ThemeContext, type ThemeName, loadThemeName, saveThemeName, useTheme } from "./theme.js";

/** The TUI is the one place that imports ink and react: `jevelry tui` loads this file with a dynamic import, so no other command pays for them. */

export type Screen = "home" | "review" | "history" | "try" | "jevel";

const GLOBAL: Hint[] = [["h", "home"], ["v", "review"], ["y", "history"], ["t", "try"], ["ctrl+p", "commands"], ["?", "help"], ["q", "quit"]];

/** A screen the next task builds: its title, what it will be for, and where to go meanwhile. */
function Placeholder(props: { title: string; purpose: string; meanwhile: string; height: number }): React.JSX.Element {
  const theme = useTheme();
  useChrome([]);
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height={props.height}>
      <Box flexDirection="column" backgroundColor={theme.panel} paddingX={3} paddingY={1}>
        <Text bold color={theme.text}>{props.title}</Text>
        <Text color={theme.muted}>{props.purpose}</Text>
        <Text> </Text>
        <Text color={theme.text}>This screen is coming in the next task.</Text>
        <Text color={theme.muted}>{props.meanwhile}</Text>
      </Box>
    </Box>
  );
}

/**
 * Keys on the left; on the right the home directory and version, or for four seconds the toast in their place,
 * so a message never covers what is on the screen.
 */
function Footer(props: { hints: Hint[]; home: string; version: string; width: number; toast: { text: string; error: boolean } | null; extra: Hint[] }): React.JSX.Element {
  const theme = useTheme();
  const right = props.toast ? `┃ ${props.toast.text}` : `${props.home}  v${props.version}`;
  const width = (h: Hint): number => h[0].length + h[1].length + 3;
  // The toast or the home directory keeps its whole length, then "? help" (it lists everything else),
  // then the screen's own keys, then the rest of the shell's keys, as far as they fit.
  let room = props.width - Math.min(right.length, props.width - 4) - 4;
  const help = props.extra.filter(([k]) => k === "?");
  for (const h of help) room -= width(h);
  const shown: Hint[] = [];
  for (const h of [...props.hints, ...props.extra.filter(([k]) => k !== "?")]) {
    if (width(h) > room) break;
    shown.push(h);
    room -= width(h);
  }
  shown.push(...help);
  return (
    <Box width={props.width} paddingX={1} justifyContent="space-between" backgroundColor={theme.panel}>
      <Text wrap="truncate">
        {shown.map(([key, label]) => (
          <Text key={key}>
            <Text color={theme.text} bold>{key}</Text>
            <Text color={theme.muted}>{` ${label}  `}</Text>
          </Text>
        ))}
      </Text>
      {props.toast ? (
        <Text wrap="truncate">
          <Text color={props.toast.error ? theme.error : theme.accent}>┃ </Text>
          <Text color={props.toast.error ? theme.error : theme.text} bold>{props.toast.text}</Text>
        </Text>
      ) : <Text color={theme.muted}>{right}</Text>}
    </Box>
  );
}

/** What the three decisions mean, for someone who has never seen them. */
export const WORDS: Hint[] = [
  ["act", "Jev was sure: your code uses the answer"],
  ["mark", "fairly sure: your code uses it, check it"],
  ["fall_back", "unsure or failed: your code decides"],
];

function HelpDialog(props: { hints: Hint[]; columns: number; rows: number; onClose: () => void }): React.JSX.Element {
  const theme = useTheme();
  useInput((input, key) => { if (key.escape || input === "?" || key.return) props.onClose(); });
  const cell = ([key, label]: Hint): React.JSX.Element => (
    <Text>
      <Text color={theme.text} bold>{key.padEnd(8)}</Text>
      <Text color={theme.muted}>{label.padEnd(16)}</Text>
    </Text>
  );
  // Two keys per line, so the overlay fits an 80x24 terminal.
  const rows = (hints: Hint[]): React.JSX.Element[] =>
    Array.from({ length: Math.ceil(hints.length / 2) }, (_, i) => (
      <Text key={i}>{cell(hints[2 * i]!)}{hints[2 * i + 1] ? cell(hints[2 * i + 1]!) : null}</Text>
    ));
  const own = props.hints.filter(([k]) => !GLOBAL.some(([g]) => g === k));
  // The gutter and the panel's padding (four rows), the title, and the thirteen rows below it besides this screen's keys.
  const height = 18 + Math.max(1, Math.ceil(own.length / 2));
  return (
    <Dialog title="Keys" width={56} columns={props.columns} rows={props.rows} height={height}>
      <Text> </Text>
      <Text color={theme.accent}>This screen</Text>
      {own.length === 0 ? <Text color={theme.muted}>none</Text> : rows(own)}
      <Text> </Text>
      <Text color={theme.accent}>Everywhere</Text>
      {rows(GLOBAL)}
      <Text> </Text>
      <Text color={theme.accent}>What the decisions mean</Text>
      {WORDS.map(([word, meaning]) => (
        <Text key={word} wrap="truncate">
          <Text color={word === "act" ? theme.act : word === "mark" ? theme.mark : theme.fallBack} bold>{word.padEnd(10)}</Text>
          <Text color={theme.text}>{meaning}</Text>
        </Text>
      ))}
    </Dialog>
  );
}

/** The log and how many of its lines could not be read, counted instead of printed. */
async function readCounted(home: string): Promise<{ lines: LogLine[]; skipped: number }> {
  let skipped = 0;
  const lines = await readLog(home, () => { skipped += 1; });
  return { lines, skipped };
}

type Command = { go: Screen } | { jevel: string } | { theme: true } | { help: true } | { quit: true };

export function App(props: {
  home: string;
  dirs: string[];
  lines: LogLine[];
  skipped?: number;
  filters?: Filters;
  screen?: Screen;
  version?: string;
  /** Fixed size for tests; the terminal's own size otherwise. */
  size?: { columns: number; rows: number };
  /** The clock Home counts "today" from; tests pin it. */
  now?: () => Date;
}): React.JSX.Element {
  const { exit } = useApp();
  const window = useWindowSize();
  const columns = props.size?.columns ?? (window.columns || 80);
  const rows = props.size?.rows ?? (window.rows || 24);
  const version = props.version ?? "0.0.0";
  const [lines, setLines] = useState(props.lines);
  const [skipped, setSkipped] = useState(props.skipped ?? 0);
  const [screen, setScreen] = useState<Screen>(props.screen ?? "home");
  const [themeName, setThemeName] = useState<ThemeName>(() => loadThemeName(props.home));
  const [dialog, setDialog] = useState<null | "palette" | "theme" | "help">(null);
  const [hints, setHints] = useState<Hint[]>([]);
  const [capture, setCapture] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [filters, setFilters] = useState<Filters>(props.filters ?? ALL);
  const [historyView, setHistoryView] = useState<"list" | "detail" | "report">("list");
  const [open, setOpen] = useState<{ id: string; question: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  /** A detail opened from Home's feed goes back to Home. */
  const [fromHome, setFromHome] = useState(false);
  /** Filters set by a jump from Home last for that visit only; the next h, y or palette History opens everything. */
  const [jumped, setJumped] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const freshTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  // Jevel names for the palette: read once, then again when a jevels folder changes.
  const [shipped, setShipped] = useState(() => listJevels(props.dirs).map((j) => j.name));
  const [homeCursor, setHomeCursor] = useState(0);
  const [jevel, setJevel] = useState<string | null>(null);
  const [lookup] = useState(() => thresholdsLookup(props.dirs));
  const byQuestion = useMemo(() => tallies(lines), [lines]);
  const toastTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  const say = (text: string, error = false): void => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  };
  const reload = (): void => {
    readCounted(props.home).then(
      (read) => {
        setLines((before) => {
          const seen = new Set(before.filter((l) => l.kind === "ask").map((l) => l.id));
          const arrived = read.lines.filter((l) => l.kind === "ask" && !seen.has(l.id)).map((l) => l.id);
          if (arrived.length > 0) {
            setFresh(new Set(arrived));
            clearTimeout(freshTimer.current);
            freshTimer.current = setTimeout(() => setFresh(new Set()), 5000);
          }
          return read.lines;
        });
        setSkipped(read.skipped);
      },
      (error: unknown) => say(`log could not be read: ${error instanceof Error ? error.message : String(error)}`, true),
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
      // No home directory yet: nothing to watch, the screens stay as read.
    }
    return () => { clearTimeout(timer); clearTimeout(toastTimer.current); clearTimeout(freshTimer.current); watcher?.close(); };
  }, [props.home]);
  useEffect(() => {
    const watchers = props.dirs.flatMap((dir) => {
      try { return [watch(dir, () => setShipped(listJevels(props.dirs).map((j) => j.name)))]; } catch { return []; }
    });
    return () => { for (const w of watchers) w.close(); };
  }, [props.dirs.join("\n")]);

  const go = (next: Screen): void => {
    setScreen(next);
    if (next === "history") {
      setHistoryView("list");
      setFromHome(false);
      if (jumped) { setFilters(ALL); setCursor(0); setJumped(false); }
    }
  };
  const run = (c: Command): void => {
    setDialog(null);
    if ("go" in c) go(c.go);
    else if ("jevel" in c) { setJevel(c.jevel); go("jevel"); }
    else if ("theme" in c) setDialog("theme");
    else if ("help" in c) setDialog("help");
    else exit();
  };
  useInput((input, key) => {
    if (key.ctrl && input === "p") setDialog("palette");
    else if (key.ctrl || key.meta) return;
    else if (input === "?") setDialog("help");
    else if (input === "q") exit();
    else if (input === "h") go("home");
    else if (input === "v") go("review");
    else if (input === "y") go("history");
    else if (input === "t") { setJevel(null); go("try"); }
  }, { isActive: dialog === null && !capture });

  const body = rows - 1;
  const active = dialog === null;
  let content: React.JSX.Element;
  if (screen === "history") {
    const row = open && historyView === "detail" ? rowsOf(lines, ALL).find((r) => r.ask.id === open.id && r.question === open.question) : undefined;
    if (row) {
      content = (
        <DetailView row={row} home={props.home} thresholds={lookup(row)} tallies={byQuestion} height={body} width={columns} active={active}
          onBack={() => (fromHome ? go("home") : setHistoryView("list"))} onRecorded={(message: string) => { say(message); if (fromHome) go("home"); else setHistoryView("list"); reload(); }} />
      );
    } else if (historyView === "report") {
      content = <ReportView lines={lines} filters={filters} height={body} active={active} onFilters={setFilters} onBack={() => setHistoryView("list")} />;
    } else {
      content = (
        <DecisionsView lines={lines} filters={filters} height={body} width={columns} active={active} skipped={skipped} cursor={cursor} onCursor={setCursor}
          onFilters={(f) => { setFilters(f); setCursor(0); }}
          onOpen={(r) => { setOpen({ id: r.ask.id, question: r.question }); setFromHome(false); setHistoryView("detail"); }}
          onReport={() => setHistoryView("report")} onBack={() => go("home")} />
      );
    }
  } else if (screen === "review") {
    content = <ReviewView lines={lines} home={props.home} lookup={lookup} tallies={byQuestion} width={columns} height={body} active={active} onBack={() => go("home")} onRecorded={(message) => { say(message); reload(); }} />;
  } else if (screen === "jevel") {
    content = <Placeholder title={`Jevel ${jevel ?? ""}`.trim()} purpose="How each question of this jevel decides, and whether its thresholds should move." meanwhile="Meanwhile y opens History and J filters it to one jevel." height={body} />;
  } else if (screen === "try") {
    content = <Placeholder title={`Try ${jevel ?? "a jevel"}`} purpose="Ask Jev live with an example state and see how it decides." meanwhile="Meanwhile: npx jevelry ask ticket-triage --state @jevels/ticket-triage/example.json" height={body} />;
  } else {
    content = (
      <HomeView lines={lines} now={(props.now ?? (() => new Date()))()} version={version} width={columns} height={body} rows={rows} fresh={fresh} active={active} cursor={homeCursor} onCursor={setHomeCursor}
        onTry={(name) => { setJevel(name); go("try"); }}
        onOpen={(target) => {
          if (target.kind === "review") go("review");
          else if (target.kind === "jevel") { setJevel(target.name); go("jevel"); }
          else if (target.kind === "decision") { setOpen({ id: target.id, question: target.question }); setFromHome(true); setScreen("history"); setHistoryView("detail"); }
          else { setFilters({ ...ALL, ...target.filters }); setCursor(0); setJumped(true); setScreen("history"); setHistoryView("list"); setFromHome(false); }
        }} />
    );
  }

  // Screens and commands first, so they stay on screen however many jevels follow.
  const palette = (): SelectItem<Command>[] => [
    { label: "Home", value: { go: "home" }, hint: "h" },
    { label: "Review marked decisions", value: { go: "review" }, hint: "v" },
    { label: "History", value: { go: "history" }, hint: "y" },
    { label: "Try a jevel", value: { go: "try" }, hint: "t" },
    { label: "Switch theme", value: { theme: true }, hint: themeName },
    { label: "Help", value: { help: true }, hint: "?" },
    { label: "Quit", value: { quit: true }, hint: "q" },
    ...[...new Set([...shipped, ...jevelNames(lines).filter((n) => n !== NO_JEVEL)])].sort()
      .map((name) => ({ label: `Jevel ${name}`, value: { jevel: name } as Command, hint: "jevel" })),
  ];
  const tilde = props.home.startsWith(homedir()) ? `~${props.home.slice(homedir().length)}` : props.home;
  const home = tilde.length > 24 ? `...${tilde.slice(-21)}` : tilde;
  return (
    <ThemeContext.Provider value={THEMES[themeName]}>
      <ChromeContext.Provider value={{ setHints, setCapture }}>
        <Root columns={columns} rows={rows}>
          <Box height={body} flexDirection="column" overflow="hidden">{content}</Box>
          <Footer
            hints={dialog === null ? hints : []}
            extra={dialog === "help" ? [["esc", "close"]] : dialog !== null ? [["↑↓", "move"], ["enter", "choose"], ["esc", "close"]] : capture ? [] : [["ctrl+p", "commands"], ["?", "help"]]}
            home={home} version={version} width={columns} toast={toast} />
          {dialog === "palette" ? <SelectDialog title="Commands" items={palette()} columns={columns} rows={rows} onSelect={run} onClose={() => setDialog(null)} /> : null}
          {dialog === "theme" ? (
            <SelectDialog<ThemeName>
              title="Theme"
              items={(["dark", "light"] as const).map((n) => ({ label: n, value: n, hint: n === themeName ? "current" : "" }))}
              columns={columns}
              rows={rows}
              onClose={() => setDialog(null)}
              onSelect={(n) => {
                setDialog(null);
                setThemeName(n);
                try { saveThemeName(props.home, n); say(`Saved: ${n} theme`); } catch (e) { say(`theme not saved: ${e instanceof Error ? e.message : String(e)}`, true); }
              }}
            />
          ) : null}
          {dialog === "help" ? <HelpDialog hints={hints} columns={columns} rows={rows} onClose={() => setDialog(null)} /> : null}
        </Root>
      </ChromeContext.Provider>
    </ThemeContext.Provider>
  );
}

/** The whole terminal, painted in the theme's background. */
function Root(props: { columns: number; rows: number; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return <Box width={props.columns} height={props.rows} flexDirection="column" backgroundColor={theme.background}>{props.children}</Box>;
}

export async function runTui(input: { home: string; dirs: string[]; version: string; jevel?: string; since?: string }): Promise<void> {
  const { lines, skipped } = await readCounted(input.home);
  const filtered = input.jevel !== undefined || input.since !== undefined;
  const filters: Filters = { ...ALL, jevel: input.jevel ?? null, since: input.since ?? null };
  const app = render(
    <App home={input.home} dirs={input.dirs} lines={lines} skipped={skipped} filters={filters} version={input.version} screen={filtered ? "history" : "home"} />,
    { alternateScreen: true },
  );
  await app.waitUntilExit();
}

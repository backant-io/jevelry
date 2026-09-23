import { watch } from "node:fs";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { homedir } from "node:os";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { dirname, join } from "node:path";
import { mergeThresholds } from "../decision.js";
import { type Jevel, listJevels, loadJevel } from "../jevel.js";
import { LOG_FILE, type LogLine, readLog } from "../log.js";
import { ChromeContext, Dialog, type Hint, SelectDialog, type SelectItem, newKeyMemory, useChrome } from "./dialog.js";
import { ALL, DecisionsView, type Filters, NO_JEVEL, ReportView, jevelNames, rowsOf, thresholdsLookup } from "./history.js";
import { JevelView, TuneDialog, type QuestionView, questionViews, tunePlan } from "./jevel-screen.js";
import { DetailView, ReviewView } from "./review.js";
import { type Place, placeOf, proposeAct, tallies } from "./tuning.js";
import { HomeView, StartView } from "./home.js";
import { TryView } from "./try.js";
import { MEANINGS, THEMES, ThemeContext, type ThemeName, loadThemeName, saveThemeName, useTheme } from "./theme.js";

/** The TUI is the one place that imports ink and react: `jevelry tui` loads this file with a dynamic import, so no other command pays for them. */

export type Screen = "start" | "dashboard" | "review" | "history" | "try" | "jevel";

const GLOBAL: Hint[] = [["h", "start"], ["d", "dashboard"], ["v", "review"], ["y", "history"], ["t", "try"], ["ctrl+p", "commands"], ["?", "help"], ["q", "quit"]];

/**
 * Keys on the left; on the right the home directory and version, or for four seconds the toast in their place,
 * so a message never covers what is on the screen.
 */
function Footer(props: { hints: Hint[]; home: string; version: string; width: number; toast: { text: string; error: boolean } | null; extra: Hint[] }): React.JSX.Element {
  const theme = useTheme();
  // Below 100 columns the home directory goes, so the screen's keys keep their room; the version stays.
  const right = props.toast ? `┃ ${props.toast.text}` : props.width < 100 ? `v${props.version}` : `${props.home}  v${props.version}`;
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
export const WORDS: Hint[] = (["act", "mark", "fall_back"] as const).map((d) => [d, MEANINGS[d]]);

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

type Command = { go: Screen } | { jevel: string } | { pick: true } | { theme: true } | { help: true } | { quit: true };

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
  /** The clock the start screen and the dashboard count "today" from; tests pin it. */
  now?: () => Date;
  /** Where a jevel is copied to be tuned; `./jevels` by default. */
  project?: string;
  /** The jevel the Jevel screen, or Try, opens on. */
  jevel?: string;
  /** Where the shipped jevels are; tests point it at a copy. */
  shipped?: string;
  /** What Try asks Jev through; tests pass one that talks to a local server. */
  client?: TypeSafeClient;
}): React.JSX.Element {
  const { exit } = useApp();
  const window = useWindowSize();
  const columns = props.size?.columns ?? (window.columns || 80);
  const rows = props.size?.rows ?? (window.rows || 24);
  const version = props.version ?? "0.0.0";
  const [lines, setLines] = useState(props.lines);
  const [skipped, setSkipped] = useState(props.skipped ?? 0);
  const [screen, setScreen] = useState<Screen>(props.screen ?? "start");
  const [themeName, setThemeName] = useState<ThemeName>(() => loadThemeName(props.home));
  const [dialog, setDialog] = useState<null | "palette" | "theme" | "help" | "tune" | "pick" | "quit">(null);
  /** The jevel Try asks, and the state text left in Try per jevel, kept while jevelry runs. */
  const [tryName, setTryName] = useState<string | null>(props.screen === "try" ? props.jevel ?? null : null);
  const drafts = useRef(new Map<string, { text: string; edited: boolean }>()).current;
  /** q asks first when an edit in Try would be lost. */
  const quit = (): void => { if ([...drafts.values()].some((d) => d.edited)) setDialog("quit"); else exit(); };
  const [hints, setHints] = useState<Hint[]>([]);
  const [capture, setCaptureState] = useState(false);
  const captureRef = useRef(false);
  const setCapture = (on: boolean): void => { captureRef.current = on; setCaptureState(on); };
  const captureNow = (on: boolean): void => { captureRef.current = on; };
  const keys = useRef(newKeyMemory()).current;
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [filters, setFilters] = useState<Filters>(props.filters ?? ALL);
  const [historyView, setHistoryView] = useState<"list" | "detail" | "report">("list");
  const [open, setOpen] = useState<{ id: string; question: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  /** A detail opened from the dashboard's feed goes back to the dashboard. */
  const [fromHome, setFromHome] = useState(false);
  /** Filters set by a jump from the dashboard last for that visit only; the next y or palette History opens everything. */
  const [jumped, setJumped] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const freshTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  // Jevel names for the palette: read once, then again when a jevels folder changes.
  const [shipped, setShipped] = useState(() => listJevels(props.dirs).map((j) => j.name));
  const [homeCursor, setHomeCursor] = useState(0);
  const [startCursor, setStartCursor] = useState(0);
  const [jevel, setJevel] = useState<string | null>(props.jevel ?? null);
  /** Raised when a jevel file may have changed (a folder changed, a threshold was set), so every file is read again. */
  const [rev, setRev] = useState(0);
  const lookup = useMemo(() => thresholdsLookup(props.dirs), [rev]);
  const loaded = useMemo(() => {
    const cache = new Map<string, Jevel | null>();
    return (name: string): Jevel | null => {
      if (!cache.has(name)) { try { cache.set(name, loadJevel(name, props.dirs).jevel); } catch { cache.set(name, null); } }
      return cache.get(name)!;
    };
  }, [rev]);
  const byQuestion = useMemo(() => tallies(lines), [lines]);
  // Every question whose act threshold could come down, for the dashboard's "Needs you".
  const worth = useMemo(() => [...byQuestion.values()].filter((t) => {
    const j = loaded(t.jevel);
    const q = j && Object.hasOwn(j.questions, t.question) ? j.questions[t.question]! : null;
    return j !== null && q !== null && proposeAct(t, mergeThresholds(j.thresholds, q.thresholds)) !== null;
  }).map((t) => ({ jevel: t.jevel, question: t.question })), [byQuestion, loaded]);
  const [tuning, setTuning] = useState<QuestionView | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [jevelFocus, setJevelFocus] = useState<string | undefined>(undefined);
  const project = props.project ?? join(process.cwd(), "jevels");
  /** Where esc from History goes: the start screen, or the Jevel screen that opened it. */
  const [historyBack, setHistoryBack] = useState<Screen>("start");
  // The project's jevels folder sits in the directory jevelry runs from.
  const place = (j: Jevel): Place => placeOf(j.path, { home: props.home, cwd: dirname(project), ...(props.shipped ? { shipped: props.shipped } : {}) });
  const tuneKeys: Hint[] = dialog !== "tune" || tuning === null || jevel === null || loaded(jevel) === null ? []
    : ((plan) => (plan.blocked !== null ? [["esc", "close"]] : [["enter", plan.copy ? "copy and set" : "set it"], ["esc", "cancel"]]))(tunePlan(loaded(jevel)!, place(loaded(jevel)!), tuning, project));
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
      try { return [watch(dir, () => { setShipped(listJevels(props.dirs).map((j) => j.name)); setRev((r) => r + 1); })]; } catch { return []; }
    });
    return () => { for (const w of watchers) w.close(); };
  }, [props.dirs.join("\n")]);

  const go = (next: Screen): void => {
    setScreen(next);
    if (next === "history") {
      setHistoryView("list");
      setFromHome(false);
      setHistoryBack("start");
      if (jumped) { setFilters(ALL); setCursor(0); setJumped(false); }
    }
  };
  const openTry = (name: string): void => { setTryName(name); go("try"); };
  const run = (c: Command): void => {
    setDialog(null);
    if ("go" in c) go(c.go);
    else if ("jevel" in c) { setJevel(c.jevel); setJevelFocus(undefined); go("jevel"); }
    else if ("theme" in c) setDialog("theme");
    else if ("help" in c) setDialog("help");
    else if ("pick" in c) setDialog("pick");
    else quit();
  };
  useInput((input, key) => {
    // ctrl+p is never text, so it opens the palette even while a screen takes typed text.
    if (key.ctrl && input === "p") { setDialog("palette"); return; }
    // Typed text belongs to the screen (the ref is set the moment a screen starts taking it).
    if (captureRef.current) return;
    if (key.ctrl || key.meta) return;
    // A chunk of several keys (a paste, a burst) belongs to the screen.
    else if (input.length > 1) return;
    else if (input === "?") setDialog("help");
    else if (input === "q") quit();
    else if (input === "h") go("start");
    else if (input === "d") go("dashboard");
    else if (input === "v") go("review");
    else if (input === "y") go("history");
    // On an empty log the start screen's first row is ticket-triage with its sample ticket, and t is that row's key.
    else if (input === "t" && screen === "start" && !lines.some((l) => l.kind === "ask")) openTry("ticket-triage");
    else if (input === "t") setDialog("pick");
  }, { isActive: dialog === null });

  const body = rows - 1;
  const active = dialog === null;
  let content: React.JSX.Element;
  if (screen === "history") {
    const row = open && historyView === "detail" ? rowsOf(lines, ALL).find((r) => r.ask.id === open.id && r.question === open.question) : undefined;
    if (row) {
      content = (
        <DetailView row={row} home={props.home} thresholds={lookup(row)} tallies={byQuestion} height={body} width={columns} active={active}
          onBack={() => (fromHome ? go("dashboard") : setHistoryView("list"))} onRecorded={(message: string) => { say(message); if (fromHome) go("dashboard"); else setHistoryView("list"); reload(); }} />
      );
    } else if (historyView === "report") {
      content = <ReportView lines={lines} filters={filters} height={body} active={active} onFilters={setFilters} onBack={() => setHistoryView("list")} />;
    } else {
      content = (
        <DecisionsView lines={lines} filters={filters} height={body} width={columns} active={active} skipped={skipped} cursor={cursor} onCursor={setCursor}
          onFilters={(f) => { setFilters(f); setCursor(0); }}
          onOpen={(r) => { setOpen({ id: r.ask.id, question: r.question }); setFromHome(false); setHistoryView("detail"); }}
          onReport={() => setHistoryView("report")} onBack={() => go(historyBack)} />
      );
    }
  } else if (screen === "review") {
    content = <ReviewView lines={lines} home={props.home} lookup={lookup} tallies={byQuestion} width={columns} height={body} active={active} onBack={() => go("start")} onRecorded={(message) => { say(message); reload(); }} />;
  } else if (screen === "jevel" && jevel !== null) {
    const file = loaded(jevel);
    content = (
      <JevelView key={`${jevel}\n${jevelFocus ?? ""}`} name={jevel} {...(jevelFocus ? { focus: jevelFocus } : {})} jevel={file} place={file ? place(file) : null} views={questionViews(file, jevel, byQuestion)} width={columns} height={body} active={active && !quiet}
        onBack={() => go("start")}
        onTune={(view) => { setTuning(view); setDialog("tune"); }}
        onOpen={(question) => {
          setFilters({ ...ALL, jevel, question }); setCursor(0); setJumped(true);
          setScreen("history"); setHistoryView("list"); setFromHome(false); setHistoryBack("jevel");
        }} />
    );
  } else if (screen === "try" && tryName !== null) {
    content = (
      <TryView key={tryName} name={tryName} dirs={props.dirs} home={props.home} {...(props.client ? { client: props.client } : {})} {...(drafts.has(tryName) ? { draft: drafts.get(tryName)!.text } : {})}
        onDraft={(text, edited) => drafts.set(tryName, { text, edited })}
        width={columns} height={body} active={active} onPick={() => setDialog("pick")} onBack={() => go("start")} onAsked={reload} />
    );
  } else if (screen === "dashboard") {
    content = (
      <HomeView lines={lines} worth={worth} now={(props.now ?? (() => new Date()))()} width={columns} height={body} fresh={fresh} active={active} cursor={homeCursor} onCursor={setHomeCursor}
        onTry={openTry} onBack={() => go("start")}
        onOpen={(target) => {
          if (target.kind === "review") go("review");
          else if (target.kind === "jevel") { setJevel(target.name); setJevelFocus(target.question); go("jevel"); }
          else if (target.kind === "decision") { setOpen({ id: target.id, question: target.question }); setFromHome(true); setScreen("history"); setHistoryView("detail"); }
          else { setFilters({ ...ALL, ...target.filters }); setCursor(0); setJumped(true); setScreen("history"); setHistoryView("list"); setFromHome(false); }
        }} />
    );
  } else {
    content = (
      <StartView lines={lines} now={(props.now ?? (() => new Date()))()} version={version} width={columns} height={body} active={active} cursor={startCursor} onCursor={setStartCursor}
        onTry={openTry} onPick={() => setDialog("pick")} onGo={go} />
    );
  }

  // Screens and commands first, so they stay on screen however many jevels follow.
  const palette = (): SelectItem<Command>[] => [
    { label: "Start screen", value: { go: "start" }, hint: "h" },
    { label: "Dashboard", value: { go: "dashboard" }, hint: "d" },
    { label: "Review marked decisions", value: { go: "review" }, hint: "v" },
    { label: "History", value: { go: "history" }, hint: "y" },
    { label: "Try a jevel", value: { pick: true }, hint: "t" },
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
      <ChromeContext.Provider value={{ setHints, setCapture, captureNow, keys }}>
        <Root columns={columns} rows={rows}>
          <Box height={body} flexDirection="column" overflow="hidden">{content}</Box>
          <Footer
            hints={dialog === null ? hints : []}
            extra={dialog === "help" ? [["esc", "close"]] : dialog === "tune" ? tuneKeys : dialog === "quit" ? [["enter", "quit"], ["esc", "stay"]] : dialog !== null ? [["↑↓", "move"], ["enter", "choose"], ["esc", "close"]] : capture ? [] : [["ctrl+p", "commands"], ["?", "help"]]}
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
          {dialog === "tune" && tuning && jevel && loaded(jevel) ? (
            <TuneDialog jevel={loaded(jevel)!} place={place(loaded(jevel)!)} view={tuning} project={project} columns={columns} rows={rows}
              onClose={() => setDialog(null)} onQuit={exit}
              onDone={(message, error) => {
                setDialog(null); say(message, error); setRev((r) => r + 1);
                // A second enter from the same press must not fall through to the Jevel screen.
                setQuiet(true); setTimeout(() => setQuiet(false), 300);
              }} />
          ) : null}
          {dialog === "pick" ? (
            <SelectDialog title="Try a jevel" items={shipped.map((name) => ({ label: name, value: name, hint: questionCount(loaded(name)) }))} columns={columns} rows={rows}
              onClose={() => setDialog(null)} onSelect={(name) => { setDialog(null); setTryName(name); go("try"); }} />
          ) : null}
          {dialog === "quit" ? <QuitDialog columns={columns} rows={rows} onQuit={exit} onStay={() => setDialog(null)} /> : null}
          {dialog === "help" ? <HelpDialog hints={hints} columns={columns} rows={rows} onClose={() => setDialog(null)} /> : null}
        </Root>
      </ChromeContext.Provider>
    </ThemeContext.Provider>
  );
}

const questionCount = (j: Jevel | null): string => (j === null ? "" : `${Object.keys(j.questions).length} question${Object.keys(j.questions).length === 1 ? "" : "s"}`);

/** An edit in Try lives only while jevelry runs, so q asks before it goes. */
function QuitDialog(props: { columns: number; rows: number; onQuit: () => void; onStay: () => void }): React.JSX.Element {
  const theme = useTheme();
  useInput((input, key) => { if (key.return || input === "q" || input === "y") props.onQuit(); else if (key.escape || input === "n") props.onStay(); });
  return (
    <Dialog title="Quit jevelry?" width={56} columns={props.columns} rows={props.rows} height={9}>
      <Text> </Text>
      <Text color={theme.text}>The state you edited in Try is kept only while jevelry runs.</Text>
      <Text> </Text>
      <Text><Text color={theme.accent} bold>enter</Text><Text color={theme.text}> quit   </Text><Text color={theme.accent} bold>esc</Text><Text color={theme.text}> stay</Text></Text>
    </Dialog>
  );
}

/** The whole terminal, painted in the theme's background. */
function Root(props: { columns: number; rows: number; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return <Box width={props.columns} height={props.rows} flexDirection="column" backgroundColor={theme.background}>{props.children}</Box>;
}

export async function runTui(input: { home: string; dirs: string[]; version: string; jevel?: string; since?: string; dashboard?: boolean }): Promise<void> {
  const { lines, skipped } = await readCounted(input.home);
  const filtered = input.jevel !== undefined || input.since !== undefined;
  const filters: Filters = { ...ALL, jevel: input.jevel ?? null, since: input.since ?? null };
  const app = render(
    <App home={input.home} dirs={input.dirs} lines={lines} skipped={skipped} filters={filters} version={input.version} screen={filtered ? "history" : input.dashboard ? "dashboard" : "start"} />,
    { alternateScreen: true },
  );
  await app.waitUntilExit();
  // An ask still in flight (Try, then q) holds its socket open until the client's timeout. Once the screen is gone,
  // give a log write in progress a moment, then end: the timer is unref'd, so a quiet event loop ends sooner on its own.
  setTimeout(() => process.exit(0), 200).unref();
}

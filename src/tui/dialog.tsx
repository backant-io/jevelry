import { Box, Text, useInput } from "ink";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { useTheme } from "./theme.js";

/** A key and what it does, as the footer and the help overlay show it. */
export type Hint = [key: string, label: string];

export type KeyMemory = { last: { key: string; at: number }; verdict: { key: string; at: number } };
export function newKeyMemory(): KeyMemory { return { last: { key: "", at: 0 }, verdict: { key: "", at: 0 } }; }

/** How a screen tells the app shell which keys it offers and whether it is taking typed text (then the global keys stay off). */
export const ChromeContext = createContext<{
  setHints: (hints: Hint[]) => void;
  setCapture: (capture: boolean) => void;
  /** The same, at once: a key that arrives before the next render must already be text, not a shell key. */
  captureNow: (capture: boolean) => void;
  /** The last key a card saw and the last verdict key that counted, kept by the shell so a held key stays held across cards. */
  keys: KeyMemory;
}>({
  setHints: () => undefined,
  setCapture: () => undefined,
  captureNow: () => undefined,
  keys: newKeyMemory(),
});

export function useChrome(hints: Hint[], capture = false): void {
  const chrome = useContext(ChromeContext);
  const key = JSON.stringify(hints);
  useEffect(() => { chrome.setHints(hints); }, [key]);
  useEffect(() => { chrome.setCapture(capture); return () => chrome.setCapture(false); }, [capture]);
}

/**
 * How far a key press moves a cursor: arrows one step, and every `j` or `k` in the input one step each,
 * because a held key or a slow terminal can deliver "jjjj" as one chunk.
 */
export function moves(input: string, key: { downArrow: boolean; upArrow: boolean }): number {
  if (key.downArrow) return 1;
  if (key.upArrow) return -1;
  if (!/^[jk]+$/.test(input)) return 0;
  return [...input].reduce((n, c) => n + (c === "j" ? 1 : -1), 0);
}

export interface SelectItem<V> {
  label: string;
  value: V;
  /** Right-aligned in the row: a key, a count, what the item opens. */
  hint?: string;
}

/**
 * Where `query` appears in `label` as a subsequence, ignoring case, with a lower score for a tighter, earlier match.
 * null when it does not appear.
 */
export function fuzzyScore(label: string, query: string): number | null {
  const l = label.toLowerCase();
  let at = -1;
  let first = -1;
  for (const ch of query.toLowerCase()) {
    at = l.indexOf(ch, at + 1);
    if (at === -1) return null;
    if (first === -1) first = at;
  }
  return first === -1 ? 0 : first + (at - first);
}

export function fuzzyFilter<V>(items: SelectItem<V>[], query: string): SelectItem<V>[] {
  if (query === "") return items;
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(item.label, query) }))
    .filter((x): x is { item: SelectItem<V>; index: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.item);
}

/**
 * A panel drawn over the screen: centred, a quarter down, on the panel tone, with the title left and esc right.
 * A backdrop in the background tone covers everything above the footer, so no screen shows through beside it.
 */
export function Dialog(props: { title: string; width: number; columns: number; rows: number; height?: number; children: ReactNode }): React.JSX.Element {
  const theme = useTheme();
  const width = Math.min(props.width, props.columns - 4);
  // A quarter down, or higher when the dialog (with its gutter) would otherwise run into the footer.
  const top = Math.max(0, Math.min(Math.floor(props.rows / 4) - 1, props.rows - 1 - (props.height ?? 0)));
  // The footer stays in sight: it lists the dialog's keys.
  return (
    <Box position="absolute" top={0} left={0} width={props.columns} height={Math.max(0, props.rows - 1)} flexDirection="column" alignItems="center" paddingTop={top + 1} backgroundColor={theme.background}>
      <Box width={width} flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>{props.title}</Text>
          <Text color={theme.muted}>esc</Text>
        </Box>
        {props.children}
      </Box>
    </Box>
  );
}

/** The one list picker: the command palette, the jevel picker and the theme picker all use it. */
export function SelectDialog<V>(props: {
  title: string;
  items: SelectItem<V>[];
  columns: number;
  rows: number;
  onSelect: (value: V) => void;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const shown = fuzzyFilter(props.items, query);
  const cursor = Math.min(at, Math.max(shown.length - 1, 0));
  // Gutter, padding, title, the search line with its margins and the "more" line take ten rows; the rest is the list.
  const visible = Math.max(3, Math.min(shown.length, props.rows - 12));
  const top = Math.max(0, Math.min(cursor - visible + 1, shown.length - visible));
  const below = Math.max(0, shown.length - top - visible);
  useInput((input, key) => {
    if (key.escape) props.onClose();
    else if (key.return) { const item = shown[cursor]; if (item) props.onSelect(item.value); }
    else if (key.downArrow || (key.ctrl && input === "n")) setAt((a) => Math.min(Math.min(a, shown.length - 1) + 1, shown.length - 1));
    else if (key.upArrow || (key.ctrl && input === "p")) setAt((a) => Math.max(Math.min(a, shown.length - 1) - 1, 0));
    else if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setAt(0); }
    else if (!key.ctrl && !key.meta && input !== "" && !/[\u0000-\u001f]/.test(input)) { setQuery((q) => q + input); setAt(0); }
  });
  const width = Math.min(60, props.columns - 4);
  const inner = width - 4;
  return (
    <Dialog title={props.title} width={width} columns={props.columns} rows={props.rows} height={10 + visible}>
      <Box marginY={1}>
        <Text color={query === "" ? theme.muted : theme.text}>{query === "" ? "Type to search" : query}</Text>
        <Text color={theme.accent}>▏</Text>
      </Box>
      {shown.length === 0 ? <Text color={theme.muted}>No results</Text> : null}
      {shown.slice(top, top + visible).map((item, i) => {
        const active = top + i === cursor;
        const hint = item.hint ?? "";
        const label = item.label.length > inner - hint.length - 3 ? `${item.label.slice(0, inner - hint.length - 4)}~` : item.label;
        // The row's Box sets the background: a nested Text takes the nearest Box's background, never its parent Text's.
        return (
          <Box key={`${i}:${item.label}`} backgroundColor={active ? theme.accent : theme.panel}>
            <Text bold={active}>
              <Text color={active ? theme.background : theme.text}>{`${active ? "> " : "  "}${label.padEnd(inner - hint.length - 3)}`}</Text>
              <Text color={active ? theme.background : theme.muted}>{`${hint} `}</Text>
            </Text>
          </Box>
        );
      })}
      <Text color={theme.muted}>{below > 0 ? ` ↓ ${below} more` : top > 0 ? ` ↑ ${top} above` : " "}</Text>
    </Dialog>
  );
}

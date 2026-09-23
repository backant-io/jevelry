import { Box, Text, useInput } from "ink";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { useTheme } from "./theme.js";

/** A key and what it does, as the footer and the help overlay show it. */
export type Hint = [key: string, label: string];

/** How a screen tells the app shell which keys it offers and whether it is taking typed text (then the global keys stay off). */
export const ChromeContext = createContext<{ setHints: (hints: Hint[]) => void; setCapture: (capture: boolean) => void }>({
  setHints: () => undefined,
  setCapture: () => undefined,
});

export function useChrome(hints: Hint[], capture = false): void {
  const chrome = useContext(ChromeContext);
  const key = JSON.stringify(hints);
  useEffect(() => { chrome.setHints(hints); }, [key]);
  useEffect(() => { chrome.setCapture(capture); return () => chrome.setCapture(false); }, [capture]);
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

/** A panel drawn over the screen: centred, a quarter down, on the panel tone, with the title left and esc right. */
export function Dialog(props: { title: string; width: number; columns: number; rows: number; children: ReactNode }): React.JSX.Element {
  const theme = useTheme();
  const width = Math.min(props.width, props.columns - 4);
  // A gutter in the background tone around the panel, so the screen underneath stops short of the dialog's edge.
  return (
    <Box position="absolute" top={Math.max(0, Math.floor(props.rows / 4) - 1)} left={Math.max(0, Math.floor((props.columns - width) / 2) - 2)} flexDirection="column" backgroundColor={theme.background} paddingX={2} paddingY={1}>
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
  const visible = Math.max(3, Math.min(shown.length, props.rows - Math.floor(props.rows / 4) - 9));
  const top = Math.max(0, Math.min(cursor - visible + 1, shown.length - visible));
  useInput((input, key) => {
    if (key.escape) props.onClose();
    else if (key.return) { const item = shown[cursor]; if (item) props.onSelect(item.value); }
    else if (key.downArrow || (key.ctrl && input === "n")) setAt(Math.min(cursor + 1, shown.length - 1));
    else if (key.upArrow || (key.ctrl && input === "p")) setAt(Math.max(cursor - 1, 0));
    else if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setAt(0); }
    else if (!key.ctrl && !key.meta && input !== "" && !/[\u0000-\u001f]/.test(input)) { setQuery((q) => q + input); setAt(0); }
  });
  const width = Math.min(60, props.columns - 4);
  const inner = width - 4;
  return (
    <Dialog title={props.title} width={width} columns={props.columns} rows={props.rows}>
      <Box marginY={1}>
        <Text color={query === "" ? theme.muted : theme.text}>{query === "" ? "Type to search" : query}</Text>
        <Text color={theme.accent}>▏</Text>
      </Box>
      {shown.length === 0 ? <Text color={theme.muted}>No results</Text> : null}
      {shown.slice(top, top + visible).map((item, i) => {
        const active = top + i === cursor;
        const hint = item.hint ?? "";
        const label = item.label.length > inner - hint.length - 2 ? `${item.label.slice(0, inner - hint.length - 3)}~` : item.label;
        return (
          <Text key={`${i}:${item.label}`} backgroundColor={active ? theme.accent : theme.panel} bold={active}>
            <Text color={active ? theme.background : theme.text}>{` ${label.padEnd(inner - hint.length - 2)}`}</Text>
            <Text color={active ? theme.background : theme.muted}>{`${hint} `}</Text>
          </Text>
        );
      })}
    </Dialog>
  );
}

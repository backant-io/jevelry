/** Hand-drawn charts: each returns a plain string of block glyphs, and the screen colours it with theme tokens. */

const SPARK = "▁▂▃▄▅▆▇█";
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * One glyph per value, exactly `width` glyphs: more values are summed into `width` buckets, fewer are padded with spaces on the right.
 * Zero (and anything not a positive number) is `▁`, anything above zero at least `▂`, so an hour with one decision is never lost.
 */
export function spark(values: number[], width: number): string {
  if (!(width > 0)) return "";
  let v = values.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  if (v.length > width && width > 0) {
    v = Array.from({ length: width }, (_, i) => {
      const from = Math.floor((i * values.length) / width);
      const to = Math.floor(((i + 1) * values.length) / width);
      return v.slice(from, to).reduce((a, b) => a + b, 0);
    });
  }
  const max = Math.max(0, ...v);
  return v.map((x) => (x <= 0 || max === 0 ? SPARK[0] : SPARK[1 + Math.round((x / max) * 6)])).join("").padEnd(width);
}

/** A horizontal bar `width` cells long, filled to `fraction` with eighth-block precision and padded with spaces. */
export function bar(fraction: number, width: number): string {
  if (!(width > 0)) return "";
  const f = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;
  const eighths = Math.round(f * width * 8);
  const full = Math.floor(eighths / 8);
  const text = "█".repeat(full) + EIGHTHS[eighths % 8];
  return text.padEnd(width);
}

/** Cells per count, summing to `width` (largest remainder), and at least one cell for any count above zero while the width allows. */
function split(counts: number[], width: number): number[] {
  counts = counts.map((c) => (Number.isFinite(c) && c > 0 ? c : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c / total) * width);
  const cells = exact.map(Math.floor);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  const left = width - cells.reduce((a, b) => a + b, 0);
  for (let k = 0; k < left; k++) cells[order[k % order.length]![1]]! += 1;
  for (let i = 0; i < cells.length; i++) {
    if (counts[i]! > 0 && cells[i] === 0) {
      const donor = cells.indexOf(Math.max(...cells));
      if (cells[donor]! > 1) { cells[donor]! -= 1; cells[i] = 1; }
    }
  }
  return cells;
}

/** The decision mix as one stacked bar: `█` act, `▓` mark, `░` fall_back, so the shape reads without colour too. Empty when there are no decisions. */
export function mix(act: number, mark: number, fallBack: number, width: number): string {
  if (!(width > 0)) return "";
  const [a, m, f] = split([act, mark, fallBack], width) as [number, number, number];
  return "█".repeat(a) + "▓".repeat(m) + "░".repeat(f);
}

/**
 * Certainties from 0 to 1 counted into `width` columns and drawn as one row of spark glyphs, an empty column as `·`
 * so "none" never looks like "a few", then a second row with `│` under each threshold in `marks`. Two lines joined by a newline.
 */
export function histogram(certainties: number[], width: number, marks: number[]): string {
  if (!(width > 0)) return "\n";
  const counts = new Array<number>(width).fill(0);
  const column = (c: number): number => Math.min(width - 1, Math.max(0, Math.floor(c * width)));
  for (const c of certainties) if (Number.isFinite(c)) counts[column(c)]! += 1;
  const under = new Array<string>(width).fill(" ");
  for (const m of marks) if (Number.isFinite(m)) under[column(m)] = "│";
  const bars = [...spark(counts, width)].map((g, i) => (counts[i] === 0 ? "·" : g)).join("");
  return `${bars}\n${under.join("").trimEnd()}`;
}

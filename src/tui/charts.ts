/** Hand-drawn charts: each returns a plain string of block glyphs, and the screen colours it with theme tokens. */

const SPARK = "▁▂▃▄▅▆▇█";
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** One glyph per value; more values than `width` are summed into `width` buckets. Zero is `▁`, anything above zero at least `▂`, so an hour with one decision is never lost. */
export function spark(values: number[], width: number): string {
  let v = values;
  if (v.length > width && width > 0) {
    v = Array.from({ length: width }, (_, i) => {
      const from = Math.floor((i * values.length) / width);
      const to = Math.floor(((i + 1) * values.length) / width);
      return values.slice(from, to).reduce((a, b) => a + b, 0);
    });
  }
  const max = Math.max(0, ...v);
  return v.map((x) => (x <= 0 || max === 0 ? SPARK[0] : SPARK[1 + Math.round((x / max) * 6)])).join("");
}

/** A horizontal bar `width` cells long, filled to `fraction` with eighth-block precision and padded with spaces. */
export function bar(fraction: number, width: number): string {
  const eighths = Math.round(Math.min(Math.max(fraction, 0), 1) * width * 8);
  const full = Math.floor(eighths / 8);
  const text = "█".repeat(full) + EIGHTHS[eighths % 8];
  return text.padEnd(width);
}

/** Cells per count, summing to `width` (largest remainder), and at least one cell for any count above zero while the width allows. */
function split(counts: number[], width: number): number[] {
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
  const [a, m, f] = split([act, mark, fallBack], width) as [number, number, number];
  return "█".repeat(a) + "▓".repeat(m) + "░".repeat(f);
}

/**
 * Certainties from 0 to 1 counted into `width` columns and drawn as one row of spark glyphs,
 * then a second row with `│` under each threshold in `marks`. Two lines joined by a newline.
 */
export function histogram(certainties: number[], width: number, marks: number[]): string {
  const counts = new Array<number>(width).fill(0);
  const column = (c: number): number => Math.min(width - 1, Math.max(0, Math.floor(c * width)));
  for (const c of certainties) counts[column(c)]! += 1;
  const under = new Array<string>(width).fill(" ");
  for (const m of marks) under[column(m)] = "│";
  return `${spark(counts, width)}\n${under.join("").trimEnd()}`;
}

import { formatUsdc, parseUsdc, toInput } from './amount';

export type Normalized = { text: string; note: string | null };

/** Comma as the decimal mark ("4,5" -> "4.5"). A dot present, or a comma before exactly 3 digits ("1,000"), means
 *  the commas are thousands separators and are dropped. */
export function fixSeparators(raw: string): string {
  const s = raw.trim().replace(/\s+/g, '');
  if (s.includes('.')) return s.replace(/,/g, '');
  const n = (s.match(/,/g) ?? []).length;
  if (n === 1 && !/,\d{3}$/.test(s)) return s.replace(',', '.');
  return s.replace(/,/g, '');
}

/** What the amount field shows after the user types `raw`. More than 2 decimals rounds DOWN to the cent; above `cap`
 *  clamps to the cap. Either change comes with a note, so nothing is changed silently. Half-typed input ("4.", "")
 *  and junk are left alone (junk shows the field's own error). */
export function normalizeAmount(raw: string, cap: bigint, overNote: (cap: bigint) => string = (c) => `Your limit is ${formatUsdc(c)}`): Normalized {
  let text = fixSeparators(raw);
  if (!/^\d*\.?\d*$/.test(text)) return { text: raw, note: null };
  let note: string | null = null;
  const dot = text.indexOf('.');
  if (dot >= 0 && text.length - dot - 1 > 2) { text = text.slice(0, dot + 3); note = 'Rounded to 2 decimals'; }
  const v = parseUsdc(text);
  if (v !== null && v > cap) {
    // The cap itself, cut to the cent so the field never shows more than 2 decimals.
    const c = cap - (cap % 10_000n);
    return { text: centsText(c), note: overNote(c) };
  }
  return { text, note };
}

/** micro-USDC -> input text with at most 2 decimals, cut (never reads high). */
export function centsText(micro: bigint): string {
  return toInput(micro - (micro % 10_000n));
}

// ---------- the stamp sheet as a drag control ----------

const UNITS = [1n, 2n, 5n, 10n, 20n, 50n, 100n, 200n, 500n, 1000n, 5000n].map((u) => u * 1_000_000n);

/** Face value of one stamp: the smallest unit that fits the limit in 12 stamps or fewer. */
export function stampUnit(limit: bigint): bigint {
  return UNITS.find((u) => (limit + u - 1n) / u <= 12n) ?? UNITS[UNITS.length - 1];
}

/** Which stamp a point is over (reading order, `cols` per row) and how far across it, 0..1. x/y are relative to the
 *  grid's top-left, w/h its size. A point outside the grid clamps to the nearest edge; a point over an empty cell
 *  past the last stamp counts as the far end of the last stamp. */
export function cellAt(x: number, y: number, w: number, h: number, cols: number, count: number): { index: number; frac: number } {
  if (count <= 0 || w <= 0 || h <= 0) return { index: 0, frac: 0 };
  const rows = Math.ceil(count / cols);
  const cw = w / cols, ch = h / rows;
  const col = Math.min(cols - 1, Math.max(0, Math.floor(x / cw)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(y / ch)));
  const index = row * cols + col;
  if (index >= count) return { index: count - 1, frac: 1 };
  return { index, frac: Math.min(1, Math.max(0, (x - col * cw) / cw)) };
}

/** Amount for a finger over free stamp `k` (0 = the first stamp not yet borrowed), `frac` of the way across it.
 *  Full stamps before it plus that share of it, rounded to the cent. Every stamp is worth `unit` except the last of
 *  the `n` free ones, which is worth what is left of `total`. Within `snap` of a stamp edge it snaps to the whole
 *  value. Clamped to 0..cap. */
export function amountAtStamp(k: number, frac: number, unit: bigint, n: number, total: bigint, cap: bigint, snap = 0.03): bigint {
  if (k < 0 || n <= 0) return 0n;
  if (k >= n) return total < cap ? total : cap;
  const base = BigInt(k) * unit;
  const width = k === n - 1 ? total - base : unit;
  if (width <= 0n) return base < cap ? base : cap;
  const f = frac < snap ? 0 : frac > 1 - snap ? 1 : frac;
  let v = f === 1 ? base + width : base + BigInt(Math.round((f * Number(width)) / 10_000)) * 10_000n;
  if (v > base + width) v = base + width;
  if (v < 0n) v = 0n;
  return v > cap ? cap : v;
}

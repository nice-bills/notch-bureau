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

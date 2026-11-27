// The dates to type into a mobile-money statement request: about the last 90 days, ending YESTERDAY (the phone's own calendar).
// MTN's *170# refuses today as the end date, so the range stops the day before.
// People picked "last 30 days" because they did not know which date was 3 months ago, so the app says it.

/** Start (today minus `days` calendar days, local time) and end (yesterday) of the statement to request. */
export function statementRange(now: Date = new Date(), days = 90): { start: Date; end: Date } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today);
  start.setDate(start.getDate() - days); // calendar days, so a DST change never shifts it by one
  const end = new Date(today);
  end.setDate(end.getDate() - 1);
  return { start, end };
}

/** "28 Aug 2026" in the phone's language. */
export const longDay = (d: Date, locale?: string) => d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
/** "28/08/2026" (or the phone's own numeric order): what a statement form usually asks for. */
export const numericDay = (d: Date, locale?: string) => d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });

/** "28 11 2026": the exact format MTN MoMo's *170# statement request asks for ("Day Month Year"). */
export const momoDay = (d: Date) => `${String(d.getDate()).padStart(2, '0')} ${String(d.getMonth() + 1).padStart(2, '0')} ${d.getFullYear()}`;

export type WaitStage = 'preparing' | 'usually' | 'stuck';

/** Which waiting message to show after `ms` of waiting: under 2 min, 2-10 min, then 10 min and over. */
export function waitStage(ms: number): WaitStage {
  return ms < 2 * 60_000 ? 'preparing' : ms < 10 * 60_000 ? 'usually' : 'stuck';
}

/** Copy text; falls back to a hidden textarea where the async clipboard is missing (older iOS, http pages). */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}

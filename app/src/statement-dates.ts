// The dates to type into a mobile-money statement request: the last 90 days, ending today (the phone's own calendar).
// People picked "last 30 days" because they did not know which date was 3 months ago, so the app says it.

/** Start (today minus `days` calendar days, local time) and end (today) of the statement to request. */
export function statementRange(now: Date = new Date(), days = 90): { start: Date; end: Date } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - days); // calendar days, so a DST change never shifts it by one
  return { start, end };
}

/** "28 Aug 2026" in the phone's language. */
export const longDay = (d: Date, locale?: string) => d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
/** "28/08/2026" (or the phone's own numeric order): what a statement form usually asks for. */
export const numericDay = (d: Date, locale?: string) => d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });

/** "28 11 2026": the exact format MTN MoMo's *170# statement request asks for ("Day Month Year"). */
export const momoDay = (d: Date) => `${String(d.getDate()).padStart(2, '0')} ${String(d.getMonth() + 1).padStart(2, '0')} ${d.getFullYear()}`;

/** "1:42" or "1:02:05" for a span of milliseconds. */
export function clockSpan(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
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

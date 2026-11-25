// DEMO ONLY (final gate #1): the demo servers hand out freshly signed fake income emails at GET /samples/*.eml. A fresh email is
// a fresh underwriter record, which was the cheap fuel for pumping the repayment count. The program now counts at most one
// repayment per 14 days per line, but a demo that hands one caller unlimited fresh income is still a faucet, so it is
// rate-limited: SAMPLE_PER_KEY per caller (IP, or the first X-Forwarded-For hop behind a proxy) and SAMPLE_GLOBAL for everyone,
// per SAMPLE_WINDOW_MS. A caller over the limit gets HTTP 429. Memory only; a restart resets it (it is a speed bump for a demo).
export const SAMPLE_PER_KEY = 6;
export const SAMPLE_GLOBAL = 120;
export const SAMPLE_WINDOW_MS = 3600_000;

export function callerKey(req) {
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
}

export function createSampleLimiter({ perKey = SAMPLE_PER_KEY, global = SAMPLE_GLOBAL, windowMs = SAMPLE_WINDOW_MS, now = Date.now } = {}) {
  const hits = new Map(); // key -> [timestamps]
  let all = [];
  return {
    /** -> { ok: true } or { ok: false, retryAfterS } */
    take(key) {
      const t = now();
      const keep = (a) => a.filter((x) => t - x < windowMs);
      all = keep(all);
      const mine = keep(hits.get(key) || []);
      if (mine.length >= perKey || all.length >= global) {
        hits.set(key, mine);
        const oldest = mine.length >= perKey ? mine[0] : all[0];
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000)) };
      }
      mine.push(t); all.push(t); hits.set(key, mine);
      if (hits.size > 5000) for (const [k, v] of hits) if (!keep(v).length) hits.delete(k);
      return { ok: true };
    },
  };
}

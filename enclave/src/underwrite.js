// v1 limit rule, kept simple and explainable (see PLAN.md).
// Limit = 30% of verified average monthly income over 90 days, capped; first-timers capped at 50 USDC.
export const FIRST_CAP_USDC = 50;
export const HARD_CAP_USDC = 2000;
export const SHARE = 0.3;
const DAY = 86400_000;

// Static FX for the prototype; replaced by a live rate feed later.
export const USD_PER = { USD: 1, USDC: 1, GHS: 0.065, NGN: 0.00065, KES: 0.0077, EUR: 1.08, GBP: 1.27 };

export function computeLimit(events, { now = new Date(), repaidOnTime = 0, frozen = false } = {}) {
  if (frozen) return { limitUsdc: 0, monthlyUsd: 0 };
  const recent = events.filter((e) => now - e.date <= 90 * DAY && USD_PER[e.currency]);
  const totalUsd = recent.reduce((s, e) => s + e.amount * USD_PER[e.currency], 0);
  const monthlyUsd = totalUsd / 3;
  const cap = Math.min(HARD_CAP_USDC, FIRST_CAP_USDC * 2 ** Math.min(repaidOnTime, 6));
  const limitUsdc = Math.floor(Math.min(cap, monthlyUsd * SHARE) * 100) / 100;
  return { limitUsdc, monthlyUsd: Math.round(monthlyUsd * 100) / 100 };
}

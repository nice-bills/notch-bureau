// v1 limit rule, kept simple and explainable (see PLAN.md).
// Limit = 30% of verified average monthly income over 90 days, capped; first-timers capped at 50 USDC.
export const FIRST_CAP_USDC = 50;
export const HARD_CAP_USDC = 2000;
export const SHARE = 0.3;
const DAY = 86400_000;

// Static FX for the prototype; replaced by a live rate feed later.
export const USD_PER = { USD: 1, USDC: 1, GHS: 0.065, NGN: 0.00065, KES: 0.0077, EUR: 1.08, GBP: 1.27 };

// events: [{ amount, currency, date, weight? }]. `weight` (0..1, default 1) is how much of a credit counts: statements
// give 1 for earned income and a fraction for regular peer transfers (src/income.js); other sources leave it out.
//
// signals (statement sources only, from src/income.js; optional):
//   incomeRegularity        months with income / 3        -> scales the limit by 0.5 + 0.5 * regularity
//   bettingShareOfSpend     betting stakes / all spend    -> scales by max(0, 1 - 2 * share): half the spend on betting = 0
//   loanRepaymentsPerMonth  existing loan repayments      -> deducted from monthly income BEFORE the 30% share
//   avgEodBalance           average end-of-day balance    -> computed and reported, not used in the limit yet
export function computeLimit(events, { now = new Date(), repaidOnTime = 0, frozen = false, signals = null } = {}) {
  if (frozen) return { limitUsdc: 0, monthlyUsd: 0 };
  const recent = events.filter((e) => now - e.date <= 90 * DAY && USD_PER[e.currency]);
  const totalUsd = recent.reduce((s, e) => s + e.amount * (e.weight ?? 1) * USD_PER[e.currency], 0);
  const monthlyUsd = totalUsd / 3;
  const cap = Math.min(HARD_CAP_USDC, FIRST_CAP_USDC * 2 ** Math.min(repaidOnTime, 6));
  let affordable = monthlyUsd;
  let factor = 1;
  if (signals) {
    const cur = USD_PER[signals.currency] ?? 0;
    affordable = Math.max(0, monthlyUsd - (signals.loanRepaymentsPerMonth || 0) * cur);
    factor = (0.5 + 0.5 * (signals.incomeRegularity ?? 1)) * Math.max(0, 1 - 2 * (signals.bettingShareOfSpend || 0));
  }
  const limitUsdc = Math.floor(Math.min(cap, affordable * SHARE * factor) * 100) / 100;
  return { limitUsdc, monthlyUsd: Math.round(monthlyUsd * 100) / 100 };
}

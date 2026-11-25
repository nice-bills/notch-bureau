// Permanent regression tests for final gate finding #2 (reviews/2026-11-25-final/REVIEW-final-gate.md): a merchant-till loop
// beat the #6/#7 income rules. Source of the repro: reviews/2026-11-25-final/merchant-loop.mjs.
//  * a peer credit that follows a similar-size debit (a merchant/till payment, or any debit to a party) within 7 days is money
//    passed back: it does not count, and the debit it undoes is not real spending;
//  * cash: every unmatched outgoing debit of the window subtracts (not only cash-outs);
//  * soft income (peers + cash) is capped per month, so no float can scale it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as income from '../src/income.js';
import { classifyRows, finalizeIncome } from '../src/income.js';
const SOFT_CAP_USD_PER_MONTH = income.SOFT_CAP_USD_PER_MONTH ?? 250; // (undefined before the fix: the test then runs against the same number)
import { computeLimit, USD_PER } from '../src/underwrite.js';

const DAY = 86400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const HOLDER = 'ALICE KWAME TEST';
let seq = 0;
const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const row = (o) => ({ page: 1, dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100, fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o });
const run = (rows) => {
  rows.sort((a, b) => b.date - a.date);
  const f = finalizeIncome(classifyRows(rows, { holder: HOLDER }), { now: NOW });
  return { f, pumped: computeLimit(f.events, { now: NOW, signals: f.signals, repaidOnTime: 6 }).limitUsdc, first: computeLimit(f.events, { now: NOW, signals: f.signals }).limitUsdc };
};

// ONE float of K GHS. Every 3 days: pay a cooperating merchant till, its owner sends it back P2P from one of two SIMs a day later.
const tillLoop = (K, { split = 1, ret = 1 } = {}) => {
  const rows = [];
  let i = 0;
  for (let d = 88; d >= 2; d -= 3, i++) {
    for (let s = 0; s < split; s++) rows.push(row({ type: 'PAYMENT', acct: 'KOFI PROVISIONS', amount: -K / split, date: at(d, 12 - s * 0.01) }));
    const n = 1 + (i % 2);
    for (let s = 0; s < ret; s++) rows.push(row({ party: P(n), acct: n === 1 ? 'KOFI A' : 'AMA B', amount: K / ret, date: at(d - 1, 10 + s * 0.01) }));
  }
  return rows;
};

test('FG2 repro: a merchant-till loop of a 1000 or 5000 GHS float counts for nothing (it counted 14,500 and 72,500 GHS)', () => {
  for (const K of [1000, 5000]) {
    const { f, pumped, first } = run(tillLoop(K));
    assert.equal(f.countedTotal, 0, `float ${K}`);
    assert.equal(pumped, 0);
    assert.equal(first, 0);
  }
});

test('FG2: the loop cannot hide by changing the amounts (return in two halves, or the payment split in two)', () => {
  assert.equal(run(tillLoop(5000, { ret: 2 })).f.countedTotal, 0);
  assert.equal(run(tillLoop(5000, { split: 2 })).f.countedTotal, 0);
});

test('FG2: a loop that evades the size match (ten small payments out, one big credit back) is still bounded by the soft cap, whatever the float', () => {
  const capUsd = SOFT_CAP_USD_PER_MONTH * 3;
  for (const K of [5000, 50000, 500000]) {
    const { f, pumped } = run(tillLoop(K, { split: 10 }));
    const usd = f.countedTotal * USD_PER.GHS;
    assert.ok(usd <= capUsd + 0.01, `float ${K}: ${usd} USD counted, cap ${capUsd}`);
    assert.ok(pumped <= SOFT_CAP_USD_PER_MONTH * 0.3 + 0.01, `float ${K}: limit ${pumped}`); // 30% of the capped monthly income, however big the float
  }
});

test('FG2: cash cashed in, then moved out by a person-to-person transfer 8+ days later, counts for nothing (every unmatched leaving debit subtracts)', () => {
  const rows = [];
  for (let d = 85; d >= 9; d -= 10) {
    rows.push(row({ type: 'CASH IN', party: P(11), acct: 'AGENT ABENA', amount: 2000, date: at(d, 10) }));
    rows.push(row({ type: 'MOMO USER', party: P(12), acct: 'YAA ASANTEWAA', amount: -2000, date: at(d - 8.5, 9) }));
  }
  assert.equal(run(rows).f.countedTotal, 0);
});

test('FG2 controls: honest peers who pay a shopkeeper and a landlord are still counted; verified income is never capped', () => {
  const rows = [];
  for (const d of [80, 50, 20]) {
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: 400, date: at(d) }));
    rows.push(row({ party: P(2), acct: 'AMA B', amount: 400, date: at(d, 11) }));
    rows.push(row({ type: 'PAYMENT', acct: 'SHOPRITE', amount: -500, date: at(d - 3, 12) })); // a week of shopping, after the credits
    rows.push(row({ party: P(4), acct: 'ESI MANU', amount: -300, date: at(d - 4, 12) })); // rent
  }
  const { f } = run(rows);
  assert.equal(f.countedTotal, 2400 * 0.5);
  // 12,000 GHS a month of recognised payer income (about 780 USD): over the soft cap, and untouched by it
  const earned = [];
  for (const d of [80, 50, 20]) earned.push(row({ acct: 'PAYSTACK PAYOUT', ref: 'Payout', amount: 12000, date: at(d, 9) }));
  assert.equal(run(earned).f.countedTotal, 36000);
});

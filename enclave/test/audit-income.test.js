// Permanent regression tests for audit findings #6 (cash cycled out by transfer after 8+ days) and #7 (peer income
// cycled through helper SIMs). Source: reviews/2026-11-24-audit/income.test.js (the repro). The rules live in src/income.js.
//
//  * peer credits whose money goes back to the same counterparty within 14 days (before or after) count only for what
//    did not go back;
//  * net-flow check: cash + peer income may not exceed 2x the REAL spending of the window (merchant, bills, airtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as income from '../src/income.js';
import { classifyRows, finalizeIncome } from '../src/income.js';
const SPEND_BACKING = income.SPEND_BACKING ?? 2;
import { computeLimit } from '../src/underwrite.js';

const DAY = 86400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const HOLDER = 'ALICE KWAME TEST';
let seq = 0;
const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const row = (o) => ({ page: 1, dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100, fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o });
const run = (rows) => {
  rows.sort((a, b) => b.date - a.date);
  const c = classifyRows(rows, { holder: HOLDER });
  const f = finalizeIncome(c, { now: NOW });
  const lim = computeLimit(f.events, { now: NOW, signals: f.signals });
  return { f, lim };
};
const merchant = (d, amount) => row({ type: 'PAYMENT', acct: 'MAKOLA WHOLESALE', amount: -amount, date: at(d, 12) });

// ---- #6: a 10,000 GHS float: cash in, sent P2P to a helper 8 days later, repeated (the repro) -------------------------------
const cashLoop = (delay, K = 10000) => {
  const rows = [];
  for (let d = 88; d - delay >= 0; d -= delay) {
    rows.push(row({ type: 'CASH IN', party: P(11), acct: 'AGENT ABENA', amount: K, date: at(d, 10) }));
    rows.push(row({ type: 'MOMO USER', party: P(12), acct: 'YAA ASANTEWAA', amount: -K, date: at(d - delay, 9) }));
  }
  return rows;
};

test('#6 repro: a float cashed in and sent to a helper 8 days later counts for nothing (it counted 55,000 GHS)', () => {
  const { f, lim } = run(cashLoop(8));
  assert.equal(f.countedTotal, 0);
  assert.equal(lim.limitUsdc, 0);
  assert.equal(f.netFlow?.realSpend, 0);
});

test('#6: waiting longer between cash in and the transfer out (20 and 35 days) does not help either', () => {
  assert.equal(run(cashLoop(20)).f.countedTotal, 0);
  assert.equal(run(cashLoop(35)).f.countedTotal, 0);
});

test('#6: the only way to count cash is to spend real money: income counted <= 2x real spending', () => {
  for (const S of [200, 1000, 4000]) {
    const rows = cashLoop(8);
    // spread S of merchant payments over the window
    for (let d = 80; d >= 5; d -= 15) rows.push(merchant(d, S / 6));
    const { f } = run(rows);
    assert.ok(f.countedTotal <= SPEND_BACKING * f.netFlow?.realSpend + 0.01, `${f.countedTotal} vs spend ${f.netFlow?.realSpend}`);
    assert.ok(f.netFlow?.realSpend <= S + 0.01);
  }
});

test('#6: spending that proves nothing does not back income: transfers, cash-outs, own accounts, betting, loan repayments', () => {
  const rows = cashLoop(8);
  rows.push(row({ type: 'MOMO USER', party: P(13), acct: 'KOFI', amount: -5000, date: at(40) }));
  rows.push(row({ type: 'CASH OUT', party: P(11), acct: 'AGENT ABENA', amount: -5000, date: at(41) }));
  rows.push(row({ type: 'DEBIT', acct: 'ysavedep OVA', ref: '1234', amount: -5000, date: at(42) }));
  rows.push(row({ type: 'OTHER TRANSACTIONS', party: '9', acct: 'Debit. Inv5', ref: 'Football Internet', amount: -5000, date: at(43) }));
  rows.push(row({ type: 'DEBIT', acct: 'QwikLoan OVA', amount: -5000, date: at(44) }));
  const { f } = run(rows);
  assert.equal(f.netFlow?.realSpend, 0);
  assert.equal(f.countedTotal, 0);
});

// ---- #7: two helper SIMs send 1000 GHS, the holder sends it back 4 days later, every 9 days (the repro) --------------------
const peerLoop = (back, K = 1000) => {
  const rows = [];
  for (let d = 88; d - back >= 0; d -= 9) {
    for (const [n, name, hh] of [[1, 'KOFI A', 10], [2, 'AMA B', 11]]) {
      rows.push(row({ party: P(n), acct: name, amount: K, date: at(d, hh) }));
      rows.push(row({ party: P(n), acct: name, amount: -K, date: at(d - back, hh) }));
    }
  }
  return rows;
};

test('#7 repro: helper SIMs that get their money back 4 days later count for nothing (they counted 10,000 GHS)', () => {
  const { f, lim } = run(peerLoop(4));
  assert.equal(f.countedTotal, 0);
  assert.equal(lim.limitUsdc, 0);
});

test('#7: coming back after 12 days is still a loop (inside the 14 day window)', () => {
  assert.equal(run(peerLoop(12)).f.countedTotal, 0);
});

test('#7: a loop that waits 20 days to give the money back is stopped by the net-flow check (no real spending behind it)', () => {
  assert.equal(run(peerLoop(20)).f.countedTotal, 0);
});

test('#7: money sent TO the payer shortly BEFORE it comes back (lending and being repaid) is not income either', () => {
  const rows = [];
  for (const d of [80, 50, 20]) {
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: -500, date: at(d + 5) })); // (a same-size return within 3 days is already the refund rule)
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: 500, date: at(d) }));
    rows.push(row({ party: P(2), acct: 'AMA B', amount: 500, date: at(d, 11) }));
  }
  rows.push(merchant(10, 5000));
  const { f } = run(rows);
  // AMA B (no debit around it) counts at 50%; KOFI A (a debit of the same size 3 days before each credit) counts for nothing.
  assert.equal(f.countedTotal, 1500 * 0.5);
});

test('#7 controls: honest regular peers and a trader who spends are NOT touched', () => {
  const rows = [];
  for (const d of [80, 50, 20]) {
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: 400, date: at(d) }));
    rows.push(row({ party: P(2), acct: 'AMA B', amount: 400, date: at(d, 11) }));
    rows.push(merchant(d - 1, 300));
  }
  const { f } = run(rows);
  assert.equal(f.countedTotal, 2400 * 0.5); // two regular payers at 50%
  assert.equal(f.netFlow?.backing, 1);
  // a small change-giving return (under 10% of the credit) is ignored
  const withChange = [...rows, row({ party: P(1), acct: 'KOFI A', amount: -30, date: at(79) })];
  assert.equal(run(withChange).f.countedTotal, 2400 * 0.5);
});

test('#7: a partial return counts only what did not come back', () => {
  const rows = [];
  for (const d of [80, 50, 20]) {
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: 400, date: at(d) }));
    rows.push(row({ party: P(2), acct: 'AMA B', amount: 400, date: at(d, 11) }));
    rows.push(merchant(d - 5, 300)); // clear of the 48 hour pass-through window
  }
  rows.push(row({ party: P(1), acct: 'KOFI A', amount: -200, date: at(79) })); // half of the first credit goes back
  const { f } = run(rows);
  assert.equal(f.countedTotal, (2400 - 200) * 0.5);
});

test('the repro limit with a pumped cap: even repaidOnTime=6 cannot lift a limit that has no counted income', () => {
  const rows = cashLoop(8);
  const c = classifyRows(rows.sort((a, b) => b.date - a.date), { holder: HOLDER });
  const f = finalizeIncome(c, { now: NOW });
  assert.equal(computeLimit(f.events, { now: NOW, signals: f.signals, repaidOnTime: 6 }).limitUsdc, 0);
});

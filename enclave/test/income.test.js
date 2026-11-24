// Income sorting: every class has a rule, free text can only lower a credit, only earned income + regular peers count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { classifyRows, applyDowngrades, finalizeIncome, mentionsHolder, rankOf, PEER_WEIGHT } from '../src/income.js';
import { computeLimit } from '../src/underwrite.js';

const DAY = 86400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const HOLDER = 'ALICE KWAME TEST';
let seq = 0;
const row = (o) => ({
  page: 1, date: new Date(NOW - (o.days ?? 10) * DAY), dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100,
  fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o,
});
const credit = (o) => classifyRows([row(o)], { holder: HOLDER })[0].cls;
const P = (n) => `23324400${String(n).padStart(4, '0')}`;

test('each class has a rule', () => {
  assert.equal(credit({ type: 'REVERSAL', party: P(1), acct: 'X' }), 'refund');
  assert.equal(credit({ ref: 'refund of order 12', party: P(1), acct: 'X' }), 'refund');
  assert.equal(credit({ acct: 'Interest Payments', ref: 'Interest for April to June 2026' }), 'interest');
  assert.equal(credit({ party: P(1), acct: 'Credit.Inv', ref: 'SportyBet' }), 'betting');
  assert.equal(credit({ acct: 'Debit. Inv5', ref: 'Football Internet' }), 'betting');
  assert.equal(credit({ acct: 'QwikLoan OVA' }), 'loan_disbursement');
  assert.equal(credit({ acct: 'ysavedep OVA', ref: '123_ABC' }), 'self_transfer');
  assert.equal(credit({ acct: 'ICS GHS EQUITIES TRUST ACCOUNT 3' }), 'self_transfer');
  assert.equal(credit({ acct: 'INTEROPERABILI TY PULL OVA', ref: `${HOLDER} ,23xxxxxx45, GIPS Transfer from GCB Bank` }), 'self_transfer');
  assert.equal(credit({ type: 'CASH IN', party: P(1), acct: 'AGENT' }), 'cash_deposit');
  assert.equal(credit({ acct: 'PAYSTACK PAYOUT' }), 'earned_income');
  assert.equal(credit({ acct: 'DEEL INC' }), 'earned_income');
  assert.equal(credit({ type: 'SALARY', acct: 'ACME LTD' }), 'earned_income');
  assert.equal(credit({ party: P(2), acct: 'ADWOA BOATENG' }), 'peer_transfer');
  assert.equal(credit({ acct: 'BLUE KITE TRADING' }), 'unknown');
});

test('free text can only lower a credit: a memo or a person named like a payer never makes earned income', () => {
  assert.equal(credit({ party: P(2), acct: 'PAYSTACK PAYOUT', ref: 'salary' }), 'peer_transfer');
  assert.equal(credit({ party: P(2), acct: 'ADWOA', ref: 'SALARY PAYROLL PAYSTACK DEEL' }), 'peer_transfer');
  assert.equal(credit({ acct: 'BLUE KITE TRADING', ref: 'payroll salary deel' }), 'unknown');
  // but the same free text can push DOWN: "loan" in a memo, the holder's own name in a name
  assert.equal(credit({ party: P(2), acct: 'ADWOA', ref: 'loan back' }), 'loan_disbursement');
  assert.equal(credit({ party: P(2), acct: `${HOLDER} (my other wallet)` }), 'self_transfer');
  // a name that shares only one part with the holder is somebody else
  assert.equal(mentionsHolder('JOHN KWAME', HOLDER), false);
  assert.equal(mentionsHolder('KWAME TEST ALICE', HOLDER), true);
});

test('a refund by structure: the money came back to where it went', () => {
  const rows = classifyRows([
    row({ days: 6, amount: -80, party: P(3), acct: 'EFUA' }),
    row({ days: 5, amount: 80, party: P(3), acct: 'EFUA' }),
    row({ days: 4, amount: 80, party: P(4), acct: 'KOFI' }),
  ].sort((a, b) => b.date - a.date), { holder: HOLDER });
  assert.deepEqual(rows.filter((r) => r.amount > 0).map((r) => r.cls).sort(), ['peer_transfer', 'refund']);
});

test('pass-through: a large credit that leaves within 48 hours is not income; slow spending is', () => {
  const moved = classifyRows([
    row({ days: 3, amount: -300, acct: 'SHOP', date: new Date(NOW - 3 * DAY + 20 * 3600_000) }),
    row({ days: 4, amount: -250, acct: 'SHOP2', date: new Date(NOW - 4 * DAY + 5 * 3600_000) }),
    row({ days: 4, amount: 500, acct: 'PAYSTACK PAYOUT' }),
  ].sort((a, b) => b.date - a.date), { holder: HOLDER });
  assert.equal(moved.find((r) => r.amount === 500).cls, 'pass_through');
  const slow = classifyRows([
    row({ days: 1, amount: -300, acct: 'SHOP' }),
    row({ days: 6, amount: 500, acct: 'PAYSTACK PAYOUT' }),
  ], { holder: HOLDER });
  assert.equal(slow.find((r) => r.amount === 500).cls, 'earned_income');
  // each debit pays for one credit only
  const shared = classifyRows([
    row({ days: 5, amount: -450, acct: 'SHOP', date: new Date(NOW - 5 * DAY + 3600_000 * 5) }),
    row({ days: 5, amount: 500, acct: 'PAYSTACK PAYOUT', date: new Date(NOW - 5 * DAY + 3600_000 * 2) }),
    row({ days: 5, amount: 500, acct: 'DEEL INC', date: new Date(NOW - 5 * DAY + 3600_000 * 1) }),
  ].sort((a, b) => b.date - a.date), { holder: HOLDER });
  assert.deepEqual(shared.filter((r) => r.amount > 0).map((r) => r.cls).sort(), ['earned_income', 'pass_through']);
  // small credits are never judged
  assert.equal(classifyRows([row({ days: 5, amount: -50 }), row({ days: 5, amount: 60, acct: 'PAYSTACK PAYOUT', date: new Date(NOW - 5 * DAY - 1000) })].sort((a, b) => b.date - a.date), { holder: HOLDER }).find((r) => r.amount === 60).cls, 'earned_income');
});

test('untrusted rows (broken running balance, future date) can never count', () => {
  const rows = classifyRows([row({ acct: 'PAYSTACK PAYOUT', amount: 900, balanceOk: false }), row({ acct: 'PAYSTACK PAYOUT', amount: 900, future: true })], { holder: HOLDER });
  assert.ok(rows.every((r) => r.cls === 'unknown' && r.untrusted));
  assert.equal(finalizeIncome(rows, { now: NOW }).events.length, 0);
});

test('what counts: earned in full, regular peers at half, one-off peers and the rest at zero', () => {
  const rows = classifyRows([
    row({ days: 70, acct: 'PAYSTACK PAYOUT', amount: 1000 }),
    row({ days: 40, acct: 'PAYSTACK PAYOUT', amount: 1000 }),
    row({ days: 70, party: P(1), acct: 'A', amount: 200 }), row({ days: 40, party: P(1), acct: 'A', amount: 200 }),
    row({ days: 71, party: P(2), acct: 'B', amount: 100 }), row({ days: 41, party: P(2), acct: 'B', amount: 100 }),
    row({ days: 20, party: P(3), acct: 'C', amount: 999 }), // one-off
    row({ days: 20, acct: 'QwikLoan OVA', amount: 999 }),
    row({ days: 10, type: 'PAYMENT', acct: 'SHOP', amount: -700 }), // real spending backs the 300 of peer income counted (net-flow check)
  ].sort((a, b) => b.date - a.date), { holder: HOLDER });
  const f = finalizeIncome(rows, { now: NOW });
  assert.equal(f.countedTotal, 2000 + (400 + 200) * PEER_WEIGHT);
  assert.equal(f.regularPeers, 2);
  assert.equal(f.totals.earned_income.amount, 2000);
  assert.equal(f.totals.peer_transfer.amount, 400 + 200 + 999);
  assert.equal(f.totals.loan_disbursement.amount, 999);
});

test('a single regular payer counts at a quarter (one source is easy to fake)', () => {
  const rows = classifyRows([row({ days: 70, party: P(1), acct: 'A', amount: 400 }), row({ days: 40, party: P(1), acct: 'A', amount: 400 }),
    row({ days: 10, type: 'PAYMENT', acct: 'SHOP', amount: -150 })], { holder: HOLDER });
  assert.equal(finalizeIncome(rows, { now: NOW }).countedTotal, 800 * PEER_WEIGHT * 0.5);
});

test('signals: regularity, betting share of spend, loan repayments, average end-of-day balance', () => {
  const rows = classifyRows([
    row({ days: 80, acct: 'PAYSTACK PAYOUT', amount: 1000, balance: 1000 }),
    row({ days: 50, acct: 'PAYSTACK PAYOUT', amount: 1000, balance: 2000 }),
    row({ days: 40, amount: -60, acct: 'Debit. Inv5', ref: 'Football Internet', balance: 1940 }),
    row({ days: 35, amount: -180, acct: 'SHOP', balance: 1760 }),
    row({ days: 30, amount: -330, acct: 'QwikLoan OVA', balance: 1430 }),
    row({ days: 25, amount: -60, acct: 'ysavedep OVA', balance: 1370 }), // own money: not spend
  ].sort((a, b) => b.date - a.date), { holder: HOLDER });
  const { signals } = finalizeIncome(rows, { now: NOW });
  assert.equal(signals.monthsWithIncome, 2);
  assert.equal(signals.incomeRegularity, 0.67);
  assert.equal(signals.bettingShareOfSpend, 0.11); // 60 of (60 + 180 + 330)
  assert.equal(signals.loanRepaymentsPerMonth, 110);
  assert.ok(signals.avgEodBalance > 1000 && signals.avgEodBalance < 2000);
});

test('the limit uses the signals: loans come off income, betting and irregular income shrink it', () => {
  const ev = [{ amount: 3000, currency: 'GHS', date: new Date(NOW - 20 * DAY), weight: 1 }]; // 195 USD, 65/mo
  const plain = computeLimit(ev, { now: NOW });
  assert.equal(plain.limitUsdc, 19.5);
  const sig = (o) => ({ currency: 'GHS', incomeRegularity: 1, bettingShareOfSpend: 0, loanRepaymentsPerMonth: 0, ...o });
  assert.equal(computeLimit(ev, { now: NOW, signals: sig({}) }).limitUsdc, 19.5);
  assert.equal(computeLimit(ev, { now: NOW, signals: sig({ incomeRegularity: 0.33 }) }).limitUsdc, 12.96); // x 0.665
  assert.equal(computeLimit(ev, { now: NOW, signals: sig({ bettingShareOfSpend: 0.25 }) }).limitUsdc, 9.75); // x 0.5
  assert.equal(computeLimit(ev, { now: NOW, signals: sig({ bettingShareOfSpend: 0.5 }) }).limitUsdc, 0);
  assert.equal(computeLimit(ev, { now: NOW, signals: sig({ loanRepaymentsPerMonth: 500 }) }).limitUsdc, 9.75); // 65 - 32.5 = 32.5
  assert.equal(computeLimit([{ ...ev[0], weight: 0.5 }], { now: NOW }).limitUsdc, 9.75);
});

test('downgrades only: rank must strictly fall', () => {
  const rows = classifyRows([row({ acct: 'PAYSTACK PAYOUT' }), row({ party: P(1), acct: 'A' }), row({ acct: 'BLUE KITE' }), row({ acct: 'QwikLoan OVA' })], { holder: HOLDER });
  const [e, p, u, l] = rows;
  assert.deepEqual([e.cls, p.cls, u.cls, l.cls], ['earned_income', 'peer_transfer', 'unknown', 'loan_disbursement']);
  const n = applyDowngrades(rows, [
    { row: 0, cls: 'peer_transfer' }, // earned -> peer: down, applied
    { row: 1, cls: 'earned_income' }, // up: refused
    { row: 2, cls: 'earned_income' }, // up: refused
    { row: 3, cls: 'earned_income' }, // up: refused
    { row: 3, cls: 'betting' }, // sideways between zero-rank classes: refused
  ]);
  assert.equal(n, 1);
  assert.deepEqual(rows.map((r) => r.cls), ['peer_transfer', 'peer_transfer', 'unknown', 'loan_disbursement']);
  assert.ok(rankOf('earned_income') > rankOf('peer_transfer') && rankOf('peer_transfer') > rankOf('unknown') && rankOf('unknown') > rankOf('betting'));
});

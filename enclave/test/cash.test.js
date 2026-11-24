// Cash deposits as trading income, and every way an attacker can try to fake them. The rules live in src/income.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { classifyRows, applyDowngrades, finalizeIncome, CASH_WEIGHT } from '../src/income.js';
import { computeLimit } from '../src/underwrite.js';
import { parseStatements } from '../src/statement.js';
import { pdfAttachments } from '../src/mime.js';
import { extractStatementAuto } from '../src/llm-extract.js';
import { Underwriter } from '../src/underwriter.js';
import { InboxedUnderwriter } from './fixtures/inboxed.js';
import {
  resolver, momoStatementEmail, syntheticCashRows, syntheticCashLoopRows, TRADER_COUNTED_CASH, SYNTH_HOLDER,
} from './fixtures/emails.js';

const DAY = 86400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const HOLDER = 'ALICE KWAME TEST';
let seq = 0;
const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const row = (o) => ({
  page: 1, date: new Date(NOW - (o.days ?? 10) * DAY), dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100,
  fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o,
});
// days: how long ago. `hh`: hour of that day (so a debit can come before/after a deposit on the same day).
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const cashIn = (days, amount, o = {}) => row({ type: 'CASH IN', party: P(11), acct: 'AGENT ABENA', amount, date: at(days, o.hh ?? 10), ...o });
const cashOut = (days, amount, o = {}) => row({ type: 'CASH OUT', party: P(11), acct: 'AGENT ABENA', amount: -amount, date: at(days, o.hh ?? 10), ...o });
const p2p = (days, amount, o = {}) => row({ type: 'MOMO USER', party: P(12), acct: 'YAA ASANTEWAA', amount: -amount, date: at(days, o.hh ?? 10), ...o });
const pay = (days, amount, o = {}) => row({ type: 'PAYMENT', party: '', acct: 'MAKOLA WHOLESALE', amount: -amount, date: at(days, o.hh ?? 10), ...o });
const run = (rows, opts = {}) => {
  const sorted = [...rows].sort((a, b) => b.date - a.date);
  const classed = classifyRows(sorted, { holder: HOLDER });
  return { rows: classed, ...finalizeIncome(classed, { now: NOW, ...opts }) };
};
// the same three-month pattern: one deposit of `amount` in each 30-day month
const monthly = (amount, extra = () => []) => [80, 50, 20].flatMap((d) => [cashIn(d, amount), ...[].concat(extra(d))]);
const counted = (r) => r.cash.counted;

test('steady cash deposits in all three months count at 50%', () => {
  // an honest trader also spends: 300 a month at the wholesaler backs the 1500 counted (the net-flow check, audit #6)
  const r = run(monthly(1000, (d) => pay(d - 1, 300)));
  assert.equal(r.totals.cash_deposit.amount, 3000);
  assert.equal(counted(r), 1500);
  assert.equal(r.countedTotal, 1500);
  assert.deepEqual(r.events.map((e) => e.kind), ['cash_deposit', 'cash_deposit', 'cash_deposit']);
  assert.equal(CASH_WEIGHT, 0.5);
  // and it shows in the limit: 1500 GHS / 3 months = 32.5 USD a month, 30% of it
  const { limitUsdc } = computeLimit(r.events, { now: NOW, signals: r.signals });
  assert.ok(limitUsdc >= 9.7 && limitUsdc <= 9.8, String(limitUsdc));
});

test('regularity: one month of cash is not income; two of three months is', () => {
  assert.equal(counted(run([cashIn(20, 1000), cashIn(15, 1000), cashIn(5, 1000)])), 0);
  assert.equal(counted(run([cashIn(50, 1000), cashIn(20, 1000)])), 1000);
  assert.equal(counted(run([cashIn(80, 1000), cashIn(50, 1000)])), 1000);
  // a deposit older than the 90 day window never helps the two-month test
  assert.equal(counted(run([cashIn(120, 1000), cashIn(20, 1000)])), 0);
});

test('evenness: a token deposit in a second month cannot unlock one huge deposit', () => {
  const r = run([cashIn(80, 10), cashIn(50, 10), cashIn(20, 10_000)]);
  assert.equal(counted(r), (10 + 10 + 20) * 0.5); // the big month is held to 2x the median month
  assert.equal(counted(run([cashIn(50, 10), cashIn(20, 10_000)])), (10 + 20) * 0.5);
  // a real, uneven trader is not held back: 500 / 5000 / 5000
  assert.equal(counted(run([cashIn(80, 500), cashIn(50, 5000), cashIn(20, 5000)])), 5250);
});

test('ATTACK same cash in and out every month (deposit, withdraw next day, repeat): nothing counts', () => {
  const r = run(monthly(1000, (d) => [cashOut(d - 1, 1000)]));
  assert.equal(counted(r), 0);
  assert.equal(r.cash.cycled, 3000);
  assert.equal(r.countedTotal, 0);
});

test('ATTACK same cash through the agent but a fee smaller than the amount: the fee does not hide it', () => {
  const r = run(monthly(1000, (d) => [cashOut(d - 1, 985, { fee: 15 })]));
  assert.equal(counted(r), 3 * 15 * 0.5); // only the 15 left
});

test('ATTACK split deposits: many deposits under the 100 pass-through floor, one withdrawal', () => {
  const split = (d) => Array.from({ length: 10 }, (_, i) => cashIn(d, 99, { hh: 8 + i }));
  const rows = [80, 50, 20].flatMap((d) => [...split(d), cashOut(d - 2, 990)]);
  assert.equal(counted(run(rows)), 0);
  // the same deposits with nothing taken out do count
  assert.equal(counted(run([80, 50, 20].flatMap(split))), 3 * 990 * 0.5);
});

test('ATTACK leave 10% behind to slip under a 90% test: the part that left is cut, the rest counts', () => {
  const r = run(monthly(1000, (d) => [cashOut(d - 1, 900)]));
  assert.equal(counted(r), 3 * 100 * 0.5); // not 1500
  const r2 = run(monthly(1000, (d) => [cashOut(d - 1, 850)]));
  assert.equal(counted(r2), 3 * 150 * 0.5);
});

test('ATTACK wait 8 days to withdraw: the cash-out still comes off (net cash), it only escapes the 7 day match', () => {
  const rows = [...monthly(1000), cashOut(42, 1000)]; // 8 days after the day-50 deposit, 22 before the day-20 one
  const r = run(rows);
  assert.equal(r.cash.cycled, 0);
  assert.equal(r.cash.unmatchedCashOut, 1000);
  assert.equal(counted(r), 1000); // (3000 - 1000) x 50%
  // a cash-out of everything, late, leaves nothing
  assert.equal(counted(run([...monthly(1000), cashOut(5, 3000)])), 0);
});

test('ATTACK take cash out first, put it back in: a cash-out in the 7 days BEFORE a deposit cancels it', () => {
  const r = run(monthly(1000, (d) => [cashOut(d + 3, 1000)]));
  assert.equal(counted(r), 0);
  // 8 days before is outside the match (it is then judged only as net cash)
  const far = run(monthly(1000, (d) => [cashOut(d + 8, 1000, { hh: 9 })]));
  assert.equal(far.cash.cycled, 0);
});

test('ATTACK send the cash on to a person (or an accomplice) within a week: cancelled; ordinary spending is not', () => {
  assert.equal(counted(run(monthly(1000, (d) => [p2p(d - 1, 1000)]))), 0);
  assert.equal(counted(run(monthly(1000, (d) => [p2p(d - 7, 1000, { hh: 9 })]))), 0); // just inside day 7
  assert.equal(counted(run(monthly(1000, (d) => [p2p(d - 8, 1000)]))), 1500); // day 8: outside the window (only the net-cash rule is left, and a transfer is not a cash-out)
  // paying a shop, airtime, bills: spending, not cycling
  assert.equal(counted(run(monthly(1000, (d) => [pay(d - 1, 1000)]))), 1500);
  assert.equal(counted(run(monthly(1000, (d) => [row({ type: 'AIRTIME', party: P(4), acct: 'MTNONLINEAIRTIMEVENDOR', amount: -900, date: at(d - 1) })]))), 1500);
});

test('ATTACK own bank loop (cash in, push to my bank, ATM, cash in again): a move to my own bank cancels; a savings product does not', () => {
  const gips = (d) => row({ type: 'OTHER TRANSACTIONS', party: '', acct: 'INTEROPERABILI TY PUSH OVA', ref: `${HOLDER} ,23xxxxxx45, GIPS Transfer to GCB Bank`, amount: -1000, date: at(d - 1) });
  assert.equal(counted(run(monthly(1000, gips))), 0);
  const save = (d) => row({ type: 'DEBIT', party: '', acct: 'ysavedep OVA', ref: '123_ABC', amount: -1000, date: at(d - 1) });
  assert.equal(counted(run(monthly(1000, save))), 1500);
  // the strictest setting treats a savings move as leaving too, the what-if setting treats no own move as leaving
  assert.equal(counted(run(monthly(1000, save), { cashOwnMoney: 'all' })), 0);
  assert.equal(counted(run(monthly(1000, gips), { cashOwnMoney: 'none' })), 1500);
});

test('ATTACK text on a debit can only make a deposit count LESS: a memo that says "savings" never exempts it', () => {
  // to a person, with "savings" in the memo
  const toPerson = (d) => row({ type: 'DEBIT', party: P(12), acct: 'YAA ASANTEWAA', ref: 'my savings', amount: -1000, date: at(d - 1) });
  assert.equal(counted(run(monthly(1000, toPerson))), 0);
  // to a business account that is not a savings product, with savings words only in the memo
  const toBiz = (d) => row({ type: 'DEBIT', party: '', acct: 'BLUE KITE TRADING', ref: 'ysavedep savings trust', amount: -1000, date: at(d - 1) });
  assert.equal(counted(run(monthly(1000, toBiz))), 0);
  // a name that merely says "savings" on a person's account is still a person
  const named = (d) => row({ type: 'MOMO USER', party: P(13), acct: 'SAVINGS KOFI', amount: -1000, date: at(d - 1) });
  assert.equal(counted(run(monthly(1000, named))), 0);
});

test('each debit is used once: one 500 cash-out cancels one 500 deposit, not two', () => {
  const rows = [80, 50, 20].flatMap((d) => [cashIn(d, 500, { hh: 8 }), cashIn(d, 500, { hh: 9 }), cashOut(d - 1, 500)]);
  assert.equal(counted(run(rows)), 3 * 500 * 0.5);
});

test('a debit already used by a pass-through credit is not used again against cash', () => {
  const rows = [
    ...monthly(1000, () => []),
    row({ days: 20, acct: 'PAYSTACK PAYOUT', amount: 1000, date: at(20, 10.5) }), // earned, and gone within the hour
    p2p(20, 1000, { hh: 11 }),
  ];
  const r = run(rows);
  assert.equal(r.rows.find((x) => x.amount === 1000 && x.acct === 'PAYSTACK PAYOUT').cls, 'pass_through');
  assert.equal(r.cash.cycled, 0);
  assert.equal(counted(r), 1500);
});

test('cash that never counted stays out of every other class: not earned income, not a peer', () => {
  const r = run(monthly(1000));
  assert.equal(r.totals.earned_income.count, 0);
  assert.equal(r.totals.peer_transfer.count, 0);
  assert.equal(r.regularPeers, 0);
});

test('untrusted rows never count as cash: broken running balance, future date', () => {
  const r = run([cashIn(80, 1000), cashIn(50, 1000), cashIn(20, 1000, { balanceOk: false })]);
  assert.equal(r.cash.deposits, 2);
  assert.equal(counted(r), 1000);
  assert.equal(counted(run([cashIn(80, 1000), cashIn(50, 1000, { future: true })])), 0);
});

test('the AI reader can only lower cash: it can never file a credit as cash, it can drop a cash deposit', () => {
  const rows = classifyRows([
    row({ acct: 'PAYSTACK PAYOUT', amount: 500 }),
    row({ party: P(1), acct: 'ADWOA BOATENG', amount: 500 }),
    row({ acct: 'BLUE KITE TRADING', amount: 500 }),
    cashIn(10, 500),
  ], { holder: HOLDER });
  assert.deepEqual(rows.map((r) => r.cls), ['earned_income', 'peer_transfer', 'unknown', 'cash_deposit']);
  const n = applyDowngrades(rows, [
    { row: 0, cls: 'cash_deposit' }, // would turn a one-off peer / unknown into a cash credit: refused
    { row: 1, cls: 'cash_deposit' },
    { row: 2, cls: 'cash_deposit' },
    { row: 3, cls: 'earned_income' }, // up: refused
    { row: 3, cls: 'peer_transfer' }, // up: refused
  ]);
  assert.equal(n, 0);
  assert.deepEqual(rows.map((r) => r.cls), ['earned_income', 'peer_transfer', 'unknown', 'cash_deposit']);
  assert.equal(applyDowngrades(rows, [{ row: 3, cls: 'unknown' }, { row: 3, cls: 'self_transfer' }]), 2);
  assert.equal(rows[3].cls, 'self_transfer');
});

test('a lying AI reply (cash_deposit, or a promotion) changes nothing in a full statement run', async () => {
  const eml = await momoStatementEmail({ msisdn: '0241234567', rows: syntheticCashRows() });
  const st = await parseStatements(await pdfAttachments(eml));
  const base = await extractStatementAuto(st, { llm: null });
  const idx = base.rows.map((r, i) => (r.cls === 'cash_deposit' ? i : -1)).filter((i) => i >= 0);
  const reply = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ rows: [{ i: idx[0], amount: base.rows[idx[0]].amount, class: 'earned_income' }] }) } }] }) });
  const lied = await extractStatementAuto(st, { llm: { url: 'http://x.invalid', model: 'm' }, fetchImpl: reply });
  assert.equal(lied.countedTotal, base.countedTotal);
});

// ---- through a real PDF (pdfmake) and the underwriter -----------------------------------------------------------------

const newWallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const make = (extra = {}) => new InboxedUnderwriter({ resolver, llm: null, ...extra });

test('trader statement (PDF): steady deposits count at 50%, cycled, split, transferred and own-bank deposits do not', async () => {
  const eml = await momoStatementEmail({ msisdn: '0241234567', rows: syntheticCashRows() });
  const st = await parseStatements(await pdfAttachments(eml));
  assert.equal(st.balance.failed.length, 0);
  const x = await extractStatementAuto(st, { llm: null });
  assert.equal(x.totals.cash_deposit.count, 3 + 1 + 5 + 1 + 1); // every CASH IN row is filed as cash
  assert.equal(x.totals.earned_income.count, 0);
  assert.equal(x.cash.counted, TRADER_COUNTED_CASH * CASH_WEIGHT);
  assert.equal(x.cash.cycled, 600 + 500 + 300 + 700);
  assert.equal(x.cash.monthsWithCash, 3);
  assert.equal(x.countedTotal, 1350);
  // and the underwriter now posts a limit for this borrower (before: "no earned income found")
  const r = await make().submit(eml, newWallet());
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.limitUsdc > 8 && r.limitUsdc < 9, String(r.limitUsdc));
});

test('trader looping the same cash every month (PDF): refused, nothing counts', async () => {
  const eml = await momoStatementEmail({ msisdn: '0242222222', rows: syntheticCashLoopRows() });
  const r = await make().submit(eml, newWallet());
  assert.equal(r.ok, false);
  assert.match(r.reason, /no earned income/);
  assert.match(r.reason, /cash/);
});

test('the holder name in the fixture is what the own-bank rule matches', () => {
  assert.equal(SYNTH_HOLDER, 'KOFI KWAME MENSAH');
});

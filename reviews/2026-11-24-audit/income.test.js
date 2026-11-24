import { test } from 'node:test';
import crypto from 'node:crypto';
import { classifyRows, finalizeIncome } from '/home/bills/code/dev3pack/notch/enclave/src/income.js';
import { computeLimit } from '/home/bills/code/dev3pack/notch/enclave/src/underwrite.js';
const DAY = 86400_000, NOW = new Date('2026-11-23T12:00:00Z'), HOLDER = 'ALICE KWAME TEST';
let seq = 0;
const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const row = (o) => ({ page: 1, dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100, fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o });
const run = (rows, label, repaidOnTime = 0) => {
  rows.sort((a, b) => b.date - a.date);
  const c = classifyRows(rows, { holder: HOLDER });
  const f = finalizeIncome(c, { now: NOW });
  const lim = computeLimit(f.events, { now: NOW, signals: f.signals, repaidOnTime });
  console.log(label, 'counted GHS', f.countedTotal, 'cash', JSON.stringify(f.cash), 'limit', lim.limitUsdc, 'monthlyUsd', lim.monthlyUsd);
};
test('cash: one 1000 GHS float, deposit, then P2P transfer out 8 days later, repeat', () => {
  const rows = [];
  for (let d = 88; d >= 1; d -= 8) { const K = 10000;
    rows.push(row({ type: 'CASH IN', party: P(11), acct: 'AGENT ABENA', amount: K, date: at(d, 10) }));
    if (d - 8 >= 0) rows.push(row({ type: 'MOMO USER', party: P(12), acct: 'YAA ASANTEWAA', amount: -K, date: at(d - 8, 9) }));
  }
  run(rows, 'cash-loop', 0); run(rows, 'cash-loop+6 dust repays', 6);
});
test('peer: two helper SIMs send 1000 GHS, holder sends it back 3 days later, 15 times', () => {
  const rows = [];
  for (let d = 88; d >= 5; d -= 9) {
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: 1000, date: at(d) }));
    rows.push(row({ party: P(2), acct: 'AMA B', amount: 1000, date: at(d, 11) }));
    rows.push(row({ party: P(1), acct: 'KOFI A', amount: -1000, date: at(d - 4) }));
    rows.push(row({ party: P(2), acct: 'AMA B', amount: -1000, date: at(d - 4, 11) }));
  }
  run(rows, 'peer-loop', 0); run(rows, 'peer-loop+6 dust repays', 6);
});

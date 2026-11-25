import crypto from 'node:crypto';
import { classifyRows, finalizeIncome } from '/home/bills/code/dev3pack/notch/enclave/src/income.js';
import { computeLimit } from '/home/bills/code/dev3pack/notch/enclave/src/underwrite.js';
const DAY = 86400_000, NOW = new Date('2026-11-23T12:00:00Z'), HOLDER = 'ALICE KWAME TEST';
let seq = 0; const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const row = (o) => ({ page: 1, dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100, fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o });
const run = (label, rows) => { rows.sort((a, b) => b.date - a.date); const f = finalizeIncome(classifyRows(rows, { holder: HOLDER }), { now: NOW });
  console.log(label, 'counted', f.countedTotal, 'limit', computeLimit(f.events, { now: NOW, signals: f.signals }).limitUsdc, JSON.stringify(f.netFlow)); };
for (const [float, payees, step] of [[500, 5, 7], [5000, 5, 7], [50000, 5, 7], [5000, 1, 6], [5000, 1, 4]]) {
  const rows = [];
  for (let d = 88; d >= 2; d -= step) for (let i = 0; i < payees; i++) {
    rows.push(row({ type: 'PAYMENT', acct: 'TILL ' + i, amount: -float, date: at(d + 1, 9 + i) }));
    rows.push(row({ party: P(20 + i), acct: 'FRIEND ' + i, amount: float, date: at(d, 9 + i) }));
  }
  run(`float ${float} x${payees} every ${step}d:`, rows);
}

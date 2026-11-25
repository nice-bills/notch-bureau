import crypto from 'node:crypto';
import { classifyRows, finalizeIncome } from '/home/bills/code/dev3pack/notch/enclave/src/income.js';
import { computeLimit } from '/home/bills/code/dev3pack/notch/enclave/src/underwrite.js';
const DAY = 86400_000, NOW = new Date('2026-11-23T12:00:00Z'), HOLDER = 'ALICE KWAME TEST';
let seq = 0; const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const row = (o) => ({ page: 1, dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100, fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o });
const run = (label, rows) => { rows.sort((a, b) => b.date - a.date); const f = finalizeIncome(classifyRows(rows, { holder: HOLDER }), { now: NOW });
  console.log(label, 'counted', f.countedTotal, 'limit', computeLimit(f.events, { now: NOW, signals: f.signals }).limitUsdc, JSON.stringify(f.netFlow)); };
// same control as the repo test, but the shopping/rent happen 3-4 days BEFORE the peer credits
let rows = [];
for (const d of [80, 50, 20]) {
  rows.push(row({ party: P(1), acct: 'KOFI A', amount: 400, date: at(d) }));
  rows.push(row({ party: P(2), acct: 'AMA B', amount: 400, date: at(d, 11) }));
  rows.push(row({ type: 'PAYMENT', acct: 'SHOPRITE', amount: -500, date: at(d + 3, 12) }));
  rows.push(row({ party: P(4), acct: 'ESI MANU', amount: -300, date: at(d + 4, 12) }));
}
run('spend BEFORE credits:', rows);
rows = [];
for (const d of [80, 50, 20]) {
  rows.push(row({ party: P(1), acct: 'KOFI A', amount: 400, date: at(d) }));
  rows.push(row({ party: P(2), acct: 'AMA B', amount: 400, date: at(d, 11) }));
  rows.push(row({ type: 'PAYMENT', acct: 'SHOPRITE', amount: -500, date: at(d - 3, 12) }));
  rows.push(row({ party: P(4), acct: 'ESI MANU', amount: -300, date: at(d - 4, 12) }));
}
run('spend AFTER credits (repo control):', rows);
// trader: customers pay weekly ~300, trader restocks weekly ~250 at a supplier till two days before
rows = [];
for (let d = 86; d >= 2; d -= 7) {
  rows.push(row({ type: 'PAYMENT', acct: 'MAKOLA WHOLESALE', amount: -250, date: at(d + 2, 12) }));
  rows.push(row({ party: P(10 + (d % 3)), acct: 'CUSTOMER ' + (d % 3), amount: 300, date: at(d) }));
  rows.push(row({ type: 'PAYMENT', acct: 'ECG PREPAID', amount: -60, date: at(d - 1, 12) }));
}
run('weekly trader (restock then sales):', rows);

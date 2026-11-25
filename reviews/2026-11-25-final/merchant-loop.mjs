import crypto from 'node:crypto';
const E = '/home/bills/code/dev3pack/notch/enclave/src/';
const { classifyRows, finalizeIncome } = await import(E + 'income.js');
const { computeLimit } = await import(E + 'underwrite.js');
const DAY = 86400_000, NOW = new Date('2026-11-23T12:00:00Z'), HOLDER = 'ALICE KWAME TEST';
let seq = 0;
const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const at = (days, hh = 10) => new Date(NOW - days * DAY + (hh - 12) * 3600_000);
const row = (o) => ({ page: 1, dateText: '', type: 'MOMO USER', party: '', acct: '', ref: '', amount: 100, fee: 0, tax: 0, balance: 1000, currency: 'GHS', txid: String(++seq), txKey: crypto.randomUUID(), balanceOk: true, future: false, ...o });
// ONE float of K GHS. Loop every 3 days: holder PAYS a cooperating merchant till (MoMoPay), the till owner sends it back
// P2P from one of two personal SIMs (alternating), 1 day later.
for (const K of [1000, 5000]) {
  const rows = [];
  let i = 0;
  for (let d = 88; d >= 2; d -= 3, i++) {
    rows.push(row({ type: 'PAYMENT', acct: 'KOFI PROVISIONS', amount: -K, date: at(d, 12) }));
    const n = 1 + (i % 2);
    rows.push(row({ party: P(n), acct: n === 1 ? 'KOFI A' : 'AMA B', amount: K, date: at(d - 1, 10) }));
  }
  rows.sort((a, b) => b.date - a.date);
  const c = classifyRows(rows, { holder: HOLDER });
  const f = finalizeIncome(c, { now: NOW });
  const lim = computeLimit(f.events, { now: NOW, signals: f.signals, repaidOnTime: 6 });
  console.log(`float ${K} GHS: counted ${f.countedTotal} GHS over 90d, netFlow`, f.netFlow, 'limit (pumped cap)', lim.limitUsdc, 'limit (first-timer)', computeLimit(f.events, { now: NOW, signals: f.signals }).limitUsdc);
}

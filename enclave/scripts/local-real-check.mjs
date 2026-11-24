#!/usr/bin/env node
// LOCAL-ONLY check of a REAL MoMo statement PDF: parse + classify + limit, printing AGGREGATES ONLY.
//
//   node enclave/scripts/local-real-check.mjs /path/to/MomoStatementReport.pdf
//
// Privacy: nothing leaves this machine (no network, no AI reader: rules only), nothing is written into the repo
// (optional --out writes the same aggregates to enclave/local-real-check.out.json, which is git-ignored), and the
// output never contains a name, phone number, counterparty, memo or transaction id: only counts, sums and rates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStatements } from '../src/statement.js';
import { extractStatementAuto } from '../src/llm-extract.js';
import { computeLimit } from '../src/underwrite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node enclave/scripts/local-real-check.mjs <statement.pdf> [--out]');
  process.exit(2);
}
const now = new Date();
const st = await parseStatements([{ content: fs.readFileSync(file) }], { now });
const x = await extractStatementAuto(st, { llm: null, now }); // rules only: the statement is never sent anywhere
const { limitUsdc, monthlyUsd } = computeLimit(x.events, { now, signals: x.signals });
const naive = computeLimit(st.rows.filter((r) => r.amount > 0).map((r) => ({ amount: r.amount, currency: r.currency, date: r.date })), { now });
const r2 = (v) => Math.round(v * 100) / 100;
const spanDays = st.period.from && st.period.to ? Math.round((st.period.to - st.period.from) / 86400_000) : null;

const out = {
  rows: st.rows.length,
  pages: st.pages,
  currency: st.currency,
  spanDays,
  identityFound: !!st.msisdn,
  holderFound: st.holder.split(' ').filter(Boolean).length > 0,
  balanceCheck: {
    linksChecked: st.balance.checked,
    passed: st.balance.passed,
    passRate: r2(st.balance.passed / Math.max(1, st.balance.checked)),
    failedRowNumbers: st.balance.failed, // 1 = newest row; row numbers only
  },
  credits: { count: st.rows.filter((r) => r.amount > 0).length, sum: r2(st.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)) },
  perClass: Object.fromEntries(Object.entries(x.totals).map(([k, v]) => [k, { count: v.count, sum: v.amount }])),
  countedIncomeSum: x.countedTotal,
  regularPeerPayers: x.regularPeers,
  signals: x.signals,
  limit: { monthlyCountedIncomeUsd: monthlyUsd, limitUsdc, ifEveryCreditCounted: naive.limitUsdc, firstTimerCapUsdc: 50 },
};
console.log(JSON.stringify(out, null, 2));
if (args.includes('--out')) fs.writeFileSync(path.join(here, '..', 'local-real-check.out.json'), JSON.stringify(out, null, 2));

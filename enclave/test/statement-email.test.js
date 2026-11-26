// The statement MTN emails on a *170# request (src/statement-email.js). Synthetic PDFs only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readPdf } from '../src/pdf-text.js';
import { parseStatements, identityHash } from '../src/statement.js';
import { isEmailedLayout, mapType } from '../src/statement-email.js';
import { assessRules } from '../src/income.js';
import { computeLimit } from '../src/underwrite.js';
import { InboxedUnderwriter } from './fixtures/inboxed.js';
import { emailedStatementPdf, syntheticRows30 } from './fixtures/momo-emailed-pdf.js';
import {
  resolver, momoStatementEmail, statementPdf, syntheticRows, syntheticCashRows, momoAt, MTN_SIGNED_HEADERS,
} from './fixtures/emails.js';

const parse = async (opts) => parseStatements([{ content: await emailedStatementPdf(opts) }]);
const fixed = (rows) => rows.map((r, i) => ({ ...r, txid: `9${String(1000000000 + i)}` }));
const OTHER = '233244009999';

test('layout detection: only the emailed statement takes the second reader', async () => {
  assert.equal(isEmailedLayout(await readPdf(await emailedStatementPdf())), true);
  assert.equal(isEmailedLayout(await readPdf(await statementPdf())), false);
});

test('30 days: every row, identity, direction from the numbers, 12-hour dates, balances', async () => {
  const s = await parse({ msisdn: '0241234567' });
  assert.equal(s.rows.length, syntheticRows30().length);
  assert.equal(s.msisdn, '233241234567');
  assert.equal(s.holder, 'KOFI KWAME MENSAH');
  assert.equal(s.currency, 'GHS');
  assert.ok(s.period.from < s.period.to);
  assert.equal(s.balance.checked, s.rows.length - 1);
  assert.deepEqual(s.balance.failed, []);
  assert.ok(s.rows.every((r, i) => r.rowOk && (i === 0 || r.date <= s.rows[i - 1].date)));
  const by = (acct) => s.rows.find((r) => r.acct === acct);
  assert.equal(by('PAYSTACK PAYOUT').amount, 1200);
  assert.equal(by('PAYSTACK PAYOUT').party, ''); // no phone number: a system account
  assert.deepEqual([by('ADWOA SERWAA BOATENG').amount, by('ADWOA SERWAA BOATENG').party, by('ADWOA SERWAA BOATENG').type], [150, '233244000001', 'TRANSFER']);
  const rent = by('ESI MANU');
  assert.deepEqual([rent.amount, rent.fee, rent.type, rent.date.getUTCHours()], [-300, 3, 'TRANSFER', 0]); // "12:05:00 AM"
  assert.equal(by('FELIX AGYEMAN').type, 'CASH IN');
  assert.equal(by('MTN AGENT ACCRA').type, 'CASH OUT');
  assert.equal(by('MTN AGENT ACCRA').date.getUTCHours(), 15); // "03:30:00 PM"
  assert.equal(by('SHOPRITE ACCRA MALL').balance, by('SHOPRITE ACCRA MALL').balanceBefore - 181.5);
});

test('a long statement spans pages and gives the same income as the app statement of the same rows', async () => {
  for (const rows of [fixed(syntheticRows()), fixed(syntheticCashRows())]) {
    const emailed = await parse({ rows });
    const app = await parseStatements([{ content: await statementPdf({ rows }) }]);
    assert.ok(emailed.pages >= 2);
    assert.equal(emailed.rows.length, rows.length);
    assert.deepEqual(emailed.balance.failed, []);
    const a = assessRules(emailed);
    const b = assessRules(app);
    assert.deepEqual(a.totals, b.totals);
    assert.equal(a.countedTotal, b.countedTotal);
    // one transaction has one identity, whichever statement it arrives on: it can never count twice
    assert.deepEqual(emailed.rows.map((r) => r.txKey).sort(), app.rows.map((r) => r.txKey).sort());
  }
});

test('trans. type words map to the classes the income rules read', () => {
  assert.equal(mapType('CASH_IN', false).type, 'CASH IN');
  assert.equal(mapType('DEPOSIT', false).type, 'CASH IN');
  assert.equal(mapType('CASH_OUT', true).type, 'CASH OUT');
  assert.equal(mapType('TRANSFER', false).type, 'TRANSFER');
  assert.equal(mapType('PAYMENT_SEND', true).type, 'TRANSFER');
  assert.equal(mapType('PAYMENT', true).type, 'PAYMENT');
  assert.equal(mapType('DEBIT', true).type, 'DEBIT');
  assert.equal(mapType('PAYMENT_REVERSAL', false).type, 'REVERSAL');
  assert.equal(mapType('LOAN_DISBURSEMENT', false).note, 'loan');
  assert.equal(mapType('SPORTS_BETTING', true).note, 'betting');
  assert.equal(mapType('SOMETHING_NEW', true).type, 'TRANSFER'); // unknown money out is never "real spending"
});

test('sanity check: a row whose balances or numbers disagree with its direction never counts', async () => {
  const rows = syntheticRows30();
  const payout = rows[0]; // the oldest row, so the bad one is not hidden by the chain
  const cases = [
    { ...payout, toNo: OTHER }, // neither number is the account's
    { ...payout, shownBefore: 9999 }, // "money in", but the balance fell
  ];
  for (const bad of cases) {
    const s = await parse({ rows: [bad, ...rows.slice(1)], opening: 250 });
    const r = s.rows.at(-1);
    assert.equal(r.rowOk, false);
    assert.equal(r.balanceOk, false);
    assert.ok(!assessRules(s).events.some((e) => e.txKey === r.txKey));
  }
});

test('a statement whose rows mostly do not add up is refused', async () => {
  const rows = syntheticRows30().map((r) => ({ ...r, shownBefore: 1 }));
  await assert.rejects(parse({ rows }), /does not add up/);
});

test('a counterparty name or memo that looks like a row or a header stays in its cell', async () => {
  const rows = syntheticRows30();
  rows[1] = { ...rows[1], acct: '01-Nov-2026 09:00:00 AM 999999', ref: 'MSISDN: 233200000000 HOLDER NAME: X' };
  const s = await parse({ rows });
  assert.equal(s.rows.length, rows.length);
  assert.equal(s.msisdn, '233241234567');
  assert.equal(s.holder, 'KOFI KWAME MENSAH');
  assert.equal(s.rows.find((r) => r.party === '233244000001').amount, 150);
});

test('end to end: an MTN-signed email of the 30-day statement gives the limit the unchanged rule computes', async () => {
  const eml = await momoStatementEmail({ pdf: await emailedStatementPdf({ msisdn: '0241112223' }), headerList: MTN_SIGNED_HEADERS });
  const u = new InboxedUnderwriter({ resolver, llm: null });
  const r = await u.submit(eml, bs58.encode(nacl.sign.keyPair().publicKey), { issuedAt: Date.now() - 5 * 60_000 });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(Buffer.from(r.message, 'base64').subarray(96, 128), identityHash('233241112223'));
  const x = assessRules(await parse({ msisdn: '0241112223' }));
  assert.equal(x.signals.monthsWithIncome, 1);
  assert.equal(r.limitUsdc, computeLimit(x.events, { signals: x.signals }).limitUsdc);
  // one month of income is still averaged over three, and scaled by 0.5 + 0.5 * 1/3: nothing is inflated
  assert.ok(computeLimit(x.events, {}).monthlyUsd <= (1200 * 0.065) / 3 + 0.01);
});

test('30 days of peers and one-off cash alone count nothing', async () => {
  const rows = syntheticRows30().filter((r) => r.acct !== 'PAYSTACK PAYOUT');
  const x = assessRules(await parse({ rows, from: momoAt(30) }));
  assert.equal(x.events.filter((e) => e.cls === 'earned_income').length, 0);
});

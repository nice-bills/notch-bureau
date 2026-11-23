// Mobile-money statement PDF -> credit rows + the account's phone number.
//
// Layout modelled here (MTN MoMo Ghana "MomoStatementReport.pdf" - modelled, NOT yet checked against a real
// file; see README SOURCES): a header block (title, account name, "Mobile Number: ...", period, currency),
// then a table whose header row names the columns, then one row per transaction:
//
//   Date | Transaction ID | Type | From/To | Amount | Fee | Balance
//
// SECURITY MODEL. The PDF is signed by the provider, but several cells are written by other people (the
// counterparty name, the memo). So:
//   * the columns come from the table's own header row, and a transaction row is a line whose FIRST
//     column holds a date: wrapped memo text sits in the From/To column and is never a row;
//   * the amount is read only from the Amount column. Fee and Balance columns are ignored, and so is
//     everything in the free-text columns;
//   * a row is income only when its Type is on the credit list (cash-in, incoming transfer, salary ...).
//     Debits, fees, airtime and anything unknown are ignored (fail closed);
//   * the phone number is read only from the header block above the table, and only from a line that
//     STARTS with its label.
import crypto from 'node:crypto';
import { readPdf } from './pdf-text.js';

export class StatementError extends Error {}

const CREDIT_TYPES = new Set([
  'CASH_IN', 'TRANSFER_IN', 'PAYMENT_RECEIVED', 'RECEIVE_MONEY', 'MONEY_RECEIVED', 'SALARY', 'DEPOSIT',
  'MERCHANT_CREDIT', 'BULK_CREDIT', 'DISBURSEMENT_IN',
]);

// Header-cell keyword -> column key. First match per key wins, left to right.
const COLUMN_WORDS = [
  ['date', /^(?:transaction\s+)?date\b/i],
  ['txid', /^(?:financial\s+)?(?:transaction|txn|trans)\.?\s*(?:id|no|number|ref)\b|^(?:id|reference)$/i],
  ['type', /^(?:transaction\s+)?(?:type|description)\b/i],
  ['party', /^(?:from\s*\/\s*to|from|to|counterparty|details|narration|message)\b/i],
  ['amount', /^amount\b/i],
  ['fee', /^(?:fees?|charges?)\b/i],
  ['balance', /^(?:balance|bal)\b/i],
];
const DATE_CELL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$|^(\d{2})[/-](\d{2})[/-](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const MONEY_CELL = /^([+-])?\s*(?:(GHS|GH₵|USD|NGN|KES|EUR|GBP)\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\d)\s*$/i;
const LABELLED_NUMBER = /^(?:mobile|phone|msisdn|wallet|account)\s*(?:number|no\.?|#)?\s*:\s*(\+?\d[\d\s-]{7,16}\d)$/i;
const CURRENCY_LINE = /^currency\s*:\s*([A-Za-z]{3})$/i;
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,39}$/;
const MAX_ROWS = 5000;

// Parse every PDF in `pdfs` ([{ content }]) and merge. Throws StatementError with a user-safe reason.
export async function parseStatements(pdfs, { now = new Date(), defaultCurrency = 'GHS', countryCode = '233' } = {}) {
  if (!pdfs.length) throw new StatementError('the email has no PDF statement attached');
  const out = { credits: [], text: '', msisdn: null, rows: 0 };
  const numbers = new Set();
  for (const pdf of pdfs) {
    let doc;
    try {
      doc = await readPdf(pdf.content);
    } catch (e) {
      throw new StatementError(e.message);
    }
    const one = parseStatement(doc, { now, defaultCurrency, countryCode });
    if (one.msisdn) numbers.add(one.msisdn);
    out.credits.push(...one.credits);
    out.rows += one.rows;
    out.text += `${one.text}\n`;
  }
  if (numbers.size === 0) throw new StatementError('could not find the account phone number in the statement');
  if (numbers.size > 1) throw new StatementError('the attached statements belong to different phone numbers');
  out.msisdn = [...numbers][0];
  // The same transaction can appear in two attached statements; count it once.
  const seen = new Set();
  out.credits = out.credits.filter((c) => !seen.has(c.txKey) && seen.add(c.txKey));
  return out;
}

export function parseStatement(doc, { now = new Date(), defaultCurrency = 'GHS', countryCode = '233' } = {}) {
  const { lines } = doc;
  const head = lines.findIndex((l) => columnsOf(l));
  if (head < 0) throw new StatementError('no transaction table found in the statement');
  const cols = columnsOf(lines[head]);

  // ---- header block: phone number + currency (above the table only)
  const numbers = new Set();
  let currency = null;
  for (const l of lines.slice(0, head)) {
    const t = l.items.map((i) => i.str).join(' ').trim();
    const num = t.match(LABELLED_NUMBER);
    if (num) {
      const n = normalizeMsisdn(num[1], countryCode);
      if (n) numbers.add(n);
    }
    const cur = t.match(CURRENCY_LINE);
    if (cur && !currency) currency = cur[1].toUpperCase();
  }
  const amountHeader = lines[head].items.find((i) => COLUMN_WORDS[4][1].test(i.str))?.str || '';
  currency = currency || amountHeader.match(/\(([A-Za-z]{3})\)/)?.[1]?.toUpperCase() || defaultCurrency;
  if (numbers.size > 1) throw new StatementError('the statement names more than one phone number');

  // ---- table rows
  const credits = [];
  const textLines = [];
  let rows = 0;
  for (const l of lines.slice(head)) {
    textLines.push(l.items.map((i) => i.str).join('  '));
    if (l === lines[head] || !isRowStart(l, cols)) continue;
    const cell = cellsOf(l, cols);
    const at = parseDate(cell.date);
    const money = parseMoney(cell.amount);
    if (!at || !money) continue;
    if (++rows > MAX_ROWS) throw new StatementError('statement has too many rows');
    const type = String(cell.type || '').toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
    if (!CREDIT_TYPES.has(type) || money.sign === '-') continue;
    if (at.getTime() > now.getTime() + 86400_000) continue; // a statement cannot describe the future
    const txid = TX_ID.test(cell.txid || '') ? cell.txid : null;
    // Row identity for double-count protection: overlapping statements repeat the same rows.
    const txKey = crypto.createHash('sha256').update(`${txid || `${cell.date}|${type}|${money.value}|${cell.balance || ''}`}`).digest('hex');
    credits.push({
      amount: money.value,
      currency: money.currency || currency,
      date: at > now ? now : at,
      kind: type === 'SALARY' ? 'salary' : type === 'CASH_IN' || type === 'DEPOSIT' ? 'other_credit' : 'transfer_in',
      txKey,
      amountText: cell.amount.replace(/^[+-]\s*/, ''),
    });
  }
  return { credits, text: textLines.join('\n'), msisdn: numbers.size ? [...numbers][0] : null, rows };
}

// ---- identity -------------------------------------------------------------------------------------

// E.164 digits without '+'. Local Ghana numbers (0XXXXXXXXX or 9 digits) get the country code.
export function normalizeMsisdn(raw, countryCode = '233') {
  let d = String(raw).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith(countryCode) && d.length === countryCode.length + 9) return d;
  if (d.startsWith('0') && d.length === 10) return countryCode + d.slice(1);
  if (d.length === 9) return countryCode + d;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

// The on-chain identity key. `pepper` is optional and secret: with it, the hash cannot be reversed by trying
// every phone number (there are only ~10^9 of them); without it this is exactly sha256("notch-msisdn"|number).
export function identityHash(msisdn, pepper = '') {
  return crypto.createHash('sha256').update(`notch-msisdn|${pepper ? `${pepper}|` : ''}${msisdn}`).digest();
}

// ---- table geometry -------------------------------------------------------------------------------

function columnsOf(line) {
  const cols = {};
  for (const it of line.items) {
    for (const [key, re] of COLUMN_WORDS) {
      if (re.test(it.str) && !(key in cols)) { cols[key] = it.x; break; }
    }
  }
  return 'date' in cols && 'amount' in cols && 'type' in cols ? cols : null;
}

function cellsOf(line, cols) {
  const order = Object.entries(cols).sort((a, b) => a[1] - b[1]);
  const cells = {};
  for (const it of line.items) {
    let key = null;
    for (const [k, x] of order) if (it.x >= x - 3) key = k;
    if (key) cells[key] = cells[key] ? `${cells[key]} ${it.str}` : it.str;
  }
  return cells;
}

// A row starts with a date in the first (Date) column; nothing else qualifies.
function isRowStart(line, cols) {
  const first = line.items[0];
  return !!first && Math.abs(first.x - cols.date) <= 6 && DATE_CELL.test(cellsOf(line, cols).date || '');
}

function parseDate(text) {
  const m = DATE_CELL.exec(text || '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m[1]
    ? [m[1], m[2], m[3], m[4], m[5], m[6]]
    : [m[9], m[8], m[7], m[10], m[11], m[12]]; // DD/MM/YYYY
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0)));
  return Number.isNaN(date.getTime()) || date.getUTCMonth() !== +mo - 1 ? null : date;
}

function parseMoney(text) {
  const m = MONEY_CELL.exec(String(text || '').trim());
  if (!m) return null;
  const value = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const cur = m[2] && (m[2].toUpperCase() === 'GH₵' ? 'GHS' : m[2].toUpperCase());
  return { sign: m[1] || '', value, currency: cur || null };
}

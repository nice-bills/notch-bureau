// Mobile-money statement PDF -> transaction rows + the account's identity (wallet number, holder).
//
// Layout (MTN MoMo Ghana, read from a REAL statement on 2026-11-23, made with pdfmake): a header block
// ("Account holder:", "Wallet number:", "From date:", "To date:" ...), an "Available balance GHS x" line, then a table
// repeated on every page whose header row names the columns
//
//   Date & Time | Payment Type | To/From | Account Name | Amount (+/-) | Transaction ID | Fees | Tax | Balance | Reference
//
// Rows run newest first. Dates look like "5 Nov 2026 14:32" (the day is NOT zero padded). The Amount carries its sign;
// Fees, Tax and Balance carry "GHS ". Long cells wrap onto extra lines in their own column. The row rule is
//
//   balance(row) - balance(next older row) = amount - fees - tax
//
// and the parser checks it on every row (see `balance` in the result); a row that breaks it is reported, and a
// credit on such a row never counts as income.
//
// SECURITY MODEL. The PDF is not signed, the DKIM signature on the email is (and covers the PDF bytes). Even so, several
// cells are written by other people (the counterparty's registered name, the memo), so:
//   * columns come from the table's own header row; a transaction row is a line whose FIRST column holds a date, so a
//     memo that wraps onto a new line stays in its column and can never pass for a row;
//   * the amount is read only from the Amount column (signed); the identity only from the header block, only from the
//     value next to its label;
//   * free text is handed on as data. src/income.js lets it LOWER what a credit counts for, never raise it.
import crypto from 'node:crypto';
import { readPdf } from './pdf-text.js';

export class StatementError extends Error {}

// Header-cell keyword -> column key. First match per key wins, left to right.
const COLUMN_WORDS = [
  ['date', /^(?:transaction\s+)?date\b/i],
  ['type', /^(?:payment\s+)?type\b|^payment$/i],
  ['party', /^(?:to\s*\/\s*from|from\s*\/\s*to)\b/i],
  ['acct', /^account\b/i],
  ['amount', /^amount\b/i],
  ['txid', /^(?:financial\s+)?(?:transaction|txn)\s*(?:id|no|number)\b|^transaction$/i],
  ['fees', /^(?:fees?|charges?)\b/i],
  ['tax', /^(?:tax|e-?levy|levy)\b/i],
  ['balance', /^(?:balance|bal)\b/i],
  ['ref', /^(?:reference|narration|memo|message)\b/i],
];
const REQUIRED = ['date', 'type', 'amount', 'txid', 'balance'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "5 Nov 2026 14:32" | "05 Nov 2026 14:32:10" | "2026-11-05 14:32:10" | "05/11/2026 14:32"
const DATE_CELL = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$|^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$|^(\d{2})[/-](\d{2})[/-](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const AMOUNT_CELL = /^([+-])\s*(?:(GHS|GH₵|USD|NGN|KES|EUR|GBP)\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i;
const PLAIN_MONEY = /^(?:(GHS|GH₵|USD|NGN|KES|EUR|GBP)\s*)?(-)?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i;
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,39}$/;
const PAGE_FOOTER = /^Page\s+\d+\s+of\s+\d+$/i;
const MAX_ROWS = 5000;
const CHAIN_TOLERANCE = 0.005;
// More than this share of rows breaking the running-balance rule means we are not reading the table correctly.
// (One misread cell breaks two links: its own and its newer neighbour's.)
export const MAX_CHAIN_FAILURE_SHARE = 0.1;

// Parse every PDF in `pdfs` ([{ content }]) and merge. Throws StatementError with a user-safe reason.
export async function parseStatements(pdfs, { now = new Date(), defaultCurrency = 'GHS', countryCode = '233' } = {}) {
  if (!pdfs.length) throw new StatementError('the email has no PDF statement attached');
  const parts = [];
  for (const pdf of pdfs) {
    let doc;
    try {
      doc = await readPdf(pdf.content);
    } catch (e) {
      throw new StatementError(e.message);
    }
    parts.push(parseStatement(doc, { now, defaultCurrency, countryCode }));
  }
  const numbers = new Set(parts.map((p) => p.msisdn).filter(Boolean));
  if (numbers.size === 0) throw new StatementError('could not find the account phone number in the statement');
  if (numbers.size > 1) throw new StatementError('the attached statements belong to different phone numbers');
  const currencies = new Set(parts.map((p) => p.currency));
  if (currencies.size > 1) throw new StatementError('the attached statements use different currencies');

  // The same transaction can appear in two attached statements; keep it once, newest first.
  const seen = new Set();
  const rows = parts.flatMap((p) => p.rows).filter((r) => !seen.has(r.txKey) && seen.add(r.txKey));
  rows.sort((a, b) => b.date - a.date); // stable: rows of one minute keep the order the statement printed them in
  const balance = checkBalances(rows);
  if (rows.length && balance.failed.length / rows.length > MAX_CHAIN_FAILURE_SHARE) {
    throw new StatementError(`the statement table does not add up (${balance.failed.length} of ${rows.length} rows break the running balance), so it cannot be read reliably`);
  }
  return {
    rows,
    msisdn: [...numbers][0],
    holder: parts.map((p) => p.holder).find(Boolean) || '',
    currency: [...currencies][0],
    period: { from: minDate(parts.map((p) => p.from)), to: maxDate(parts.map((p) => p.to)) },
    text: parts.map((p) => p.text).join('\n'),
    pages: parts.reduce((s, p) => s + p.pages, 0),
    balance,
  };
}

export function parseStatement(doc, { now = new Date(), defaultCurrency = 'GHS', countryCode = '233' } = {}) {
  const { lines } = doc;
  const first = lines.findIndex((l) => columnsOf(l));
  if (first < 0) throw new StatementError('no transaction table found in the statement');

  // ---- header block (above the first table header only)
  const head = readHeader(lines.slice(0, first), countryCode);

  // ---- table: the header row repeats on every page, rows follow, "Page N of M" closes the table on a page
  const rows = [];
  const textLines = [];
  let cols = null;
  let cur = null; // the row being filled (continuation lines belong to it)
  let inTable = false;
  for (const l of lines.slice(first)) {
    const header = columnsOf(l);
    if (header) { cols = header; cur = null; inTable = true; continue; }
    if (l.items.some((i) => PAGE_FOOTER.test(i.str))) { cur = null; inTable = false; continue; }
    if (!inTable) continue;
    textLines.push(l.items.map((i) => i.str).join('  '));
    if (isRowStart(l, cols)) {
      if (rows.length >= MAX_ROWS) throw new StatementError('statement has too many rows');
      cur = { page: l.page, cells: {} };
      rows.push(cur);
    } else if (!cur || cur.page !== l.page) {
      continue; // second header line ("Time", "Type", ...) or stray text: not part of any row
    }
    addToCells(cur.cells, l, cols);
  }

  const out = [];
  for (const r of rows) {
    const row = buildRow(r.cells, r.page, { defaultCurrency, now, countryCode });
    if (row) out.push(row);
  }
  if (out.length < rows.length) throw new StatementError(`could not read ${rows.length - out.length} of ${rows.length} transaction rows (unexpected cell format)`);
  const currencies = new Set(out.map((r) => r.currency));
  if (currencies.size > 1) throw new StatementError('the statement mixes currencies');
  const currency = out[0]?.currency || head.currency || defaultCurrency;
  // The statement is newest-first; accept the other order too.
  if (out.length > 1 && out[0].date < out[out.length - 1].date) out.reverse();
  return {
    rows: out,
    msisdn: head.msisdn,
    holder: head.holder,
    currency,
    from: head.from,
    to: head.to,
    available: head.available,
    text: textLines.join('\n'),
    pages: doc.pages,
  };
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

// ---- header block ---------------------------------------------------------------------------------

const LABEL = /^(account holder|wallet number|mobile number|phone number|from date|to date|duration|profile|available balance)\s*:?$/i;

function readHeader(lines, countryCode) {
  const out = { msisdn: null, holder: '', currency: null, from: null, to: null, available: null };
  const numbers = new Set();
  for (let i = 0; i < lines.length; i++) {
    const items = lines[i].items;
    for (let k = 0; k < items.length; k++) {
      const m = LABEL.exec(items[k].str);
      if (!m) continue;
      const label = m[1].toLowerCase();
      const next = items.slice(k + 1).find((it) => it.x > items[k].x + 5);
      const value = next && !LABEL.test(next.str) ? next : null;
      if (!value) continue;
      if (label === 'wallet number' || label === 'mobile number' || label === 'phone number') {
        const n = normalizeMsisdn(value.str, countryCode);
        if (n) numbers.add(n);
      } else if (label === 'account holder') {
        // the name wraps: keep taking the value column on the next lines until another label starts
        const parts = [value.str];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].items.some((it) => Math.abs(it.x - items[k].x) <= 4)) break;
          const cont = lines[j].items.find((it) => Math.abs(it.x - value.x) <= 4);
          if (!cont) break;
          parts.push(cont.str);
        }
        out.holder = parts.join(' ').replace(/\s+/g, ' ').trim().toUpperCase();
      } else if (label === 'from date') out.from = parseDate(value.str);
      else if (label === 'to date') out.to = parseDate(value.str);
    }
    // "Available balance GHS 1,321.04" is one item
    for (const it of items) {
      const m = /^available balance\s+(?:(GHS|USD|NGN|KES|EUR|GBP)\s*)?([\d,]+(?:\.\d{1,2})?)$/i.exec(it.str);
      if (m) {
        out.available = Number(m[2].replace(/,/g, ''));
        out.currency = (m[1] || '').toUpperCase() || out.currency;
      }
    }
  }
  if (numbers.size > 1) throw new StatementError('the statement names more than one phone number');
  out.msisdn = numbers.size ? [...numbers][0] : null;
  return out;
}

// ---- table geometry -------------------------------------------------------------------------------

function columnsOf(line) {
  const cols = {};
  for (const it of line.items) {
    for (const [key, re] of COLUMN_WORDS) {
      if (re.test(it.str) && !(key in cols)) { cols[key] = it.x; break; }
    }
  }
  return REQUIRED.every((k) => k in cols) ? cols : null;
}

function addToCells(cells, line, cols) {
  const order = Object.entries(cols).sort((a, b) => a[1] - b[1]);
  for (const it of line.items) {
    let key = null;
    for (const [k, x] of order) if (it.x >= x - 3) key = k;
    if (key) cells[key] = cells[key] ? `${cells[key]} ${it.str}` : it.str;
  }
}

// A row starts with a date in the first (Date) column; nothing else qualifies.
function isRowStart(line, cols) {
  const first = line.items[0];
  return !!first && Math.abs(first.x - cols.date) <= 6 && !!DATE_CELL.test(first.str);
}

function buildRow(cell, page, { defaultCurrency, now, countryCode }) {
  const date = parseDate(cell.date);
  const amt = AMOUNT_CELL.exec(String(cell.amount || '').trim());
  const bal = parsePlain(cell.balance);
  if (!date || !amt || !bal) return null;
  const fee = cell.fees ? parsePlain(cell.fees) : { value: 0 };
  const tax = cell.tax ? parsePlain(cell.tax) : { value: 0 };
  if (!fee || !tax) return null;
  const amount = (amt[1] === '-' ? -1 : 1) * Number(amt[3].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount === 0) return null;
  const currency = normCur(amt[2]) || bal.currency || defaultCurrency;
  const txid = TX_ID.test(cell.txid || '') ? cell.txid : null;
  const dateText = String(cell.date).trim();
  const partyDigits = String(cell.party || '').replace(/\D/g, '');
  return {
    page,
    date,
    future: date.getTime() > now.getTime() + 86400_000, // a statement cannot describe the future: such a row never counts
    dateText,
    type: String(cell.type || '').trim().toUpperCase().replace(/\s+/g, ' '),
    // The counterparty's phone number when it is one; short codes ("9") and empty cells mean a system account.
    party: partyDigits.length >= 9 ? (normalizeMsisdn(partyDigits, countryCode) || partyDigits) : '',
    acct: String(cell.acct || '').replace(/\s+/g, ' ').trim(),
    ref: String(cell.ref || '').replace(/\s+/g, ' ').trim(),
    amount,
    fee: fee.value,
    tax: tax.value,
    balance: bal.signed,
    currency,
    txid,
    // Row identity (overlapping statements repeat rows). The same id can appear on a transfer and on its fee row.
    txKey: crypto.createHash('sha256').update(`${txid || ''}|${dateText}|${amount}|${bal.signed}`).digest('hex'),
  };
}

// ---- running-balance check ------------------------------------------------------------------------

// rows are newest first. For each row with an older neighbour: balance - olderBalance == amount - fee - tax.
// A row that breaks it (a misread cell, or rows missing from the statement) is listed in `failed` by row number
// (1 = newest) and its credit never counts as income. The oldest row has no neighbour and is not checked.
export function checkBalances(rows) {
  const failed = [];
  let checked = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    checked++;
    const r = rows[i];
    const diff = Math.round((r.balance - rows[i + 1].balance) * 100) / 100;
    const want = Math.round((r.amount - r.fee - r.tax) * 100) / 100;
    r.balanceOk = Math.abs(diff - want) <= CHAIN_TOLERANCE;
    if (!r.balanceOk) failed.push(i + 1);
  }
  if (rows.length) rows[rows.length - 1].balanceOk = true; // nothing older to compare with: judged by its own cells only
  return { checked, passed: checked - failed.length, failed };
}

// ---- cells ----------------------------------------------------------------------------------------

function normCur(c) {
  if (!c) return null;
  const u = c.toUpperCase();
  return u === 'GH₵' ? 'GHS' : u;
}

function parsePlain(text) {
  const m = PLAIN_MONEY.exec(String(text || '').trim());
  if (!m) return null;
  const value = Number(m[3].replace(/,/g, ''));
  return Number.isFinite(value) ? { value, signed: m[2] ? -value : value, currency: normCur(m[1]) } : null;
}

function parseDate(text) {
  const m = DATE_CELL.exec(String(text || '').trim());
  if (!m) return null;
  let y; let mo; let d; let h; let mi; let s;
  if (m[1]) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined) return null;
    [d, mo, y, h, mi, s] = [m[1], mon + 1, m[3], m[4], m[5], m[6]];
  } else if (m[7]) {
    [y, mo, d, h, mi, s] = [m[7], m[8], m[9], m[10], m[11], m[12]];
  } else {
    [d, mo, y, h, mi, s] = [m[13], m[14], m[15], m[16], m[17], m[18]]; // DD/MM/YYYY
  }
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0)));
  return Number.isNaN(date.getTime()) || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d ? null : date;
}

const minDate = (ds) => ds.filter(Boolean).sort((a, b) => a - b)[0] || null;
const maxDate = (ds) => ds.filter(Boolean).sort((a, b) => b - a)[0] || null;

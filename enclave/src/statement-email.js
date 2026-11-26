// The statement MTN MoMo Ghana EMAILS when it is requested over *170# -> the same rows src/statement.js produces.
//
// Layout (read from a real emailed statement on 2026-11-26): a wide landscape page, a header block on every page
// ("From:" / "To:" dates, "MSISDN:", "ACCOUNT HOLDER NAME:"), then a table with DRAWN cell borders whose header row is
//
//   TRANSACTION DATE | FROM ACCT | FROM NAME | FROM NO. | TRANS. TYPE | AMOUNT | FEES | E-LEVY | BAL BEFORE | BAL AFTER |
//   TO NO. | TO NAME | TO ACCT | F_ID | REF | OVA
//
// Rows run newest first, dates look like "05-Nov-2026 02:32:10 PM", amounts are unsigned with no currency (GHS) and
// text is centred in its cell, wrapping both up and down from the row's middle.
//
// DIRECTION comes from the phone numbers: money IN when TO NO. is the account's MSISDN, money OUT when FROM NO. is.
// BAL BEFORE / BAL AFTER are the account's own balance, so every row is checked against them:
//   after - before = (in: +amount, out: -amount) - fees - e-levy
// A row where neither number (or both) is the account's, or whose balances disagree with its direction, is marked
// `rowOk: false`: its credit never counts (src/statement.js checkBalances), and too many of them refuse the statement.
//
// SECURITY MODEL: the same as src/statement.js. Cells are the rectangles the PDF itself draws, so a name or memo,
// however it wraps, stays in its own cell: it can never become a row, a number or an amount. A counterparty with a
// phone number is a person (`party`); only one without can be a system account. REF and OVA go to `ref`, which
// src/income.js only ever uses to LOWER what a credit counts for.
import crypto from 'node:crypto';
import { StatementError, normalizeMsisdn } from './statement.js';

const TITLES = [
  ['date', 'TRANSACTION DATE'], ['fromAcct', 'FROM ACCT'], ['fromName', 'FROM NAME'], ['fromNo', 'FROM NO.'],
  ['type', 'TRANS. TYPE'], ['amount', 'AMOUNT'], ['fees', 'FEES'], ['tax', 'E-LEVY'], ['before', 'BAL BEFORE'],
  ['after', 'BAL AFTER'], ['toNo', 'TO NO.'], ['toName', 'TO NAME'], ['toAcct', 'TO ACCT'], ['txid', 'F_ID'],
  ['ref', 'REF'], ['ova', 'OVA'],
];
const squash = (s) => String(s).replace(/\s+/g, '').toUpperCase();
const HEADER_LINE = squash(TITLES.map(([, t]) => t).join(''));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_CELL = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i;
const MONEY = /^(?:(?:GHS|GH₵)\s*)?-?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i;
const SIGNED_MONEY = /^(?:(?:GHS|GH₵)\s*)?(-?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)$/i;
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,39}$/;
const TOLERANCE = 0.005;
const MAX_ROWS = 5000;

const isHeaderLine = (line) => squash(line.items.map((i) => i.str).join('')) === HEADER_LINE;

// True when the document's table header is this layout's (the whole line, nothing else on it).
export const isEmailedLayout = (doc) => doc.lines.some(isHeaderLine);

// TRANS. TYPE -> the type words src/income.js reads. `note` is added to the memo, where it can only lower a credit.
// An unrecognised outgoing type is treated as a transfer: it never counts as real spending.
export function mapType(raw, out) {
  const t = String(raw || '').toUpperCase().replace(/[_\s-]+/g, ' ').trim();
  if (/REVERS|REFUND/.test(t)) return { type: 'REVERSAL' };
  if (/LOAN|LENDING/.test(t)) return { type: t, note: 'loan' };
  if (/\bBET|GAMING|LOTTERY/.test(t)) return { type: t, note: 'betting' };
  if (/^CASH ?IN$|DEPOSIT/.test(t)) return { type: 'CASH IN' };
  if (/^CASH ?OUT$|WITHDRAW/.test(t)) return { type: 'CASH OUT' };
  if (/TRANSFER|SEND/.test(t)) return { type: 'TRANSFER' };
  if (/^(PAYMENT|DEBIT|AIRTIME|BUNDLE|DATA BUNDLE|BILL( PAYMENT)?|MERCHANT( PAYMENT)?)$/.test(t)) return { type: t };
  return { type: out ? 'TRANSFER' : t };
}

export function parseEmailedStatement(doc, { now = new Date(), countryCode = '233' } = {}) {
  const head = readHeader(doc, countryCode);
  if (!head.msisdn) throw new StatementError('could not find the account phone number in the statement');

  const cells = [];
  const textLines = [];
  for (let n = 1; n <= doc.pages; n++) {
    const lines = doc.lines.filter((l) => l.page === n);
    const header = lines.find(isHeaderLine);
    if (!header) continue;
    const items = lines.flatMap((l) => l.items);
    const { h, v } = doc.rules[n - 1];
    const cols = columnsOf(header, v);
    const top = h.filter((y) => y < header.y).sort((a, b) => b - a); // the header row's bottom border, then each row's
    const used = new Set();
    for (let b = 0; b + 1 < top.length; b++) {
      const inside = items.filter((i) => i.y < top[b] && i.y > top[b + 1]);
      if (!inside.length) continue;
      const cell = {};
      for (const { key, left, right } of cols) {
        const mine = inside.filter((i) => i.x + i.w / 2 > left && i.x + i.w / 2 <= right);
        mine.forEach((i) => used.add(i));
        mine.sort((a, z) => (Math.abs(a.y - z.y) > 2.5 ? z.y - a.y : a.x - z.x));
        cell[key] = mine.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      }
      if (cells.length >= MAX_ROWS) throw new StatementError('statement has too many rows');
      cells.push({ page: n, ...cell });
      textLines.push(TITLES.map(([k]) => cell[k]).filter(Boolean).join('  '));
    }
    // A date under the header that no row claimed means the table was not read: fail rather than drop money silently.
    const dateCol = cols.find((c) => c.key === 'date');
    const lost = items.some((i) => !used.has(i) && i.y < header.y && /^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(i.str)
      && i.x + i.w / 2 > dateCol.left && i.x + i.w / 2 <= dateCol.right);
    if (lost) throw new StatementError('could not read some transaction rows (a row lies outside the table borders)');
  }

  const rows = cells.map((c) => buildRow(c, head.msisdn, { now, countryCode }));
  const bad = rows.filter((r) => !r).length;
  if (bad) throw new StatementError(`could not read ${bad} of ${rows.length} transaction rows (unexpected cell format)`);
  if (rows.length > 1 && rows[0].date < rows[rows.length - 1].date) rows.reverse(); // newest first
  return {
    rows,
    msisdn: head.msisdn,
    holder: head.holder,
    currency: 'GHS',
    from: head.from,
    to: head.to,
    available: rows[0]?.balance ?? null,
    text: textLines.join('\n'),
    pages: doc.pages,
  };
}

// Header block: only lines ABOVE the table header, on every page; the value follows its label on the same line.
function readHeader(doc, countryCode) {
  const out = { msisdn: null, holder: '', from: null, to: null };
  const numbers = new Set();
  const closed = new Set(); // pages whose table has started
  for (const line of doc.lines) {
    if (isHeaderLine(line)) closed.add(line.page);
    if (closed.has(line.page)) continue;
    const text = line.items.map((i) => i.str).join(' ');
    for (const [, digits] of text.matchAll(/\bMSISDN\s*:\s*\+?(\d{9,15})\b/gi)) {
      const n = normalizeMsisdn(digits, countryCode);
      if (n) numbers.add(n);
    }
    out.holder ||= (/\bHOLDER\s+NAME\s*:\s*(.+)$/i.exec(text)?.[1] || '').replace(/\s+/g, ' ').trim().toUpperCase();
    out.from ??= parseDate(/\bFrom\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(text)?.[1]);
    out.to ??= parseDate(/\bTo\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(text)?.[1]);
  }
  if (numbers.size > 1) throw new StatementError('the statement names more than one phone number');
  out.msisdn = numbers.size ? [...numbers][0] : null;
  return out;
}

// The drawn vertical borders cut the page into cells; each title names the cell it is centred in.
function columnsOf(header, v) {
  const edges = [...v].sort((a, b) => a - b);
  const letters = header.items.flatMap((i) => [...squash(i.str)].map(() => i)); // which item holds each header letter
  let at = 0;
  const cols = TITLES.map(([key, title]) => {
    const len = squash(title).length;
    const words = letters.slice(at, at + len);
    at += len;
    const centre = (words[0].x + words[words.length - 1].x + words[words.length - 1].w) / 2;
    const right = edges.findIndex((x) => x > centre);
    if (right <= 0) throw new StatementError('could not read the statement table (its column borders are missing)');
    return { key, left: edges[right - 1], right: edges[right] };
  });
  if (new Set(cols.map((c) => c.left)).size !== cols.length) throw new StatementError('could not read the statement table (its column borders are missing)');
  return cols;
}

function buildRow(c, msisdn, { now, countryCode }) {
  const date = parseDate(c.date);
  const amount = money(c.amount);
  const fee = c.fees ? money(c.fees) : 0;
  const tax = c.tax ? money(c.tax) : 0;
  const before = signedMoney(c.before);
  const after = signedMoney(c.after);
  if (!date || !amount || fee === null || tax === null || before === null || after === null) return null;

  const number = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    return d.length >= 9 ? (normalizeMsisdn(d, countryCode) || d) : ''; // short codes and empty cells: a system account
  };
  const toMe = number(c.toNo) === msisdn;
  const fromMe = number(c.fromNo) === msisdn;
  const delta = round2(after - before);
  const known = toMe !== fromMe;
  const out = known ? fromMe : delta <= 0;
  const signed = out ? -amount : amount;
  const adds = (f, t) => Math.abs(delta - (signed - f - t)) <= TOLERANCE;
  // on money in, a printed fee may be the sender's: it is charged here only when the balances say so
  const charged = !out && !adds(fee, tax) && adds(0, 0) ? { fee: 0, tax: 0 } : { fee, tax };

  const { type, note } = mapType(c.type, out);
  // written the way the app statement prints dates, so a row that appears on both statements has one identity
  const dateText = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  const txid = TX_ID.test(c.txid || '') ? c.txid : null;
  return {
    page: c.page,
    date,
    future: date.getTime() > now.getTime() + 86400_000,
    dateText,
    type,
    party: number(out ? c.toNo : c.fromNo),
    acct: out ? c.toName : c.fromName,
    ref: [c.ref === '-' ? '' : c.ref, c.ova, note].filter(Boolean).join(' '),
    amount: signed,
    fee: charged.fee,
    tax: charged.tax,
    balance: after,
    balanceBefore: before,
    rowOk: known && adds(charged.fee, charged.tax),
    currency: 'GHS',
    txid,
    txKey: crypto.createHash('sha256').update(`${txid || ''}|${dateText}|${signed}|${after}`).digest('hex'),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

function money(text) {
  const m = MONEY.exec(String(text || '').trim());
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function signedMoney(text) {
  const m = SIGNED_MONEY.exec(String(text || '').trim());
  return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '')) : null;
}

function parseDate(text) {
  const m = DATE_CELL.exec(String(text || '').trim());
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  let hour = +(m[4] || 0);
  if (m[7]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  }
  const date = new Date(Date.UTC(+m[3], month, +m[1], hour, +(m[5] || 0), +(m[6] || 0)));
  return month < 0 || Number.isNaN(date.getTime()) || date.getUTCMonth() !== month || date.getUTCDate() !== +m[1] ? null : date;
}

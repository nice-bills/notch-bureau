// Synthetic copy of the LAYOUT of the statement MTN emails on a *170# request (see src/statement-email.js): a wide
// landscape page, a header block on every page, a bordered table, centred cells that wrap both ways. All data made up.
// It takes the same row objects as statementPdf (momo-pdf.js), so one set of rows can be printed in either layout.
import crypto from 'node:crypto';
import PdfPrinter from 'pdfmake';
import { SYNTH_HOLDER, at } from './momo-pdf.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TITLES = ['TRANSACTION DATE', 'FROM ACCT', 'FROM NAME', 'FROM NO.', 'TRANS. TYPE', 'AMOUNT', 'FEES', 'E-LEVY', 'BAL BEFORE', 'BAL AFTER', 'TO NO.', 'TO NAME', 'TO ACCT', 'F_ID', 'REF', 'OVA'];
const WIDTHS = [96, 46, 74, 62, 72, 40, 28, 34, 58, 56, 62, 74, 46, 56, 90, 56];
const FONT = 7;
const LINE = FONT * 1.156; // pdfmake's line height for Helvetica
// the app statement's payment types -> the words this statement uses
const TYPES = { 'MOMO USER': 'TRANSFER', 'CASH IN': 'CASH_IN', 'CASH OUT': 'CASH_OUT', 'OTHER TRANSACTIONS': 'DEBIT' };

const two = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => `${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const fmtDate = (d) => `${fmtDay(d)} ${two(d.getUTCHours() % 12 || 12)}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
const money = (v) => String(Math.round(v * 100) / 100); // as printed: "5", "12.5", "1250.75" (no currency, no commas)
const wrap = (text, max) => String(text).split(' ').reduce((acc, w) => {
  if (acc.length && acc[acc.length - 1].length + w.length < max) acc[acc.length - 1] += ` ${w}`;
  else acc.push(w);
  return acc;
}, []);

// Extra row fields for tests: shownBefore / shownAfter force a printed balance; fromNo / toNo force a printed number.
export function emailedStatementPdf({ rows = syntheticRows30(), msisdn = '0241234567', holder = SYNTH_HOLDER, opening = 250, from = at(30), to = at(0) } = {}) {
  const digits = String(msisdn).replace(/\D/g, '');
  const wallet = digits.startsWith('233') ? digits : `233${digits.replace(/^0/, '')}`;
  let bal = opening;
  const printed = [...rows].sort((a, b) => a.date - b.date).map((r) => {
    const fee = r.fee ?? 0;
    const tax = r.tax ?? 0;
    const before = bal;
    bal = Math.round((bal + r.amount - fee - tax) * 100) / 100;
    const out = r.amount < 0;
    const other = { name: r.acct || '', no: r.party || '9' };
    const me = { name: holder, no: wallet };
    const [src, dst] = out ? [me, other] : [other, me];
    return [
      fmtDate(r.date), '10000001', src.name, r.fromNo ?? src.no, TYPES[r.type] || r.type, money(Math.abs(r.amount)),
      money(fee), money(tax), money(r.shownBefore ?? before), money(r.shownAfter ?? r.balance ?? bal), r.toNo ?? dst.no,
      dst.name, '20000002', r.txid || String(crypto.randomInt(1e10, 1e11)), r.ref || '-', 'fakeova',
    ];
  }).reverse(); // newest first

  const cell = (lines, tallest) => ({ text: lines.join('\n'), alignment: 'center', fontSize: FONT, margin: [0, ((tallest - lines.length) * LINE) / 2, 0, 0] });
  const body = [
    TITLES.map((t) => ({ text: t, bold: true, alignment: 'center', fontSize: FONT })),
    ...printed.map((r) => {
      const lines = r.map((v, i) => (i === 2 || i === 11 ? wrap(v, 13) : i === 14 ? wrap(v, 18) : [v]));
      const tallest = Math.max(...lines.map((l) => l.length));
      return lines.map((l) => cell(l, tallest));
    }),
  ];
  const t = (text, extra = {}) => ({ text, fontSize: 9, width: 'auto', ...extra });
  const doc = {
    pageSize: { width: 1440, height: 612 },
    pageMargins: [72, 170, 72, 150], // about 15 rows a page, like the real one
    defaultStyle: { font: 'Helvetica' },
    header: () => ({
      margin: [72, 70, 72, 0],
      stack: [
        { text: 'MOBILE MONEY TRANSACTION HISTORY', bold: true, fontSize: 11, alignment: 'center', margin: [0, 0, 0, 12] },
        { columns: [t('From:'), t(fmtDay(from)), t('To:'), t(fmtDay(to))], columnGap: 12, margin: [450, 0, 0, 10] },
        { columns: [t('Date: 01 Nov,2026 10:00:00PM'), t('MSISDN:'), t(wallet), t('ACCOUNT HOLDER NAME:'), t(holder)], columnGap: 12 },
      ],
    }),
    content: [{ table: { headerRows: 1, widths: WIDTHS, dontBreakRows: true, body }, layout: { paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 1, paddingBottom: () => 1 } }],
  };
  const fonts = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };
  return new Promise((resolve, reject) => {
    const pdf = new PdfPrinter(fonts).createPdfKitDocument(doc);
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

// ---- 30 days, what a *170# request returns (made up; GHS) ---------------------------------------------------------
const P = (n) => `23324400${String(n).padStart(4, '0')}`;

export function syntheticRows30() {
  return [
    { date: at(27, 9, 0), type: 'TRANSFER', party: '', acct: 'PAYSTACK PAYOUT', ref: 'Payout 1', amount: 1200 },
    { date: at(25, 14, 5), type: 'TRANSFER', party: P(1), acct: 'ADWOA SERWAA BOATENG', ref: 'logo work', amount: 150 },
    { date: at(22, 12, 0), type: 'PAYMENT', party: '', acct: 'SHOPRITE ACCRA MALL', ref: '-', amount: -180, fee: 1.5 },
    { date: at(18, 10, 0), type: 'CASH_IN', party: P(6), acct: 'FELIX AGYEMAN', ref: '-', amount: 400 },
    { date: at(14, 13, 0), type: 'TRANSFER', party: '', acct: 'QwikLoan OVA', ref: '-', amount: 300 },
    { date: at(11, 12, 0), type: 'DEBIT', party: '', acct: 'MTN BUNDLE', ref: 'your Requested', amount: -35 },
    { date: at(9, 16, 20), type: 'TRANSFER', party: P(2), acct: 'YAW OPOKU MENSAH', ref: 'thanks', amount: 100 },
    { date: at(7, 20, 0), type: 'DEBIT', party: '', acct: 'Debit. Inv5', ref: 'Football Internet', amount: -20 },
    { date: at(5, 0, 5), type: 'PAYMENT_SEND', party: P(4), acct: 'ESI MANU', ref: 'rent', amount: -300, fee: 3 },
    { date: at(3, 15, 30), type: 'CASH_OUT', party: P(8), acct: 'MTN AGENT ACCRA', ref: '-', amount: -200, fee: 2 },
  ];
}

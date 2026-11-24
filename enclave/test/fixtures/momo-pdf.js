// Synthetic MTN MoMo Ghana statement with the SAME LAYOUT as a real one (pdfmake, A4 portrait), all data made up.
//
// Layout learned from a real statement (kept private, never copied here): a header block (Account holder, Wallet
// number, From date, To date, Duration, Profile), an "Available balance" line, then a table repeated on every page with
// the columns  Date & Time | Payment Type | To/From | Account Name | Amount (+/-) | Transaction ID | Fees | Tax |
// Balance | Reference.  Rows run newest first, dates look like "5 Nov 2026 14:32" (day NOT zero-padded), the amount
// carries its sign ("-10.00", "+117.00"), fees/tax/balance carry "GHS ". Cells wrap onto extra lines (phone number in
// To/From, long names, memos) and the page footer says "Page N of M" above a disclaimer.
//
//   balance(row) - balance(older row) = amount - fees - tax        (the running-balance rule the parser checks)
import crypto from 'node:crypto';
import PdfPrinter from 'pdfmake';

const DAY = 86400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const SYNTH_HOLDER = 'KOFI KWAME MENSAH';

// A moment `n` days ago at hh:mm UTC (what a fixture row's date means).
export const at = (n, hh = 10, mm = 15) => {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(hh, mm, 0, 0);
  return d;
};
const fmtDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const fmtDay = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const money = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v) => `${v < 0 ? '-' : '+'}${money(Math.abs(v))}`;
// "+233 54 12 34 56 7": spaced like the real one, so it wraps inside the narrow To/From column.
const phone = (digits) => (digits ? `+${digits.slice(0, 3)} ${digits.slice(3).replace(/(\d\d)(?=\d)/g, '$1 ')}` : '');
const txid = () => String(crypto.randomInt(1e10, 1e11));

// One row of the fixture. amount is signed (credits +, debits -); fee is positive (it is taken on top of a debit).
//   { date: Date, type: 'MOMO USER', party: '233244000111' | '', acct: 'NAME', ref: 'memo', amount: 117, fee: 0 }
// `balance` (a number) forces the printed balance, for tests of the running-balance check.
export function statementPdf({
  rows = syntheticRows(),
  msisdn = '0241234567',
  holder = SYNTH_HOLDER,
  opening = 250,
  userPassword,
  from = at(90),
  to = at(0),
} = {}) {
  const sorted = [...rows].sort((a, b) => a.date - b.date); // oldest first, to run the balance forward
  let bal = opening;
  const printed = sorted.map((r) => {
    const fee = r.fee ?? 0;
    const tax = r.tax ?? 0;
    bal = Math.round((bal + r.amount - fee - tax) * 100) / 100;
    return { ...r, fee, tax, shown: r.balance ?? bal, txid: r.txid || txid() };
  }).reverse(); // real statements list the newest row first
  const available = printed.length ? printed[0].shown : opening;
  const dialled = String(msisdn).replace(/\D/g, '');
  const wallet = dialled.startsWith('233') ? dialled : `233${dialled.replace(/^0/, '')}`;

  const W = [80, 54, 43, 53, 43, 64, 38, 37, 54, 69]; // sums to 535 = A4 width minus 30pt margins
  const head = (t) => ({ text: t, bold: true, fontSize: 7 });
  const headRow = [head('Date &\nTime'), head('Payment\nType'), head('To/From'), head('Account\nName'), head('Amount'), head('Transaction ID'), head('Fees'), head('Tax'), head('Balance'), head('Reference')];
  const body = [headRow, ...printed.map((r) => [
    fmtDate(r.date), r.type, phone(r.party), r.acct || '', signed(r.amount), r.txid,
    `GHS ${money(r.fee)}`, `GHS ${money(r.tax)}`, `GHS ${money(r.shown)}`, r.ref || '-',
  ].map((t) => ({ text: String(t), fontSize: 6.5 })))];

  const label = (t) => ({ text: t, bold: true, fontSize: 7.5 });
  const val = (t) => ({ text: t, fontSize: 7.5 });
  const nameLines = holder.split(' ').reduce((acc, w) => {
    if (acc.length && acc[acc.length - 1].length + w.length < 12) acc[acc.length - 1] += ` ${w}`;
    else acc.push(w);
    return acc;
  }, []).join('\n');
  const doc = {
    pageSize: 'A4',
    pageMargins: [30, 40, 30, 90],
    defaultStyle: { font: 'Helvetica' },
    ...(userPassword ? { userPassword, ownerPassword: `${userPassword}-owner` } : {}),
    footer: (page, pages) => ({
      stack: [
        { text: `Page ${page} of ${pages}`, alignment: 'right', fontSize: 6.5, margin: [0, 0, 36, 4] },
        { text: 'Disclaimer', bold: true, fontSize: 6.5, margin: [30, 0, 0, 2] },
        { text: 'This synthetic statement was made for tests: no real customer, number or transaction is in it.', fontSize: 6, margin: [30, 0, 30, 0] },
      ],
    }),
    content: [
      { text: 'Mobile Money Statement', bold: true, fontSize: 11, margin: [172, 0, 0, 6] },
      {
        margin: [16, 0, 0, 14],
        layout: 'noBorders',
        table: {
          widths: [77, 79, 77, 120],
          body: [
            [label('Account holder:'), val(nameLines), label('From date:'), val(fmtDay(from))],
            [label('Wallet number:'), val(`+${wallet.slice(0, 3)} ${wallet.slice(3)}`), label('To date:'), val(fmtDay(to))],
            [label('Profile:'), val('MTN MOMO\nSUBSCRIBER'), label('Duration:'), val('90 days')],
          ],
        },
      },
      {
        columns: [
          { text: 'Transaction details', bold: true, fontSize: 8 },
          { text: `Available balance GHS ${money(available)}`, bold: true, fontSize: 8, alignment: 'right' },
        ],
        margin: [0, 6, 0, 8],
      },
      {
        table: { headerRows: 1, widths: W, dontBreakRows: true, body },
        layout: {
          hLineWidth: () => 0.5, vLineWidth: () => 0, hLineColor: () => '#bbbbbb',
          paddingLeft: () => 5, paddingRight: () => 0, paddingTop: () => 3, paddingBottom: () => 3,
        },
      },
    ],
  };
  const fonts = { Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } };
  const printer = new PdfPrinter(fonts);
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

// ---- a statement that covers every income class (all names, numbers and amounts are made up) -----------------------
const P = (n) => `23324400${String(n).padStart(4, '0')}`;
const OWN = SYNTH_HOLDER;

// Rows by class. Amounts are GHS. Month buckets are 30 days back from now: m1 = 0..29 days, m2 = 30..59, m3 = 60..89.
export function syntheticRows() {
  return [
    // earned_income: a payout processor and a freelance platform (system accounts: no phone number), one per month
    { date: at(80, 9, 0), type: 'MOMO USER', party: '', acct: 'PAYSTACK PAYOUT', ref: 'Payout 1', amount: 1200 },
    { date: at(50, 9, 0), type: 'MOMO USER', party: '', acct: 'PAYSTACK PAYOUT', ref: 'Payout 2', amount: 1250 },
    { date: at(21, 9, 0), type: 'MOMO USER', party: '', acct: 'PAYSTACK PAYOUT', ref: 'Payout 3', amount: 1300 },
    { date: at(34, 11, 30), type: 'MOMO USER', party: '', acct: 'DEEL INC', ref: 'Invoice 17', amount: 800 },
    // peer_transfer: one payer in three months (regular), one in two (regular), one only once (not regular)
    { date: at(75, 14, 5), type: 'MOMO USER', party: P(1), acct: 'ADWOA SERWAA BOATENG', ref: 'logo work', amount: 150 },
    { date: at(45, 14, 5), type: 'MOMO USER', party: P(1), acct: 'ADWOA SERWAA BOATENG', ref: 'logo work', amount: 150 },
    { date: at(15, 14, 5), type: 'MOMO USER', party: P(1), acct: 'ADWOA SERWAA BOATENG', ref: 'logo work', amount: 150 },
    { date: at(40, 16, 20), type: 'MOMO USER', party: P(2), acct: 'YAW OPOKU MENSAH', ref: 'thanks', amount: 100 },
    { date: at(10, 16, 20), type: 'MOMO USER', party: P(2), acct: 'YAW OPOKU MENSAH', ref: 'thanks', amount: 100 },
    { date: at(26, 12, 0), type: 'MOMO USER', party: P(3), acct: 'AKUA ANSAH', ref: 'gift', amount: 70 },
    // self_transfer: own savings wallet, own bank (name in the memo), own investment account
    { date: at(66, 8, 10), type: 'MOMO USER', party: '', acct: 'ysavedep OVA', ref: '1234567890_ABC1 xY2z', amount: 200 },
    { date: at(30, 8, 10), type: 'MOMO USER', party: '', acct: 'INTEROPERABILI TY PULL OVA', ref: `${OWN} ,23xxxxxx45, GIPS Transfer from GCB Bank`, amount: 500 },
    { date: at(18, 8, 10), type: 'MOMO USER', party: '9', acct: 'ICS GHS EQUITIES TRUST ACCOUNT 3', ref: 'Payment of GHS 90.25 to 233241234567 wallet', amount: 90.25 },
    // loan_disbursement + its repayment (a debit)
    { date: at(58, 13, 0), type: 'MOMO USER', party: '', acct: 'QwikLoan OVA', ref: '-', amount: 300 },
    { date: at(41, 13, 0), type: 'DEBIT', party: '', acct: 'QwikLoan OVA', ref: '-', amount: -330 },
    // betting: payouts in, stakes out
    { date: at(70, 19, 40), type: 'MOMO USER', party: P(9), acct: 'Credit.Inv', ref: 'SportyBet', amount: 80 },
    { date: at(60, 20, 0), type: 'OTHER TRANSACTIONS', party: '9', acct: 'Debit. Inv5', ref: 'Football Internet', amount: -20 },
    { date: at(39, 20, 0), type: 'OTHER TRANSACTIONS', party: '9', acct: 'Debit. Inv5', ref: 'Football Internet', amount: -20 },
    { date: at(5, 20, 0), type: 'OTHER TRANSACTIONS', party: '9', acct: 'Debit. Inv5', ref: 'Football Internet', amount: -20 },
    // interest
    { date: at(62, 6, 0), type: 'MOMO USER', party: '', acct: 'Interest Payments', ref: 'Interest for April to June 2026', amount: 4.2 },
    // refund: a transfer that bounced back
    { date: at(25, 15, 0), type: 'MOMO USER', party: P(5), acct: 'EFUA BOATENG', ref: 'for the books', amount: -50 },
    { date: at(24, 15, 0), type: 'REVERSAL', party: P(5), acct: 'EFUA BOATENG', ref: 'Reversal of failed transfer', amount: 50 },
    // cash_deposit: cash put in at an agent
    { date: at(55, 10, 0), type: 'CASH IN', party: P(6), acct: 'FELIX AGYEMAN', ref: 'Cashin To-233241234567', amount: 400 },
    // pass_through: a large one-off from a new payer, gone within a day
    { date: at(12, 9, 0), type: 'MOMO USER', party: P(7), acct: 'KWAKU DARKO', ref: 'for the car', amount: 600 },
    { date: at(12, 15, 30), type: 'CASH OUT', party: P(8), acct: 'MTN AGENT ACCRA', ref: 'NationalId--', amount: -400, fee: 2 },
    { date: at(11, 8, 45), type: 'MOMO USER', party: P(4), acct: 'ESI MANU', ref: 'rent', amount: -195 },
    // unknown: a business account we do not recognise (no phone number, not on the payer list)
    { date: at(33, 10, 5), type: 'MOMO USER', party: '', acct: 'BLUE KITE TRADING GH', ref: 'inv 88', amount: 260 },
    // ordinary spending (keeps the wallet balance realistic)
    { date: at(78, 12, 0), type: 'AIRTIME', party: P(4), acct: 'MTNONLINEAIRTIMEVENDOR', ref: '-', amount: -10 },
    { date: at(64, 12, 0), type: 'PAYMENT', party: '', acct: 'SHOPRITE ACCRA MALL', ref: '-', amount: -180 },
    { date: at(48, 12, 0), type: 'DEBIT', party: '', acct: 'MTN BUNDLE', ref: 'your Requested', amount: -35 },
    { date: at(36, 12, 0), type: 'MOMO USER', party: P(4), acct: 'ESI MANU', ref: 'rent', amount: -300 },
    { date: at(20, 12, 0), type: 'MOMO USER', party: P(4), acct: 'ESI MANU', ref: 'rent', amount: -300 },
    { date: at(7, 12, 0), type: 'DEBIT', party: '', acct: 'MTN BUNDLE', ref: 'your Requested', amount: -35 },
    { date: at(2, 12, 0), type: 'MOMO USER', party: P(4), acct: 'ESI MANU', ref: 'rent', amount: -150 },
  ];
}

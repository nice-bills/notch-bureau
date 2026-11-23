// Synthetic provider emails for the enclave tests. The DKIM signatures are generated here at
// test time with a throwaway key, so nothing in this file is real customer data and no test
// touches the network. Formats (what is real and what is modelled is listed in enclave/README.md):
//   * momoStatementEmail: MTN MoMo Ghana's monthly statement, a PDF attached to a boilerplate email,
//     signed as d=mtn.com. The PDF layout is MODELLED, not copied from a real statement.
//   * earnPayoutEmail: Superteam Earn payout email. Body wording is MODELLED.
//   * creditNotice / deelPayout / bankStatement: generic body-text emails (MTN sends none of these).
import crypto from 'node:crypto';
import { dkimSign } from 'mailauth';
import PDFDocument from 'pdfkit';

export const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// Fake DNS: answer any selector under the test domains with our key.
export const resolver = async (name, rr) => {
  if (rr === 'TXT' && name.includes('._domainkey.')) return [[`v=DKIM1; k=rsa; p=${pubB64}`]];
  const e = new Error('not found');
  e.code = 'ENOTFOUND';
  throw e;
};

export async function signedEmail({
  body,
  domain = 'momo.test',
  from = 'MoMo <noreply@momo.test>',
  subject = 'Payment received',
  date = new Date(),
}) {
  const msg = [
    `From: ${from}`,
    'To: student@example.com',
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    '',
    body,
    '',
  ].join('\r\n');
  const { signatures } = await dkimSign(msg, {
    signatureData: [{ signingDomain: domain, selector: 'sel', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }],
  });
  return Buffer.from(signatures + msg);
}

// A hypothetical per-transaction notice, signed by a made-up domain. NOT an MTN email: MTN Ghana sends
// statements only (see momoStatementEmail), per-transaction notices are SMS.
export const creditNotice = {
  domain: 'notice.test',
  from: 'Mobile Money <noreply@notice.test>',
  subject: 'You have received money',
  body: [
    'Hello KOFI MENSAH,',
    '',
    'You have received GHS 1,250.00 from KWAME ASANTE (024 000 0000).',
    '',
    'Your new balance is GHS 1,300.00.',
    '',
    'Transaction ID: MP261122.1234.A56789',
    'Reference: Payment for design work',
    '',
    'Thank you for using MTN Mobile Money.',
  ].join('\r\n'),
  // Only the received amount is income; the balance is not.
  credits: [{ amount: 1250, currency: 'GHS' }],
};

export const deelPayout = {
  domain: 'deel.com',
  from: 'Deel <notifications@deel.com>',
  subject: 'Your payment is on its way',
  body: [
    'Hi Ama,',
    '',
    'Your payment of USD 2,400.00 has been sent to your bank account ending in 4321.',
    '',
    'Payment period: 1 - 31 October 2026',
    'Payment method: Bank transfer',
    'Reference: DEEL-2026-10-8842',
    '',
    'This is an automated message from Deel.',
  ].join('\r\n'),
  credits: [{ amount: 2400, currency: 'USD' }],
};

export const bankStatement = {
  domain: 'bank.test',
  from: 'GTBank <statements@bank.test>',
  subject: 'Statement summary for October',
  body: [
    'GTBank Ghana - Statement summary',
    'Account: 1234567890',
    'Period: 01 Oct 2026 - 31 Oct 2026',
    '',
    'Opening balance: GHS 500.00',
    '',
    '05 Oct  SALARY CREDIT - ACME LTD          GHS 4,000.00',
    '12 Oct  MOBILE MONEY RECEIVED - KOFI      GHS 750.00',
    '18 Oct  ATM WITHDRAWAL                    GHS 300.00',
    '22 Oct  CARD PAYMENT TO SHOPRITE          GHS 120.00',
    '28 Oct  BANK CHARGE                       GHS 15.00',
    '',
    'Closing balance: GHS 4,815.00',
  ].join('\r\n'),
  // Debits, charges and balances must all be ignored.
  credits: [
    { amount: 4000, currency: 'GHS' },
    { amount: 750, currency: 'GHS' },
  ],
};


// ---------------------------------------------------------------------------------------------
// MTN MoMo Ghana statement: PDF + multipart email
// ---------------------------------------------------------------------------------------------

export const dayAgo = (n, hms = '10:15:30') => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10) + ` ${hms}`;

// Credits and debits, as a real month looks. Types follow the modelled column "Type".
export const defaultStatementRows = () => [
  { date: dayAgo(70), txid: '31245670011', type: 'CASH_IN', party: 'MTN AGENT 0244000111', amount: '800.00', fee: '0.00', balance: '850.00' },
  { date: dayAgo(55), txid: '31245670012', type: 'TRANSFER_IN', party: 'KWAME ASANTE 0243000222 Payment for design work', amount: '1,250.00', fee: '0.00', balance: '2,100.00' },
  { date: dayAgo(50), txid: '31245670013', type: 'PAYMENT', party: 'SHOPRITE ACCRA MALL', amount: '45.00', fee: '0.00', balance: '2,055.00' },
  { date: dayAgo(40), txid: '31245670014', type: 'CASH_OUT', party: 'MTN AGENT 0244000333', amount: '200.00', fee: '2.00', balance: '1,853.00' },
  { date: dayAgo(30), txid: '31245670015', type: 'TRANSFER_IN', party: 'ACME LTD 0302000444 October pay', amount: '2,000.00', fee: '0.00', balance: '3,853.00' },
  { date: dayAgo(12), txid: '31245670016', type: 'AIRTIME', party: 'MTN AIRTIME', amount: '10.00', fee: '0.00', balance: '3,843.00' },
  { date: dayAgo(5), txid: '31245670017', type: 'TRANSFER_OUT', party: 'EFUA BOATENG 0551000555', amount: '300.00', fee: '1.50', balance: '3,541.50' },
];
// Total credits in the default rows: 800 + 1,250 + 2,000 = 4,050 GHS.
export const DEFAULT_STATEMENT_CREDITS = [800, 1250, 2000];

// x of each column on the page (A4 landscape, points).
const COLS = { date: 30, txid: 130, type: 215, party: 310, amount: 530, fee: 600, balance: 670 };

export function statementPdf({
  msisdn = '0241234567',
  name = 'KOFI MENSAH',
  rows = defaultStatementRows(),
  currency = 'GHS',
  userPassword,
  extraHeaderLines = [],
} = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, ...(userPassword ? { userPassword, ownerPassword: `${userPassword}-owner` } : {}) });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const at = (text, x, y, opts = {}) => doc.text(String(text), x, y, { lineBreak: false, ...opts });
    const tableHead = (y) => {
      doc.font('Helvetica-Bold').fontSize(9);
      at('Date', COLS.date, y); at('Transaction ID', COLS.txid, y); at('Type', COLS.type, y); at('From/To', COLS.party, y);
      at(`Amount (${currency})`, COLS.amount, y); at('Fee', COLS.fee, y); at('Balance', COLS.balance, y);
      doc.moveTo(30, y + 13).lineTo(812, y + 13).stroke();
      doc.font('Helvetica').fontSize(9);
      return y + 20;
    };

    doc.font('Helvetica-Bold').fontSize(16);
    at('MTN Mobile Money', 30, 30);
    doc.fontSize(11);
    at('Statement of Account', 30, 52);
    doc.font('Helvetica').fontSize(10);
    let y = 74;
    for (const line of [`Account Name: ${name}`, `Mobile Number: ${msisdn}`, `Currency: ${currency}`, `Statement Period: ${dayAgo(90).slice(0, 10)} to ${dayAgo(0).slice(0, 10)}`, ...extraHeaderLines]) {
      at(line, 30, y);
      y += 14;
    }
    y = tableHead(y + 10);
    for (const r of rows) {
      if (y > 540) { doc.addPage(); y = tableHead(30); }
      const partyHeight = doc.heightOfString(r.party, { width: 200 });
      at(r.date, COLS.date, y); at(r.txid, COLS.txid, y); at(r.type, COLS.type, y);
      doc.text(r.party, COLS.party, y, { width: 200 }); // free text wraps inside its own column
      at(r.amount, COLS.amount, y, { width: 55, align: 'right' }); // numbers are right-aligned
      at(r.fee, COLS.fee, y, { width: 55, align: 'right' }); at(r.balance, COLS.balance, y, { width: 55, align: 'right' });
      y += Math.max(partyHeight, 12) + 6;
    }
    at('This statement is system generated and does not require a signature.', 30, Math.min(y + 20, 560));
    doc.end();
  });
}

const b64lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

// A signed multipart email with one PDF attachment, shaped like MTN's statement mail.
export async function momoStatementEmail({
  pdf,
  rows,
  msisdn,
  name,
  domain = 'mtn.com',
  from = 'MTN MoMo <ServiceMMStatement.GH@mtn.com>',
  subject = 'MTN MoMo Statement',
  date = new Date(),
  filename = 'MomoStatementReport.pdf',
  userPassword,
  unique = true,
} = {}) {
  const attachment = pdf ?? (await statementPdf({ rows, msisdn, name, userPassword }));
  const boundary = `----=_Part_${crypto.randomUUID().replace(/-/g, '')}`;
  const msg = [
    `From: ${from}`,
    'To: student@example.com',
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    'Dear Customer,',
    '',
    'Please find attached your MTN Mobile Money statement for the period requested.',
    ...(unique ? ['', `Request reference: ${crypto.randomUUID()}`] : []),
    '',
    'Thank you for using MTN Mobile Money.',
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64lines(attachment).replace(/\r\n$/, ''),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const { signatures } = await dkimSign(msg, {
    signatureData: [{ signingDomain: domain, selector: 'sel', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }],
  });
  return Buffer.from(signatures + msg);
}

// Fresh, never-used phone number (so tests do not trip the one-number-one-wallet rule by accident).
export const randomMsisdn = () => `024${String(crypto.randomInt(0, 10_000_000)).padStart(7, '0')}`;

// ---------------------------------------------------------------------------------------------
// Superteam Earn payout email (body wording modelled; the real template is unknown)
// ---------------------------------------------------------------------------------------------
export const earnPayout = (amount = 500, extra = '') => ({
  domain: 'superteam.fun',
  from: 'Superteam Earn <hello@superteam.fun>',
  subject: 'Your payment has been sent',
  body: [
    'Hi Ama,',
    '',
    `You have been paid ${amount} USDC for "Build a landing page" on Superteam Earn.`,
    '',
    `Reference: ${crypto.randomUUID()}`,
    ...(extra ? ['', extra] : []),
    '',
    'Superteam Earn',
  ].join('\r\n'),
});

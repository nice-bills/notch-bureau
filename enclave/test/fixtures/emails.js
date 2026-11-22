// Synthetic provider emails for the enclave tests. The bodies imitate the real formats
// (MTN MoMo Ghana, Deel, a Ghanaian bank statement summary); the DKIM signatures are
// generated here at test time with a throwaway key, so nothing in this file is real
// customer data and no test touches the network.
import crypto from 'node:crypto';
import { dkimSign } from 'mailauth';

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

export const momoGhana = {
  domain: 'mtn.com.gh',
  from: 'MTN Mobile Money <noreply@mtn.com.gh>',
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

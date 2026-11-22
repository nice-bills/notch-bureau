import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { dkimSign } from 'mailauth';
import { Underwriter } from '../src/underwriter.js';
import { verifyRecord, RECORD_LEN } from '../src/record.js';

// A fake provider "momo.test" with its own DKIM key, served by a fake DNS resolver.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const resolver = async (name, rr) => {
  if (rr === 'TXT' && name.includes('._domainkey.') && name.endsWith('.momo.test')) return [[`v=DKIM1; k=rsa; p=${pubB64}`]];
  const e = new Error('not found');
  e.code = 'ENOTFOUND';
  throw e;
};

async function email(body, date = new Date(), signingDomain = 'momo.test') {
  const msg = [
    'From: MoMo <noreply@momo.test>',
    'To: student@example.com',
    'Subject: Payment received',
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@momo.test>`,
    '',
    body,
    '',
  ].join('\r\n');
  const { signatures } = await dkimSign(msg, {
    signatureData: [{ signingDomain, selector: 'sel', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }],
  });
  return Buffer.from(signatures + msg);
}

const wallet = bs58.encode(nacl.sign.keyPair().publicKey);
const make = () => new Underwriter({ trusted: ['momo.test'], resolver, llm: null });

test('genuine email gives a signed limit', async () => {
  const u = make();
  const r = await u.submit(await email('You have received GHS 3,000.00 from ACME LTD.'), wallet);
  assert.equal(r.ok, true, r.reason);
  // 3000 GHS * 0.065 = 195 USD over 90d -> 65/mo -> 30% = 19.5
  assert.equal(r.limitUsdc, 19.5);
  assert.equal(Buffer.from(r.message, 'base64').length, RECORD_LEN);
  assert.equal(verifyRecord(r.message, r.signature, bs58.decode(u.publicKey)), true);
});

test('edited amount fails DKIM', async () => {
  const u = make();
  const real = (await email('You have received GHS 300.00 from ACME LTD.')).toString();
  const forged = Buffer.from(real.replace('GHS 300.00', 'GHS 30000.00'));
  const r = await u.submit(forged, wallet);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no passing DKIM/);
});

test('same email twice is rejected', async () => {
  const u = make();
  const e = await email('Payment received: USD 400 salary.');
  assert.equal((await u.submit(e, wallet)).ok, true);
  const again = await u.submit(e, wallet);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'email already used');
});

test('untrusted signer is rejected', async () => {
  const u = new Underwriter({ trusted: ['deel.com'], resolver, llm: null });
  const r = await u.submit(await email('You have received GHS 3000 from ACME.'), wallet);
  assert.equal(r.ok, false);
  assert.match(r.reason, /untrusted signer/);
});

test('a subdomain signer is not implicitly trusted', async () => {
  const u = make();
  const r = await u.submit(await email('Salary credited USD 900.00', new Date(), 'notify.momo.test'), wallet);
  assert.equal(r.ok, false);
  assert.match(r.reason, /untrusted signer/);
});

test('first-timer cap holds and more income raises the limit', async () => {
  const u = make();
  await u.submit(await email('Salary credited USD 900.00'), wallet);
  const r = await u.submit(await email('Salary credited USD 900.00 for November'), wallet);
  // 1800/3 = 600/mo -> 30% = 180, capped at 50 for first-timers
  assert.equal(r.limitUsdc, 50);
});

test('on-chain repayment history raises the cap and a default freezes it', async () => {
  const rewarded = new Underwriter({ trusted: ['momo.test'], resolver, historyProvider: async () => ({ repaidOnTime: 1, frozen: false }), llm: null });
  const earned = await rewarded.submit(await email('Salary credited USD 900.00'), wallet);
  assert.equal(earned.limitUsdc, 90);

  const defaulted = new Underwriter({ trusted: ['momo.test'], resolver, historyProvider: async () => ({ repaidOnTime: 10, frozen: true }), llm: null });
  const frozen = await defaulted.submit(await email('Salary credited USD 900.00'), wallet);
  assert.equal(frozen.limitUsdc, 0);
});

test('signature from another key does not verify', async () => {
  const u = make();
  const r = await u.submit(await email('You have received GHS 3000 from ACME.'), wallet);
  const other = nacl.sign.keyPair();
  assert.equal(verifyRecord(r.message, r.signature, other.publicKey), false);
});

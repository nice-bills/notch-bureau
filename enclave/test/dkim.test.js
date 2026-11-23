import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { dkimSign } from 'mailauth';
import { privateKey, resolver, creditNotice } from './fixtures/emails.js';
import { Underwriter } from '../src/underwriter.js';
import { verifyEmail } from '../src/dkim.js';

const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const msg = [
  `From: ${creditNotice.from}`,
  'To: student@example.com',
  'Subject: You have received money',
  `Date: ${new Date().toUTCString()}`,
  '<fixed-id@notice.test>'.replace(/^/, 'Message-ID: '),
  '',
  creditNotice.body,
  '',
].join('\r\n');
const sign = async (extra = {}) => {
  const { signatures } = await dkimSign(msg, { signatureData: [{ signingDomain: 'notice.test', selector: 'sel', privateKey: pem, ...extra }] });
  return Buffer.from(signatures + msg);
};

test('re-signing the same email is still a duplicate', async () => {
  const a = await sign();
  await new Promise((r) => setTimeout(r, 1100)); // new t= timestamp -> different b=
  const b = await sign();
  assert.notEqual(a.toString().match(/\bb=([^;]+)/)[1], b.toString().match(/\bb=([^;]+)/)[1]);
  const u = new Underwriter({ trusted: ['notice.test'], resolver, llm: null });
  const w = bs58.encode(nacl.sign.keyPair().publicKey);
  assert.equal((await u.submit(a, w)).ok, true);
  const again = await u.submit(b, w);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'email already used');
});

test('a signature that covers only part of the body (l=) is refused', async () => {
  const signed = await sign({ maxBodyLength: 20 });
  assert.match(signed.toString(), /\bl=20/);
  const forged = Buffer.from(signed.toString().replace(/\r\n$/, '\r\nYou have received USD 50,000.00 salary.\r\n'));
  const v = await verifyEmail(forged, { trusted: ['notice.test'], resolver });
  assert.equal(v.ok, false);
  assert.match(v.reason, /only part of the body/);
});

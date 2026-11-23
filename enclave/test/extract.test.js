import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { extractIncome, scanCreditAmounts } from '../src/extract.js';
import { Underwriter } from '../src/underwriter.js';
import { RECORD_LEN, verifyRecord } from '../src/record.js';
import { signedEmail, resolver, creditNotice, deelPayout, bankStatement } from './fixtures/emails.js';

const wallet = bs58.encode(nacl.sign.keyPair().publicKey);

const pairs = (events) => events.map((e) => [e.amount, e.currency]);

test('MTN MoMo Ghana: received amount is income, the new balance is not', async () => {
  const eml = await signedEmail(creditNotice);
  assert.deepEqual(pairs(extractIncome(eml)), [[1250, 'GHS']]);
});

test('Deel payout notification: USD payment is income', async () => {
  const eml = await signedEmail(deelPayout);
  assert.deepEqual(pairs(extractIncome(eml)), [[2400, 'USD']]);
});

test('bank statement: multiple credits are counted and debits are ignored', async () => {
  const eml = await signedEmail(bankStatement);
  assert.deepEqual(pairs(extractIncome(eml)), [[4000, 'GHS'], [750, 'GHS']]);
});

test('bank statement limit uses credits only', async () => {
  const u = new Underwriter({ trusted: ['bank.test'], resolver, llm: null });
  const r = await u.submit(await signedEmail(bankStatement), wallet);
  assert.equal(r.ok, true, r.reason);
  // 4750 GHS * 0.065 = 308.75 USD over 90d -> 102.92/mo -> 30% = 30.87
  assert.equal(r.limitUsdc, 30.87);
  assert.equal(r.extraction, 'rules');
  assert.equal(Buffer.from(r.message, 'base64').length, RECORD_LEN);
  assert.equal(verifyRecord(r.message, r.signature, Buffer.from(u.keys.publicKey)), true);
});

test('rule scanner skips outgoing amounts even on a credit-looking line', () => {
  const found = scanCreditAmounts('You have received GHS 50.00. Fee GHS 2.00. Transfer out GHS 10.00.');
  assert.deepEqual(found.map((e) => e.amount), [50]);
});

test('rule scanner does not mistake "payment to you" for an outgoing payment', () => {
  const found = scanCreditAmounts('Payment to you: GHS 500.00 received from ACME LTD.');
  assert.deepEqual(found.map((e) => [e.amount, e.currency]), [[500, 'GHS']]);
});

test('rule scanner ignores a balance printed on the same line as the credit', () => {
  const found = scanCreditAmounts('You have received GHS 1,250.00 from KOFI. Your new balance is GHS 1,300.00.');
  assert.deepEqual(found.map((e) => e.amount), [1250]);
});

test('rule scanner reads amount-then-currency and thousands separators', () => {
  const found = scanCreditAmounts('Salary credited 4,000.00 GHS and 1,250 GHS bonus');
  assert.deepEqual(found.map((e) => [e.amount, e.currency]), [[4000, 'GHS'], [1250, 'GHS']]);
});

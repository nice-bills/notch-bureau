// Permanent regression tests for the smaller audit findings (reviews/2026-11-24-audit/REVIEW.md):
//  #5 (enclave side)  no new limit while a loan is overdue
//  #8   email-body sources: "X sent you ..." (a person paying a person) counts like a peer transfer, not at full weight;
//       the provider's domain is passed to the extractor
//  #9   an on-chain Earn payout backs ONE record: the record's dedupe is derived from the payout transaction, so a second
//       email about the same transfer, even after an enclave restart, maps to the same one-shot program PDA
//  #10  one wallet, one mobile-money account (the line's pinned id_hash is read from chain)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter, DEFAULT_TRUSTED } from '../src/underwriter.js';
import { InboxedUnderwriter } from './fixtures/inboxed.js';
import { getCreditHistory } from '../src/chain-history.js';
import { resolver, signedEmail, earnPayout, momoStatementEmail, syntheticCashRows, randomMsisdn, deelPayout } from './fixtures/emails.js';

const w = () => bs58.encode(nacl.sign.keyPair().publicKey);
const bytes = (r) => Buffer.from(r.message, 'base64');
const dedupeOf = (r) => bytes(r).subarray(56, 88).toString('hex');

// ---- #8 ----------------------------------------------------------------------------------------------------------------------
const wiseMail = (line) => signedEmail({ domain: 'wise.com', from: 'Wise <noreply@wise.com>', subject: 'Money received', body: `Hi,\r\n\r\n${line}\r\n\r\nReference ${crypto.randomUUID()}` });
const mk = (extra = {}) => new Underwriter({ resolver, llm: null, trusted: [...DEFAULT_TRUSTED, 'wise.com'], ...extra });

test('#8: "KOFI sent you USD 150" counts at half the weight of a payer-side "Your payment of USD 150 has been sent"', async () => {
  const person = await mk().submit(await wiseMail('Kofi Mensah sent you USD 150.00'), w());
  const payer = await mk().submit(await wiseMail('You have received USD 150.00'), w());
  assert.equal(person.ok, true, person.reason);
  assert.equal(payer.ok, true, payer.reason);
  assert.ok(person.limitUsdc > 0);
  assert.ok(Math.abs(person.limitUsdc * 2 - payer.limitUsdc) <= 0.02, `${person.limitUsdc} vs ${payer.limitUsdc}`);
});

test('#8: a person-to-person line cannot be promoted by the memo (free text only lowers)', async () => {
  const r = await mk().submit(await wiseMail('Kofi Mensah sent you USD 150.00\r\nNote: salary from ACME payroll'), w());
  const base = await mk().submit(await wiseMail('Kofi Mensah sent you USD 150.00'), w());
  assert.equal(r.limitUsdc, base.limitUsdc);
});

// ---- #9 ----------------------------------------------------------------------------------------------------------------------
const MINT = 'MiNtMiNtMiNtMiNtMiNtMiNtMiNtMiNtMiNtMiNtMiN'.slice(0, 43);
const chainWith = (owner, sig, usdc) => {
  const blockTime = Math.floor(Date.now() / 1000) - 3600;
  return async (method, params) => {
    if (method === 'getSignaturesForAddress') return params[1].before ? [] : [{ signature: sig, blockTime, err: null }];
    if (method === 'getTransaction') {
      return { blockTime, meta: { err: null, preTokenBalances: [{ accountIndex: 3, mint: MINT, owner, uiTokenAmount: { amount: '5000000' } }], postTokenBalances: [{ accountIndex: 3, mint: MINT, owner, uiTokenAmount: { amount: String(5_000_000 + usdc * 1e6) } }] } };
    }
    throw new Error(`rpc ${method}`);
  };
};

test('#9: two different Earn emails about the SAME on-chain payout give the same dedupe, even after a restart', async () => {
  const wallet = w();
  const sig = `${crypto.randomBytes(30).toString('hex')}`;
  const rpc = chainWith(wallet, sig, 500);
  const first = await new Underwriter({ resolver, llm: null, chainRpc: rpc, usdcMint: MINT }).submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(first.ok, true, first.reason);
  // "restart": a brand new Underwriter with empty memory, and a DIFFERENT email (new reference id, so a different DKIM body hash)
  const second = await new Underwriter({ resolver, llm: null, chainRpc: rpc, usdcMint: MINT }).submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(second.ok, true, second.reason);
  assert.equal(dedupeOf(second), dedupeOf(first), 'the program\'s dedupe PDA is what refuses the second one');
});

test('#9: the same process also refuses the second email about the same transfer', async () => {
  const wallet = w();
  const u = new Underwriter({ resolver, llm: null, chainRpc: chainWith(wallet, crypto.randomBytes(30).toString('hex'), 500), usdcMint: MINT });
  assert.equal((await u.submit(await signedEmail(earnPayout(500)), wallet)).ok, true);
  const again = await u.submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(again.ok, false);
});

// ---- #10 / #5 ----------------------------------------------------------------------------------------------------------------
test('#10: a wallet that submitted a statement for one phone is refused a statement for another phone (in this process)', async () => {
  const wallet = w();
  const u = new InboxedUnderwriter({ resolver, llm: null });
  const a = await u.submit(await momoStatementEmail({ msisdn: randomMsisdn(), rows: syntheticCashRows() }), wallet);
  assert.equal(a.ok, true, a.reason);
  const b = await u.submit(await momoStatementEmail({ msisdn: randomMsisdn(), rows: syntheticCashRows() }), wallet);
  assert.equal(b.ok, false);
  assert.match(b.reason, /different mobile-money account/);
});

test('#10: ... and across a restart, the id_hash the program pinned in the line is what decides', async () => {
  const wallet = w();
  const phone = randomMsisdn();
  const first = await new InboxedUnderwriter({ resolver, llm: null }).submit(await momoStatementEmail({ msisdn: phone, rows: syntheticCashRows() }), wallet);
  assert.equal(first.ok, true, first.reason);
  const pinned = bytes(first).subarray(96, 128);
  const historyProvider = async () => ({ repaidOnTime: 0, frozen: false, drawn: 0n, due: 0, idHash: Buffer.from(pinned) });
  const fresh = () => new InboxedUnderwriter({ resolver, llm: null, historyProvider, idPepper: undefined });
  const other = await fresh().submit(await momoStatementEmail({ msisdn: randomMsisdn(), rows: syntheticCashRows() }), wallet);
  assert.equal(other.ok, false);
  assert.match(other.reason, /different mobile-money account/);
  const same = await fresh().submit(await momoStatementEmail({ msisdn: phone, rows: syntheticCashRows() }), wallet);
  assert.equal(same.ok, true, same.reason);
});

test('#5 (enclave side): no new limit while a loan is overdue; fine before it is due, and fine once repaid', async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const mkU = (h) => new InboxedUnderwriter({ resolver, llm: null, historyProvider: async () => ({ repaidOnTime: 0, frozen: false, ...h }) });
  const mail = () => momoStatementEmail({ msisdn: randomMsisdn(), rows: syntheticCashRows() });
  const late = await mkU({ drawn: 5_000_000n, due: nowS - 3600 }).submit(await mail(), w());
  assert.equal(late.ok, false);
  assert.match(late.reason, /overdue/);
  assert.equal((await mkU({ drawn: 5_000_000n, due: nowS + 3600 }).submit(await mail(), w())).ok, true);
  assert.equal((await mkU({ drawn: 0n, due: nowS - 3600 }).submit(await mail(), w())).ok, true);
});

test('chain-history reads drawn, due and the pinned id_hash from a current 154 byte line (and none from a short one)', async () => {
  const programId = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
  const wallet = w();
  const disc = crypto.createHash('sha256').update('account:CreditLine').digest().subarray(0, 8);
  const data = Buffer.alloc(154);
  disc.copy(data, 0);
  Buffer.from(bs58.decode(wallet)).copy(data, 8);
  data.writeBigUInt64LE(7_000_000n, 56);
  data.writeBigInt64LE(1_800_000_123n, 64);
  data.fill(7, 122, 154);
  const rpc = (buf) => async () => ({ ok: true, json: async () => ({ result: { value: { owner: programId, data: [buf.toString('base64'), 'base64'] } } }) });
  const h = await getCreditHistory(wallet, { programId, fetchImpl: rpc(data) });
  assert.equal(h.drawn, 7_000_000n);
  assert.equal(h.due, 1_800_000_123);
  assert.equal(h.idHash.toString('hex'), '07'.repeat(32));
  const short = await getCreditHistory(wallet, { programId, fetchImpl: rpc(data.subarray(0, 98)) });
  assert.equal(short.idHash, null);
  void deelPayout;
});

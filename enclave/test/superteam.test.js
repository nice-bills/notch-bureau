// Superteam Earn: a DKIM-signed payout email only counts when a matching USDC credit to the
// borrower's own token account exists on chain within +-7 days. The RPC is an injected fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter } from '../src/underwriter.js';
import { findUsdcReceipt, netCredit, usdcAccountOf, signatureIn } from '../src/chain-payout.js';
import { getIdentityOwner } from '../src/chain-history.js';
import { signedEmail, resolver, earnPayout } from './fixtures/emails.js';

const MINT = 'MiNtMiNtMiNtMiNtMiNtMiNtMiNtMiNtMiNtMiNtMiN'.slice(0, 43);
const w = () => bs58.encode(nacl.sign.keyPair().publicKey);
const now = () => Math.floor(Date.now() / 1000);

// A fake chain: list of { signature, blockTime, err, owner, mint, pre, post, extra? } for one wallet's USDC account.
function fakeChain(txs) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getSignaturesForAddress') {
      const before = params[1].before;
      const list = [...txs].sort((a, b) => b.blockTime - a.blockTime);
      const from = before ? list.findIndex((t) => t.signature === before) + 1 : 0;
      return list.slice(from, from + 100).map((t) => ({ signature: t.signature, blockTime: t.blockTime, err: t.err ?? null }));
    }
    if (method === 'getTransaction') {
      const t = txs.find((x) => x.signature === params[0]);
      if (!t) return null;
      return {
        blockTime: t.blockTime,
        meta: {
          err: t.err ?? null,
          preTokenBalances: [{ accountIndex: 3, mint: t.mint || MINT, owner: t.owner, uiTokenAmount: { amount: String(t.pre ?? 0) } }, ...(t.extraPre || [])],
          postTokenBalances: [{ accountIndex: 3, mint: t.mint || MINT, owner: t.owner, uiTokenAmount: { amount: String(t.post) } }, ...(t.extraPost || [])],
        },
      };
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  rpc.calls = calls;
  return rpc;
}
const paid = (owner, usdc, over = {}) => ({ signature: `sig${Math.random().toString(36).slice(2)}`, blockTime: now() - 3600, owner, pre: 5_000_000, post: 5_000_000 + usdc * 1e6, ...over });
const make = (rpc, extra = {}) => new Underwriter({ resolver, llm: null, chainRpc: rpc, usdcMint: MINT, ...extra });

test('Earn email + matching USDC credit: accepted, limit from the proven amount', async () => {
  const wallet = w();
  const u = make(fakeChain([paid(wallet, 500)]));
  const r = await u.submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.limitUsdc, 49.99); // 500 USDC / 3 = 166.67 -> 30% = 50.00, floored to the cent
  assert.equal(Buffer.from(r.message, 'base64').subarray(96, 128).every((b) => b === 0), true, 'no identity for Earn');
});

test('Earn email without a transfer is refused', async () => {
  const wallet = w();
  const r = await make(fakeChain([])).submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no matching USDC transfer/);
});

test('transfer to a different wallet, wrong amount, wrong mint, failed tx, or outside +-7 days: refused', async () => {
  const wallet = w();
  const cases = {
    'other wallet': paid(w(), 500),
    'wrong amount': paid(wallet, 50),
    'wrong mint': paid(wallet, 500, { mint: 'OtherMint1111111111111111111111111111111111' }),
    'failed tx': paid(wallet, 500, { err: { InstructionError: [0, 'Custom'] } }),
    'too old': paid(wallet, 500, { blockTime: now() - 9 * 86400 }),
    'too new': paid(wallet, 500, { blockTime: now() + 9 * 86400 }),
    'wallet also sent USDC (self transfer)': paid(wallet, 500, { extraPre: [{ accountIndex: 7, mint: MINT, owner: wallet, uiTokenAmount: { amount: '900000000' } }], extraPost: [{ accountIndex: 7, mint: MINT, owner: wallet, uiTokenAmount: { amount: '400000000' } }] }),
  };
  for (const [name, tx] of Object.entries(cases)) {
    const r = await make(fakeChain([tx])).submit(await signedEmail(earnPayout(500)), wallet);
    assert.equal(r.ok, false, name);
  }
});

test('within +-7 days of the email counts, and the amount may differ by up to 0.5%', async () => {
  const wallet = w();
  const ok = await make(fakeChain([paid(wallet, 500, { blockTime: now() - 6 * 86400 })])).submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(ok.ok, true, ok.reason);
  const w2 = w();
  const close = await make(fakeChain([paid(w2, 498)])).submit(await signedEmail(earnPayout(500)), w2); // 0.4% short
  assert.equal(close.ok, true, close.reason);
  const w3 = w();
  const far = await make(fakeChain([paid(w3, 490)])).submit(await signedEmail(earnPayout(500)), w3); // 2% short
  assert.equal(far.ok, false);
});

test('one on-chain transfer cannot back two Earn emails', async () => {
  const wallet = w();
  const u = make(fakeChain([paid(wallet, 500)]));
  assert.equal((await u.submit(await signedEmail(earnPayout(500)), wallet)).ok, true);
  const again = await u.submit(await signedEmail(earnPayout(500)), wallet);
  assert.equal(again.ok, false);
  assert.match(again.reason, /no matching USDC transfer/);
});

test('a tx signature quoted in the email is checked first; text cannot make a wrong tx count', async () => {
  const wallet = w();
  const hit = paid(wallet, 500, { signature: 'S'.repeat(88).replace(/S/g, '5') });
  const rpc = fakeChain([hit]);
  const u = make(rpc);
  const r = await u.submit(await signedEmail(earnPayout(500, `Transaction: ${hit.signature}`)), wallet);
  assert.equal(r.ok, true, r.reason);
  assert.equal(signatureIn(`x ${hit.signature} y`), hit.signature);
  // quoting somebody else's transaction does not help
  const w2 = w();
  const other = paid(w(), 500, { signature: '6'.repeat(88) });
  const r2 = await make(fakeChain([other])).submit(await signedEmail(earnPayout(500, `Transaction: ${other.signature}`)), w2);
  assert.equal(r2.ok, false);
});

test('the Earn signing domain is configurable', async () => {
  const wallet = w();
  const eml = await signedEmail({ ...earnPayout(500), domain: 'earn.example.test', from: 'Earn <hello@earn.example.test>' });
  const chain = fakeChain([paid(wallet, 500)]);
  const stock = await make(chain).submit(eml, wallet);
  assert.equal(stock.ok, false);
  assert.match(stock.reason, /untrusted signer/);
  const configured = make(chain, { superteamDomain: 'earn.example.test' });
  const r = await configured.submit(eml, wallet);
  assert.equal(r.ok, true, r.reason);
});

test('a plain Earn email whose amount is not USDC is refused', async () => {
  const wallet = w();
  const e = earnPayout(500);
  const r = await make(fakeChain([paid(wallet, 500)])).submit(await signedEmail({ ...e, body: e.body.replace('500 USDC', 'GHS 500') }), wallet);
  assert.equal(r.ok, false);
});

test('chain helpers: netCredit and findUsdcReceipt', async () => {
  const wallet = w();
  const tx = { meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: wallet, uiTokenAmount: { amount: '1000000' } }] } };
  assert.equal(netCredit(tx, wallet, MINT), 1_000_000n);
  assert.equal(netCredit(tx, w(), MINT), 0n);
  assert.match(await usdcAccountOf(wallet, MINT), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const hit = await findUsdcReceipt({ wallet, amountUsdc: 10, at: new Date(), mint: MINT, rpc: fakeChain([paid(wallet, 10)]) });
  assert.equal(hit.amountMicro, 10_000_000n);
});

test('getIdentityOwner reads the IdentityLink account', async () => {
  const crypto = await import('node:crypto');
  const { getAddressDecoder } = await import('@solana/kit');
  const owner = nacl.sign.keyPair().publicKey;
  const data = Buffer.concat([crypto.createHash('sha256').update('account:IdentityLink').digest().subarray(0, 8), Buffer.from(owner), Buffer.from([254])]);
  const program = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';
  const mk = (value) => async () => ({ ok: true, json: async () => ({ result: { value } }) });
  const idHash = crypto.createHash('sha256').update('x').digest();
  assert.equal(await getIdentityOwner(idHash, { fetchImpl: mk({ owner: program, data: [data.toString('base64'), 'base64'] }), programId: program }), getAddressDecoder().decode(owner));
  assert.equal(await getIdentityOwner(idHash, { fetchImpl: mk(null), programId: program }), null);
  await assert.rejects(getIdentityOwner(idHash, { fetchImpl: mk({ owner: program, data: ['AAAA', 'base64'] }), programId: program }), /malformed/);
});

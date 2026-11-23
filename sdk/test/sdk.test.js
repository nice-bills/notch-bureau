import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { address, getAddressEncoder } from '@solana/kit';
import {
  BUCKETS, NOTCH_PROGRAM_ADDRESS, availableBucket, buildCheckCreditIx, decodeCreditCheck, decodeCreditLine, findCreditLineAddress, getCredit,
} from '../src/index.js';

const W = address('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const USDC = 1_000_000n;

function lineBytes({ limit, drawn = 0n, expiry, onTime = 0, defaulted = false, postedAt = 100n, wallet = W }) {
  const b = Buffer.alloc(106);
  Buffer.from(getAddressEncoder().encode(wallet)).copy(b, 8);
  b.writeBigUInt64LE(limit, 40); b.writeBigInt64LE(expiry, 48); b.writeBigUInt64LE(drawn, 56);
  b.writeUInt32LE(onTime, 72); b[88] = defaulted ? 1 : 0; b.writeBigInt64LE(postedAt, 98);
  return b;
}
const rpcWith = (owner, bytes) => ({
  getAccountInfo: () => ({ send: async () => ({ value: bytes ? { owner, data: [Buffer.from(bytes).toString('base64'), 'base64'] } : null }) }),
});

test('check_credit discriminator matches Anchor', async () => {
  const ix = await buildCheckCreditIx({ wallet: W, minAvailable: 30n * USDC, maxAgeSeconds: 3600 });
  assert.equal(Buffer.from(ix.data.subarray(0, 8)).toString('hex'), crypto.createHash('sha256').update('global:check_credit').digest().subarray(0, 8).toString('hex'));
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), 30n * USDC);
  assert.equal(Buffer.from(ix.data).readBigInt64LE(16), 3600n);
  assert.equal(ix.accounts[1].address, await findCreditLineAddress(W));
  assert.equal(ix.programAddress, NOTCH_PROGRAM_ADDRESS);
});

test('buckets follow the program: <25, 25-100, 100-500, 500+', () => {
  const cases = [[0, 0], [24_999_999n, 0], [25n * USDC, 1], [99n * USDC, 1], [100n * USDC, 2], [499n * USDC, 2], [500n * USDC, 3]];
  for (const [amt, b] of cases) assert.equal(availableBucket(amt), b);
  assert.equal(BUCKETS.length, 4);
});

test('getCredit: no account, wrong owner and short data all read as exists:false', async () => {
  assert.deepEqual(await getCredit(rpcWith(NOTCH_PROGRAM_ADDRESS, null), W), { exists: false });
  assert.deepEqual(await getCredit(rpcWith(address('11111111111111111111111111111111'), lineBytes({ limit: 1n, expiry: 9n })), W), { exists: false });
  assert.deepEqual(await getCredit(rpcWith(NOTCH_PROGRAM_ADDRESS, Buffer.alloc(20)), W), { exists: false });
});

test('getCredit reads bucket, history, defaulted and expiry from account data', async () => {
  const c = await getCredit(rpcWith(NOTCH_PROGRAM_ADDRESS, lineBytes({ limit: 120n * USDC, drawn: 30n * USDC, expiry: 5000n, onTime: 2 })), W, { nowSeconds: 1000 });
  assert.deepEqual(c, { exists: true, wallet: W, availableBucket: 1, availableBucketLabel: '25 to 100 USDC', onTimeRepayments: 2, defaulted: false, expiresAt: 5000, postedAt: 100, expired: false, active: true });
  const d = await getCredit(rpcWith(NOTCH_PROGRAM_ADDRESS, lineBytes({ limit: 0n, expiry: 5000n, defaulted: true })), W, { nowSeconds: 1000 });
  assert.equal(d.defaulted, true); assert.equal(d.active, false); assert.equal(d.availableBucket, 0);
  const e = await getCredit(rpcWith(NOTCH_PROGRAM_ADDRESS, lineBytes({ limit: 50n * USDC, expiry: 5000n })), W, { nowSeconds: 5000 });
  assert.deepEqual([e.expired, e.active], [true, false]);
});

test('decodeCreditLine tolerates a pre-posted_at (98 byte) line', () => {
  const b = lineBytes({ limit: 5n, expiry: 9n }).subarray(0, 98);
  assert.equal(decodeCreditLine(b).postedAt, 0n);
});

test('decodeCreditCheck reads the 38 byte return data', () => {
  const b = Buffer.alloc(38);
  Buffer.from(getAddressEncoder().encode(W)).copy(b, 0); b[32] = 2; b.writeUInt32LE(3, 33);
  assert.deepEqual(decodeCreditCheck(b), { wallet: W, availableBucket: 2, availableBucketLabel: '100 to 500 USDC', onTimeRepayments: 3, defaulted: false });
  assert.throws(() => decodeCreditCheck(Buffer.alloc(5)));
});

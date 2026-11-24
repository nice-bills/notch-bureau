// Notch Bureau: `check_credit` (every pass/fail case) and the hostel-deposit program that calls it over CPI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import bs58 from 'bs58';
import { address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports } from '@solana/kit';
import {
  PROGRAM, SYSTEM, USDC, U, W, R, WS, advance, disc, drawIx, depositBorrowerIx, enc, i64, markDefaultIx, meta, open,
  pda, postLimit, repayIx, readLine, record, send, sendB, setup, u64, warp, fails,
} from './lib.js';

const HOSTEL = address(fs.readFileSync(new URL('../Anchor.toml', import.meta.url), 'utf8').match(/hostel_deposit = "(\w+)"/)[1]);
const HOSTEL_SO = new URL('../target/deploy/hostel_deposit.so', import.meta.url).pathname;
const DAY = 86_400;
const MAX_AGE = 30 * DAY; // MAX_RECORD_AGE_S in programs/hostel-deposit/src/lib.rs

const lineOf = async (w) => pda(Buffer.from('line'), enc.encode(w));
const checkIx = async (borrower, minAvailable, maxAge, { line } = {}) => ({
  programAddress: PROGRAM,
  accounts: [meta(borrower, R), meta(line ?? (await lineOf(borrower)), R)],
  data: Buffer.concat([disc('check_credit'), u64(minAvailable), i64(maxAge)]),
});
const decode = (rd) => ({
  wallet: bs58.encode(rd.subarray(0, 32)), bucket: rd[32], onTime: rd.readUInt32LE(33), defaulted: rd[37] === 1, len: rd.length,
});
const bookingOf = async (w) => (await getProgramDerivedAddress({ programAddress: HOSTEL, seeds: [Buffer.from('booking'), enc.encode(w)] })).at(0);
const bookIx = async (student, rent, { line, notch = PROGRAM, booking } = {}) => ({
  programAddress: HOSTEL,
  accounts: [meta(student, WS), meta(booking ?? (await bookingOf(student)), W), meta(line ?? (await lineOf(student)), R), meta(notch, R), meta(SYSTEM, R)],
  data: Buffer.concat([disc('book'), u64(rent)]),
});
const readBooking = async (ctx, w) => {
  const a = ctx.svm.getAccount(await bookingOf(w));
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return { student: bs58.encode(d.subarray(8, 40)), rent: d.readBigUInt64LE(40), bucket: d[48], bookedAt: d.readBigInt64LE(49) };
};
async function bureauSetup(opts) {
  const ctx = await setup(opts);
  ctx.svm.addProgramFromFile(HOSTEL, HOSTEL_SO);
  return ctx;
}
const checkAs = (ctx, ...a) => async () => sendB(ctx, await checkIx(ctx.borrower.address, ...a));
async function defaultTheLine(ctx) {
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  advance(ctx, 31 * DAY);
  const r = await sendB(ctx, markDefaultIx(ctx));
  assert.ok(r.ok, r.logs);
}

// ---------- check_credit ----------

test('check_credit passes for a live line and returns a coarse bucket, never the exact numbers', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  const r = await sendB(ctx, await checkIx(ctx.borrower.address, 30n * USDC, 60));
  assert.ok(r.ok, r.logs);
  const out = decode(r.returnData);
  assert.deepEqual(out, { wallet: ctx.borrower.address, bucket: 1, onTime: 0, defaulted: false, len: 38 });
  // the event is logged for same-transaction readers
  assert.match(r.logs, /Program data:/);
});

test('check_credit bucket edges: <25, 25-100, 100-500, 500+ USDC of AVAILABLE credit', async () => {
  const cases = [[24, 0], [25, 1], [99, 1], [100, 2], [499, 2], [500, 3], [2000, 3]];
  for (const [limit, bucket] of cases) {
    const ctx = await bureauSetup();
    await open(ctx, limit);
    const r = await sendB(ctx, await checkIx(ctx.borrower.address, 0n, 60));
    assert.ok(r.ok, r.logs);
    assert.equal(decode(r.returnData).bucket, bucket, `limit ${limit}`);
  }
});

test('check_credit buckets what is LEFT after a draw, and reports on-time repayments', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 120);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  let r = await sendB(ctx, await checkIx(ctx.borrower.address, 60n * USDC, 60));
  assert.ok(r.ok, r.logs);
  assert.deepEqual([decode(r.returnData).bucket, decode(r.returnData).onTime], [1, 0]); // 90 left
  advance(ctx, 31); // held long enough for the repayment to count
  assert.ok((await sendB(ctx, repayIx(ctx, U(30.6)))).ok);
  r = await sendB(ctx, await checkIx(ctx.borrower.address, 60n * USDC, 60));
  assert.ok(r.ok, r.logs);
  assert.deepEqual([decode(r.returnData).bucket, decode(r.returnData).onTime], [2, 1]); // 120 left
});

test('check_credit is read-only: no account changes, and anyone (not the borrower) can ask', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  const before = Buffer.from(ctx.svm.getAccount(ctx.line).data);
  const lamportsBefore = ctx.svm.getAccount(ctx.line).lamports;
  const stranger = await generateKeyPairSigner();
  ctx.svm.airdrop(stranger.address, lamports(1_000_000_000n));
  const r = await send(ctx.svm, stranger, [await checkIx(ctx.borrower.address, 1n, 60)]);
  assert.ok(r.ok, r.logs);
  assert.deepEqual(Buffer.from(ctx.svm.getAccount(ctx.line).data), before);
  assert.equal(ctx.svm.getAccount(ctx.line).lamports, lamportsBefore);
});

test('check_credit fails NoCreditLine for a wallet that never got a record', async () => {
  const ctx = await bureauSetup();
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 60)), 'NoCreditLine');
  const nobody = await generateKeyPairSigner();
  fails(await sendB(ctx, await checkIx(nobody.address, 0n, 60)), 'NoCreditLine');
});

test('check_credit fails Defaulted once the line is marked defaulted, whatever the ask', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  await defaultTheLine(ctx);
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 0n, 1_000 * DAY)), 'Defaulted');
});

test('check_credit fails RecordExpired once the signed record expires (even with a huge max_age)', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50); // expires at now + 90d
  warp(ctx, 90 * DAY - 1);
  assert.ok((await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 1_000 * DAY))).ok);
  warp(ctx, 90 * DAY);
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 1_000 * DAY)), 'RecordExpired');
});

test('check_credit fails InsufficientCredit when less than min_available is left', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  assert.ok((await sendB(ctx, await checkIx(ctx.borrower.address, 50n * USDC, 60))).ok); // exactly enough
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 50n * USDC + 1n, 60)), 'InsufficientCredit');
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  assert.ok((await sendB(ctx, await checkIx(ctx.borrower.address, 20n * USDC, 60))).ok);
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 21n * USDC, 60)), 'InsufficientCredit');
});

test('check_credit fails StaleRecord when the record was posted longer ago than max_age_s (exactly max_age passes)', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  const posted = readLine(ctx.svm, ctx.line).postedAt;
  assert.equal(posted, ctx.svm.getClock().unixTimestamp);
  advance(ctx, 1000);
  assert.ok((await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 1000))).ok);
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 999)), 'StaleRecord');
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 1n, -1)), 'StaleRecord');
  // re-posting a newer record refreshes the clock
  assert.ok((await postLimit(ctx, record(ctx, { limitUsdc: 50, nonce: 2, expiry: Number(ctx.now) + 90 * DAY }))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).postedAt, ctx.svm.getClock().unixTimestamp);
  assert.ok((await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 0))).ok);
});

test('check_credit: another wallet\'s line cannot be passed for this borrower', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  const other = await generateKeyPairSigner();
  const r = await sendB(ctx, await checkIx(other.address, 1n, 60, { line: ctx.line }));
  assert.equal(r.ok, false);
  assert.match(r.logs, /ConstraintSeeds/);
});

// ---------- hostel-deposit (CPI consumer) ----------

test('hostel: books a room when Notch says the student is good for the rent (and stores only the bucket)', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  const r = await sendB(ctx, await bookIx(ctx.borrower.address, 30n * USDC));
  assert.ok(r.ok, r.logs);
  assert.match(r.logs, new RegExp(`Program ${PROGRAM} invoke \\[2\\]`)); // really a CPI into notch
  const b = await readBooking(ctx, ctx.borrower.address);
  assert.deepEqual([b.student, b.rent, b.bucket], [ctx.borrower.address, 30n * USDC, 1]);
  // the booking never touches Notch's state
  assert.equal(readLine(ctx.svm, ctx.line).drawn, 0n);
});

test('hostel: refuses a student with no Notch line', async () => {
  const ctx = await bureauSetup();
  const r = await sendB(ctx, await bookIx(ctx.borrower.address, 1n * USDC));
  fails(r, 'NoCreditLine');
  assert.equal(await readBooking(ctx, ctx.borrower.address), null);
});

test('hostel: refuses a defaulted student', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  await defaultTheLine(ctx);
  fails(await sendB(ctx, await bookIx(ctx.borrower.address, 1n * USDC)), 'Defaulted');
  assert.equal(await readBooking(ctx, ctx.borrower.address), null);
});

test('hostel: refuses an expired record', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  warp(ctx, 91 * DAY);
  fails(await sendB(ctx, await bookIx(ctx.borrower.address, 1n * USDC)), 'RecordExpired');
});

test('hostel: refuses when the rent is more than what is left (before and after a draw)', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  fails(await sendB(ctx, await bookIx(ctx.borrower.address, 51n * USDC)), 'InsufficientCredit');
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  fails(await sendB(ctx, await bookIx(ctx.borrower.address, 25n * USDC)), 'InsufficientCredit');
  assert.equal(await readBooking(ctx, ctx.borrower.address), null);
  assert.ok((await sendB(ctx, await bookIx(ctx.borrower.address, 20n * USDC))).ok);
});

test('hostel: refuses a record posted longer ago than its 30 day freshness window', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50); // valid 90 days
  warp(ctx, MAX_AGE + 1);
  fails(await sendB(ctx, await bookIx(ctx.borrower.address, 1n * USDC)), 'StaleRecord');
  assert.ok((await postLimit(ctx, record(ctx, { limitUsdc: 50, nonce: 2, expiry: Number(ctx.now) + 120 * DAY }))).ok);
  assert.ok((await sendB(ctx, await bookIx(ctx.borrower.address, 1n * USDC))).ok);
});

test('hostel attack: a student cannot book using someone else\'s good line, or a fake Notch program', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50); // ctx.borrower is the good one
  const mallory = await generateKeyPairSigner();
  ctx.svm.airdrop(mallory.address, lamports(1_000_000_000n));
  let r = await send(ctx.svm, mallory, [await bookIx(mallory.address, 1n * USDC, { line: ctx.line })]);
  assert.equal(r.ok, false);
  assert.match(r.logs, /ConstraintSeeds/);
  // a lookalike "notch" program that always succeeds is refused by the address check
  const fake = await generateKeyPairSigner();
  r = await send(ctx.svm, mallory, [await bookIx(mallory.address, 1n * USDC, { notch: fake.address })]);
  assert.equal(r.ok, false);
  assert.match(r.logs, /ConstraintAddress|InvalidProgramId|AccountNotExecutable|IncorrectProgramId/);
  assert.equal(await readBooking(ctx, mallory.address), null);
});

test('hostel: one booking per student', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  assert.ok((await sendB(ctx, await bookIx(ctx.borrower.address, 10n * USDC))).ok);
  const r = await sendB(ctx, await bookIx(ctx.borrower.address, 10n * USDC));
  assert.equal(r.ok, false);
});

// ---------- legacy lines (created before posted_at existed: 98 bytes instead of the current 154) ----------

test('legacy 98-byte lines keep working: draw, repay and default still save; check_credit reads them as posted long ago', async () => {
  const ctx = await bureauSetup();
  await open(ctx, 50);
  const a = ctx.svm.getAccount(ctx.line);
  assert.equal(a.data.length, 154);
  ctx.svm.setAccount({ ...a, data: a.data.slice(0, 98), space: 98n });
  assert.equal(ctx.svm.getAccount(ctx.line).data.length, 98);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 50n * USDC);

  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  const d = await sendB(ctx, drawIx(ctx, 30n * USDC));
  assert.ok(d.ok, d.logs);
  assert.equal(ctx.svm.getAccount(ctx.line).data.length, 98);
  advance(ctx, 7200); // the test clock starts at 0, which would otherwise look "just posted"
  // no timestamp to read: a normal freshness ask fails, an "any age" ask passes
  fails(await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 3600)), 'StaleRecord');
  const r = await sendB(ctx, await checkIx(ctx.borrower.address, 1n, 2n ** 62n));
  assert.ok(r.ok, r.logs);
  assert.equal(decode(r.returnData).bucket, 0); // 20 left
  assert.ok((await sendB(ctx, repayIx(ctx, U(30.6)))).ok);
  // A line without the trailing fields has no draw clock, so it cannot prove how long the loan was held: the repayment
  // is made in full but is not a track-record entry until the next post_limit grows the line (see tests/audit.test.js).
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0);
  assert.equal(ctx.svm.getAccount(ctx.line).data.length, 98);

  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  advance(ctx, 31 * DAY);
  const m = await sendB(ctx, markDefaultIx(ctx));
  assert.ok(m.ok, m.logs);
  assert.equal(readLine(ctx.svm, ctx.line).defaulted, true);
});

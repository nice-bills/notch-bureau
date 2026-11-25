// Permanent regression tests for the final gate review (reviews/2026-11-25-final/REVIEW-final-gate.md), program side.
// The scratch proofs there (prog-rev.test.mjs R1 and R2) live on here as tests that fail on the pre-fix build:
//   NOTCH_SO=<old notch.so> node --test tests/final-gate.test.js   (see reviews/2026-11-25-final/proof/)
// #1 repayment-count pumping: tests/audit.test.js ("final gate #1"). #6 overdue check_credit: tests/bureau.test.js.
// Here: #3 cancel forfeits the escrow gain, mark_default from due + 1, #4 partial claim, #5 legacy request cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_WINDOW, COOLDOWN, U, USDC, advance, cancelLegacyWithdrawIx, cancelWithdrawIx, claimWithdrawIx, depositBorrowerIx, depositIx, drawIx,
  drawWithTermIx, fails, lenderPdas, markDefaultIx, newLender, open, readLine, readPool, readRequest, repayIx, requestWithdrawIx,
  sendB, sendL, setup, tokenBalance, mintSupply,
} from './lib.js';

const bal = (ctx, a) => tokenBalance(ctx.svm, a);
const DAY = 86400;
// What a lender's shares are worth in the junior tranche right now (floor, base units).
const worth = (ctx, shares) => (shares * readPool(ctx.svm, ctx.pool).juniorNav) / mintSupply(ctx.svm, ctx.shareMint);

async function twoJuniorsWithFee() {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC });
  const a = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok); // fee 2 -> junior NAV 202, price 1.01
  return { ctx, a };
}

test('R1 (final gate #3): cancelling an armed request returns shares worth at most the request-time value; the escrow gain is burned for the pool', async () => {
  const { ctx, a } = await twoJuniorsWithFee();
  advance(ctx, COOLDOWN + CLAIM_WINDOW - 10);
  const supplyBefore = mintSupply(ctx.svm, ctx.shareMint);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  const back = bal(ctx, a.shares);
  assert.ok(back < 100n * USDC, `fewer shares come back (${back})`);
  assert.ok(back > 98n * USDC, `but not many fewer (${back})`);
  assert.ok(worth(ctx, back) <= 100n * USDC, `worth ${worth(ctx, back)}: at most the request-time 100 USDC (it was 101 before the fix)`);
  assert.ok(worth(ctx, back) >= 100n * USDC - 2n, 'and within rounding of it');
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), supplyBefore - (100n * USDC - back), 'the rest was burned, not paid out');
  // the lender who stayed owns the forfeited value: 100 shares of supply ~ 198, NAV 202
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.juniorNav, 202n * USDC, 'NAV untouched: the gain stays in the pool');
  // a rolling bot gains nothing from re-arming: re-file at the new price, cancel again, value does not grow
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, back))).ok);
  advance(ctx, 4 * DAY);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  assert.ok(worth(ctx, bal(ctx, a.shares)) <= 100n * USDC);
});

test('final gate #3: if the price FELL while the request was armed (a default), cancel returns every share: the loss is carried, nothing is burned', async () => {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC });
  const a = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  await open(ctx, 100);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 50n * USDC, 10))).ok);
  advance(ctx, 11);
  assert.ok((await sendB(ctx, markDefaultIx(ctx))).ok); // loss 40 -> junior NAV 160
  const supply = mintSupply(ctx.svm, ctx.shareMint);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.shares), 100n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), supply);
});

test('final gate #3: the only holder of a tranche gets every share back (no one to give the forfeited value to)', async () => {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC });
  const a = ctx.lender; // the seed lender holds all 100 junior shares
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.shares), 100n * USDC);
});

test('final gate #3: mark_default works from due + 1 second (not at due), so a keeper can race a lender\'s claim from the first second', async () => {
  const ctx = await setup();
  await open(ctx, 50);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 50n * USDC, 100))).ok);
  const due = readLine(ctx.svm, ctx.line).due;
  const now = ctx.svm.getClock().unixTimestamp;
  advance(ctx, Number(due - now)); // now == due
  fails(await sendB(ctx, markDefaultIx(ctx)), 'NotPastDue');
  advance(ctx, 1); // due + 1
  assert.ok((await sendB(ctx, markDefaultIx(ctx))).ok);
});

test('final gate #4: a lender behind a big request is paid in parts as cash returns, never stuck; the locked price holds across parts', async () => {
  const ctx = await setup();
  const a = ctx.lender;
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 50n * USDC))).ok); // idle 450
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 500n * USDC))).ok);
  advance(ctx, COOLDOWN);
  const before = bal(ctx, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.usdc) - before, 450n * USDC);
  const req = await readRequest(ctx, a);
  assert.equal(req.shares, 50n * USDC);
  assert.equal(req.supplyAtRequest, 500n * USDC, 'locked price untouched by the part-payment');
  assert.equal(readPool(ctx.svm, ctx.pool).juniorNav, 50n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 50n * USDC);
});

test('final gate #5: a legacy (pre price-lock, 16 bytes shorter) request can be cancelled and closed; the current-size request is refused', async () => {
  const ctx = await setup({ seed: 100n * USDC });
  const a = ctx.lender;
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 40n * USDC))).ok);
  const { request } = await lenderPdas(a);
  // a request of the current size is not a legacy one
  fails(await sendL(ctx, a, await cancelLegacyWithdrawIx(ctx, a)), 'NotLegacyRequest');
  // cut it down to the old layout (no nav_at_request / supply_at_request)
  const acc = ctx.svm.getAccount(request);
  ctx.svm.setAccount({ ...acc, data: acc.data.slice(0, 58), space: 58n, lamports: ctx.svm.minimumBalanceForRentExemption(58n) });
  assert.equal(bal(ctx, a.shares), 60n * USDC);
  fails(await sendL(ctx, a, await cancelWithdrawIx(ctx, a)), 'AccountDidNotDeserialize'); // the bricked state
  assert.ok((await sendL(ctx, a, await cancelLegacyWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.shares), 100n * USDC, 'every escrowed share is back');
  assert.equal(await readRequest(ctx, a), null);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 10n * USDC))).ok, 'the PDA is free again');
});

test('final gate #3 (found by the devnet e2e): cancel with NO price change returns every share even when the price is not a round number (no dust burn from rounding)', async () => {
  const { ctx, a } = await twoJuniorsWithFee(); // price 1.01 now
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  const b = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, b, depositIx(ctx, b, 50n * USDC))).ok); // mints 49.504950... shares at 1.01
  const got = bal(ctx, b.shares);
  assert.ok(got % 10n !== 0n, 'a non-round share count');
  assert.ok((await sendL(ctx, b, await requestWithdrawIx(ctx, b, got))).ok);
  const supply = mintSupply(ctx.svm, ctx.shareMint);
  advance(ctx, 3600);
  assert.ok((await sendL(ctx, b, await cancelWithdrawIx(ctx, b))).ok);
  assert.equal(bal(ctx, b.shares), got, 'every share back');
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), supply, 'nothing burned');
});

// Last gate #1 (reviews/2026-11-25-final/dust.test.mjs): cancel_withdraw burned the escrow gain with no dust check, so a
// lender with a 1-share second wallet could burn the supply down to ~50 shares and price one share at ~2 USDC
// (first-depositor inflation). Cancel must never leave 0 < supply < MIN_FIRST_DEPOSIT.
test('LG1: cancel_withdraw never burns the share supply down to dust', async () => {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC });
  const a = ctx.lender;
  const b = await newLender(ctx, 10n * USDC);
  assert.ok((await sendL(ctx, b, depositIx(ctx, b, 1n))).ok, 'second wallet holds 1 share');
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  const sup = mintSupply(ctx.svm, ctx.shareMint);
  assert.ok(sup === 0n || sup >= 1_000_000n, `supply after cancel is dust: ${sup}`);
  // and an honest depositor is not robbed: 3 USDC in is worth ~3 USDC
  const v = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, v, depositIx(ctx, v, 3n * USDC))).ok);
  const got = tokenBalance(ctx.svm, v.shares);
  const worth = (got * readPool(ctx.svm, ctx.pool).juniorNav) / mintSupply(ctx.svm, ctx.shareMint);
  assert.ok(worth >= 2_990_000n, `3 USDC deposit is worth ${worth}`);
});

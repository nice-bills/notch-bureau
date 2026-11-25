import test from 'node:test';
import assert from 'node:assert/strict';
const L = await import('/home/bills/code/dev3pack/notch/tests/lib.js');
const { COOLDOWN, CLAIM_WINDOW, U, USDC, advance, cancelWithdrawIx, claimWithdrawIx, depositBorrowerIx, depositIx, drawIx, drawWithTermIx,
  markDefaultIx, newLender, open, postLimit, readLine, readPool, record, repayIx, requestWithdrawIx, sendB, sendL, setup, tokenBalance } = L;
const bal = (ctx, a) => tokenBalance(ctx.svm, a);

test('R1: an armed request costs nothing: cancel returns shares that kept earning (no forfeit unless you claim)', async () => {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC });
  const a = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok); // fee 2 -> junior NAV 202
  advance(ctx, COOLDOWN + CLAIM_WINDOW - 10);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok); // nothing went wrong: cancel
  assert.equal(bal(ctx, a.shares), 100n * USDC);
  const p = readPool(ctx.svm, ctx.pool);
  console.log('A shares 100 of supply 200, junior NAV', p.juniorNav, '=> A still owns 101 USDC (the fee earned while "armed")');
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok); // re-arm at once, the new price (1.01) is locked
  // a loan goes overdue while A is armed: A claims + calls mark_default itself in ONE tx -> pre-loss price
  await open(ctx, 50, { nonce: 9 }).catch(() => {});
});

test('R2: a dust limit still earns a full on-time count (floor = min(limit, ...))', async () => {
  const ctx = await setup({ borrowerFunds: 10n * USDC });
  let nonce = 1;
  for (let i = 0; i < 6; i++) {
    const r = await postLimit(ctx, record(ctx, { limitUsdc: 0.05, nonce: nonce++, expiry: Number(ctx.now) + 90 * 86400 }));
    assert.ok(r.ok, r.logs);
    assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 10_000n))).ok);
    assert.ok((await sendB(ctx, drawIx(ctx, 50_000n))).ok); // 0.05 USDC
    advance(ctx, 31);
    assert.ok((await sendB(ctx, repayIx(ctx, 60_000n))).ok);
  }
  const l = readLine(ctx.svm, ctx.line);
  console.log('repaid_on_time after six 0.05 USDC loans held 31 s:', l.repaidOnTime);
  assert.equal(l.repaidOnTime, 6);
});

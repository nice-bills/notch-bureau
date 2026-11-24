import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '/home/bills/code/dev3pack/notch/tests/lib.js';
const { USDC, setup, open, sendB, sendL, drawIx, repayIx, depositBorrowerIx, readLine, readPool, newLender, depositIx, requestWithdrawIx, claimWithdrawIx, markDefaultIx, advance, COOLDOWN, tokenBalance, drawWithTermIx } = L;

test('F1: dust draw+repay pumps repaid_on_time to 6 in ONE transaction', async () => {
  const ctx = await setup();
  await open(ctx);
  const ixs = [depositBorrowerIx(ctx, 1n)];
  for (let i = 0; i < 6; i++) { ixs.push(drawIx(ctx, 1n), repayIx(ctx, 2n), depositBorrowerIx(ctx, 1n)); }
  const before = tokenBalance(ctx.svm, ctx.borrowerAcct);
  const r = await sendB(ctx, ...ixs);
  assert.ok(r.ok, r.logs);
  const l = readLine(ctx.svm, ctx.line);
  console.log('repaidOnTime', l.repaidOnTime, 'cost micro-USDC', before - tokenBalance(ctx.svm, ctx.borrowerAcct) - l.deposit);
  assert.equal(l.repaidOnTime, 6);
});

test('F2: an armed (matured) junior withdraw request exits at full price after the loan is overdue, before mark_default', async () => {
  const ctx = await setup({ seed: 100n * USDC });
  const a = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok);
  // A arms a request right away and waits out the cooldown (shares keep earning in escrow).
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  advance(ctx, COOLDOWN + 1);
  await open(ctx, 50);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 10n * USDC))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 50n * USDC, 10))).ok);
  advance(ctx, 11); // loan is overdue; keeper has not marked it yet
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  console.log('A got back', tokenBalance(ctx.svm, a.usdc));
  assert.equal(tokenBalance(ctx.svm, a.usdc), 100n * USDC);
  assert.ok((await sendB(ctx, markDefaultIx(ctx))).ok);
  const p = readPool(ctx.svm, ctx.pool);
  console.log('remaining junior nav', p.juniorNav ?? p);
});

test('F3: borrower can keep drawing after the due date has passed (line overdue, not yet marked)', async () => {
  const ctx = await setup();
  await open(ctx, 50);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 10n * USDC))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 10n * USDC, 10))).ok);
  advance(ctx, 100);
  const r = await sendB(ctx, drawIx(ctx, 40n * USDC));
  console.log('draw while overdue ok?', r.ok);
});

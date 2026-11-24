// Permanent regression tests for the 2026-11-24 audit (reviews/2026-11-24-audit/REVIEW.md), program side.
// Every test runs the real program (target/deploy/notch.so, or NOTCH_SO=<older build>) in LiteSVM.
// Findings: #2 dust repayments (F1), #4 armed withdraw requests (F2), #5 draw while overdue (F3),
//          #10 one identity per wallet, #11 first depositor / dust supply, plus the line layout the keeper reads.
// Run against the pre-fix build to see them fail:  NOTCH_SO=<old notch.so> node --test tests/audit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CLAIM_WINDOW, COOLDOWN, U, USDC, advance, cancelWithdrawIx, claimWithdrawIx, depositBorrowerIx, depositIx, drawIx, drawWithTermIx,
  enc, fails, markDefaultIx, newLender, open, pda, postLimit, readLine, readPool, readRequest, record, repayIx,
  requestWithdrawIx, sendB, sendL, setup, tokenBalance,
} from './lib.js';

const bal = (ctx, a) => tokenBalance(ctx.svm, a);
const rich = (ctx) => ctx.mintTo(ctx.borrowerAcct, 200n * USDC);

// ------------------------------------------------------------------------------------------------------------------
// #2 / F1: dust draw+repay cycles must not pump repaid_on_time
// ------------------------------------------------------------------------------------------------------------------
test('F1 (audit #2): six 1-micro-USDC draw+repay cycles in ONE transaction do not count', async () => {
  const ctx = await setup();
  await open(ctx);
  const ixs = [depositBorrowerIx(ctx, 1n)];
  for (let i = 0; i < 6; i++) ixs.push(drawIx(ctx, 1n), repayIx(ctx, 2n), depositBorrowerIx(ctx, 1n));
  const r = await sendB(ctx, ...ixs);
  assert.ok(r.ok, r.logs); // the cycles still work, they just earn no reputation
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0);
});

test('F1: a real-size loan drawn and repaid in the same transaction (same slot) does not count', async () => {
  const ctx = await setup();
  await open(ctx, 50);
  await rich(ctx);
  const r = await sendB(ctx, depositBorrowerIx(ctx, U(4)), drawIx(ctx, 20n * USDC), repayIx(ctx, 30n * USDC));
  assert.ok(r.ok, r.logs);
  const l = readLine(ctx.svm, ctx.line);
  assert.equal(l.repaidOnTime, 0);
  assert.equal(l.drawn, 0n);
});

test('F1: a real loan held >= 30 s counts, but only ONCE per posted record; a new record re-arms it', async () => {
  const ctx = await setup();
  await open(ctx, 50); // nonce 1
  await rich(ctx);
  const cycle = async () => {
    assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(4)))).ok);
    assert.ok((await sendB(ctx, drawIx(ctx, 20n * USDC))).ok);
    advance(ctx, 31);
    assert.ok((await sendB(ctx, repayIx(ctx, 30n * USDC))).ok);
    return readLine(ctx.svm, ctx.line);
  };
  let l = await cycle();
  assert.equal(l.repaidOnTime, 1, 'first real repayment counts');
  assert.equal(l.countedNonce, 1n);
  for (let i = 0; i < 3; i++) l = await cycle();
  assert.equal(l.repaidOnTime, 1, 'more cycles under the SAME posted record do not count again');
  // A fresh signed record (a fresh statement) re-arms one count.
  assert.ok((await postLimit(ctx, record(ctx, { limitUsdc: 50, nonce: 2, expiry: Number(ctx.now) + 90 * 86400 }))).ok);
  l = await cycle();
  assert.equal(l.repaidOnTime, 2);
  l = await cycle();
  assert.equal(l.repaidOnTime, 2);
});

test('F1: the size floor is min(limit, max(5 USDC, limit/4)); the hold clock restarts at every draw', async () => {
  const ctx = await setup();
  await open(ctx, 50); // floor = max(12.5, 5) = 12.5 USDC
  await rich(ctx);
  // 1 micro-unit under the floor, held for days: not counted.
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(3)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 12_499_999n))).ok);
  advance(ctx, 5 * 86400);
  assert.ok((await sendB(ctx, repayIx(ctx, 30n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0);
  // Exactly the floor, but a second draw right before repaying restarts the clock: not counted.
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(3)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 12_000_000n))).ok);
  advance(ctx, 5 * 86400);
  assert.ok((await sendB(ctx, drawIx(ctx, 500_000n))).ok);
  assert.ok((await sendB(ctx, repayIx(ctx, 30n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0);
  // Exactly the floor and held: counted.
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(3)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 12_500_000n))).ok);
  advance(ctx, 30);
  assert.ok((await sendB(ctx, repayIx(ctx, 30n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 1);
});

test('F1: a small limit still works: the floor never exceeds the limit', async () => {
  const ctx = await setup();
  await open(ctx, 4); // max(5, 1) = 5 > limit, so the floor is the whole limit (4)
  await rich(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(1)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 3n * USDC))).ok);
  advance(ctx, 60);
  assert.ok((await sendB(ctx, repayIx(ctx, 30n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0, '3 of 4 is under the floor');
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(1)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 4n * USDC))).ok);
  advance(ctx, 60);
  assert.ok((await sendB(ctx, repayIx(ctx, 30n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 1, 'the whole limit counts');
});

// ------------------------------------------------------------------------------------------------------------------
// #4 / F2: withdraw requests: claim window, price locked at request (no earning in escrow, losses carried)
// ------------------------------------------------------------------------------------------------------------------
async function twoJuniors() {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC }); // admin = lender 1 with 100
  const a = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok); // junior supply 200, NAV 200
  return { ctx, a };
}

test('F2 (audit #4): a request left armed past the claim window cannot be used to exit before a default; cancel + refile costs a new cooldown', async () => {
  const { ctx, a } = await twoJuniors();
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  const req = await readRequest(ctx, a);
  advance(ctx, COOLDOWN + CLAIM_WINDOW + 1); // A keeps the request armed far past maturity and waits for trouble
  await open(ctx, 50);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 10n * USDC))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 50n * USDC, 10))).ok);
  advance(ctx, 11); // overdue, the keeper has not marked it yet
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'ClaimWindowClosed');
  assert.equal(bal(ctx, a.usdc), 0n);
  assert.ok(req.unlockTs > 0n);
  // The only way out is cancel + refile: shares come back, and a new request needs a new cooldown.
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.shares), 100n * USDC);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'CooldownActive');
  // The keeper marks the default inside that cooldown; the loss lands on A as well (they are a junior holder): 200 -> 160.
  assert.ok((await sendB(ctx, markDefaultIx(ctx))).ok);
  advance(ctx, COOLDOWN);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.usdc), 80n * USDC, 'A takes its fair half of the 40 loss (the unfixed program paid 100)');
});

test('F2: the claim window is exactly [unlock, unlock + 2 days]; inside it the claim pays', async () => {
  const { ctx, a } = await twoJuniors();
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  advance(ctx, COOLDOWN + CLAIM_WINDOW); // the very last second of the window
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.usdc), 100n * USDC);
  // one second later it would have lapsed
  const b = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, b, depositIx(ctx, b, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, b, await requestWithdrawIx(ctx, b, 100n * USDC))).ok);
  advance(ctx, COOLDOWN + CLAIM_WINDOW + 1);
  fails(await sendL(ctx, b, await claimWithdrawIx(ctx, b)), 'ClaimWindowClosed');
});

test('F2: shares in escrow earn nothing: a fee paid after the request goes to the lenders who stay', async () => {
  const { ctx, a } = await twoJuniors();
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  const r = await readRequest(ctx, a);
  assert.deepEqual([r.navAtRequest, r.supplyAtRequest], [200n * USDC, 200n * USDC]);
  await open(ctx, 200);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok); // fee 2 USDC, NAV 202
  assert.equal(readPool(ctx.svm, ctx.pool).juniorNav, 202n * USDC);
  advance(ctx, COOLDOWN);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.usdc), 100n * USDC, 'A gets the request-time price (1.00), not 1.01');
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.juniorNav, 102n * USDC, 'the 1 USDC A forfeited stays for the other holder (admin: 100 shares worth 102)');
  assert.equal(p.idle + p.outstanding, p.juniorNav + p.seniorNav);
});

test('F2: shares in escrow carry losses: a default marked after the request lowers the payout', async () => {
  const { ctx, a } = await twoJuniors();
  await open(ctx, 50);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 10n * USDC))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 50n * USDC, 10))).ok);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok); // priced 1.00 at request
  advance(ctx, 11);
  assert.ok((await sendB(ctx, markDefaultIx(ctx))).ok); // net loss 40 (10 seized): price 0.80
  advance(ctx, COOLDOWN);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.usdc), 80n * USDC);
});

test('F2 KNOWN RESIDUAL (documented in lib.rs): a claim that lands between "overdue" and mark_default still pays the pre-loss price; the window is the keeper latency', async () => {
  const { ctx, a } = await twoJuniors();
  await open(ctx, 50);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  advance(ctx, COOLDOWN);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 10n * USDC))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 50n * USDC, 10))).ok);
  advance(ctx, 11);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(bal(ctx, a.usdc), 100n * USDC);
  // ... which is why the keeper must mark overdue loans quickly (hourly, 3-day cooldown): the keeper test covers its reach.
});

// ------------------------------------------------------------------------------------------------------------------
// #5 / F3: no new draws while a loan is overdue
// ------------------------------------------------------------------------------------------------------------------
test('F3 (audit #5): once a loan is past due the borrower cannot draw more; at the due second it is still allowed; repaying re-opens the line', async () => {
  const ctx = await setup();
  await open(ctx, 50);
  await rich(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 20n * USDC))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, 10n * USDC, 10))).ok);
  advance(ctx, 10); // now == due: not overdue yet
  assert.ok((await sendB(ctx, drawIx(ctx, 1n * USDC))).ok);
  advance(ctx, 1); // now > due
  fails(await sendB(ctx, drawIx(ctx, 40n * USDC)), 'LoanOverdue');
  fails(await sendB(ctx, drawIx(ctx, 1n)), 'LoanOverdue');
  // Late repayment is still accepted (counted late); afterwards the borrower can draw again.
  assert.ok((await sendB(ctx, repayIx(ctx, 20n * USDC))).ok);
  const l = readLine(ctx.svm, ctx.line);
  assert.deepEqual([l.repaidLate, l.repaidOnTime, l.drawn], [1, 0, 0n]);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, 1n * USDC))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 1n * USDC))).ok);
});

// ------------------------------------------------------------------------------------------------------------------
// #10: one wallet, one identity
// ------------------------------------------------------------------------------------------------------------------
test('F10 (audit #10): a wallet is pinned to ONE mobile-money identity; a record without identity leaves the pin alone', async () => {
  const ctx = await setup();
  const idA = crypto.createHash('sha256').update('notch-msisdn|233240000001').digest();
  const idB = crypto.createHash('sha256').update('notch-msisdn|233240000002').digest();
  assert.ok((await postLimit(ctx, record(ctx, { idHash: idA, nonce: 1 }))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).idHash, idA.toString('hex'));
  fails(await postLimit(ctx, record(ctx, { idHash: idB, nonce: 2 })), 'WalletIdentityPinned');
  assert.ok((await postLimit(ctx, record(ctx, { idHash: idA, nonce: 3 }))).ok, 'the same identity may re-post');
  assert.ok((await postLimit(ctx, record(ctx, { nonce: 4 }))).ok, 'a no-identity source (Deel, Earn) leaves the pin as it was');
  assert.equal(readLine(ctx.svm, ctx.line).idHash, idA.toString('hex'));
});

// ------------------------------------------------------------------------------------------------------------------
// #11: first depositor
// ------------------------------------------------------------------------------------------------------------------
test('F11 (audit #11): the first deposit into an empty tranche is at least 1 USDC; a claim cannot leave a dust supply', async () => {
  const ctx = await setup({ seed: 0n });
  fails(await sendL(ctx, ctx.lender, depositIx(ctx, ctx.lender, 1n)), 'DepositTooSmall');
  fails(await sendL(ctx, ctx.lender, depositIx(ctx, ctx.lender, 999_999n)), 'DepositTooSmall');
  assert.ok((await sendL(ctx, ctx.lender, depositIx(ctx, ctx.lender, 100n * USDC))).ok);
  // Leaving 0.5 USDC of shares behind (supply 0 < 0.5 < 1) is refused; taking everything, or leaving >= 1, is fine.
  assert.ok((await sendL(ctx, ctx.lender, await requestWithdrawIx(ctx, ctx.lender, 99_500_000n))).ok);
  advance(ctx, COOLDOWN);
  fails(await sendL(ctx, ctx.lender, await claimWithdrawIx(ctx, ctx.lender)), 'DustSupply');
  assert.ok((await sendL(ctx, ctx.lender, await cancelWithdrawIx(ctx, ctx.lender))).ok);
  assert.ok((await sendL(ctx, ctx.lender, await requestWithdrawIx(ctx, ctx.lender, 99n * USDC))).ok);
  advance(ctx, COOLDOWN);
  assert.ok((await sendL(ctx, ctx.lender, await claimWithdrawIx(ctx, ctx.lender))).ok); // 1 USDC of shares stays
});

// ------------------------------------------------------------------------------------------------------------------
// Line layout: the account the keeper reads, and lines made before the trailing fields existed
// ------------------------------------------------------------------------------------------------------------------
test('layout: a CreditLine built by the current program is 154 bytes (8 discriminator + 90 + 56 trailing)', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.equal(ctx.svm.getAccount(ctx.line).data.length, 154);
});

test('legacy 106-byte line (before the trailing fields): draw and repay still save, the repayment cannot count, post_limit grows it and pays the rent', async () => {
  const ctx = await setup();
  await open(ctx, 50);
  const a = ctx.svm.getAccount(ctx.line);
  const lam = ctx.svm.minimumBalanceForRentExemption(106n);
  ctx.svm.setAccount({ ...a, data: a.data.slice(0, 106), space: 106n, lamports: lam });
  assert.equal(ctx.svm.getAccount(ctx.line).data.length, 106);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 50n * USDC);
  await rich(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  assert.equal(ctx.svm.getAccount(ctx.line).data.length, 106, 'draw saved without growing the account');
  advance(ctx, 120);
  assert.ok((await sendB(ctx, repayIx(ctx, 31n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0, 'no draw clock on a legacy line: not counted');
  // The next post_limit grows the line; after that the full rules apply.
  const grow = await postLimit(ctx, record(ctx, { limitUsdc: 50, nonce: 2, expiry: Number(ctx.now) + 90 * 86400 }));
  assert.ok(grow.ok, grow.logs);
  const grown = ctx.svm.getAccount(ctx.line);
  assert.equal(grown.data.length, 154);
  assert.ok(grown.lamports >= ctx.svm.minimumBalanceForRentExemption(154n));
  assert.equal(readLine(ctx.svm, ctx.line).limit, 50n * USDC);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  advance(ctx, 31);
  assert.ok((await sendB(ctx, repayIx(ctx, 31n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 1);
});

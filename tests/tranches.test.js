// Senior / junior tranches. Every test runs the real program (target/deploy/notch.so) in LiteSVM.
// Numbers: junior 100 USDC, senior 400 USDC, junior floor 20%, a junior dollar counts 2x in the fee split.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, lamports } from '@solana/kit';
import {
  COOLDOWN, U, USDC, advance, cancelWithdrawIx, claimWithdrawIx, depositBorrowerIx, depositIx, drawIx, drawWithTermIx, enc, exists, fails,
  lenderPdas, markDefaultIx, meta, mintSupply, readLine, newLender, open, pda, readPool, readRequest, redeem, repayIx,
  requestWithdrawIx, send, sendB, sendL, setup, tokenBalance, warp, W, R,
} from './lib.js';

const bal = (ctx, acct) => tokenBalance(ctx.svm, acct);
const pool = (ctx) => readPool(ctx.svm, ctx.pool);
// The accounting invariant the program enforces on every pool touch.
const inv = (ctx) => { const p = pool(ctx); assert.equal(p.seniorNav + p.juniorNav, p.idle + p.outstanding, 'NAV invariant'); return p; };

// admin = junior lender (100); `s` = senior lender (400).
async function seeded({ senior = 400n * USDC, ...opts } = {}) {
  const ctx = await setup({ seed: 100n * USDC, borrowerFunds: 200n * USDC, ...opts });
  const s = await newLender(ctx, 1000n * USDC);
  if (senior > 0n) assert.ok((await sendL(ctx, s, depositIx(ctx, s, senior, 'senior'))).ok);
  return { ctx, s };
}
// A second (third, ...) borrower: same helpers, different wallet / line.
async function newBorrower(ctx, funds = 200n * USDC) {
  const borrower = await generateKeyPairSigner();
  ctx.svm.airdrop(borrower.address, lamports(1_000_000_000n));
  const borrowerAcct = await ctx.mkAcct(borrower.address);
  await ctx.mintTo(borrowerAcct, funds);
  const line = await pda(Buffer.from('line'), enc.encode(borrower.address));
  return { ...ctx, borrower, borrowerAcct, line };
}
// Borrower draws `draw` USDC with a deposit of `dep`, then the loan goes 31 days overdue and is marked defaulted.
async function defaultLoan(ctx, draw, dep) {
  await open(ctx, 300);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(dep)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, U(draw)))).ok);
  warp(ctx, 31 * 86400);
  const r = await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)]);
  assert.ok(r.ok, r.logs);
}
// Borrower draws `draw` and repays it (plus the 2% fee) on time.
async function repaid(ctx, draw, dep) {
  await open(ctx, 300);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(dep)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, U(draw)))).ok);
  const r = await sendB(ctx, repayIx(ctx, U(draw * 1.02)));
  assert.ok(r.ok, r.logs);
}


test('deposits choose a tranche: each mint tracks its own NAV and supply, and the invariant holds', async () => {
  const { ctx, s } = await seeded();
  const p = inv(ctx);
  assert.equal(p.juniorNav, 100n * USDC);
  assert.equal(p.seniorNav, 400n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.juniorMint), 100n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.seniorMint), 400n * USDC);
  assert.equal(bal(ctx, ctx.lender.shares), 100n * USDC);
  assert.equal(bal(ctx, s.seniorShares), 400n * USDC);
  assert.equal(bal(ctx, ctx.vault), 500n * USDC);
});

test('pool parameters are validated at init (floor <= 100%, junior weight between 1x and 10x)', async () => {
  fails(await setup({ poolMustFail: true, juniorWeightBps: 9_999 }), 'InvalidTrancheParams');
  fails(await setup({ poolMustFail: true, juniorWeightBps: 100_001 }), 'InvalidTrancheParams');
  fails(await setup({ poolMustFail: true, minJuniorBps: 10_001 }), 'InvalidTrancheParams');
  const ok = await setup({ poolMustFail: true, minJuniorBps: 10_000, juniorWeightBps: 10_000 });
  assert.ok(ok.ok, ok.logs);
});

test('loss smaller than junior: junior NAV falls, senior NAV is untouched', async () => {
  const { ctx, s } = await seeded();
  await defaultLoan(ctx, 40, 8); // 40 lost, 8 seized -> net loss 32
  const p = inv(ctx);
  assert.equal(p.juniorNav, 68n * USDC);
  assert.equal(p.seniorNav, 400n * USDC);
  assert.equal(p.juniorLosses, 32n * USDC);
  assert.equal(p.seniorLosses, 0n);
  // Senior still redeems at exactly 1.0 per share; junior now at 0.68.
  const before = bal(ctx, s.usdc);
  assert.ok((await redeem(ctx, s, 100n * USDC, 'senior')).ok);
  assert.equal(bal(ctx, s.usdc) - before, 100n * USDC);
  // Once the rest of senior has left, junior is free to exit: its 100 shares are worth 68 USDC.
  assert.ok((await redeem(ctx, s, 300n * USDC, 'senior')).ok);
  const jb = bal(ctx, ctx.lender.usdc);
  assert.ok((await redeem(ctx, ctx.lender, 100n * USDC)).ok);
  assert.equal(bal(ctx, ctx.lender.usdc) - jb, 68n * USDC);
  inv(ctx);
});

test('loss larger than junior: junior goes to zero and senior takes only the rest', async () => {
  const { ctx, s } = await seeded();
  await defaultLoan(ctx, 150, 30); // 150 lost, 30 seized -> net loss 120 vs junior 100
  const p = inv(ctx);
  assert.equal(p.juniorNav, 0n);
  assert.equal(p.seniorNav, 380n * USDC);
  assert.equal(p.juniorLosses, 100n * USDC);
  assert.equal(p.seniorLosses, 20n * USDC);
  // Senior shares are now worth 0.95 each.
  const before = bal(ctx, s.usdc);
  assert.ok((await redeem(ctx, s, 100n * USDC, 'senior')).ok);
  assert.equal(bal(ctx, s.usdc) - before, U(95));
  // Junior shares are worth nothing: a claim pays 0 and is refused (redeem() cancels the request again).
  fails(await redeem(ctx, ctx.lender, 100n * USDC), 'InvalidAmount');
  assert.equal(bal(ctx, ctx.lender.shares), 100n * USDC);
  // A wiped tranche is dead: nobody can buy into the hole, and senior needs a junior cushion first.
  const c = await newLender(ctx, 50n * USDC);
  fails(await sendL(ctx, c, depositIx(ctx, c, 10n * USDC)), 'InvalidPoolState');
  fails(await sendL(ctx, c, depositIx(ctx, c, 10n * USDC, 'senior')), 'SubordinationBreached');
});

test('a loss equal to junior leaves senior whole; a bigger one reaches senior by exactly the excess', async () => {
  let { ctx } = await seeded();
  await defaultLoan(ctx, 125, 25); // net loss 100 == junior
  let p = inv(ctx);
  assert.equal(p.juniorNav, 0n);
  assert.equal(p.seniorNav, 400n * USDC);
  assert.equal(p.seniorLosses, 0n);
  ({ ctx } = await seeded());
  await defaultLoan(ctx, 126, 25.2); // net loss 100.8
  p = inv(ctx);
  assert.equal(p.juniorNav, 0n);
  assert.equal(p.seniorNav, 400n * USDC - 800_000n);
  assert.equal(p.seniorLosses, 800_000n);
});

test('fee waterfall: weighted pro-rata, junior dollar counts 2x (80/20 pool -> senior 2/3, junior 1/3 of fees)', async () => {
  const { ctx } = await seeded();
  await repaid(ctx, 100, 20); // fee = 2 USDC = 2_000_000
  const p = inv(ctx);
  // senior = floor(2_000_000 * 400e6*10_000 / (400e6*10_000 + 100e6*20_000)) = 1_333_333 ; junior gets the remainder
  assert.equal(p.seniorFees, 1_333_333n);
  assert.equal(p.juniorFees, 666_667n);
  assert.equal(p.seniorNav, 400n * USDC + 1_333_333n);
  assert.equal(p.juniorNav, 100n * USDC + 666_667n);
  assert.equal(p.feesEarned, 2n * USDC);
  // Per dollar of capital junior earns about 2x senior (0.67% vs 0.33% on this loan).
  const jy = (p.juniorFees * 10_000n) / (100n * USDC), sy = (p.seniorFees * 10_000n) / (400n * USDC);
  assert.equal(jy, 66n); assert.equal(sy, 33n);
});

test('fee waterfall: weight 1.0x is plain pro-rata; junior-only and senior-only (floor 0) pools take it all', async () => {
  let { ctx } = await seeded({ juniorWeightBps: 10_000 });
  await repaid(ctx, 100, 20);
  let p = inv(ctx);
  assert.equal(p.seniorFees, 1_600_000n); // 400/500 of 2 USDC
  assert.equal(p.juniorFees, 400_000n);

  ctx = (await seeded({ senior: 0n })).ctx; // junior only
  await repaid(ctx, 50, 10);
  p = inv(ctx);
  assert.equal(p.juniorFees, 1_000_000n);
  assert.equal(p.seniorFees, 0n);

  // A senior-only pool is possible only when the floor is 0; then senior takes every fee.
  ctx = await setup({ seed: 0n, borrowerFunds: 200n * USDC, minJuniorBps: 0 });
  const s = await newLender(ctx, 500n * USDC);
  assert.ok((await sendL(ctx, s, depositIx(ctx, s, 200n * USDC, 'senior'))).ok);
  await repaid(ctx, 50, 10);
  p = inv(ctx);
  assert.equal(p.seniorFees, 1_000_000n);
  assert.equal(p.juniorFees, 0n);
});

test('fees after a loss use the NEW navs (no make-whole): a hurt junior earns a smaller cut', async () => {
  const { ctx } = await seeded();
  await defaultLoan(ctx, 40, 8); // junior 100 -> 68, senior 400
  const b2 = await newBorrower(ctx);
  await repaid(b2, 100, 20); // fee 2_000_000
  const p = inv(ctx);
  // senior = floor(2_000_000 * 400e6*10_000 / (400e6*10_000 + 68e6*20_000)) = 1_492_537
  assert.equal(p.seniorFees, 1_492_537n);
  assert.equal(p.juniorFees, 507_463n);
  assert.equal(p.juniorNav, 68n * USDC + 507_463n); // the earlier 32 USDC hole is not refilled first
});

test('subordination guard: senior deposits need junior first, and stop exactly at the floor', async () => {
  const ctx = await setup({ seed: 0n });
  const s = await newLender(ctx, 1000n * USDC);
  fails(await sendL(ctx, s, depositIx(ctx, s, 1n * USDC, 'senior')), 'SubordinationBreached'); // no junior at all
  const j = await newLender(ctx, 1000n * USDC);
  assert.ok((await sendL(ctx, j, depositIx(ctx, j, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, s, depositIx(ctx, s, 400n * USDC, 'senior'))).ok); // 100/500 = exactly 20%
  fails(await sendL(ctx, s, depositIx(ctx, s, 1n, 'senior')), 'SubordinationBreached'); // one unit over
  assert.ok((await sendL(ctx, j, depositIx(ctx, j, 25n * USDC))).ok); // junior 125
  assert.ok((await sendL(ctx, s, depositIx(ctx, s, 100n * USDC, 'senior'))).ok); // 125/625 = 20%
  fails(await sendL(ctx, s, depositIx(ctx, s, 1n, 'senior')), 'SubordinationBreached');
  inv(ctx);
});

test('subordination guard: junior exits that break the floor are refused; senior leaving frees junior', async () => {
  const { ctx, s } = await seeded();
  // Pool is exactly at 20%: junior cannot take out even one unit.
  fails(await redeem(ctx, ctx.lender, 1n), 'SubordinationBreached');
  assert.equal(bal(ctx, ctx.lender.shares), 100n * USDC); // the request was cancelled again
  // Senior is never blocked by the guard: 100 senior leaves -> junior is 100/400 = 25%.
  assert.ok((await redeem(ctx, s, 100n * USDC, 'senior')).ok);
  // Largest junior exit x: (100-x)/(400-x) >= 0.2  ->  x <= 25
  fails(await redeem(ctx, ctx.lender, 25n * USDC + 1n), 'SubordinationBreached');
  assert.ok((await redeem(ctx, ctx.lender, 25n * USDC)).ok); // lands exactly on 75/375 = 20%
  fails(await redeem(ctx, ctx.lender, 1n), 'SubordinationBreached');
  // Last senior leaves -> junior is unconstrained and can exit completely.
  assert.ok((await redeem(ctx, s, 300n * USDC, 'senior')).ok);
  assert.ok((await redeem(ctx, ctx.lender, 75n * USDC)).ok);
  assert.equal(mintSupply(ctx.svm, ctx.juniorMint), 0n);
  assert.equal(pool(ctx).juniorNav, 0n);
});

test('a loss that pushes junior under the floor blocks senior deposits and junior exits until topped up', async () => {
  const { ctx, s } = await seeded();
  await defaultLoan(ctx, 40, 8); // junior 68 / total 468 = 14.5%
  fails(await sendL(ctx, s, depositIx(ctx, s, 1n, 'senior')), 'SubordinationBreached');
  fails(await redeem(ctx, ctx.lender, 10n * USDC), 'SubordinationBreached');
  // Topping up junior by 40 -> junior 108 of 508; senior may then add x with 108*5 >= 508 + x -> x <= 32.
  const j = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, j, depositIx(ctx, j, 40n * USDC))).ok);
  fails(await sendL(ctx, s, depositIx(ctx, s, 33n * USDC, 'senior')), 'SubordinationBreached');
  assert.ok((await sendL(ctx, s, depositIx(ctx, s, 32n * USDC, 'senior'))).ok);
  inv(ctx);
});

test('timed withdraw per tranche: senior waits out the cooldown and is paid at claim-time NAV (a default in between is priced in)', async () => {
  const { ctx, s } = await seeded();
  await open(ctx, 300);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(30)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, U(150)))).ok); // due at day 30
  warp(ctx, 30 * 86400 + 3600); // overdue, but nobody has marked it yet: senior NAV still 400
  assert.equal(pool(ctx).seniorNav, 400n * USDC);
  assert.ok((await sendL(ctx, s, await requestWithdrawIx(ctx, s, 100n * USDC, 'senior'))).ok);
  assert.equal(bal(ctx, s.seniorShares), 300n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.seniorMint), 400n * USDC); // escrowed shares stay in the supply
  const { unlockTs } = await readRequest(ctx, s, 'senior');
  fails(await sendL(ctx, s, await claimWithdrawIx(ctx, s, 'senior')), 'CooldownActive');
  // The keeper marks the default during the cooldown: junior 100 -> 0, senior 400 -> 380.
  warp(ctx, 31 * 86400);
  assert.ok((await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)])).ok);
  assert.equal(pool(ctx).seniorNav, 380n * USDC);
  fails(await sendL(ctx, s, await claimWithdrawIx(ctx, s, 'senior')), 'CooldownActive'); // still locked
  ctx.svm.setClock((() => { const c = ctx.svm.getClock(); c.unixTimestamp = unlockTs; return c; })());
  const before = bal(ctx, s.usdc);
  assert.ok((await sendL(ctx, s, await claimWithdrawIx(ctx, s, 'senior'))).ok);
  assert.equal(bal(ctx, s.usdc) - before, U(95)); // 100 shares x 0.95, NOT 100 USDC
  assert.equal(await exists(ctx, (await lenderPdas(s, 'senior')).request), false);
  assert.equal(mintSupply(ctx.svm, ctx.seniorMint), 300n * USDC);
  assert.equal(pool(ctx).seniorNav, 285n * USDC);
  inv(ctx);
});

test('timed withdraw per tranche: both tranches can be pending at once, and cancel returns the right shares', async () => {
  const { ctx, s } = await seeded();
  assert.ok((await sendL(ctx, s, depositIx(ctx, s, 50n * USDC))).ok); // s also holds 50 junior
  assert.ok((await sendL(ctx, s, await requestWithdrawIx(ctx, s, 10n * USDC, 'senior'))).ok);
  assert.ok((await sendL(ctx, s, await requestWithdrawIx(ctx, s, 20n * USDC, 'junior'))).ok);
  assert.equal((await readRequest(ctx, s, 'senior')).shares, 10n * USDC);
  assert.equal((await readRequest(ctx, s, 'junior')).shares, 20n * USDC);
  assert.equal(bal(ctx, s.seniorShares), 390n * USDC);
  assert.equal(bal(ctx, s.shares), 30n * USDC);
  // One pending request per tranche: a second senior request is refused, a junior one too.
  assert.equal((await sendL(ctx, s, await requestWithdrawIx(ctx, s, 1n, 'senior'))).ok, false);
  assert.ok((await sendL(ctx, s, await cancelWithdrawIx(ctx, s, 'senior'))).ok);
  assert.equal(bal(ctx, s.seniorShares), 400n * USDC);
  assert.equal(bal(ctx, s.shares), 30n * USDC); // junior request untouched
  assert.equal((await readRequest(ctx, s, 'junior')).shares, 20n * USDC);
  assert.equal(await readRequest(ctx, s, 'senior'), null);
  // Cooldown applies to the tranche's own request; junior claim: 150 total, 20 out -> 130/530 >= 20%? 130*5=650 >= 530.
  advance(ctx, COOLDOWN);
  assert.ok((await sendL(ctx, s, await claimWithdrawIx(ctx, s, 'junior'))).ok);
  assert.equal(pool(ctx).juniorNav, 130n * USDC);
  inv(ctx);
});

test('timed withdraw per tranche: claim cannot exceed idle cash, and a request in one tranche cannot be claimed through the other', async () => {
  const { ctx, s } = await seeded();
  await open(ctx, 300);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(30)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, U(150)))).ok); // idle 350, out 150
  // Asking for 400 with 350 idle pays 350 now (partial claim) and keeps 50 senior shares queued at the locked price.
  const usdcBefore = bal(ctx, s.usdc);
  assert.ok((await redeem(ctx, s, 400n * USDC, 'senior')).ok);
  assert.equal(bal(ctx, s.usdc) - usdcBefore, 350n * USDC);
  assert.equal((await readRequest(ctx, s, 'senior')).shares, 50n * USDC);
  assert.equal(pool(ctx).idle, 0n);
  fails(await sendL(ctx, s, await claimWithdrawIx(ctx, s, 'senior')), 'InsufficientLiquidity');
  assert.ok((await sendL(ctx, s, await cancelWithdrawIx(ctx, s, 'senior'))).ok); // nothing gained in escrow, all 50 shares come back
  assert.equal(bal(ctx, s.seniorShares), 50n * USDC);
  // Cross-tranche: request junior shares, then try to claim passing the SENIOR mint/escrow -> no such request.
  assert.ok((await sendL(ctx, ctx.lender, await requestWithdrawIx(ctx, ctx.lender, 10n * USDC, 'junior'))).ok);
  advance(ctx, COOLDOWN);
  const wrong = await claimWithdrawIx(ctx, ctx.lender, 'senior');
  assert.equal((await sendL(ctx, ctx.lender, wrong)).ok, false);
});

test('wrong mints are refused: a non-tranche mint, or share tokens of the other tranche', async () => {
  const { ctx, s } = await seeded();
  const ix = depositIx(ctx, s, 1n * USDC, 'senior');
  // share_mint (index 6) / share_account (index 7) swapped for the USDC mint and the lender's USDC account
  const spare = await ctx.mkAcct(s.signer.address); // a second USDC account of the lender
  const bad = { ...ix, accounts: ix.accounts.map((m, i) => (i === 6 ? meta(ctx.mint.address, W) : i === 7 ? meta(spare, W) : m)) };
  fails(await sendL(ctx, s, bad), 'BadTrancheMint');
  // senior mint with a JUNIOR share account
  const mixed = { ...ix, accounts: ix.accounts.map((m, i) => (i === 7 ? meta(s.shares, W) : m)) };
  assert.equal((await sendL(ctx, s, mixed)).ok, false);
  // request_withdraw with the USDC mint as "share mint"
  const rq = await requestWithdrawIx(ctx, s, 1n, 'senior');
  const badRq = { ...rq, accounts: rq.accounts.map((m, i) => (i === 2 ? meta(ctx.mint.address, R) : i === 3 ? meta(spare, W) : m)) };
  assert.equal((await sendL(ctx, s, badRq)).ok, false);
});

test('attack (senior tranche): first depositor + direct token donation cannot steal from the next senior depositor', async () => {
  const ctx = await setup({ seed: 0n });
  const j = await newLender(ctx, 500n * USDC);
  assert.ok((await sendL(ctx, j, depositIx(ctx, j, 100n * USDC))).ok); // junior cushion so senior may deposit
  const attacker = await newLender(ctx, 10n * USDC);
  const victim = await newLender(ctx, 200n * USDC);
  assert.ok((await sendL(ctx, attacker, depositIx(ctx, attacker, 1n * USDC, 'senior'))).ok); // 1 USDC (the minimum first deposit) -> 1 senior share unit each
  assert.equal(bal(ctx, attacker.seniorShares), 1n * USDC);
  await ctx.mintTo(ctx.vault, 100n * USDC); // donate straight into the vault
  const p = inv(ctx);
  assert.equal(p.seniorNav, 1n * USDC); // senior price untouched by the donation
  assert.equal(p.juniorNav, 100n * USDC);
  assert.ok((await sendL(ctx, victim, depositIx(ctx, victim, 100n * USDC, 'senior'))).ok);
  assert.equal(bal(ctx, victim.seniorShares), 100n * USDC); // full 1:1 shares, not rounded to ~0
  assert.ok((await redeem(ctx, victim, 100n * USDC, 'senior')).ok);
  assert.equal(bal(ctx, victim.usdc), 200n * USDC);
  const before = bal(ctx, attacker.usdc);
  assert.ok((await redeem(ctx, attacker, 1n * USDC, 'senior')).ok);
  assert.equal(bal(ctx, attacker.usdc) - before, 1n * USDC); // only their own stake; the donation is stranded
  assert.equal(bal(ctx, ctx.vault), 200n * USDC); // 100 junior + 100 stranded donation
  assert.equal(pool(ctx).juniorNav, 100n * USDC);
});

test('attack (junior tranche): donation cannot move the junior price or the senior price', async () => {
  const ctx = await setup({ seed: 0n });
  const attacker = await newLender(ctx, 10n * USDC);
  const victim = await newLender(ctx, 200n * USDC);
  assert.ok((await sendL(ctx, attacker, depositIx(ctx, attacker, 1n * USDC))).ok);
  await ctx.mintTo(ctx.vault, 100n * USDC);
  assert.equal(pool(ctx).juniorNav, 1n * USDC);
  assert.ok((await sendL(ctx, victim, depositIx(ctx, victim, 100n * USDC))).ok);
  assert.equal(bal(ctx, victim.shares), 100n * USDC);
  assert.ok((await redeem(ctx, victim, 100n * USDC)).ok);
  assert.equal(bal(ctx, victim.usdc), 200n * USDC);
  const before = bal(ctx, attacker.usdc);
  assert.ok((await redeem(ctx, attacker, 1n * USDC)).ok);
  assert.equal(bal(ctx, attacker.usdc) - before, 1n * USDC);
  assert.equal(bal(ctx, ctx.vault), 100n * USDC); // the donation, stranded
  inv(ctx);
});

test('borrower first-loss deposits and draws are untouched by tranching (not lender assets; liquidity cap is shared idle cash)', async () => {
  const { ctx } = await seeded();
  await open(ctx, 300);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  const p = inv(ctx);
  assert.equal(p.borrowerDeposits, 20n * USDC);
  assert.equal(p.seniorNav + p.juniorNav, 500n * USDC);
  fails(await sendB(ctx, drawIx(ctx, 501n * USDC)), 'OverLimit|InsufficientDeposit|InsufficientLiquidity');
});

test('draw_with_term: due period is bounded (10 s ..= 30 d), only the first draw sets it, and a short loan can default in seconds', async () => {
  const { ctx } = await seeded();
  await open(ctx, 300);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  fails(await sendB(ctx, drawWithTermIx(ctx, U(10), 9)), 'InvalidTerm');
  fails(await sendB(ctx, drawWithTermIx(ctx, U(10), 30 * 86400 + 1)), 'InvalidTerm');
  fails(await sendB(ctx, drawWithTermIx(ctx, U(10), 0)), 'InvalidTerm');
  fails(await sendB(ctx, drawWithTermIx(ctx, U(10), -5)), 'InvalidTerm');
  const t0 = ctx.svm.getClock().unixTimestamp;
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, U(10), 10))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).due, t0 + 10n);
  // A second draw (plain or short) does not move the due date.
  advance(ctx, 3);
  assert.ok((await sendB(ctx, drawIx(ctx, U(5)))).ok);
  assert.ok((await sendB(ctx, drawWithTermIx(ctx, U(5), 600))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).due, t0 + 10n);
  // Not overdue at exactly due; overdue one second later.
  warp(ctx, Number(t0 - ctx.now) + 10);
  fails(await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)]), 'NotPastDue');
  advance(ctx, 1);
  assert.ok((await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)])).ok);
  // 20 drawn, deposit 20 seized in full -> no net loss; plain draw() is still 30 days.
  const p = inv(ctx);
  assert.equal(p.juniorNav, 100n * USDC);
  const b2 = await newBorrower(ctx);
  await open(b2, 300);
  assert.ok((await sendB(b2, depositBorrowerIx(b2, U(5)))).ok);
  const t1 = ctx.svm.getClock().unixTimestamp;
  assert.ok((await sendB(b2, drawIx(b2, U(10)))).ok);
  assert.equal(readLine(ctx.svm, b2.line).due, t1 + BigInt(30 * 86400));
});

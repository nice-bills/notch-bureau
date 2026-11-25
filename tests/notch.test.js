import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenSize,
  getTransferInstruction,
} from '@solana-program/token';
import { encodeRecord } from '../enclave/src/record.js';
import { COOLDOWN, ED25519, IX_SYSVAR, PROGRAM, R, RS, SO, SYSTEM, U, USDC, W, WS, advance, cancelWithdrawIx, claimWithdrawIx, depositBorrowerIx, depositIx, disc, drawIx, ed25519Ix, enc, exists, fails, i64, lenderPdas, markDefaultIx, meta, mintSupply, newLender, open, pda, postLimit, readLine, readPool, readRequest, record, redeem, repayIx, requestWithdrawIx, send, sendB, sendL, setup, tokenBalance, u64, vecU8, warp, withdrawBorrowerIx } from './lib.js';

test('underwriter-signed limit opens a line; borrower deposits, draws, repays principal + 2% fee on time', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 50n * USDC);

  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct), U(10 - 6 + 30));
  fails(await sendB(ctx, drawIx(ctx, 21n * USDC)), 'OverLimit');

  advance(ctx, 8 * 86400); // a repayment only counts once the loan was held 7 days (MIN_COUNTED_HOLD_S)
  assert.ok((await sendB(ctx, repayIx(ctx, U(30.6)))).ok);
  const l = readLine(ctx.svm, ctx.line);
  assert.equal(l.drawn, 0n);
  assert.equal(l.repaidOnTime, 1);
  assert.equal(l.deposit, 0n);
  // Borrower is out exactly the 2% fee; the deposit came back.
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct), U(10 - 0.6));
  const p = readPool(ctx.svm, ctx.pool);
  assert.deepEqual([p.outstanding, p.feesEarned, p.borrowerDeposits, p.idle, p.totalLent], [0n, U(0.6), 0n, U(500.6), 30n * USDC]);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), U(500.6));
});

test('zero-value draw and repayment cannot create repayment history', async () => {
  const ctx = await setup();
  await open(ctx);
  fails(await sendB(ctx, drawIx(ctx, 0n)), 'InvalidAmount');
  fails(await sendB(ctx, repayIx(ctx, 0n)), 'InvalidAmount');
  fails(await sendB(ctx, repayIx(ctx, 1n)), 'NothingToRepay');
  assert.equal(readLine(ctx.svm, ctx.line).repaidOnTime, 0);
});

test('attack: limit signed by our own (non-underwriter) key is rejected', async () => {
  const ctx = await setup();
  const r = await postLimit(ctx, record(ctx, { limitUsdc: 2000 }), { signKey: nacl.sign.keyPair().secretKey });
  fails(r, 'WrongUnderwriter');
});

test('attack: signature over one record, different record submitted', async () => {
  const ctx = await setup();
  const signed = record(ctx, { limitUsdc: 10 });
  const sent = Buffer.from(signed);
  sent.writeBigUInt64LE(2000n * USDC, 40);
  fails(await postLimit(ctx, sent, { signedMsg: signed }), 'RecordMismatch');
});

test('attack: same email (dedupe hash) used twice', async () => {
  const ctx = await setup();
  const dedupe = crypto.randomBytes(32);
  assert.ok((await postLimit(ctx, record(ctx, { dedupe, nonce: 1 }))).ok);
  const r = await postLimit(ctx, record(ctx, { dedupe, nonce: 2 }));
  assert.equal(r.ok, false);
});

test('attack: replaying an older record cannot overwrite a newer limit', async () => {
  const ctx = await setup();
  const old = record(ctx, { limitUsdc: 200, nonce: 5 });
  assert.ok((await postLimit(ctx, record(ctx, { limitUsdc: 20, nonce: 9 }))).ok);
  fails(await postLimit(ctx, old), 'StaleRecord');
  assert.equal(readLine(ctx.svm, ctx.line).limit, 20n * USDC);
});

test('attack: record for another wallet cannot open my line', async () => {
  const ctx = await setup();
  const other = await generateKeyPairSigner();
  fails(await postLimit(ctx, record(ctx, { wallet: other.address })), 'WrongWallet');
});

test('identity: one mobile-money account backs one wallet; a second wallet is refused, the first can re-post', async () => {
  const ctx = await setup();
  const idHash = crypto.createHash('sha256').update('notch-msisdn|233241234567').digest();
  assert.ok((await postLimit(ctx, record(ctx, { idHash, nonce: 1 }))).ok);
  const link = ctx.svm.getAccount(await pda(Buffer.from('identity'), idHash));
  assert.ok(link.exists);
  assert.equal(bs58.encode(Buffer.from(link.data).subarray(8, 40)), ctx.borrower.address);
  // same wallet, new statement (new dedupe, newer nonce): fine
  assert.ok((await postLimit(ctx, record(ctx, { idHash, nonce: 2, limitUsdc: 40 }))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 40n * USDC);
  // a different wallet presenting the same identity: refused with the new error
  const thief = await generateKeyPairSigner();
  const r = await postLimit(ctx, record(ctx, { idHash, wallet: thief.address, nonce: 1 }), { borrower: thief.address });
  fails(r, 'IdentityBound');
  assert.equal(readLine(ctx.svm, await pda(Buffer.from('line'), enc.encode(thief.address))), null, 'refused post leaves no line');
});

test('identity: a record with an id_hash needs the identity account; the wrong account is refused; zero id_hash needs none', async () => {
  const ctx = await setup();
  const idHash = crypto.randomBytes(32);
  fails(await postLimit(ctx, record(ctx, { idHash }), { identity: false }), 'IdentityRequired');
  const wrong = await pda(Buffer.from('identity'), crypto.randomBytes(32));
  fails(await postLimit(ctx, record(ctx, { idHash }), { identity: wrong }), 'ConstraintSeeds');
  assert.equal(readLine(ctx.svm, ctx.line), null);
  // no identity (e.g. a Deel email): no account, no link
  assert.ok((await postLimit(ctx, record(ctx, { nonce: 3 }))).ok);
  assert.equal(await exists(ctx, await pda(Buffer.from('identity'), Buffer.alloc(32))), false);
});

test('identity: the id_hash is covered by the signature (swapping it after signing is refused)', async () => {
  const ctx = await setup();
  const signed = record(ctx, { idHash: crypto.randomBytes(32) });
  const sent = Buffer.from(signed);
  crypto.randomBytes(32).copy(sent, 96);
  fails(await postLimit(ctx, sent, { signedMsg: signed }), 'RecordMismatch');
});

test('past-due balance can be marked defaulted and the line is closed for good', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(2)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 10n * USDC))).ok);
  fails(await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)]), 'NotPastDue');
  warp(ctx, 31 * 86400);
  const r = await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)]);
  assert.ok(r.ok, r.logs);
  assert.equal(readLine(ctx.svm, ctx.line).defaulted, true);
  const again = await postLimit(ctx, record(ctx, { nonce: 99, expiry: Number(ctx.now) + 90 * 86400 }));
  fails(again, 'Defaulted');
  fails(await sendB(ctx, drawIx(ctx, 1n * USDC)), 'Defaulted');
  fails(await sendB(ctx, depositBorrowerIx(ctx, U(1))), 'Defaulted');
});

test('deposit requirement: draws need a first-loss deposit of at least 20% of the TOTAL balance', async () => {
  const ctx = await setup();
  await open(ctx);
  fails(await sendB(ctx, drawIx(ctx, 30n * USDC)), 'InsufficientDeposit');
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(5.99)))).ok);
  fails(await sendB(ctx, drawIx(ctx, 30n * USDC)), 'InsufficientDeposit');
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(0.01)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  // A second draw is checked against the new total (31 needs 6.2), not just the new amount.
  fails(await sendB(ctx, drawIx(ctx, 1n * USDC)), 'InsufficientDeposit');
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(0.2)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 1n * USDC))).ok);
  assert.equal(readLine(ctx.svm, ctx.line).drawn, 31n * USDC);
});

test('borrower deposits are not lender assets: share price ignores them and draws cannot spend them', async () => {
  const ctx = await setup({ seed: 10n * USDC });
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.borrowerDeposits, 10n * USDC);
  assert.equal(p.idle + p.outstanding, 10n * USDC);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 20n * USDC);
  // Vault holds 20 USDC but only 10 is lendable: a 20 USDC draw (deposit is 10, 20% needs 4) must fail.
  fails(await sendB(ctx, drawIx(ctx, 20n * USDC)), 'InsufficientLiquidity');
  // The lender can only ever pull their own 10 out.
  assert.ok((await redeem(ctx, ctx.lender, 10n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 10n * USDC);
  assert.equal(tokenBalance(ctx.svm, ctx.lender.usdc), 1000n * USDC);
});

test('fee required: the line only clears when principal + 2% is paid', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  fails(await sendB(ctx, repayIx(ctx, 30n * USDC)), 'FeeRequired');
  fails(await sendB(ctx, repayIx(ctx, U(30.599999))), 'FeeRequired');
  let l = readLine(ctx.svm, ctx.line);
  assert.equal(l.drawn, 30n * USDC);
  assert.equal(l.repaidOnTime, 0);
  assert.equal(l.deposit, 6n * USDC);
  advance(ctx, 8 * 86400); // held long enough to count (7 days)
  // Overpaying only charges the exact payoff.
  const before = tokenBalance(ctx.svm, ctx.borrowerAcct);
  assert.ok((await sendB(ctx, repayIx(ctx, 40n * USDC))).ok);
  assert.equal(before - tokenBalance(ctx.svm, ctx.borrowerAcct), U(30.6) - 6n * USDC);
  l = readLine(ctx.svm, ctx.line);
  assert.equal(l.drawn, 0n);
  assert.equal(l.repaidOnTime, 1);
});

test('deposit is returned after on-time repayment; a late full repayment is counted late', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(8)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 40n * USDC))).ok);
  const mid = tokenBalance(ctx.svm, ctx.borrowerAcct);
  advance(ctx, 8 * 86400); // held long enough to count (7 days)
  assert.ok((await sendB(ctx, repayIx(ctx, U(40.8)))).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct), mid - U(40.8) + 8n * USDC);
  assert.equal(readLine(ctx.svm, ctx.line).deposit, 0n);
  assert.equal(readPool(ctx.svm, ctx.pool).borrowerDeposits, 0n);

  // Second cycle, repaid after the due date but before anyone marks it defaulted.
  await ctx.mintTo(ctx.borrowerAcct, 10n * USDC);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(2)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 10n * USDC))).ok);
  warp(ctx, 40 * 86400);
  assert.ok((await sendB(ctx, repayIx(ctx, U(10.2)))).ok);
  const l = readLine(ctx.svm, ctx.line);
  assert.deepEqual([l.repaidOnTime, l.repaidLate, l.deposit, l.drawn], [1, 1, 0n, 0n]);
});

test('deposit is seized on default (up to the loss) and cannot be withdrawn while a balance is outstanding', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(2)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 10n * USDC))).ok);
  fails(await sendB(ctx, withdrawBorrowerIx(ctx)), 'BalanceOutstanding');
  assert.equal(readLine(ctx.svm, ctx.line).deposit, 2n * USDC);

  warp(ctx, 31 * 86400);
  assert.ok((await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)])).ok);
  const l = readLine(ctx.svm, ctx.line);
  assert.deepEqual([l.deposit, l.drawn, l.defaulted], [0n, 0n, true]);
  const p = readPool(ctx.svm, ctx.pool);
  assert.deepEqual([p.outstanding, p.borrowerDeposits, p.defaults, p.defaultAmount], [0n, 0n, 1n, 10n * USDC]);
  // Lenders absorbed 10 lost - 2 seized = 8.
  assert.equal(p.idle + p.outstanding, 492n * USDC);
  fails(await sendB(ctx, withdrawBorrowerIx(ctx)), 'InvalidAmount'); // nothing left to take back
});

test('a deposit larger than the loss: only the loss is seized, the excess stays the borrower\'s', async () => {
  const ctx = await setup({ borrowerFunds: 20n * USDC });
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(15)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 10n * USDC))).ok);
  warp(ctx, 31 * 86400);
  assert.ok((await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)])).ok);
  assert.equal(readLine(ctx.svm, ctx.line).deposit, 5n * USDC);
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 500n * USDC); // lenders made whole, never over-compensated
  const before = tokenBalance(ctx.svm, ctx.borrowerAcct);
  assert.ok((await sendB(ctx, withdrawBorrowerIx(ctx))).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct) - before, 5n * USDC);
  assert.equal(readPool(ctx.svm, ctx.pool).borrowerDeposits, 0n);
  assert.equal(readLine(ctx.svm, ctx.line).deposit, 0n);
});

test('a deposit made before any draw can be taken back (no stuck funds)', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(4)))).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct), U(6));
  assert.ok((await sendB(ctx, withdrawBorrowerIx(ctx))).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct), U(10));
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 500n * USDC);
});

test('shares: first deposit mints 1:1, later deposits mint at NAV, withdraw burns at NAV', async () => {
  const ctx = await setup({ seed: 0n });
  const a = ctx.lender;
  const b = await newLender(ctx, 500n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok);
  assert.equal(tokenBalance(ctx.svm, a.shares), 100n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 100n * USDC);

  // A borrower pays a 0.4 USDC fee on a 20 USDC loan: assets 100.4 over 100 shares.
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(4)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 20n * USDC))).ok);
  assert.ok((await sendB(ctx, repayIx(ctx, U(20.4)))).ok);
  let p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, U(100.4));

  // B deposits 100.4 USDC at NAV -> exactly 100 shares; the price per share is 1.004.
  assert.ok((await sendL(ctx, b, depositIx(ctx, b, U(100.4)))).ok);
  assert.equal(tokenBalance(ctx.svm, b.shares), 100n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 200n * USDC);
  // Rounding favours the pool: 1 unit buys 0 shares and is rejected.
  fails(await sendL(ctx, b, depositIx(ctx, b, 0n)), 'InvalidAmount');

  // A burns 50 shares -> 50.2 USDC.
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await redeem(ctx, a, 50n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, U(50.2));
  assert.equal(tokenBalance(ctx.svm, a.shares), 50n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 150n * USDC);
  // Cannot burn more shares than owned, nor zero.
  fails(await redeem(ctx, a, 51n * USDC), 'InvalidAmount');
  fails(await redeem(ctx, a, 0n), 'InvalidAmount');
  p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, U(200.8 - 50.2));
});

test('a default lowers the share price', async () => {
  const ctx = await setup();
  await open(ctx);
  const supply = mintSupply(ctx.svm, ctx.shareMint);
  assert.equal(supply, 500n * USDC);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(2)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 10n * USDC))).ok);
  // Loan out and not yet defaulted: assets still count it at face value.
  let p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 500n * USDC);
  warp(ctx, 31 * 86400);
  assert.ok((await send(ctx.svm, ctx.admin, [markDefaultIx(ctx)])).ok);
  p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 492n * USDC); // 10 lost, 2 of it covered by the seized deposit
  // 100 shares were worth 100 USDC; now they pay 98.4.
  const before = tokenBalance(ctx.svm, ctx.lender.usdc);
  assert.ok((await redeem(ctx, ctx.lender, 100n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.lender.usdc) - before, U(98.4));
  // A new depositor now gets MORE shares per USDC than before (price fell).
  const c = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, c, depositIx(ctx, c, 98_400_000n))).ok);
  assert.equal(tokenBalance(ctx.svm, c.shares), 100n * USDC);
});

test('withdraw is limited by idle liquidity, not by share value: a short pool pays what idle allows (partial claim), the rest stays queued', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 50n * USDC))).ok);
  const a = ctx.lender;
  // 500 shares exist, 450 USDC is idle. Asking for all 500 pays 450 now (final gate #4: no all-or-nothing claim).
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await redeem(ctx, a, 500n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 450n * USDC);
  assert.equal(readPool(ctx.svm, ctx.pool).idle, 0n);
  assert.equal((await readRequest(ctx, a)).shares, 50n * USDC); // the rest is still queued, same locked price
  // The 10 USDC borrower deposit still sits in the vault but is not lendable or withdrawable.
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 10n * USDC);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'InsufficientLiquidity'); // nothing idle: nothing to pay
  // Repayment brings cash back; the remaining 50 shares are paid at the locked request-time price (the 1 USDC fee earned in escrow stays with the pool).
  await ctx.mintTo(ctx.borrowerAcct, 5n * USDC); // covers the 1 USDC fee
  assert.ok((await sendB(ctx, repayIx(ctx, U(51)))).ok);
  const mid = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - mid, 50n * USDC);
  assert.equal(await readRequest(ctx, a), null);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 0n);
});

test('attack: first depositor + direct token donation to the vault cannot steal from the next depositor', async () => {
  const ctx = await setup({ seed: 0n });
  const attacker = ctx.lender;
  const victim = await newLender(ctx, 200n * USDC);
  assert.ok((await sendL(ctx, attacker, depositIx(ctx, attacker, 1n))).ok === false); // below the 1 USDC first-deposit minimum
  assert.ok((await sendL(ctx, attacker, depositIx(ctx, attacker, 1n * USDC))).ok); // smallest allowed first deposit -> 1:1 shares
  assert.equal(tokenBalance(ctx.svm, attacker.shares), 1n * USDC);
  // Donate 100 USDC straight into the vault token account (inflates a balance-based share price).
  await ctx.mintTo(ctx.vault, 100n * USDC);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 101n * USDC);
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 1n * USDC); // share price is untouched by the donation

  // The victim still gets full 1:1 shares (not rounded to ~0), and gets all of it back.
  assert.ok((await sendL(ctx, victim, depositIx(ctx, victim, 100n * USDC))).ok);
  assert.equal(tokenBalance(ctx.svm, victim.shares), 100n * USDC);
  assert.ok((await redeem(ctx, victim, 100n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, victim.usdc), 200n * USDC);
  // The attacker gets back only their own 1 USDC; the donation is simply stranded.
  const before = tokenBalance(ctx.svm, attacker.usdc);
  assert.ok((await redeem(ctx, attacker, 1n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, attacker.usdc) - before, 1n * USDC);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 100n * USDC);
});

test('two-step withdraw: a default marked during the cooldown is priced in at claim (no front-running the loss)', async () => {
  const ctx = await setup(); // lender A holds 500 shares
  const a = ctx.lender;
  const b = await newLender(ctx, 500n * USDC);
  assert.ok((await sendL(ctx, b, depositIx(ctx, b, 500n * USDC))).ok);
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(2)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 10n * USDC))).ok);
  warp(ctx, 31 * 86400); // the loan is overdue and nobody has marked it yet

  // A tries to leave at the still-full price: the shares go to escrow, nothing is paid.
  const usdcBefore = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 500n * USDC))).ok);
  const { escrow, request } = await lenderPdas(a);
  assert.equal(tokenBalance(ctx.svm, a.shares), 0n);
  assert.equal(tokenBalance(ctx.svm, escrow), 500n * USDC);
  assert.equal(tokenBalance(ctx.svm, a.usdc), usdcBefore);
  // Escrowed shares are not burned: they still count in supply, so pricing is unchanged by the request.
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 1000n * USDC);
  const req = await readRequest(ctx, a);
  assert.equal(req.shares, 500n * USDC);
  assert.equal(req.lender, a.signer.address);
  assert.equal(req.unlockTs, ctx.svm.getClock().unixTimestamp + BigInt(COOLDOWN));
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'CooldownActive');

  // Anyone marks the default while the request is cooling down.
  advance(ctx, COOLDOWN / 2);
  assert.ok((await send(ctx.svm, b.signer, [markDefaultIx(ctx)])).ok);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'CooldownActive'); // still locked
  advance(ctx, COOLDOWN / 2);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);

  // 10 lost, 2 seized -> 992 over 1000 shares: A's 500 shares pay 496, not 500.
  assert.equal(tokenBalance(ctx.svm, a.usdc) - usdcBefore, 496n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 500n * USDC);
  assert.equal(await exists(ctx, escrow), false);
  assert.equal(await exists(ctx, request), false);
  // B bears exactly the same per-share loss and walks out with the rest.
  const bBefore = tokenBalance(ctx.svm, b.usdc);
  assert.ok((await redeem(ctx, b, 500n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, b.usdc) - bBefore, 496n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 0n);
  assert.equal(readPool(ctx.svm, ctx.pool).idle, 0n);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 0n);
});

test('claim before the cooldown fails; it works at exactly unlock_ts', async () => {
  const ctx = await setup();
  const a = ctx.lender;
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  const { unlockTs } = await readRequest(ctx, a);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'CooldownActive');
  const c = ctx.svm.getClock(); c.unixTimestamp = unlockTs - 1n; ctx.svm.setClock(c);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'CooldownActive');
  assert.equal(tokenBalance(ctx.svm, a.usdc), 500n * USDC); // 1000 minted, 500 deposited: nothing paid yet
  c.unixTimestamp = unlockTs; ctx.svm.setClock(c);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc), 600n * USDC);
  // The request is single-use: a second claim has nothing to claim.
  assert.equal((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok, false);
});

test('attack: nobody can claim or cancel another lender\'s request', async () => {
  const ctx = await setup();
  const victim = ctx.lender;
  const thief = await newLender(ctx, 0n);
  assert.ok((await sendL(ctx, victim, await requestWithdrawIx(ctx, victim, 100n * USDC))).ok);
  advance(ctx, COOLDOWN);
  const v = await lenderPdas(victim);
  const t = await lenderPdas(thief);

  // Thief signs a claim that points at the victim's escrow + request, paying out to the thief.
  const claim = await claimWithdrawIx(ctx, thief);
  const swapped = (ix, from, to) => ({ ...ix, accounts: ix.accounts.map((m) => (m.address === from ? meta(to, W) : m)) });
  let r = await sendL(ctx, thief, swapped(swapped(claim, t.escrow, v.escrow), t.request, v.request));
  assert.equal(r.ok, false);
  assert.match(r.logs, /ConstraintSeeds|seeds constraint/i);
  // Thief with no request of their own cannot claim at all.
  r = await sendL(ctx, thief, claim);
  assert.equal(r.ok, false);
  // Same for cancel: the thief cannot drag the victim's shares into their own account.
  const cancel = await cancelWithdrawIx(ctx, thief);
  r = await sendL(ctx, thief, swapped(swapped(cancel, t.escrow, v.escrow), t.request, v.request));
  assert.equal(r.ok, false);
  assert.match(r.logs, /ConstraintSeeds|seeds constraint/i);
  // Victim's pending request and escrow are untouched, and the victim still claims in full.
  assert.equal(tokenBalance(ctx.svm, v.escrow), 100n * USDC);
  assert.equal(tokenBalance(ctx.svm, thief.usdc), 0n);
  assert.ok((await sendL(ctx, victim, await claimWithdrawIx(ctx, victim))).ok);
  assert.equal(tokenBalance(ctx.svm, victim.usdc), 600n * USDC);
});

test('attack: request_withdraw needs the lender\'s own shares (someone else\'s share account is rejected)', async () => {
  const ctx = await setup();
  const thief = await newLender(ctx, 0n);
  const ix = await requestWithdrawIx(ctx, thief, 1n);
  const r = await sendL(ctx, thief, { ...ix, accounts: ix.accounts.map((m, i) => (i === 3 ? meta(ctx.lender.shares, W) : m)) });
  assert.equal(r.ok, false);
  assert.equal(tokenBalance(ctx.svm, ctx.lender.shares), 500n * USDC);
});

test('cancel returns the escrowed shares (before or after unlock) and closes the request', async () => {
  const ctx = await setup();
  const a = ctx.lender;
  const { escrow, request } = await lenderPdas(a);
  assert.equal((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok, false); // nothing to cancel

  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 200n * USDC))).ok);
  assert.equal(tokenBalance(ctx.svm, a.shares), 300n * USDC);
  // One pending request at a time; shares in escrow cannot be requested twice or spent elsewhere.
  assert.equal((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok, false);
  assert.equal((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 1n))).ok, false);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.shares), 500n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 500n * USDC);
  assert.equal(await exists(ctx, escrow), false);
  assert.equal(await exists(ctx, request), false);

  // After the cooldown a cancel still works, and a fresh request can follow.
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 500n * USDC))).ok);
  advance(ctx, COOLDOWN + 1);
  assert.ok((await sendL(ctx, a, await cancelWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.shares), 500n * USDC);
  assert.equal(tokenBalance(ctx.svm, a.usdc), 500n * USDC);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 500n * USDC))).ok);
});

test('claim pays the LOWER of the request-time and claim-time price: escrowed shares earn nothing; they stay in supply', async () => {
  const ctx = await setup({ seed: 0n });
  const a = ctx.lender;
  const b = await newLender(ctx, 500n * USDC);
  assert.ok((await sendL(ctx, a, depositIx(ctx, a, 100n * USDC))).ok);
  assert.ok((await sendL(ctx, b, depositIx(ctx, b, 100n * USDC))).ok); // 200 shares, price 1.0
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);

  // During A's cooldown a borrower pays a 2 USDC fee on a 100 USDC loan: NAV 202 over 200 shares.
  await open(ctx, 200);
  await ctx.mintTo(ctx.borrowerAcct, 100n * USDC);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(20)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 100n * USDC))).ok);
  assert.ok((await sendB(ctx, repayIx(ctx, U(102)))).ok); // fee 2 USDC
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 200n * USDC); // escrowed shares still counted
  // A newcomer deposits during the cooldown and is priced against the full 200-share supply.
  const c = await newLender(ctx, 200n * USDC);
  assert.ok((await sendL(ctx, c, depositIx(ctx, c, U(101)))).ok); // NAV 202 / 200 shares = 1.01
  assert.equal(tokenBalance(ctx.svm, c.shares), 100n * USDC);

  advance(ctx, COOLDOWN);
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  // The price was locked at request time (1.00): the 1.01 earned while A sat in escrow is NOT paid to A.
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 100n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 200n * USDC);
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 203n * USDC); // 303 after C's deposit, minus the 100 paid to A; the forfeited 1 stays
});

test('claim cannot exceed idle cash: it pays the part idle covers and the request stays open for the rest until liquidity returns', async () => {
  const ctx = await setup();
  const a = ctx.lender;
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 50n * USDC))).ok); // idle 450
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 500n * USDC))).ok);
  advance(ctx, COOLDOWN);
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok); // partial: 450 now
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 450n * USDC);
  assert.equal((await readRequest(ctx, a)).shares, 50n * USDC); // still there, same unlock time and locked price
  assert.equal(readPool(ctx.svm, ctx.pool).idle, 0n);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'InsufficientLiquidity');
  await ctx.mintTo(ctx.borrowerAcct, 5n * USDC);
  assert.ok((await sendB(ctx, repayIx(ctx, U(51)))).ok);
  const mid = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - mid, 50n * USDC); // principal back; the 1 USDC fee earned in escrow stays with the pool
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 500n * USDC);
});

test('shares sent into someone\'s escrow cannot block their claim or cancel', async () => {
  const ctx = await setup();
  const a = ctx.lender;
  const griefer = await newLender(ctx, 100n * USDC);
  assert.ok((await sendL(ctx, griefer, depositIx(ctx, griefer, 10n * USDC))).ok);
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 100n * USDC))).ok);
  const { escrow } = await lenderPdas(a);
  let r = await sendL(ctx, griefer, getTransferInstruction({ source: griefer.shares, destination: escrow, authority: griefer.signer, amount: 5n * USDC }));
  assert.ok(r.ok, r.logs);
  advance(ctx, COOLDOWN);
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 100n * USDC); // paid for the request, not the donation
  assert.equal(await exists(ctx, escrow), false);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 400n * USDC + 5n * USDC); // donated shares were burned, donor's loss
});

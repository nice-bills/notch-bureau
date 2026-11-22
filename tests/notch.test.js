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

const PROGRAM = address(fs.readFileSync(new URL('../Anchor.toml', import.meta.url), 'utf8').match(/notch = "(\w+)"/)[1]);
const SO = new URL('../target/deploy/notch.so', import.meta.url).pathname;
const ED25519 = address('Ed25519SigVerify111111111111111111111111111');
const IX_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
const SYSTEM = address('11111111111111111111111111111111');
const enc = getAddressEncoder();
const USDC = 1_000_000n;
const COOLDOWN = 3 * 86_400; // WITHDRAW_COOLDOWN_S in programs/notch/src/lib.rs

const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const vecU8 = (bytes) => { const b = Buffer.alloc(4); b.writeUInt32LE(bytes.length); return Buffer.concat([b, bytes]); };
const pda = async (...seeds) => (await getProgramDerivedAddress({ programAddress: PROGRAM, seeds })).at(0);
const meta = (addr, role) => ({ address: addr, role });
const W = AccountRole.WRITABLE, R = AccountRole.READONLY, WS = AccountRole.WRITABLE_SIGNER, RS = AccountRole.READONLY_SIGNER;

function ed25519Ix(publicKey, message, signature) {
  const header = Buffer.alloc(16);
  const pkOff = 16, sigOff = 48, msgOff = 112;
  header.writeUInt8(1, 0);
  header.writeUInt16LE(sigOff, 2); header.writeUInt16LE(0xffff, 4);
  header.writeUInt16LE(pkOff, 6); header.writeUInt16LE(0xffff, 8);
  header.writeUInt16LE(msgOff, 10); header.writeUInt16LE(message.length, 12); header.writeUInt16LE(0xffff, 14);
  return { programAddress: ED25519, accounts: [], data: Buffer.concat([header, Buffer.from(publicKey), Buffer.from(signature), message]) };
}

async function send(svm, payer, ixs, extra = []) {
  svm.expireBlockhash();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  void extra;
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) return { ok: false, err: String(r.err()), logs: r.meta().logs().join('\n') };
  return { ok: true };
}

function readLine(svm, line) {
  const a = svm.getAccount(line);
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return {
    limit: d.readBigUInt64LE(40), expiry: d.readBigInt64LE(48), drawn: d.readBigUInt64LE(56), due: d.readBigInt64LE(64),
    repaidOnTime: d.readUInt32LE(72), repaidLate: d.readUInt32LE(76), lastNonce: d.readBigUInt64LE(80), defaulted: d[88] === 1,
    deposit: d.readBigUInt64LE(90),
  };
}

function readPool(svm, pool) {
  const d = Buffer.from(svm.getAccount(pool).data);
  return {
    totalLent: d.readBigUInt64LE(8), outstanding: d.readBigUInt64LE(16), defaults: d.readBigUInt64LE(24), defaultAmount: d.readBigUInt64LE(32),
    feesEarned: d.readBigUInt64LE(40), borrowerDeposits: d.readBigUInt64LE(48), idle: d.readBigUInt64LE(56),
  };
}

const tokenBalance = (svm, acct) => Buffer.from(svm.getAccount(acct).data).readBigUInt64LE(64);
const mintSupply = (svm, mint) => Buffer.from(svm.getAccount(mint).data).readBigUInt64LE(36);
const U = (x) => BigInt(Math.round(x * 1e6));

async function setup({ seed = 500n * USDC, borrowerFunds = 10n * USDC } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM, SO);
  const admin = await generateKeyPairSigner();
  const borrower = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  for (const s of [admin, borrower]) svm.airdrop(s.address, lamports(10_000_000_000n));
  const now = svm.getClock().unixTimestamp;

  const mkAcct = async (owner, mintAddr = mint.address) => {
    const kp = await generateKeyPairSigner();
    const space = BigInt(getTokenSize());
    const r = await send(svm, admin, [
      getCreateAccountInstruction({ payer: admin, newAccount: kp, lamports: svm.minimumBalanceForRentExemption(space), space, programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeAccount3Instruction({ account: kp.address, mint: mintAddr, owner }),
    ]);
    assert.ok(r.ok, r.logs);
    return kp.address;
  };
  const mintTo = async (token, amount) => {
    const r = await send(svm, admin, [getMintToInstruction({ mint: mint.address, token, mintAuthority: admin, amount })]);
    assert.ok(r.ok, r.logs);
  };

  const mintSpace = BigInt(getMintSize());
  let r = await send(svm, admin, [
    getCreateAccountInstruction({ payer: admin, newAccount: mint, lamports: svm.minimumBalanceForRentExemption(mintSpace), space: mintSpace, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: admin.address }),
  ]);
  assert.ok(r.ok, r.logs);

  const uw = nacl.sign.keyPair();
  const config = await pda(Buffer.from('config'));
  const vault = await pda(Buffer.from('vault'));
  const pool = await pda(Buffer.from('pool'));
  const shareMint = await pda(Buffer.from('share-mint'));
  r = await send(svm, admin, [{
    programAddress: PROGRAM,
    accounts: [meta(admin.address, WS), meta(config, W), meta(mint.address, R), meta(vault, W), meta(pool, W), meta(shareMint, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(SYSTEM, R)],
    data: Buffer.concat([disc('init'), Buffer.from(uw.publicKey), i64(now + 365n * 86400n)]),
  }]);
  assert.ok(r.ok, r.logs);

  const line = await pda(Buffer.from('line'), enc.encode(borrower.address));
  const ctx = { svm, admin, borrower, mint, uw, config, vault, pool, shareMint, line, now, mkAcct, mintTo };
  ctx.borrowerAcct = await mkAcct(borrower.address);
  if (borrowerFunds > 0n) await mintTo(ctx.borrowerAcct, borrowerFunds);

  // `admin` is lender #1.
  ctx.lender = { signer: admin, usdc: await mkAcct(admin.address), shares: await mkAcct(admin.address, shareMint) };
  await mintTo(ctx.lender.usdc, 1000n * USDC);
  if (seed > 0n) assert.ok((await send(svm, admin, [depositIx(ctx, ctx.lender, seed)])).ok);
  return ctx;
}

async function newLender(ctx, funds) {
  const signer = await generateKeyPairSigner();
  ctx.svm.airdrop(signer.address, lamports(1_000_000_000n));
  const l = { signer, usdc: await ctx.mkAcct(signer.address), shares: await ctx.mkAcct(signer.address, ctx.shareMint) };
  if (funds > 0n) await ctx.mintTo(l.usdc, funds);
  return l;
}

function record(ctx, { limitUsdc = 50, nonce = 1, dedupe = crypto.randomBytes(32), wallet = ctx.borrower.address, expiry } = {}) {
  return encodeRecord({ wallet, limitUsdc, expiry: expiry ?? Number(ctx.now) + 30 * 86400, dedupe, nonce });
}

async function postLimit(ctx, msg, { signKey = ctx.uw.secretKey, signedMsg = msg, borrower = ctx.borrower.address } = {}) {
  const sig = nacl.sign.detached(signedMsg, signKey);
  const pub = nacl.sign.keyPair.fromSecretKey(signKey).publicKey;
  const dedupe = await pda(Buffer.from('dedupe'), msg.subarray(56, 88));
  const line = await pda(Buffer.from('line'), enc.encode(borrower));
  return send(ctx.svm, ctx.admin, [
    ed25519Ix(pub, signedMsg, sig),
    {
      programAddress: PROGRAM,
      accounts: [meta(ctx.admin.address, WS), meta(borrower, R), meta(ctx.config, R), meta(line, W), meta(dedupe, W), meta(IX_SYSVAR, R), meta(SYSTEM, R)],
      data: Buffer.concat([disc('post_limit'), vecU8(msg)]),
    },
  ]);
}

// Account orders below mirror the #[derive(Accounts)] structs in programs/notch/src/lib.rs.
const depositIx = (ctx, lender, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(lender.signer.address, RS), meta(ctx.config, R), meta(ctx.mint.address, R), meta(lender.usdc, W), meta(ctx.vault, W), meta(ctx.pool, W), meta(ctx.shareMint, W), meta(lender.shares, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: Buffer.concat([disc('deposit'), u64(amount)]),
});
const lenderPdas = async (lender) => ({
  escrow: await pda(Buffer.from('escrow'), enc.encode(lender.signer.address)),
  request: await pda(Buffer.from('withdraw'), enc.encode(lender.signer.address)),
});
const requestWithdrawIx = async (ctx, lender, shares) => {
  const { escrow, request } = await lenderPdas(lender);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.shareMint, R), meta(lender.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(SYSTEM, R)],
    data: Buffer.concat([disc('request_withdraw'), u64(shares)]),
  };
};
const claimWithdrawIx = async (ctx, lender) => {
  const { escrow, request } = await lenderPdas(lender);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.pool, W), meta(ctx.shareMint, W), meta(escrow, W), meta(request, W), meta(lender.usdc, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
    data: disc('claim_withdraw'),
  };
};
const cancelWithdrawIx = async (ctx, lender) => {
  const { escrow, request } = await lenderPdas(lender);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.shareMint, R), meta(lender.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
    data: disc('cancel_withdraw'),
  };
};
const depositBorrowerIx = (ctx, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(ctx.pool, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: Buffer.concat([disc('deposit_borrower'), u64(amount)]),
});
const withdrawBorrowerIx = (ctx) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(ctx.pool, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: disc('withdraw_borrower'),
});
const drawIx = (ctx, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.pool, W)],
  data: Buffer.concat([disc('draw'), u64(amount)]),
});
const repayIx = (ctx, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.pool, W), meta(ctx.borrowerAcct, W)],
  data: Buffer.concat([disc('repay'), u64(amount)]),
});
const markDefaultIx = (ctx) => ({ programAddress: PROGRAM, accounts: [meta(ctx.line, W), meta(ctx.pool, W)], data: disc('mark_default') });

const sendB = (ctx, ...ixs) => send(ctx.svm, ctx.borrower, ixs);
const sendL = (ctx, lender, ...ixs) => send(ctx.svm, lender.signer, ixs);
const advance = (ctx, seconds) => { const c = ctx.svm.getClock(); c.unixTimestamp += BigInt(seconds); ctx.svm.setClock(c); };
const warp = (ctx, seconds) => { const c = ctx.svm.getClock(); c.unixTimestamp = ctx.now + BigInt(seconds); ctx.svm.setClock(c); };
const fails = (r, code) => { assert.equal(r.ok, false, `expected ${code} but tx succeeded`); assert.match(r.logs, new RegExp(code)); };
// Full exit in one call: request, wait out the cooldown, claim. If the claim is rejected the request is
// cancelled again so the lender is left exactly where they started (and the claim's result is returned).
async function redeem(ctx, lender, shares) {
  let r = await sendL(ctx, lender, await requestWithdrawIx(ctx, lender, shares));
  if (!r.ok) return r;
  advance(ctx, COOLDOWN);
  r = await sendL(ctx, lender, await claimWithdrawIx(ctx, lender));
  if (!r.ok) { const c = await sendL(ctx, lender, await cancelWithdrawIx(ctx, lender)); assert.ok(c.ok, c.logs); }
  return r;
}
const readRequest = async (ctx, lender) => {
  const a = ctx.svm.getAccount((await lenderPdas(lender)).request);
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return { lender: bs58.encode(d.subarray(8, 40)), shares: d.readBigUInt64LE(40), unlockTs: d.readBigInt64LE(48) };
};
const exists = async (ctx, addr) => ctx.svm.getAccount(addr).exists;
const open = async (ctx, limitUsdc = 50) => assert.ok((await postLimit(ctx, record(ctx, { limitUsdc, expiry: Number(ctx.now) + 90 * 86400 }))).ok);

test('underwriter-signed limit opens a line; borrower deposits, draws, repays principal + 2% fee on time', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.equal(readLine(ctx.svm, ctx.line).limit, 50n * USDC);

  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(6)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 30n * USDC))).ok);
  assert.equal(tokenBalance(ctx.svm, ctx.borrowerAcct), U(10 - 6 + 30));
  fails(await sendB(ctx, drawIx(ctx, 21n * USDC)), 'OverLimit');

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

test('withdraw is limited by idle liquidity, not by share value', async () => {
  const ctx = await setup();
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 50n * USDC))).ok);
  const a = ctx.lender;
  // 500 shares exist, 450 USDC is idle.
  fails(await redeem(ctx, a, 500n * USDC), 'InsufficientLiquidity');
  fails(await redeem(ctx, a, 451n * USDC), 'InsufficientLiquidity');
  assert.ok((await redeem(ctx, a, 450n * USDC)).ok);
  assert.equal(readPool(ctx.svm, ctx.pool).idle, 0n);
  // The 10 USDC borrower deposit still sits in the vault but is not lendable or withdrawable.
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 10n * USDC);
  fails(await redeem(ctx, a, 1n * USDC), 'InsufficientLiquidity');
  // Repayment brings cash back; the remaining 50 shares redeem for principal + fee.
  await ctx.mintTo(ctx.borrowerAcct, 5n * USDC); // covers the 1 USDC fee
  assert.ok((await sendB(ctx, repayIx(ctx, U(51)))).ok);
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await redeem(ctx, a, 50n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 51n * USDC);
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 0n);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 0n);
});

test('attack: first depositor + direct token donation to the vault cannot steal from the next depositor', async () => {
  const ctx = await setup({ seed: 0n });
  const attacker = ctx.lender;
  const victim = await newLender(ctx, 200n * USDC);
  assert.ok((await sendL(ctx, attacker, depositIx(ctx, attacker, 1n))).ok); // 1 base unit -> 1 share
  assert.equal(tokenBalance(ctx.svm, attacker.shares), 1n);
  // Donate 100 USDC straight into the vault token account (inflates a balance-based share price).
  await ctx.mintTo(ctx.vault, 100n * USDC);
  assert.equal(tokenBalance(ctx.svm, ctx.vault), 100n * USDC + 1n);
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 1n); // share price is untouched by the donation

  // The victim still gets full 1:1 shares (not rounded to ~0), and gets all of it back.
  assert.ok((await sendL(ctx, victim, depositIx(ctx, victim, 100n * USDC))).ok);
  assert.equal(tokenBalance(ctx.svm, victim.shares), 100n * USDC);
  assert.ok((await redeem(ctx, victim, 100n * USDC)).ok);
  assert.equal(tokenBalance(ctx.svm, victim.usdc), 200n * USDC);
  // The attacker gets back only their own 1 unit; the donation is simply stranded.
  const before = tokenBalance(ctx.svm, attacker.usdc);
  assert.ok((await redeem(ctx, attacker, 1n)).ok);
  assert.equal(tokenBalance(ctx.svm, attacker.usdc) - before, 1n);
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

test('claim pays at the share price at claim time, not at request time; escrowed shares stay in supply', async () => {
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
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, U(101)); // 100 shares * 1.01, not the 100 at request time
  assert.equal(mintSupply(ctx.svm, ctx.shareMint), 200n * USDC);
  const p = readPool(ctx.svm, ctx.pool);
  assert.equal(p.idle + p.outstanding, 202n * USDC); // 303 after C's deposit, minus the 101 paid to A
});

test('claim cannot exceed idle cash: it is rejected and the request stays open until liquidity returns', async () => {
  const ctx = await setup();
  const a = ctx.lender;
  await open(ctx);
  assert.ok((await sendB(ctx, depositBorrowerIx(ctx, U(10)))).ok);
  assert.ok((await sendB(ctx, drawIx(ctx, 50n * USDC))).ok); // idle 450
  assert.ok((await sendL(ctx, a, await requestWithdrawIx(ctx, a, 500n * USDC))).ok);
  advance(ctx, COOLDOWN);
  fails(await sendL(ctx, a, await claimWithdrawIx(ctx, a)), 'InsufficientLiquidity');
  assert.equal((await readRequest(ctx, a)).shares, 500n * USDC); // still there
  assert.equal(readPool(ctx.svm, ctx.pool).idle, 450n * USDC);
  await ctx.mintTo(ctx.borrowerAcct, 5n * USDC);
  assert.ok((await sendB(ctx, repayIx(ctx, U(51)))).ok);
  const before = tokenBalance(ctx.svm, a.usdc);
  assert.ok((await sendL(ctx, a, await claimWithdrawIx(ctx, a))).ok);
  assert.equal(tokenBalance(ctx.svm, a.usdc) - before, 501n * USDC); // principal back + 1 USDC fee
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

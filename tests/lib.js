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
// NOTCH_SO lets the audit tests run against an older build (to show they fail before a fix).
const SO = process.env.NOTCH_SO || new URL('../target/deploy/notch.so', import.meta.url).pathname;
const ED25519 = address('Ed25519SigVerify111111111111111111111111111');
const IX_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
const SYSTEM = address('11111111111111111111111111111111');
const enc = getAddressEncoder();
const USDC = 1_000_000n;
const COOLDOWN = 3 * 86_400; // WITHDRAW_COOLDOWN_S in programs/notch/src/lib.rs
const CLAIM_WINDOW = 2 * 86_400; // CLAIM_WINDOW_S

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
  const rd = r.returnData?.() ?? r.meta?.().returnData?.();
  return { ok: true, returnData: rd ? Buffer.from(rd.data()) : null, logs: r.logs?.().join('\n') };
}

function readLine(svm, line) {
  const a = svm.getAccount(line);
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return {
    limit: d.readBigUInt64LE(40), expiry: d.readBigInt64LE(48), drawn: d.readBigUInt64LE(56), due: d.readBigInt64LE(64),
    repaidOnTime: d.readUInt32LE(72), repaidLate: d.readUInt32LE(76), lastNonce: d.readBigUInt64LE(80), defaulted: d[88] === 1,
    deposit: d.readBigUInt64LE(90), postedAt: d.length >= 106 ? d.readBigInt64LE(98) : 0n,
    lastDrawAt: d.length >= 114 ? d.readBigInt64LE(106) : 0n, countedNonce: d.length >= 122 ? d.readBigUInt64LE(114) : 0n,
    idHash: d.length >= 154 ? d.subarray(122, 154).toString('hex') : null, countedAt: d.length >= 162 ? d.readBigInt64LE(154) : 0n, dataLen: d.length,
  };
}

function readPool(svm, pool) {
  const d = Buffer.from(svm.getAccount(pool).data);
  return {
    totalLent: d.readBigUInt64LE(8), outstanding: d.readBigUInt64LE(16), defaults: d.readBigUInt64LE(24), defaultAmount: d.readBigUInt64LE(32),
    feesEarned: d.readBigUInt64LE(40), borrowerDeposits: d.readBigUInt64LE(48), idle: d.readBigUInt64LE(56),
    seniorNav: d.readBigUInt64LE(64), juniorNav: d.readBigUInt64LE(72), seniorFees: d.readBigUInt64LE(80), juniorFees: d.readBigUInt64LE(88),
    seniorLosses: d.readBigUInt64LE(96), juniorLosses: d.readBigUInt64LE(104),
  };
}

const tokenBalance = (svm, acct) => Buffer.from(svm.getAccount(acct).data).readBigUInt64LE(64);
const mintSupply = (svm, mint) => Buffer.from(svm.getAccount(mint).data).readBigUInt64LE(36);
const U = (x) => BigInt(Math.round(x * 1e6));

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

// Defaults: junior must stay >= 20% of the pool, and a junior dollar counts 2x in the fee split.
// With only the JUNIOR tranche in use (the default `tranche` everywhere below) the pool behaves exactly like
// the old single-share pool, so the single-pool tests run unchanged.
async function setup({ seed = 500n * USDC, borrowerFunds = 10n * USDC, minJuniorBps = 2000, juniorWeightBps = 20_000, poolMustFail = false } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM, SO);
  const admin = await generateKeyPairSigner();
  const borrower = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  for (const s of [admin, borrower]) svm.airdrop(s.address, lamports(10_000_000_000n));
  // A realistic clock: LiteSVM starts at 0, but on a real chain `last_draw_at == 0` means "no draw clock" (a legacy line).
  { const c = svm.getClock(); c.unixTimestamp = 1_800_000_000n; svm.setClock(c); }
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
  const vault = await pda(Buffer.from('vault-v2'));
  const pool = await pda(Buffer.from('pool-v2'));
  const seniorMint = await pda(Buffer.from('senior-mint'));
  const juniorMint = await pda(Buffer.from('junior-mint'));
  const shareMint = juniorMint; // default tranche of the single-pool helpers
  r = await send(svm, admin, [{
    programAddress: PROGRAM,
    accounts: [meta(admin.address, WS), meta(config, W), meta(mint.address, R), meta(SYSTEM, R)],
    data: Buffer.concat([disc('init'), Buffer.from(uw.publicKey), i64(now + 365n * 86400n)]),
  }]);
  assert.ok(r.ok, r.logs);
  r = await send(svm, admin, [{
    programAddress: PROGRAM,
    accounts: [meta(admin.address, WS), meta(config, R), meta(mint.address, R), meta(vault, W), meta(pool, W), meta(seniorMint, W), meta(juniorMint, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(SYSTEM, R)],
    data: Buffer.concat([disc('init_pool'), u16(minJuniorBps), u32(juniorWeightBps)]),
  }]);
  if (poolMustFail) return r; // parameter-validation tests: hand back the failed init_pool result
  assert.ok(r.ok, r.logs);

  const line = await pda(Buffer.from('line'), enc.encode(borrower.address));
  const ctx = { svm, admin, borrower, mint, uw, config, vault, pool, shareMint, seniorMint, juniorMint, line, now, mkAcct, mintTo };
  ctx.borrowerAcct = await mkAcct(borrower.address);
  if (borrowerFunds > 0n) await mintTo(ctx.borrowerAcct, borrowerFunds);

  // `admin` is lender #1.
  ctx.lender = { signer: admin, usdc: await mkAcct(admin.address), shares: await mkAcct(admin.address, juniorMint), seniorShares: await mkAcct(admin.address, seniorMint), seniorMint, juniorMint };
  await mintTo(ctx.lender.usdc, 1000n * USDC);
  if (seed > 0n) assert.ok((await send(svm, admin, [depositIx(ctx, ctx.lender, seed)])).ok);
  return ctx;
}

async function newLender(ctx, funds) {
  const signer = await generateKeyPairSigner();
  ctx.svm.airdrop(signer.address, lamports(1_000_000_000n));
  const l = { signer, usdc: await ctx.mkAcct(signer.address), shares: await ctx.mkAcct(signer.address, ctx.juniorMint), seniorShares: await ctx.mkAcct(signer.address, ctx.seniorMint), seniorMint: ctx.seniorMint, juniorMint: ctx.juniorMint };
  if (funds > 0n) await ctx.mintTo(l.usdc, funds);
  return l;
}

function record(ctx, { limitUsdc = 50, nonce = 1, dedupe = crypto.randomBytes(32), wallet = ctx.borrower.address, expiry, idHash, deviceHash } = {}) {
  return encodeRecord({ wallet, limitUsdc, expiry: expiry ?? Number(ctx.now) + 30 * 86400, dedupe, nonce, idHash, deviceHash });
}

// `identity`: 'auto' passes the IdentityLink PDA for the record's id_hash when it is non-zero; false omits the
// optional trailing account (Anchor wants the program id as the "None" placeholder); an address passes exactly that account.
// `device` is the same for the DeviceLink PDA (v3 records, bytes 128..160), in the 9th slot (placeholder when there is none).
async function postLimit(ctx, msg, { signKey = ctx.uw.secretKey, signedMsg = msg, borrower = ctx.borrower.address, identity = 'auto', device = 'auto' } = {}) {
  const sig = nacl.sign.detached(signedMsg, signKey);
  const pub = nacl.sign.keyPair.fromSecretKey(signKey).publicKey;
  const dedupe = await pda(Buffer.from('dedupe'), msg.subarray(56, 88));
  const line = await pda(Buffer.from('line'), enc.encode(borrower));
  const idHash = msg.subarray(96, 128);
  let identityAcct = identity;
  if (identity === 'auto') identityAcct = idHash.length === 32 && idHash.some((b) => b) ? await pda(Buffer.from('identity'), idHash) : false;
  const deviceHash = msg.subarray(128, 160);
  let deviceAcct = device;
  if (device === 'auto') deviceAcct = deviceHash.length === 32 && deviceHash.some((b) => b) ? await pda(Buffer.from('device'), deviceHash) : false;
  return send(ctx.svm, ctx.admin, [
    ed25519Ix(pub, signedMsg, sig),
    {
      programAddress: PROGRAM,
      accounts: [meta(ctx.admin.address, WS), meta(borrower, R), meta(ctx.config, R), meta(line, W), meta(dedupe, W), meta(IX_SYSVAR, R), meta(SYSTEM, R), meta(identityAcct || PROGRAM, identityAcct ? W : R),
        meta(deviceAcct || PROGRAM, deviceAcct ? W : R)],
      data: Buffer.concat([disc('post_limit'), vecU8(msg)]),
    },
  ]);
}

// Account orders below mirror the #[derive(Accounts)] structs in programs/notch/src/lib.rs.
// `tranche` is 'junior' (default) or 'senior': it picks the share mint / share token account.
const trancheOf = (lender, tranche) => (tranche === 'senior'
  ? { mint: lender.seniorMint, shares: lender.seniorShares }
  : { mint: lender.juniorMint, shares: lender.shares });
const depositIx = (ctx, lender, amount, tranche = 'junior') => {
  const t = trancheOf(lender, tranche);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, RS), meta(ctx.config, R), meta(ctx.pool, W), meta(ctx.mint.address, R), meta(lender.usdc, W), meta(ctx.vault, W), meta(t.mint, W), meta(t.shares, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
    data: Buffer.concat([disc('deposit'), u64(amount)]),
  };
};
const lenderPdas = async (lender, tranche = 'junior') => {
  const { mint } = trancheOf(lender, tranche);
  return {
    escrow: await pda(Buffer.from('escrow'), enc.encode(mint), enc.encode(lender.signer.address)),
    request: await pda(Buffer.from('withdraw'), enc.encode(mint), enc.encode(lender.signer.address)),
  };
};
const requestWithdrawIx = async (ctx, lender, shares, tranche = 'junior') => {
  const { escrow, request } = await lenderPdas(lender, tranche);
  const t = trancheOf(lender, tranche);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.pool, R), meta(t.mint, R), meta(t.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(SYSTEM, R)],
    data: Buffer.concat([disc('request_withdraw'), u64(shares)]),
  };
};
const claimWithdrawIx = async (ctx, lender, tranche = 'junior') => {
  const { escrow, request } = await lenderPdas(lender, tranche);
  const t = trancheOf(lender, tranche);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.mint.address, R), meta(ctx.pool, W), meta(ctx.vault, W), meta(t.mint, W), meta(escrow, W), meta(request, W), meta(lender.usdc, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
    data: disc('claim_withdraw'),
  };
};
const cancelWithdrawIx = async (ctx, lender, tranche = 'junior') => {
  const { escrow, request } = await lenderPdas(lender, tranche);
  const t = trancheOf(lender, tranche);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.pool, R), meta(t.mint, W), meta(t.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
    data: disc('cancel_withdraw'),
  };
};
// Devnet cleanup of a request made before the price lock (shorter account): the shares come back in full.
const cancelLegacyWithdrawIx = async (ctx, lender, tranche = 'junior') => {
  const { escrow, request } = await lenderPdas(lender, tranche);
  const t = trancheOf(lender, tranche);
  return {
    programAddress: PROGRAM,
    accounts: [meta(lender.signer.address, WS), meta(ctx.pool, R), meta(t.mint, R), meta(t.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
    data: disc('cancel_legacy_withdraw'),
  };
};
const depositBorrowerIx = (ctx, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.pool, W), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: Buffer.concat([disc('deposit_borrower'), u64(amount)]),
});
const withdrawBorrowerIx = (ctx) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.pool, W), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: disc('withdraw_borrower'),
});
const drawIx = (ctx, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.pool, W), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: Buffer.concat([disc('draw'), u64(amount)]),
});
const i64le = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const drawWithTermIx = (ctx, amount, termS) => ({
  ...drawIx(ctx, amount),
  data: Buffer.concat([disc('draw_with_term'), u64(amount), i64le(termS)]),
});
const repayIx = (ctx, amount) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.pool, W), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.borrowerAcct, W)],
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
async function redeem(ctx, lender, shares, tranche = 'junior') {
  let r = await sendL(ctx, lender, await requestWithdrawIx(ctx, lender, shares, tranche));
  if (!r.ok) return r;
  advance(ctx, COOLDOWN);
  r = await sendL(ctx, lender, await claimWithdrawIx(ctx, lender, tranche));
  if (!r.ok) { const c = await sendL(ctx, lender, await cancelWithdrawIx(ctx, lender, tranche)); assert.ok(c.ok, c.logs); }
  return r;
}
const readRequest = async (ctx, lender, tranche = 'junior') => {
  const a = ctx.svm.getAccount((await lenderPdas(lender, tranche)).request);
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return { lender: bs58.encode(d.subarray(8, 40)), shares: d.readBigUInt64LE(40), unlockTs: d.readBigInt64LE(48), navAtRequest: d.length >= 74 ? d.readBigUInt64LE(58) : null, supplyAtRequest: d.length >= 74 ? d.readBigUInt64LE(66) : null };
};
const exists = async (ctx, addr) => ctx.svm.getAccount(addr).exists;
const open = async (ctx, limitUsdc = 50) => { const r = await postLimit(ctx, record(ctx, { limitUsdc, expiry: Number(ctx.now) + 90 * 86400 })); assert.ok(r.ok, r.logs); };

export { cancelLegacyWithdrawIx, CLAIM_WINDOW, drawWithTermIx, trancheOf, COOLDOWN, ED25519, IX_SYSVAR, PROGRAM, R, RS, SO, SYSTEM, U, USDC, W, WS, advance, cancelWithdrawIx, claimWithdrawIx, depositBorrowerIx, depositIx, disc, drawIx, ed25519Ix, enc, exists, fails, i64, lenderPdas, markDefaultIx, meta, mintSupply, newLender, open, pda, postLimit, readLine, readPool, readRequest, record, redeem, repayIx, requestWithdrawIx, send, sendB, sendL, setup, tokenBalance, u64, vecU8, warp, withdrawBorrowerIx };

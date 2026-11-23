// Checks that src/notch.ts builds byte-identical instructions to the reference builders in
// ../tests/notch.test.js (the LiteSVM program tests). The reference functions below are copied
// from that file; a drift guard also asserts the account lists in the JS file are unchanged.
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nacl from 'tweetnacl';
import { AccountRole, address, getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import {
  DISCRIMINATOR_HEX,
  INSTRUCTIONS_SYSVAR,
  SYSTEM_PROGRAM,
  decodeLine,
  decodePool,
  depositBorrowerIx,
  depositIx,
  deriveAddresses,
  deriveAta,
  deriveDedupe,
  deriveIdentity,
  decodeRecord,
  deriveLine,
  discriminator,
  drawIx,
  encodeRecord,
  markDefaultIx,
  isPastDue,
  postLimitIxs,
  repayIx,
  withdrawBorrowerIx,
  requestWithdrawIx,
  claimWithdrawIx,
  cancelWithdrawIx,
  deriveEscrow,
  deriveWithdrawRequest,
  decodeWithdrawRequest,
  WITHDRAW_COOLDOWN_SECONDS,
  feeFor,
  payoffFor,
  depositNeededFor,
  sharesForDeposit,
  usdcForShares,
  type InstructionName,
} from '../src/notch';
import { encodeRecord as encodeRecordRef } from '../../enclave/src/record.js';
import { explainError, TxError } from '../src/errors';
import { parseUsdc, formatUsdc } from '../src/amount';

// ---- reference implementation: copied from tests/notch.test.js -------------------------
const PROGRAM = address('4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz');
const ED25519 = address('Ed25519SigVerify111111111111111111111111111');
const TOKEN_PROGRAM_ADDRESS = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const enc = getAddressEncoder();
const disc = (name: string) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const vecU8 = (bytes: Buffer) => { const b = Buffer.alloc(4); b.writeUInt32LE(bytes.length); return Buffer.concat([b, bytes]); };
const meta = (addr: Address, role: AccountRole) => ({ address: addr, role });
const W = AccountRole.WRITABLE, R = AccountRole.READONLY, WS = AccountRole.WRITABLE_SIGNER, RS = AccountRole.READONLY_SIGNER;

function ed25519Ix(publicKey: Uint8Array, message: Buffer, signature: Uint8Array) {
  const header = Buffer.alloc(16);
  const pkOff = 16, sigOff = 48, msgOff = 112;
  header.writeUInt8(1, 0);
  header.writeUInt16LE(sigOff, 2); header.writeUInt16LE(0xffff, 4);
  header.writeUInt16LE(pkOff, 6); header.writeUInt16LE(0xffff, 8);
  header.writeUInt16LE(msgOff, 10); header.writeUInt16LE(message.length, 12); header.writeUInt16LE(0xffff, 14);
  return { programAddress: ED25519, accounts: [] as never[], data: Buffer.concat([header, Buffer.from(publicKey), Buffer.from(signature), message]) };
}

interface RefCtx {
  config: Address; vault: Address; pool: Address; shareMint: Address; line: Address;
  mint: Address; borrower: Address; borrowerAcct: Address; lender: { address: Address; usdc: Address; shares: Address; escrow: Address; request: Address };
}

const refDeposit = (ctx: RefCtx, amount: bigint) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.lender.address, RS), meta(ctx.config, R), meta(ctx.mint, R), meta(ctx.lender.usdc, W), meta(ctx.vault, W), meta(ctx.pool, W), meta(ctx.shareMint, W), meta(ctx.lender.shares, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: Buffer.concat([disc('deposit'), u64(amount)]),
});
const refRequestWithdraw = (ctx: RefCtx, shares: bigint) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.lender.address, WS), meta(ctx.config, R), meta(ctx.shareMint, R), meta(ctx.lender.shares, W), meta(ctx.lender.escrow, W), meta(ctx.lender.request, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(SYSTEM_PROGRAM, R)],
  data: Buffer.concat([disc('request_withdraw'), u64(shares)]),
});
const refClaimWithdraw = (ctx: RefCtx) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.lender.address, WS), meta(ctx.config, R), meta(ctx.mint, R), meta(ctx.vault, W), meta(ctx.pool, W), meta(ctx.shareMint, W), meta(ctx.lender.escrow, W), meta(ctx.lender.request, W), meta(ctx.lender.usdc, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: disc('claim_withdraw'),
});
const refCancelWithdraw = (ctx: RefCtx) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.lender.address, WS), meta(ctx.config, R), meta(ctx.shareMint, R), meta(ctx.lender.shares, W), meta(ctx.lender.escrow, W), meta(ctx.lender.request, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: disc('cancel_withdraw'),
});
const refDepositBorrower = (ctx: RefCtx, amount: bigint) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(ctx.pool, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: Buffer.concat([disc('deposit_borrower'), u64(amount)]),
});
const refWithdrawBorrower = (ctx: RefCtx) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(ctx.pool, W), meta(TOKEN_PROGRAM_ADDRESS, R)],
  data: disc('withdraw_borrower'),
});
const refDraw = (ctx: RefCtx, amount: bigint) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.pool, W)],
  data: Buffer.concat([disc('draw'), u64(amount)]),
});
const refRepay = (ctx: RefCtx, amount: bigint) => ({
  programAddress: PROGRAM,
  accounts: [meta(ctx.borrower, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.pool, W), meta(ctx.borrowerAcct, W)],
  data: Buffer.concat([disc('repay'), u64(amount)]),
});
const refMarkDefault = (ctx: RefCtx) => ({ programAddress: PROGRAM, accounts: [meta(ctx.line, W), meta(ctx.pool, W)], data: disc('mark_default') });
const refPostLimit = (ctx: RefCtx, payer: Address, msg: Buffer, dedupe: Address, identity?: Address) => [
  ed25519Ix(uw.publicKey, msg, nacl.sign.detached(msg, uw.secretKey)),
  {
    programAddress: PROGRAM,
    accounts: [meta(payer, WS), meta(ctx.borrower, R), meta(ctx.config, R), meta(ctx.line, W), meta(dedupe, W), meta(INSTRUCTIONS_SYSVAR, R), meta(SYSTEM_PROGRAM, R), identity ? meta(identity, W) : meta(PROGRAM, R)],
    data: Buffer.concat([disc('post_limit'), vecU8(msg)]),
  },
];
// -----------------------------------------------------------------------------------------

const uw = nacl.sign.keyPair();
const MINT = address('GnVMo9UvTpPFCT5ZxuFdpMVR6Z2hqN7TfJJZrzTzfVtS');
const borrower = address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');
const lenderAddr = address('8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR');

async function ctx(): Promise<{ a: Awaited<ReturnType<typeof deriveAddresses>>; ref: RefCtx }> {
  const a = await deriveAddresses(PROGRAM, MINT);
  const line = await deriveLine(PROGRAM, borrower);
  const borrowerAcct = await deriveAta(borrower, MINT);
  const lender = {
    address: lenderAddr,
    usdc: await deriveAta(lenderAddr, MINT),
    shares: await deriveAta(lenderAddr, a.shareMint),
    escrow: await deriveEscrow(PROGRAM, lenderAddr),
    request: await deriveWithdrawRequest(PROGRAM, lenderAddr),
  };
  return { a, ref: { config: a.config, vault: a.vault, pool: a.pool, shareMint: a.shareMint, line, mint: MINT, borrower, borrowerAcct, lender } };
}

/** Compare account lists and data bytes. */
function same(actual: { programAddress: Address; accounts?: readonly { address: Address; role: AccountRole }[]; data?: Uint8Array | readonly number[] }, expected: { programAddress: Address; accounts: readonly { address: Address; role: AccountRole }[]; data: Uint8Array }) {
  expect(actual.programAddress).toBe(expected.programAddress);
  expect(actual.accounts).toEqual(expected.accounts);
  expect(Buffer.from(actual.data as Uint8Array).toString('hex')).toBe(Buffer.from(expected.data).toString('hex'));
}

describe('notch.ts matches tests/notch.test.js', () => {
  it('post_limit: Ed25519 verify ix then post_limit with the same account order and bytes', async () => {
    const { a, ref } = await ctx();
    const record = encodeRecordRef({ wallet: borrower, limitUsdc: 50, expiry: 1_800_000_000, dedupe: crypto.randomBytes(32), nonce: 7 }) as Buffer;
    const dedupe = await deriveDedupe(PROGRAM, record.subarray(56, 88));
    const sig = nacl.sign.detached(record, uw.secretKey);
    const mine = postLimitIxs(a, { payer: lenderAddr, borrower, line: ref.line, dedupe, record }, uw.publicKey, sig);
    const expected = refPostLimit(ref, lenderAddr, record, dedupe);
    expect(mine).toHaveLength(2);
    same(mine[0], expected[0] as never);
    same(mine[1], expected[1] as never);
  });

  it('post_limit with an identity: the IdentityLink PDA is the trailing writable account', async () => {
    const { a, ref } = await ctx();
    const idHash = crypto.createHash('sha256').update('notch-msisdn|233241234567').digest();
    const record = encodeRecordRef({ wallet: borrower, limitUsdc: 50, expiry: 1_800_000_000, dedupe: crypto.randomBytes(32), nonce: 7, idHash }) as Buffer;
    expect(record.length).toBe(128);
    const dedupe = await deriveDedupe(PROGRAM, record.subarray(56, 88));
    const [identity] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from('identity'), idHash] });
    expect(await deriveIdentity(PROGRAM, decodeRecord(record).idHash)).toBe(identity);
    const sig = nacl.sign.detached(record, uw.secretKey);
    const mine = postLimitIxs(a, { payer: lenderAddr, borrower, line: ref.line, dedupe, record, identity }, uw.publicKey, sig);
    same(mine[1], refPostLimit(ref, lenderAddr, record, dedupe, identity)[1] as never);
  });

  it('draw', async () => {
    const { a, ref } = await ctx();
    same(drawIx(a, borrower, ref.line, ref.borrowerAcct, 30_000_000n), refDraw(ref, 30_000_000n));
  });

  it('repay (deposit_return defaults to the same token account, as in the tests)', async () => {
    const { a, ref } = await ctx();
    same(repayIx(a, borrower, ref.line, ref.borrowerAcct, 30_600_000n), refRepay(ref, 30_600_000n));
    // Explicit duplicate-account form is identical.
    same(repayIx(a, borrower, ref.line, ref.borrowerAcct, 30_600_000n, ref.borrowerAcct), refRepay(ref, 30_600_000n));
  });

  it('the rest: deposit, deposit_borrower, withdraw_borrower, mark_default', async () => {
    const { a, ref } = await ctx();
    same(depositIx(a, lenderAddr, ref.lender.usdc, ref.lender.shares, 500_000_000n), refDeposit(ref, 500_000_000n));
    same(depositBorrowerIx(a, borrower, ref.line, ref.borrowerAcct, 6_000_000n), refDepositBorrower(ref, 6_000_000n));
    same(withdrawBorrowerIx(a, borrower, ref.line, ref.borrowerAcct), refWithdrawBorrower(ref));
    same(markDefaultIx(a, ref.line), refMarkDefault(ref));
  });

  it('two-step withdraw: request_withdraw, claim_withdraw, cancel_withdraw', async () => {
    const { a, ref } = await ctx();
    const l = ref.lender;
    same(requestWithdrawIx(a, lenderAddr, l.shares, l.escrow, l.request, 50_000_000n), refRequestWithdraw(ref, 50_000_000n));
    same(claimWithdrawIx(a, lenderAddr, l.escrow, l.request, l.usdc), refClaimWithdraw(ref));
    same(cancelWithdrawIx(a, lenderAddr, l.shares, l.escrow, l.request), refCancelWithdraw(ref));
    // The old instant `withdraw` is gone from the program: no discriminator for it here either.
    expect(Object.keys(DISCRIMINATOR_HEX)).not.toContain('withdraw');
  });

  it('PDAs: escrow uses ["escrow", lender], request uses ["withdraw", lender]', async () => {
    const [escrow] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from('escrow'), enc.encode(lenderAddr)] });
    const [request] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from('withdraw'), enc.encode(lenderAddr)] });
    expect(await deriveEscrow(PROGRAM, lenderAddr)).toBe(escrow);
    expect(await deriveWithdrawRequest(PROGRAM, lenderAddr)).toBe(request);
  });

  it('decodeWithdrawRequest reads lender, shares and unlock time (lib.rs WithdrawRequest layout)', () => {
    const data = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 1);
    Buffer.from(enc.encode(lenderAddr)).copy(data, 8);
    data.writeBigUInt64LE(123_456_789n, 40);
    data.writeBigInt64LE(1_800_259_200n, 48);
    const r = decodeWithdrawRequest(data);
    expect(r).toEqual({ lender: lenderAddr, shares: 123_456_789n, unlockTs: 1_800_259_200n });
    expect(() => decodeWithdrawRequest(data.subarray(0, 40))).toThrow();
  });

  it('cooldown constant matches WITHDRAW_COOLDOWN_S in lib.rs', () => {
    const src = fs.readFileSync(new URL('../../programs/notch/src/lib.rs', import.meta.url), 'utf8');
    expect(src).toContain('pub const WITHDRAW_COOLDOWN_S: i64 = 3 * 86_400;');
    expect(WITHDRAW_COOLDOWN_SECONDS).toBe(3n * 86_400n);
  });

  it('CooldownActive error is recognised (program error code 6020) and explained', () => {
    const named = explainError(new TxError('x', ['Program log: AnchorError thrown in programs/notch/src/lib.rs:1. Error Code: CooldownActive. Error Number: 6020.']));
    expect(named.code).toBe('CooldownActive');
    const hex = explainError(new TxError('Transaction simulation failed: custom program error: 0x1784'));
    expect(hex.code).toBe('CooldownActive');
  });

  it('isPastDue mirrors the program test for mark_default', () => {
    const base = { drawn: 5_000_000n, due: 1_000n, defaulted: false };
    expect(isPastDue(base, 1_001)).toBe(true);
    expect(isPastDue(base, 1_000)).toBe(false); // program needs now > due
    expect(isPastDue({ ...base, drawn: 0n }, 2_000)).toBe(false);
    expect(isPastDue({ ...base, due: 0n }, 2_000)).toBe(false);
    expect(isPastDue({ ...base, defaulted: true }, 2_000)).toBe(false);
  });

  it('discriminators are sha256("global:<name>")[0..8]', () => {
    for (const name of Object.keys(DISCRIMINATOR_HEX) as InstructionName[]) {
      expect(Buffer.from(discriminator(name)).toString('hex')).toBe(disc(name).toString('hex'));
    }
  });

  it('record encoding is byte-identical to enclave/src/record.js', () => {
    const dedupe = crypto.randomBytes(32);
    const mine = encodeRecord({ wallet: borrower, limitMicro: 42_500_000n, expiry: 1_790_000_000, dedupe, nonce: 99n });
    const ref = encodeRecordRef({ wallet: borrower, limitUsdc: 42.5, expiry: 1_790_000_000, dedupe, nonce: 99 }) as Buffer;
    expect(Buffer.from(mine).toString('hex')).toBe(ref.toString('hex'));
    const idHash = crypto.randomBytes(32);
    const mine2 = encodeRecord({ wallet: borrower, limitMicro: 42_500_000n, expiry: 1_790_000_000, dedupe, nonce: 99n, idHash });
    const ref2 = encodeRecordRef({ wallet: borrower, limitUsdc: 42.5, expiry: 1_790_000_000, dedupe, nonce: 99, idHash }) as Buffer;
    expect(Buffer.from(mine2).toString('hex')).toBe(ref2.toString('hex'));
    expect(Buffer.from(decodeRecord(mine2).idHash).toString('hex')).toBe(idHash.toString('hex'));
  });

  it('PDAs: line uses ["line", borrower], dedupe uses ["dedupe", hash]', async () => {
    const [line] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from('line'), enc.encode(borrower)] });
    expect(await deriveLine(PROGRAM, borrower)).toBe(line);
    const hash = crypto.randomBytes(32);
    const [dd] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [Buffer.from('dedupe'), hash] });
    expect(await deriveDedupe(PROGRAM, hash)).toBe(dd);
  });

  it('drift guard: tests/notch.test.js still has the account lists this file mirrors', () => {
    const src = fs.readFileSync(new URL('../../tests/notch.test.js', import.meta.url), 'utf8');
    for (const needle of [
      "accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.shareMint, R), meta(lender.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(SYSTEM, R)]",
      "accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.pool, W), meta(ctx.shareMint, W), meta(escrow, W), meta(request, W), meta(lender.usdc, W), meta(TOKEN_PROGRAM_ADDRESS, R)]",
      "accounts: [meta(lender.signer.address, WS), meta(ctx.config, R), meta(ctx.shareMint, R), meta(lender.shares, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM_ADDRESS, R)]",
      "accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.vault, W), meta(ctx.borrowerAcct, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.pool, W)]",
      "accounts: [meta(ctx.borrower.address, RS), meta(ctx.config, R), meta(ctx.line, W), meta(ctx.mint.address, R), meta(ctx.borrowerAcct, W), meta(ctx.vault, W), meta(TOKEN_PROGRAM_ADDRESS, R), meta(ctx.pool, W), meta(ctx.borrowerAcct, W)]",
      "accounts: [meta(ctx.admin.address, WS), meta(borrower, R), meta(ctx.config, R), meta(line, W), meta(dedupe, W), meta(IX_SYSVAR, R), meta(SYSTEM, R), meta(identityAcct || PROGRAM, identityAcct ? W : R)]",
    ]) expect(src).toContain(needle);
  });
});

describe('account readers and money rules', () => {
  it('decodes a credit line using the test offsets', () => {
    const d = Buffer.alloc(98);
    Buffer.from(enc.encode(borrower)).copy(d, 8);
    d.writeBigUInt64LE(50_000_000n, 40); d.writeBigInt64LE(1_800_000_000n, 48); d.writeBigUInt64LE(30_000_000n, 56);
    d.writeBigInt64LE(1_790_000_000n, 64); d.writeUInt32LE(2, 72); d.writeUInt32LE(1, 76); d.writeBigUInt64LE(9n, 80);
    d[88] = 1; d.writeBigUInt64LE(6_000_000n, 90);
    expect(decodeLine(d)).toEqual({
      wallet: borrower, limit: 50_000_000n, expiry: 1_800_000_000n, drawn: 30_000_000n, due: 1_790_000_000n,
      repaidOnTime: 2, repaidLate: 1, lastNonce: 9n, defaulted: true, deposit: 6_000_000n,
    });
  });

  it('decodes pool stats using the test offsets', () => {
    const d = Buffer.alloc(65);
    [1n, 2n, 3n, 4n, 5n, 6n, 7n].forEach((v, i) => d.writeBigUInt64LE(v, 8 + i * 8));
    expect(decodePool(d)).toEqual({ totalLent: 1n, outstanding: 2n, defaults: 3n, defaultAmount: 4n, feesEarned: 5n, borrowerDeposits: 6n, idle: 7n });
  });

  it('fee, payoff, deposit and share maths match the program tests', () => {
    expect(feeFor(30_000_000n)).toBe(600_000n);
    expect(payoffFor(30_000_000n)).toBe(30_600_000n);
    expect(feeFor(1n)).toBe(1n); // rounds up so dust draws still pay
    expect(depositNeededFor(30_000_000n)).toBe(6_000_000n);
    expect(depositNeededFor(31_000_000n)).toBe(6_200_000n);
    expect(sharesForDeposit(100_400_000n, 100_000_000n, 100_400_000n)).toBe(100_000_000n);
    expect(usdcForShares(50_000_000n, 200_000_000n, 200_800_000n)).toBe(50_200_000n);
  });

  it('parses and formats USDC without floating point', () => {
    expect(parseUsdc('30.6')).toBe(30_600_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('1.0000001')).toBeNull();
    expect(parseUsdc('abc')).toBeNull();
    expect(formatUsdc(30_600_000n)).toBe('30.60');
    expect(formatUsdc(1_234_567n)).toBe('1.234567');
  });
});

describe('error messages', () => {
  const cases: [string, RegExp][] = [
    ['InsufficientDeposit', /deposit/i], ['FeeRequired', /2%/], ['InsufficientLiquidity', /idle cash/i],
    ['BalanceOutstanding', /owe/i], ['OverLimit', /limit/i], ['Defaulted', /closed/i], ['NotPastDue', /due date/i],
    ['NothingToRepay', /nothing to repay/i], ['InvalidAmount', /greater than zero/i], ['WrongUnderwriter', /not signed/i],
    ['RecordMismatch', /changed it after signing/i], ['StaleRecord', /newer limit/i], ['RecordExpired', /expired/i], ['WrongWallet', /different wallet/i],
  ];
  it.each(cases)('maps %s from an Anchor log line', (name, re) => {
    const e = explainError(new TxError('x', [`Program log: AnchorError thrown in programs/notch/src/lib.rs:1. Error Code: ${name}. Error Number: 6000. Error Message: x.`]));
    expect(e.code).toBe(name);
    expect(e.message).toMatch(re);
  });
  it('maps a bare custom error number (6003 = WrongUnderwriter)', () => {
    expect(explainError(new Error('Program failed: custom program error: 0x1773')).code).toBe('WrongUnderwriter');
  });
  it('maps a reused email (dedupe account already exists)', () => {
    expect(explainError(new TxError('x', ['Allocate: account Address { address: abc, base: None } already in use'])).code).toBe('EmailAlreadyUsed');
  });
});

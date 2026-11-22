// Instruction builders and account readers for the Notch program.
//
// This file mirrors `tests/notch.test.js` (account order, roles, data layout) and the
// `#[derive(Accounts)]` structs in `programs/notch/src/lib.rs`. It has no network and no
// browser-only code, so it can run under vitest in Node. `test/notch.test.ts` checks it
// byte for byte against the reference builders copied from the program tests.
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type Address,
  type Instruction,
} from '@solana/kit';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const ED25519_PROGRAM = address('Ed25519SigVerify111111111111111111111111111');
export const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');

export const USDC_DECIMALS = 6;
export const USDC = 1_000_000n;
export const LOAN_TERM_SECONDS = 30n * 86_400n;
/** Mirrors WITHDRAW_COOLDOWN_S in programs/notch/src/lib.rs. */
export const WITHDRAW_COOLDOWN_SECONDS = 3n * 86_400n;

/** Anchor discriminators: sha256("global:<name>")[0..8]. Verified against node:crypto in the unit test. */
const DISCRIMINATORS = {
  init: 'dc3bcfec6cfa2f64',
  set_underwriter: '6449a18380907111',
  post_limit: 'e9a2b88e298351e0',
  deposit: 'f223c68952e1f2b6',
  request_withdraw: '895fbb60fa8a1fb6',
  claim_withdraw: 'e8599a7510ccb6e0',
  cancel_withdraw: '7035e23a9e1e25a8',
  deposit_borrower: 'a0783533ea0296a8',
  withdraw_borrower: 'af42e688c2545ba2',
  draw: '3d283eb81fb01882',
  repay: 'ea674352d0eadba6',
  mark_default: 'b6e77b8442d0898b',
} as const;
export type InstructionName = keyof typeof DISCRIMINATORS;

export function discriminator(name: InstructionName): Uint8Array {
  const hex = DISCRIMINATORS[name];
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const DISCRIMINATOR_HEX: Readonly<Record<InstructionName, string>> = DISCRIMINATORS;

// ---------------------------------------------------------------------------
// Byte helpers (little endian, no Buffer so this runs in the browser).
// ---------------------------------------------------------------------------

export function u64Le(n: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}
export function i64Le(n: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n), true);
  return out;
}
/** Borsh Vec<u8>: u32 length prefix then the bytes. */
export function vecU8(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const addressEncoder = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);

export interface NotchAddresses {
  program: Address;
  mint: Address;
  config: Address;
  vault: Address;
  pool: Address;
  shareMint: Address;
}

async function pda(program: Address, ...seeds: Uint8Array[]): Promise<Address> {
  const [addr] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return addr;
}

export async function deriveAddresses(program: Address, mint: Address): Promise<NotchAddresses> {
  const [config, vault, pool, shareMint] = await Promise.all([
    pda(program, text('config')),
    pda(program, text('vault')),
    pda(program, text('pool')),
    pda(program, text('share-mint')),
  ]);
  return { program, mint, config, vault, pool, shareMint };
}

export const deriveLine = (program: Address, borrower: Address) =>
  pda(program, text('line'), new Uint8Array(addressEncoder.encode(borrower)));

/** The dedupe hash is bytes 56..88 of the signed record. */
export const deriveDedupe = (program: Address, dedupeHash: Uint8Array) =>
  pda(program, text('dedupe'), dedupeHash);

/** The lender's share escrow (a token account that owns itself) and pending-withdrawal record. */
export const deriveEscrow = (program: Address, lender: Address) =>
  pda(program, text('escrow'), new Uint8Array(addressEncoder.encode(lender)));
export const deriveWithdrawRequest = (program: Address, lender: Address) =>
  pda(program, text('withdraw'), new Uint8Array(addressEncoder.encode(lender)));

export async function deriveAta(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [
      new Uint8Array(addressEncoder.encode(owner)),
      new Uint8Array(addressEncoder.encode(TOKEN_PROGRAM)),
      new Uint8Array(addressEncoder.encode(mint)),
    ],
  });
  return ata;
}

// ---------------------------------------------------------------------------
// Signed record (96 bytes). Must match enclave/src/record.js and record.rs.
//   "NOTCHv1\0" | wallet[32] | limit_micro u64 | expiry i64 | dedupe[32] | nonce u64
// ---------------------------------------------------------------------------

export const RECORD_LEN = 96;
const RECORD_TAG = new Uint8Array([0x4e, 0x4f, 0x54, 0x43, 0x48, 0x76, 0x31, 0x00]);

export interface RecordFields {
  wallet: Address;
  limitMicro: bigint;
  expiry: bigint | number;
  dedupe: Uint8Array;
  nonce: bigint | number;
}

export function encodeRecord(f: RecordFields): Uint8Array {
  if (f.dedupe.length !== 32) throw new Error('dedupe hash must be 32 bytes');
  return concat(
    RECORD_TAG,
    new Uint8Array(addressEncoder.encode(f.wallet)),
    u64Le(f.limitMicro),
    i64Le(f.expiry),
    f.dedupe,
    u64Le(f.nonce),
  );
}

export function decodeRecord(bytes: Uint8Array): { limitMicro: bigint; expiry: bigint; dedupe: Uint8Array; nonce: bigint } {
  if (bytes.length !== RECORD_LEN) throw new Error('record must be 96 bytes');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    limitMicro: v.getBigUint64(40, true),
    expiry: v.getBigInt64(48, true),
    dedupe: bytes.slice(56, 88),
    nonce: v.getBigUint64(88, true),
  };
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const W = AccountRole.WRITABLE;
const R = AccountRole.READONLY;
const WS = AccountRole.WRITABLE_SIGNER;
const RS = AccountRole.READONLY_SIGNER;
const meta = (addr: Address, role: AccountRole): AccountMeta => ({ address: addr, role });

function ix(program: Address, accounts: AccountMeta[], data: Uint8Array): Instruction {
  return { programAddress: program, accounts, data };
}

/** Native Ed25519 verify instruction, one signature, all offsets pointing inside itself. */
export function ed25519VerifyIx(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Instruction {
  if (publicKey.length !== 32 || signature.length !== 64) throw new Error('bad key or signature length');
  const header = new Uint8Array(16);
  const v = new DataView(header.buffer);
  const pkOff = 16;
  const sigOff = 48;
  const msgOff = 112;
  header[0] = 1;
  v.setUint16(2, sigOff, true);
  v.setUint16(4, 0xffff, true);
  v.setUint16(6, pkOff, true);
  v.setUint16(8, 0xffff, true);
  v.setUint16(10, msgOff, true);
  v.setUint16(12, message.length, true);
  v.setUint16(14, 0xffff, true);
  return { programAddress: ED25519_PROGRAM, accounts: [], data: concat(header, publicKey, signature, message) };
}

export function initIx(
  a: NotchAddresses,
  admin: Address,
  underwriter: Address,
  underwriterExpiry: bigint | number,
): Instruction {
  return ix(
    a.program,
    [meta(admin, WS), meta(a.config, W), meta(a.mint, R), meta(a.vault, W), meta(a.pool, W), meta(a.shareMint, W), meta(TOKEN_PROGRAM, R), meta(SYSTEM_PROGRAM, R)],
    concat(discriminator('init'), new Uint8Array(addressEncoder.encode(underwriter)), i64Le(underwriterExpiry)),
  );
}

export function setUnderwriterIx(
  a: NotchAddresses,
  admin: Address,
  underwriter: Address,
  expiry: bigint | number,
): Instruction {
  return ix(
    a.program,
    [meta(admin, RS), meta(a.config, W)],
    concat(discriminator('set_underwriter'), new Uint8Array(addressEncoder.encode(underwriter)), i64Le(expiry)),
  );
}

export interface PostLimitParams {
  payer: Address;
  borrower: Address;
  line: Address;
  dedupe: Address;
  record: Uint8Array;
}

/** Returns [ed25519 verify, post_limit]; the verify ix must sit directly before post_limit. */
export function postLimitIxs(
  a: NotchAddresses,
  p: PostLimitParams,
  underwriterPublicKey: Uint8Array,
  signature: Uint8Array,
): Instruction[] {
  return [ed25519VerifyIx(underwriterPublicKey, p.record, signature), postLimitIx(a, p)];
}

export function postLimitIx(a: NotchAddresses, p: PostLimitParams): Instruction {
  return ix(
    a.program,
    [meta(p.payer, WS), meta(p.borrower, R), meta(a.config, R), meta(p.line, W), meta(p.dedupe, W), meta(INSTRUCTIONS_SYSVAR, R), meta(SYSTEM_PROGRAM, R)],
    concat(discriminator('post_limit'), vecU8(p.record)),
  );
}

export function depositIx(a: NotchAddresses, lender: Address, from: Address, shareAccount: Address, amount: bigint | number): Instruction {
  return ix(
    a.program,
    [meta(lender, RS), meta(a.config, R), meta(a.mint, R), meta(from, W), meta(a.vault, W), meta(a.pool, W), meta(a.shareMint, W), meta(shareAccount, W), meta(TOKEN_PROGRAM, R)],
    concat(discriminator('deposit'), u64Le(amount)),
  );
}

/**
 * Step 1 of leaving the pool: shares move into escrow, the cooldown starts. The lender pays rent for
 * the escrow and request accounts (refunded on claim or cancel). One pending request per lender.
 */
export function requestWithdrawIx(
  a: NotchAddresses,
  lender: Address,
  shareAccount: Address,
  escrow: Address,
  request: Address,
  shares: bigint | number,
): Instruction {
  return ix(
    a.program,
    [meta(lender, WS), meta(a.config, R), meta(a.shareMint, R), meta(shareAccount, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM, R), meta(SYSTEM_PROGRAM, R)],
    concat(discriminator('request_withdraw'), u64Le(shares)),
  );
}

/** Step 2, after `unlock_ts`: burns the escrowed shares and pays USDC at the share price of that moment. */
export function claimWithdrawIx(a: NotchAddresses, lender: Address, escrow: Address, request: Address, to: Address): Instruction {
  return ix(
    a.program,
    [meta(lender, WS), meta(a.config, R), meta(a.mint, R), meta(a.vault, W), meta(a.pool, W), meta(a.shareMint, W), meta(escrow, W), meta(request, W), meta(to, W), meta(TOKEN_PROGRAM, R)],
    discriminator('claim_withdraw'),
  );
}

/** Give the escrowed shares back to the lender (any time, before or after the cooldown). */
export function cancelWithdrawIx(a: NotchAddresses, lender: Address, shareAccount: Address, escrow: Address, request: Address): Instruction {
  return ix(
    a.program,
    [meta(lender, WS), meta(a.config, R), meta(a.shareMint, R), meta(shareAccount, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM, R)],
    discriminator('cancel_withdraw'),
  );
}

export function depositBorrowerIx(a: NotchAddresses, borrower: Address, line: Address, from: Address, amount: bigint | number): Instruction {
  return ix(
    a.program,
    [meta(borrower, RS), meta(a.config, R), meta(line, W), meta(a.mint, R), meta(from, W), meta(a.vault, W), meta(a.pool, W), meta(TOKEN_PROGRAM, R)],
    concat(discriminator('deposit_borrower'), u64Le(amount)),
  );
}

export function withdrawBorrowerIx(a: NotchAddresses, borrower: Address, line: Address, to: Address): Instruction {
  return ix(
    a.program,
    [meta(borrower, RS), meta(a.config, R), meta(line, W), meta(a.mint, R), meta(a.vault, W), meta(to, W), meta(a.pool, W), meta(TOKEN_PROGRAM, R)],
    discriminator('withdraw_borrower'),
  );
}

export function drawIx(a: NotchAddresses, borrower: Address, line: Address, to: Address, amount: bigint | number): Instruction {
  return ix(
    a.program,
    [meta(borrower, RS), meta(a.config, R), meta(line, W), meta(a.mint, R), meta(a.vault, W), meta(to, W), meta(TOKEN_PROGRAM, R), meta(a.pool, W)],
    concat(discriminator('draw'), u64Le(amount)),
  );
}

/** `depositReturn` may be the same account as `from` (the tests pass the same token account twice). */
export function repayIx(
  a: NotchAddresses,
  borrower: Address,
  line: Address,
  from: Address,
  amount: bigint | number,
  depositReturn: Address = from,
): Instruction {
  return ix(
    a.program,
    [meta(borrower, RS), meta(a.config, R), meta(line, W), meta(a.mint, R), meta(from, W), meta(a.vault, W), meta(TOKEN_PROGRAM, R), meta(a.pool, W), meta(depositReturn, W)],
    concat(discriminator('repay'), u64Le(amount)),
  );
}

export function markDefaultIx(a: NotchAddresses, line: Address): Instruction {
  return ix(a.program, [meta(line, W), meta(a.pool, W)], discriminator('mark_default'));
}

/** Create an associated token account if it does not exist yet (instruction 1 of the ATA program). */
export function createAtaIdempotentIx(payer: Address, ata: Address, owner: Address, mint: Address): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [meta(payer, WS), meta(ata, W), meta(owner, R), meta(mint, R), meta(SYSTEM_PROGRAM, R), meta(TOKEN_PROGRAM, R)],
    data: new Uint8Array([1]),
  };
}

// ---------------------------------------------------------------------------
// Account readers (offsets from the tests; 8 byte Anchor discriminator first)
// ---------------------------------------------------------------------------

export interface CreditLine {
  wallet: Address;
  limit: bigint;
  expiry: bigint;
  drawn: bigint;
  due: bigint;
  repaidOnTime: number;
  repaidLate: number;
  lastNonce: bigint;
  defaulted: boolean;
  deposit: bigint;
}

export const CREDIT_LINE_MIN_LEN = 98;

export function decodeLine(data: Uint8Array): CreditLine {
  if (data.length < CREDIT_LINE_MIN_LEN) throw new Error('credit line account is too short');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    wallet: getAddressDecoderFromBytes(data.subarray(8, 40)),
    limit: v.getBigUint64(40, true),
    expiry: v.getBigInt64(48, true),
    drawn: v.getBigUint64(56, true),
    due: v.getBigInt64(64, true),
    repaidOnTime: v.getUint32(72, true),
    repaidLate: v.getUint32(76, true),
    lastNonce: v.getBigUint64(80, true),
    defaulted: data[88] === 1,
    deposit: v.getBigUint64(90, true),
  };
}

export interface PoolStats {
  totalLent: bigint;
  outstanding: bigint;
  defaults: bigint;
  defaultAmount: bigint;
  feesEarned: bigint;
  borrowerDeposits: bigint;
  idle: bigint;
}

export const POOL_MIN_LEN = 64;

export function decodePool(data: Uint8Array): PoolStats {
  if (data.length < POOL_MIN_LEN) throw new Error('pool account is too short');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    totalLent: v.getBigUint64(8, true),
    outstanding: v.getBigUint64(16, true),
    defaults: v.getBigUint64(24, true),
    defaultAmount: v.getBigUint64(32, true),
    feesEarned: v.getBigUint64(40, true),
    borrowerDeposits: v.getBigUint64(48, true),
    idle: v.getBigUint64(56, true),
  };
}

export interface WithdrawRequest {
  lender: Address;
  shares: bigint;
  /** Unix seconds; `claim_withdraw` works once the chain clock reaches this. */
  unlockTs: bigint;
}

export const WITHDRAW_REQUEST_MIN_LEN = 58;

export function decodeWithdrawRequest(data: Uint8Array): WithdrawRequest {
  if (data.length < WITHDRAW_REQUEST_MIN_LEN) throw new Error('withdraw request account is too short');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    lender: getAddressDecoderFromBytes(data.subarray(8, 40)),
    shares: v.getBigUint64(40, true),
    unlockTs: v.getBigInt64(48, true),
  };
}

export function decodeTokenAmount(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}
export function decodeMintSupply(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(36, true);
}

const addressDecoder = getAddressDecoder();
function getAddressDecoderFromBytes(bytes: Uint8Array): Address {
  return addressDecoder.decode(bytes);
}

// ---------------------------------------------------------------------------
// Money rules, mirrored from the program so the UI can show them before a tx.
// ---------------------------------------------------------------------------

/** Share price numerator: idle lender cash plus principal out on loan. */
export const poolAssets = (p: PoolStats) => p.idle + p.outstanding;

/** Flat 2% fee on the drawn balance, rounded up. */
export const feeFor = (drawn: bigint) => (drawn * 2n + 99n) / 100n;
/** What repay needs: principal plus fee. */
export const payoffFor = (drawn: bigint) => drawn + feeFor(drawn);
/** First-loss deposit: 20% of the total balance after a draw, rounded up. */
export const depositNeededFor = (totalBalance: bigint) => (totalBalance + 4n) / 5n;

/** Shares minted for a deposit (floor), same maths as `deposit`. */
export function sharesForDeposit(amount: bigint, supply: bigint, assets: bigint): bigint {
  if (supply === 0n) return amount;
  if (assets === 0n) return 0n;
  return (amount * supply) / assets;
}
/** USDC paid for burning shares (floor), same maths as `claim_withdraw` (escrowed shares stay in `supply` until then). */
export function usdcForShares(shares: bigint, supply: bigint, assets: bigint): bigint {
  if (supply === 0n) return 0n;
  return (shares * assets) / supply;
}

/** Same test as `mark_default`: a balance is out, a due date is set, and it has passed. */
export function isPastDue(line: Pick<CreditLine, 'drawn' | 'due' | 'defaulted'>, nowSeconds: bigint | number): boolean {
  return !line.defaulted && line.drawn > 0n && line.due > 0n && BigInt(nowSeconds) > line.due;
}

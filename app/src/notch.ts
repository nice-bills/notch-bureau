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
/** Mirrors MIN_LOAN_TERM_S in programs/notch/src/lib.rs: the shortest `draw_with_term` period. */
export const MIN_LOAN_TERM_SECONDS = 10n;
/** Mirrors WITHDRAW_COOLDOWN_S in programs/notch/src/lib.rs. */
export const WITHDRAW_COOLDOWN_SECONDS = 3n * 86_400n;

/** Anchor discriminators: sha256("global:<name>")[0..8]. Verified against node:crypto in the unit test. */
const DISCRIMINATORS = {
  init: 'dc3bcfec6cfa2f64',
  init_pool: '74e9c7cc739fab24',
  set_underwriter: '6449a18380907111',
  post_limit: 'e9a2b88e298351e0',
  deposit: 'f223c68952e1f2b6',
  request_withdraw: '895fbb60fa8a1fb6',
  claim_withdraw: 'e8599a7510ccb6e0',
  cancel_withdraw: '7035e23a9e1e25a8',
  deposit_borrower: 'a0783533ea0296a8',
  withdraw_borrower: 'af42e688c2545ba2',
  draw: '3d283eb81fb01882',
  draw_with_term: '54a098ba60d7b3c1',
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

export type Tranche = 'senior' | 'junior';

export interface NotchAddresses {
  program: Address;
  mint: Address;
  config: Address;
  /** Pool v2 PDAs ("vault-v2", "pool-v2"); the v1 single-token pool is gone (see the tranche block in lib.rs). */
  vault: Address;
  pool: Address;
  seniorMint: Address;
  juniorMint: Address;
  /**
   * The share token the single-tranche UI deposits into: the JUNIOR tranche (the only one that can take the
   * first deposit into an empty pool). Pass an explicit `Tranche` to the builders to use senior.
   */
  shareMint: Address;
}

async function pda(program: Address, ...seeds: Uint8Array[]): Promise<Address> {
  const [addr] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return addr;
}

export async function deriveAddresses(program: Address, mint: Address): Promise<NotchAddresses> {
  const [config, vault, pool, seniorMint, juniorMint] = await Promise.all([
    pda(program, text('config')),
    pda(program, text('vault-v2')),
    pda(program, text('pool-v2')),
    pda(program, text('senior-mint')),
    pda(program, text('junior-mint')),
  ]);
  return { program, mint, config, vault, pool, seniorMint, juniorMint, shareMint: juniorMint };
}

/** Share mint of a tranche. */
export const trancheMint = (a: Pick<NotchAddresses, 'seniorMint' | 'juniorMint'>, t: Tranche): Address =>
  t === 'senior' ? a.seniorMint : a.juniorMint;

export const deriveLine = (program: Address, borrower: Address) =>
  pda(program, text('line'), new Uint8Array(addressEncoder.encode(borrower)));

/** The dedupe hash is bytes 56..88 of the signed record. */
export const deriveDedupe = (program: Address, dedupeHash: Uint8Array) =>
  pda(program, text('dedupe'), dedupeHash);

/** IdentityLink PDA ["identity", id_hash] (bytes 96..128 of the record): one mobile-money account, one wallet. */
export const deriveIdentity = (program: Address, idHash: Uint8Array) =>
  pda(program, text('identity'), idHash);

/** DeviceLink PDA ["device", device_hash] (bytes 128..160 of a v3 record): one Seeker phone, one credit line. */
export const deriveDevice = (program: Address, deviceHash: Uint8Array) =>
  pda(program, text('device'), deviceHash);

/**
 * The lender's share escrow (a token account that owns itself) and pending-withdrawal record, per tranche:
 * ["escrow", share_mint, lender] and ["withdraw", share_mint, lender]. One pending request per lender per tranche.
 */
export async function deriveEscrow(program: Address, lender: Address, tranche: Tranche = 'junior'): Promise<Address> {
  const mint = await pda(program, text(tranche === 'senior' ? 'senior-mint' : 'junior-mint'));
  return pda(program, text('escrow'), new Uint8Array(addressEncoder.encode(mint)), new Uint8Array(addressEncoder.encode(lender)));
}
export async function deriveWithdrawRequest(program: Address, lender: Address, tranche: Tranche = 'junior'): Promise<Address> {
  const mint = await pda(program, text(tranche === 'senior' ? 'senior-mint' : 'junior-mint'));
  return pda(program, text('withdraw'), new Uint8Array(addressEncoder.encode(mint)), new Uint8Array(addressEncoder.encode(lender)));
}

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
// Signed record (128 bytes, or 160 for a Seeker phone). Must match enclave/src/record.js and record.rs.
//   "NOTCHv2\0" | wallet[32] | limit_micro u64 | expiry i64 | dedupe[32] | nonce u64 | id_hash[32]
// id_hash is all zeros when the income source has no bindable identity (see IdentityLink in the program).
//   "NOTCHv3\0" | ...the same 120 bytes... | device_hash[32]   (160 bytes): sha256("notch-sgt"|mint) of the phone's Seeker
// Genesis Token (see DeviceLink). A record without a bound phone is still a plain v2 record.
// ---------------------------------------------------------------------------

export const RECORD_LEN = 128;
export const RECORD_LEN_V3 = 160;
const RECORD_TAG = new Uint8Array([0x4e, 0x4f, 0x54, 0x43, 0x48, 0x76, 0x32, 0x00]);
const RECORD_TAG_V3 = new Uint8Array([0x4e, 0x4f, 0x54, 0x43, 0x48, 0x76, 0x33, 0x00]);
const NO_IDENTITY = new Uint8Array(32);

export interface RecordFields {
  wallet: Address;
  limitMicro: bigint;
  expiry: bigint | number;
  dedupe: Uint8Array;
  nonce: bigint | number;
  /** sha256("notch-msisdn"|number) of the backing mobile-money account; omit (zeros) for none. */
  idHash?: Uint8Array;
  /** sha256("notch-sgt"|mint) of the borrower's Seeker phone; omit (or zeros) for a plain v2 record. */
  deviceHash?: Uint8Array;
}

export function encodeRecord(f: RecordFields): Uint8Array {
  if (f.dedupe.length !== 32) throw new Error('dedupe hash must be 32 bytes');
  const idHash = f.idHash ?? NO_IDENTITY;
  if (idHash.length !== 32) throw new Error('id_hash must be 32 bytes');
  if (f.deviceHash && f.deviceHash.length !== 32) throw new Error('device_hash must be 32 bytes');
  const withDevice = !!f.deviceHash && f.deviceHash.some((b) => b !== 0);
  return concat(
    withDevice ? RECORD_TAG_V3 : RECORD_TAG,
    new Uint8Array(addressEncoder.encode(f.wallet)),
    u64Le(f.limitMicro),
    i64Le(f.expiry),
    f.dedupe,
    u64Le(f.nonce),
    idHash,
    ...(withDevice ? [f.deviceHash as Uint8Array] : []),
  );
}

export function decodeRecord(bytes: Uint8Array): { limitMicro: bigint; expiry: bigint; dedupe: Uint8Array; nonce: bigint; idHash: Uint8Array; deviceHash: Uint8Array } {
  if (bytes.length !== RECORD_LEN && bytes.length !== RECORD_LEN_V3) throw new Error(`record must be ${RECORD_LEN} or ${RECORD_LEN_V3} bytes`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    deviceHash: bytes.length === RECORD_LEN_V3 ? bytes.slice(128, 160) : NO_IDENTITY,
    limitMicro: v.getBigUint64(40, true),
    expiry: v.getBigInt64(48, true),
    dedupe: bytes.slice(56, 88),
    nonce: v.getBigUint64(88, true),
    idHash: bytes.slice(96, 128),
  };
}

/** True when the record carries a mobile-money identity (non-zero id_hash). */
export const hasIdentity = (idHash: Uint8Array) => idHash.some((b) => b !== 0);

/** True when the record carries a Seeker phone (a v3 record with a non-zero device_hash). */
export const hasDevice = (deviceHash: Uint8Array) => deviceHash.some((b) => b !== 0);

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

/** Creates the config only. The lender pool (vault + senior/junior mints) comes from `initPoolIx`. */
export function initIx(
  a: NotchAddresses,
  admin: Address,
  underwriter: Address,
  underwriterExpiry: bigint | number,
): Instruction {
  return ix(
    a.program,
    [meta(admin, WS), meta(a.config, W), meta(a.mint, R), meta(SYSTEM_PROGRAM, R)],
    concat(discriminator('init'), new Uint8Array(addressEncoder.encode(underwriter)), i64Le(underwriterExpiry)),
  );
}

export function u16Le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
export function u32Le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** Defaults used by the demo pools: junior is at least 20% of the pool; a junior dollar counts 2x in the fee split. */
export const DEFAULT_MIN_JUNIOR_BPS = 2000;
export const DEFAULT_JUNIOR_WEIGHT_BPS = 20_000;

/** Admin only, once: create the vault and both share mints and fix the waterfall parameters. */
export function initPoolIx(
  a: NotchAddresses,
  admin: Address,
  minJuniorBps: number = DEFAULT_MIN_JUNIOR_BPS,
  juniorWeightBps: number = DEFAULT_JUNIOR_WEIGHT_BPS,
): Instruction {
  return ix(
    a.program,
    [meta(admin, WS), meta(a.config, R), meta(a.mint, R), meta(a.vault, W), meta(a.pool, W), meta(a.seniorMint, W), meta(a.juniorMint, W), meta(TOKEN_PROGRAM, R), meta(SYSTEM_PROGRAM, R)],
    concat(discriminator('init_pool'), u16Le(minJuniorBps), u32Le(juniorWeightBps)),
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
  /** IdentityLink PDA; needed only when the record has a non-zero id_hash. Omitted => "None" placeholder. */
  identity?: Address;
  /** DeviceLink PDA; needed only when the record is a v3 record (non-zero device_hash). Omitted => "None" placeholder. */
  device?: Address;
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
    [meta(p.payer, WS), meta(p.borrower, R), meta(a.config, R), meta(p.line, W), meta(p.dedupe, W), meta(INSTRUCTIONS_SYSVAR, R), meta(SYSTEM_PROGRAM, R),
      // Optional trailing accounts, in this order: Anchor reads the program's own id as "None". Always send both slots:
      // Anchor errors (AccountNotEnoughKeys) if a trailing optional account is left out entirely.
      p.identity ? meta(p.identity, W) : meta(a.program, R),
      p.device ? meta(p.device, W) : meta(a.program, R)],
    concat(discriminator('post_limit'), vecU8(p.record)),
  );
}

/** Deposit into a tranche (default junior, the entry tranche). `shareAccount` must hold that tranche's share mint. */
export function depositIx(a: NotchAddresses, lender: Address, from: Address, shareAccount: Address, amount: bigint | number, tranche: Tranche = 'junior'): Instruction {
  return ix(
    a.program,
    [meta(lender, RS), meta(a.config, R), meta(a.pool, W), meta(a.mint, R), meta(from, W), meta(a.vault, W), meta(trancheMint(a, tranche), W), meta(shareAccount, W), meta(TOKEN_PROGRAM, R)],
    concat(discriminator('deposit'), u64Le(amount)),
  );
}

/**
 * Step 1 of leaving a tranche: shares move into escrow, the cooldown starts. The lender pays rent for
 * the escrow and request accounts (refunded on claim or cancel). One pending request per lender per tranche.
 */
export function requestWithdrawIx(
  a: NotchAddresses,
  lender: Address,
  shareAccount: Address,
  escrow: Address,
  request: Address,
  shares: bigint | number,
  tranche: Tranche = 'junior',
): Instruction {
  return ix(
    a.program,
    [meta(lender, WS), meta(a.pool, R), meta(trancheMint(a, tranche), R), meta(shareAccount, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM, R), meta(SYSTEM_PROGRAM, R)],
    concat(discriminator('request_withdraw'), u64Le(shares)),
  );
}

/** Step 2, after `unlock_ts`: burns the escrowed shares and pays USDC at that tranche's share price of that moment. */
export function claimWithdrawIx(a: NotchAddresses, lender: Address, escrow: Address, request: Address, to: Address, tranche: Tranche = 'junior'): Instruction {
  return ix(
    a.program,
    [meta(lender, WS), meta(a.config, R), meta(a.mint, R), meta(a.pool, W), meta(a.vault, W), meta(trancheMint(a, tranche), W), meta(escrow, W), meta(request, W), meta(to, W), meta(TOKEN_PROGRAM, R)],
    discriminator('claim_withdraw'),
  );
}

/** Give the escrowed shares back to the lender (any time, before or after the cooldown), minus any gain made while in escrow (burned: the share mint is writable). */
export function cancelWithdrawIx(a: NotchAddresses, lender: Address, shareAccount: Address, escrow: Address, request: Address, tranche: Tranche = 'junior'): Instruction {
  return ix(
    a.program,
    [meta(lender, WS), meta(a.pool, R), meta(trancheMint(a, tranche), W), meta(shareAccount, W), meta(escrow, W), meta(request, W), meta(TOKEN_PROGRAM, R)],
    discriminator('cancel_withdraw'),
  );
}

export function depositBorrowerIx(a: NotchAddresses, borrower: Address, line: Address, from: Address, amount: bigint | number): Instruction {
  return ix(
    a.program,
    [meta(borrower, RS), meta(a.config, R), meta(a.pool, W), meta(line, W), meta(a.mint, R), meta(from, W), meta(a.vault, W), meta(TOKEN_PROGRAM, R)],
    concat(discriminator('deposit_borrower'), u64Le(amount)),
  );
}

export function withdrawBorrowerIx(a: NotchAddresses, borrower: Address, line: Address, to: Address): Instruction {
  return ix(
    a.program,
    [meta(borrower, RS), meta(a.config, R), meta(a.pool, W), meta(line, W), meta(a.mint, R), meta(a.vault, W), meta(to, W), meta(TOKEN_PROGRAM, R)],
    discriminator('withdraw_borrower'),
  );
}

const drawAccounts = (a: NotchAddresses, borrower: Address, line: Address, to: Address) =>
  [meta(borrower, RS), meta(a.config, R), meta(a.pool, W), meta(line, W), meta(a.mint, R), meta(a.vault, W), meta(to, W), meta(TOKEN_PROGRAM, R)];

export function drawIx(a: NotchAddresses, borrower: Address, line: Address, to: Address, amount: bigint | number): Instruction {
  return ix(a.program, drawAccounts(a, borrower, line, to), concat(discriminator('draw'), u64Le(amount)));
}

/**
 * Like `drawIx` but with a shorter due period (10 s ..= 30 days), set on the first draw of a loan only.
 * Only ever worse for the borrower; used to force a default on devnet and in tests.
 */
export function drawWithTermIx(a: NotchAddresses, borrower: Address, line: Address, to: Address, amount: bigint | number, termSeconds: bigint | number): Instruction {
  return ix(a.program, drawAccounts(a, borrower, line, to), concat(discriminator('draw_with_term'), u64Le(amount), i64Le(termSeconds)));
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
    [meta(borrower, RS), meta(a.config, R), meta(a.pool, W), meta(line, W), meta(a.mint, R), meta(from, W), meta(a.vault, W), meta(TOKEN_PROGRAM, R), meta(depositReturn, W)],
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
  /** Tracked NAV of each tranche; seniorNav + juniorNav == idle + outstanding. */
  seniorNav: bigint;
  juniorNav: bigint;
  seniorFees: bigint;
  juniorFees: bigint;
  seniorLosses: bigint;
  juniorLosses: bigint;
  /** Junior must stay at least this share of total NAV (bps). */
  minJuniorBps: number;
  /** A junior dollar counts this many bps of a senior dollar in the fee split. */
  juniorWeightBps: number;
}

export const POOL_MIN_LEN = 186;

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
    seniorNav: v.getBigUint64(64, true),
    juniorNav: v.getBigUint64(72, true),
    seniorFees: v.getBigUint64(80, true),
    juniorFees: v.getBigUint64(88, true),
    seniorLosses: v.getBigUint64(96, true),
    juniorLosses: v.getBigUint64(104, true),
    minJuniorBps: v.getUint16(112, true),
    juniorWeightBps: v.getUint32(114, true),
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

/** Total pool assets (both tranches): idle lender cash plus principal out on loan. */
export const poolAssets = (p: PoolStats) => p.idle + p.outstanding;
/** Tracked NAV of one tranche: the share price numerator for that tranche's token. */
export const trancheNav = (p: Pick<PoolStats, 'seniorNav' | 'juniorNav'>, t: Tranche) => (t === 'senior' ? p.seniorNav : p.juniorNav);

const BPS = 10_000n;
/**
 * Fee waterfall, mirrors `TranchePool::split_fee`: weighted pro-rata, a junior dollar counts
 * `juniorWeightBps / 10_000` times. Returns [seniorFee, juniorFee]; dust goes to junior; they sum to `fee`.
 */
export function splitFee(fee: bigint, seniorNav: bigint, juniorNav: bigint, juniorWeightBps: number | bigint): [bigint, bigint] {
  const sw = seniorNav * BPS;
  const jw = juniorNav * BigInt(juniorWeightBps);
  if (sw + jw === 0n) throw new Error('pool has no capital');
  const s = (fee * sw) / (sw + jw);
  return [s, fee - s];
}
/** Loss waterfall, mirrors `TranchePool::apply_loss`: junior first, senior only for the rest. Returns [seniorLoss, juniorLoss]. */
export function splitLoss(loss: bigint, seniorNav: bigint, juniorNav: bigint): [bigint, bigint] {
  const j = loss < juniorNav ? loss : juniorNav;
  const s = loss - j;
  if (s > seniorNav) throw new Error('loss exceeds the pool');
  return [s, j];
}
/** Subordination floor, mirrors `junior_ratio_ok`: junior * 10_000 >= minJuniorBps * total. */
export const juniorRatioOk = (junior: bigint, total: bigint, minJuniorBps: number | bigint) => junior * BPS >= BigInt(minJuniorBps) * total;
/** Largest senior deposit the floor allows right now (0 when none). */
export function seniorHeadroom(p: Pick<PoolStats, 'seniorNav' | 'juniorNav' | 'minJuniorBps'>): bigint {
  if (p.minJuniorBps === 0) return BigInt(Number.MAX_SAFE_INTEGER);
  const maxTotal = (p.juniorNav * BPS) / BigInt(p.minJuniorBps);
  const total = p.seniorNav + p.juniorNav;
  return maxTotal > total ? maxTotal - total : 0n;
}

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

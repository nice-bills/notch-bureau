// @notch/bureau: read the Notch credit bureau from any app.
//
// Two ways in:
//   1. getCredit(rpc, wallet)         reads the public credit-line account off chain (free, no transaction).
//   2. buildCheckCreditIx({...})      builds the on-chain `check_credit` instruction: put it in the same
//                                     transaction as your own instruction (or CPI it from your program) and the
//                                     whole transaction fails unless the wallet is good for the amount.
//
// Layout mirrors `CreditLine` in programs/notch/src/lib.rs (Anchor account: 8 byte discriminator, then fields).
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getProgramDerivedAddress,
} from '@solana/kit';

/** The deployed Notch program (devnet). Pass `programAddress` to any function to point at another deployment. */
export const NOTCH_PROGRAM_ADDRESS = address('4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz');

const USDC = 1_000_000n;
/** Coarse buckets of AVAILABLE credit (limit minus drawn), in USDC. Must match `available_bucket` on chain. */
export const BUCKETS = Object.freeze([
  { bucket: 0, label: 'under 25 USDC', min: 0n },
  { bucket: 1, label: '25 to 100 USDC', min: 25n * USDC },
  { bucket: 2, label: '100 to 500 USDC', min: 100n * USDC },
  { bucket: 3, label: '500 USDC or more', min: 500n * USDC },
]);

/** Same rule as the program: bucket of an amount in base units (6 decimals). */
export function availableBucket(available) {
  const a = BigInt(available);
  let b = 0;
  for (const x of BUCKETS) if (a >= x.min) b = x.bucket;
  return b;
}

// check_credit discriminator: sha256("global:check_credit")[0..8]
const CHECK_CREDIT_DISC = Uint8Array.from([0x0f, 0x8e, 0x3c, 0x95, 0x13, 0xd1, 0xb7, 0x86]);

const enc = getAddressEncoder();
const dec = getAddressDecoder();

/** PDA of a wallet's credit line: ["line", wallet]. It exists once any signed record was posted for the wallet. */
export async function findCreditLineAddress(wallet, programAddress = NOTCH_PROGRAM_ADDRESS) {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [new TextEncoder().encode('line'), enc.encode(address(wallet))],
  });
  return pda;
}

/** Decode raw `CreditLine` account bytes. Returns null if they are too short to be one. */
export function decodeCreditLine(bytes) {
  if (bytes.length < 98) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    wallet: dec.decode(bytes.subarray(8, 40)),
    limit: v.getBigUint64(40, true),
    expiry: v.getBigInt64(48, true),
    drawn: v.getBigUint64(56, true),
    due: v.getBigInt64(64, true),
    repaidOnTime: v.getUint32(72, true),
    repaidLate: v.getUint32(76, true),
    defaulted: bytes[88] === 1,
    deposit: v.getBigUint64(90, true),
    // Added with check_credit; absent (0) on lines written by the older program.
    postedAt: bytes.length >= 106 ? v.getBigInt64(98, true) : 0n,
  };
}

/**
 * Read a wallet's bureau entry. Never throws for "no line": it returns `{ exists: false }`.
 *
 * @param rpc  a @solana/kit rpc (createSolanaRpc(...))
 * @param wallet the wallet address
 * @returns {{exists:false} | {exists:true, wallet, availableBucket, availableBucketLabel, onTimeRepayments,
 *   defaulted, expiresAt, postedAt, expired, overdue, active}} `expiresAt`/`postedAt` are unix seconds. `active` is true when a
 *   `check_credit` with min_available 0 and a long max_age would pass right now.
 */
export async function getCredit(rpc, wallet, { programAddress = NOTCH_PROGRAM_ADDRESS, nowSeconds } = {}) {
  const line = await findCreditLineAddress(wallet, programAddress);
  const { value } = await rpc.getAccountInfo(line, { encoding: 'base64' }).send();
  if (!value || value.owner !== programAddress) return { exists: false };
  const bytes = Uint8Array.from(getBase64Encoder().encode(value.data[0]));
  const c = decodeCreditLine(bytes);
  if (!c) return { exists: false };
  const now = BigInt(nowSeconds ?? Math.floor(Date.now() / 1000));
  const available = c.limit > c.drawn ? c.limit - c.drawn : 0n;
  const bucket = availableBucket(available);
  const expired = now >= c.expiry;
  // a loan past its due date and unpaid: check_credit fails LoanOverdue even before the keeper marks the default
  const overdue = c.drawn > 0n && now > c.due;
  return {
    exists: true,
    wallet: c.wallet,
    availableBucket: bucket,
    availableBucketLabel: BUCKETS[bucket].label,
    onTimeRepayments: c.repaidOnTime,
    defaulted: c.defaulted,
    expiresAt: Number(c.expiry),
    postedAt: Number(c.postedAt),
    expired,
    overdue,
    active: !c.defaulted && !expired && !overdue,
  };
}

/**
 * Build the on-chain check. Add it to your transaction before your own instruction: if the wallet has no line, is
 * defaulted, has an expired or too-old record, or has less than `minAvailable` left, the whole transaction fails.
 * Programs call the same instruction by CPI (see the README).
 *
 * @param {{wallet: string, minAvailable: bigint|number, maxAgeSeconds: bigint|number, programAddress?: string}} args
 *   `minAvailable` is in base units (USDC has 6 decimals). `maxAgeSeconds` is how old the signed record may be.
 */
export async function buildCheckCreditIx({ wallet, minAvailable, maxAgeSeconds, programAddress = NOTCH_PROGRAM_ADDRESS }) {
  const data = new Uint8Array(8 + 8 + 8);
  data.set(CHECK_CREDIT_DISC, 0);
  const v = new DataView(data.buffer);
  v.setBigUint64(8, BigInt(minAvailable), true);
  v.setBigInt64(16, BigInt(maxAgeSeconds), true);
  return {
    programAddress,
    accounts: [
      { address: address(wallet), role: AccountRole.READONLY },
      { address: await findCreditLineAddress(wallet, programAddress), role: AccountRole.READONLY },
    ],
    data,
  };
}

/** Decode the 38 byte return data of `check_credit` (borsh: wallet, bucket u8, on_time u32, defaulted bool). */
export function decodeCreditCheck(bytes) {
  const b = Uint8Array.from(bytes);
  if (b.length !== 38) throw new Error(`check_credit return data must be 38 bytes, got ${b.length}`);
  const v = new DataView(b.buffer);
  return {
    wallet: dec.decode(b.subarray(0, 32)),
    availableBucket: b[32],
    availableBucketLabel: BUCKETS[b[32]]?.label,
    onTimeRepayments: v.getUint32(33, true),
    defaulted: b[37] === 1,
  };
}

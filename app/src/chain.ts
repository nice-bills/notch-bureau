import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import { RPC_URL, PROGRAM_ID, USDC_MINT } from './config';
import { TxError } from './errors';
import {
  base64ToBytes,
  decodeLine,
  decodeMintSupply,
  decodePool,
  decodeTokenAmount,
  decodeWithdrawRequest,
  deriveAddresses,
  deriveAta,
  deriveLine,
  deriveWithdrawRequest,
  type CreditLine,
  type NotchAddresses,
  type PoolStats,
  type Tranche,
  type WithdrawRequest,
} from './notch';

export const rpc = createSolanaRpc(RPC_URL);

let addrPromise: Promise<NotchAddresses> | null = null;
/** Program-derived addresses for the configured program and mint. */
export function notchAddresses(): Promise<NotchAddresses> {
  if (!USDC_MINT) return Promise.reject(new Error('VITE_USDC_MINT is not set. Run scripts/devnet-setup.mjs and copy the printed env values.'));
  addrPromise ??= deriveAddresses(PROGRAM_ID, USDC_MINT);
  return addrPromise;
}

async function accountBytes(addr: Address): Promise<Uint8Array | null> {
  const res = await rpc.getAccountInfo(addr, { encoding: 'base64', commitment: 'confirmed' }).send();
  if (!res.value) return null;
  return base64ToBytes(res.value.data[0] as string);
}

export interface PoolView {
  stats: PoolStats;
  /** Supply of the share token the single-tranche UI uses (JUNIOR). */
  shareSupply: bigint;
  seniorSupply: bigint;
  juniorSupply: bigint;
  vaultBalance: bigint;
  underwriter: Address | null;
  underwriterExpiry: bigint | null;
}

/** Read pool accounting, share supply and config. Returns null if the program has not been initialised. */
export async function fetchPool(): Promise<PoolView | null> {
  const a = await notchAddresses();
  const [pool, shareMint, seniorMint, vault, config] = await Promise.all([
    accountBytes(a.pool),
    accountBytes(a.shareMint),
    accountBytes(a.seniorMint),
    accountBytes(a.vault),
    accountBytes(a.config),
  ]);
  if (!pool || !shareMint || !seniorMint) return null;
  let underwriter: Address | null = null;
  let underwriterExpiry: bigint | null = null;
  if (config && config.length >= 112) {
    underwriter = getAddressDecoder().decode(config.subarray(72, 104));
    underwriterExpiry = new DataView(config.buffer, config.byteOffset).getBigInt64(104, true);
  }
  return {
    stats: decodePool(pool),
    shareSupply: decodeMintSupply(shareMint),
    seniorSupply: decodeMintSupply(seniorMint),
    juniorSupply: decodeMintSupply(shareMint),
    vaultBalance: vault ? decodeTokenAmount(vault) : 0n,
    underwriter,
    underwriterExpiry,
  };
}

export async function fetchLine(borrower: Address): Promise<CreditLine | null> {
  const a = await notchAddresses();
  const bytes = await accountBytes(await deriveLine(a.program, borrower));
  return bytes ? decodeLine(bytes) : null;
}

/** The lender's pending withdrawal, or null when there is none. */
export async function fetchWithdrawRequest(lender: Address, tranche: Tranche = 'junior'): Promise<WithdrawRequest | null> {
  const a = await notchAddresses();
  const bytes = await accountBytes(await deriveWithdrawRequest(a.program, lender, tranche));
  return bytes ? decodeWithdrawRequest(bytes) : null;
}

export async function fetchTokenBalance(owner: Address, mint: Address): Promise<bigint> {
  const bytes = await accountBytes(await deriveAta(owner, mint));
  return bytes ? decodeTokenAmount(bytes) : 0n;
}

export async function accountExists(addr: Address): Promise<boolean> {
  return (await accountBytes(addr)) !== null;
}

export async function fetchSol(addr: Address): Promise<bigint> {
  const r = await rpc.getBalance(addr, { commitment: 'confirmed' }).send();
  return r.value;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

async function compile(feePayer: Address, ixs: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return { tx: compileTransaction(msg), blockhash };
}

export interface SimResult {
  ok: boolean;
  /** Raw program logs, exactly as the network returned them. */
  logs: string[];
  err: string | null;
}

/** Dry-run without a signature and without spending anything. Used for pre-flight and the attack demo. */
export async function simulate(feePayer: Address, ixs: Instruction[]): Promise<SimResult> {
  const { tx } = await compile(feePayer, ixs);
  const wire = getBase64EncodedWireTransaction(tx);
  const res = await rpc
    .simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
    .send();
  const err = res.value.err ? JSON.stringify(res.value.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : null;
  return { ok: !err, logs: [...(res.value.logs ?? [])], err };
}

export interface SendOutcome {
  signature: string;
}

/**
 * Simulate first (so a bad tx fails with a readable error before the wallet pops up),
 * then ask the wallet to sign, send, and wait for confirmation.
 */
export async function sendTransaction(
  feePayer: Address,
  ixs: Instruction[],
  sign: (wire: Uint8Array, meta?: { lastValidBlockHeight: bigint }) => Promise<Uint8Array>,
): Promise<SendOutcome> {
  await assertCanPayFees(feePayer);
  const sim = await simulate(feePayer, ixs);
  if (!sim.ok) throw new TxError(sim.err ?? 'simulation failed', sim.logs);

  const { tx, blockhash } = await compile(feePayer, ixs);
  const wire = new Uint8Array(getTransactionEncoder().encode(tx));
  const signed = await sign(wire, { lastValidBlockHeight: blockhash.lastValidBlockHeight });
  return submitSigned(signed, blockhash.lastValidBlockHeight);
}

/** A fee payer with no SOL fails simulation with an unhelpful "account not found"; say it in plain words first. */
export const MIN_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL: a fee plus some rent; less than that and nothing here can go through
export class NoSolError extends Error {
  constructor(public lamports: bigint) { super(`NoSolForFees: the wallet holds ${lamports} lamports, needs at least ${MIN_FEE_LAMPORTS}`); }
}
async function assertCanPayFees(feePayer: Address) {
  const bal = await fetchSol(feePayer).catch(() => null);
  if (bal !== null && bal < MIN_FEE_LAMPORTS) throw new NoSolError(bal);
}

/** Send already-signed wire bytes and wait for confirmation (also used after a Phantom deeplink round trip). */
export async function submitSigned(signed: Uint8Array, lastValidBlockHeight: bigint): Promise<SendOutcome> {
  const b64 = btoa(Array.from(signed, (b) => String.fromCharCode(b)).join(''));
  const signature = await rpc.sendTransaction(b64 as never, { encoding: 'base64', skipPreflight: true }).send();
  const blockhash = { lastValidBlockHeight };

  const deadline = Date.now() + 60_000;
  for (;;) {
    const st = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: false }).send();
    const s = st.value[0];
    if (s?.err) {
      const logs = await fetchLogs(signature);
      throw new TxError(JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), logs);
    }
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { signature };
    const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
    if (height > blockhash.lastValidBlockHeight || Date.now() > deadline) {
      throw new TxError('The transaction was not confirmed in time. It may still land; check the explorer before retrying.');
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function fetchLogs(signature: string): Promise<string[]> {
  try {
    const t = await rpc.getTransaction(signature as never, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }).send();
    return [...(t?.meta?.logMessages ?? [])];
  } catch {
    return [];
  }
}

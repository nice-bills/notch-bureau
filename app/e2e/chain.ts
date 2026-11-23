// Node-side devnet helpers: funding test wallets from the admin key, minting test USDC, reading on-chain
// state with the same decoders the app uses, and sweeping leftover SOL back. Devnet only.
import fs from 'node:fs';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getMintToInstruction } from '@solana-program/token';
import {
  base64ToBytes,
  createAtaIdempotentIx,
  decodeLine,
  decodeMintSupply,
  decodePool,
  decodeTokenAmount,
  decodeWithdrawRequest,
  deriveAddresses,
  deriveAta,
  deriveEscrow,
  deriveLine,
  deriveWithdrawRequest,
  type CreditLine,
  type NotchAddresses,
  type PoolStats,
  type WithdrawRequest,
} from '../src/notch.ts';
import { ADMIN_KEYPAIR, DEVNET_GENESIS, PROGRAM_ID, RPC_URL, USDC_MINT } from './env.ts';

export const rpc = createSolanaRpc(RPC_URL);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public devnet RPC rate-limits. Retry reads with backoff. */
export async function call<T>(req: { send: () => Promise<T> }): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 24; i++) {
    try { return await req.send(); } catch (e) {
      last = e;
      const m = String((e as Error)?.message ?? e) + String(((e as Error)?.cause as Error | undefined)?.message ?? '');
      if (!/429|too many|fetch failed|timed out|ECONNRESET|503|502/i.test(m)) throw e;
      await sleep(Math.min(800 * (i + 1), 5000));
    }
  }
  throw last;
}

/** Raw JSON-RPC with the same retry (used by the test wallet's signAndSendTransaction). */
export async function rpcSend(method: string, params: unknown[]): Promise<unknown> {
  for (let i = 0; i < 24; i++) {
    const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429 || r.status >= 500) { await sleep(Math.min(800 * (i + 1), 5000)); continue; }
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  throw new Error(`${method}: RPC kept rate-limiting`);
}

export const jsonSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

let ctx: { admin: KeyPairSigner; A: NotchAddresses; program: Address; mint: Address } | null = null;
export async function chainContext() {
  if (ctx) return ctx;
  if (!PROGRAM_ID || !USDC_MINT) throw new Error('VITE_PROGRAM_ID / VITE_USDC_MINT missing (app/.env.local)');
  if (/mainnet/i.test(RPC_URL)) throw new Error('refusing to run against a mainnet RPC URL. Devnet only.');
  const genesis = await call(rpc.getGenesisHash());
  if (genesis !== DEVNET_GENESIS) throw new Error(`this RPC is not devnet (genesis ${genesis}). Refusing to run.`);
  const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(ADMIN_KEYPAIR, 'utf8'))));
  const program = address(PROGRAM_ID);
  const mint = address(USDC_MINT);
  ctx = { admin, program, mint, A: await deriveAddresses(program, mint) };
  return ctx;
}

export async function sendTx(payer: KeyPairSigner, ixs: Instruction[]): Promise<string> {
  const { value: bh } = await call(rpc.getLatestBlockhash({ commitment: 'confirmed' }));
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  const sig = await call(rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight: true }));
  for (let i = 0; i < 90; i++) {
    const st = (await call(rpc.getSignatureStatuses([sig]))).value[0];
    if (st?.err) throw new Error(`transaction failed on chain: ${jsonSafe(st.err)} (${sig})`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await sleep(1000);
  }
  throw new Error(`transaction not confirmed in time (${sig})`);
}

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------
async function accountBytes(addr: Address): Promise<Uint8Array | null> {
  const r = await call(rpc.getAccountInfo(addr, { encoding: 'base64', commitment: 'confirmed' }));
  return r.value ? base64ToBytes(r.value.data[0] as string) : null;
}
export const solBalance = async (a: Address | string) => (await call(rpc.getBalance(address(a), { commitment: 'confirmed' }))).value;
export async function tokenBalance(owner: string, mintAddr?: Address): Promise<bigint> {
  const { mint } = await chainContext();
  const b = await accountBytes(await deriveAta(address(owner), mintAddr ?? mint));
  return b ? decodeTokenAmount(b) : 0n;
}
export async function shareBalance(owner: string): Promise<bigint> {
  const { A } = await chainContext();
  return tokenBalance(owner, A.shareMint);
}
export async function readLine(borrower: string): Promise<CreditLine | null> {
  const { program } = await chainContext();
  const b = await accountBytes(await deriveLine(program, address(borrower)));
  return b ? decodeLine(b) : null;
}
export async function readWithdrawRequest(lender: string): Promise<WithdrawRequest | null> {
  const { program } = await chainContext();
  const b = await accountBytes(await deriveWithdrawRequest(program, address(lender)));
  return b ? decodeWithdrawRequest(b) : null;
}
export async function escrowShares(lender: string): Promise<bigint | null> {
  const { program } = await chainContext();
  const b = await accountBytes(await deriveEscrow(program, address(lender)));
  return b ? decodeTokenAmount(b) : null;
}
export interface PoolSnapshot { stats: PoolStats; shareSupply: bigint; vault: bigint }
export async function readPool(): Promise<PoolSnapshot> {
  const { A } = await chainContext();
  const p = await accountBytes(A.pool);
  const s = await accountBytes(A.shareMint);
  const v = await accountBytes(A.vault);
  if (!p || !s) throw new Error('pool is not initialised on this network');
  return { stats: decodePool(p), shareSupply: decodeMintSupply(s), vault: v ? decodeTokenAmount(v) : 0n };
}
export async function readUnderwriter(): Promise<string> {
  const { A } = await chainContext();
  const c = await accountBytes(A.config);
  if (!c) throw new Error('program is not initialised on this network (no config account)');
  const { getAddressDecoder } = await import('@solana/kit');
  return getAddressDecoder().decode(c.subarray(72, 104));
}

/** Poll until `read` satisfies `ok` (devnet reads can lag the confirmation the browser saw by a moment). */
export async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 45_000): Promise<T> {
  const t0 = Date.now();
  let v = await read();
  while (!ok(v)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for on-chain state: ${what} (last: ${jsonSafe(v)})`);
    await sleep(1500);
    v = await read();
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// funding + sweeping
// ---------------------------------------------------------------------------------------------
export const USDC_UNIT = 1_000_000n;

/** Give a throwaway wallet SOL and test USDC (the admin key is the mint authority). */
export async function fund(wallet: { address: string }, solLamports: bigint, usdcMicro: bigint): Promise<void> {
  const { admin, mint } = await chainContext();
  const owner = address(wallet.address);
  const ata = await deriveAta(owner, mint);
  const ixs: Instruction[] = [getTransferSolInstruction({ source: admin, destination: owner, amount: lamports(solLamports) })];
  if (usdcMicro > 0n) {
    ixs.push(createAtaIdempotentIx(admin.address, ata, owner, mint), getMintToInstruction({ mint, token: ata, mintAuthority: admin, amount: usdcMicro }));
  }
  await sendTx(admin, ixs);
}

/** Send all but the fee back to the admin wallet. The rent locked in token accounts stays on devnet. */
export async function sweep(signer: KeyPairSigner): Promise<bigint> {
  const { admin } = await chainContext();
  const bal = await solBalance(signer.address);
  if (bal <= 10_000n) return 0n;
  await sendTx(signer, [getTransferSolInstruction({ source: signer, destination: admin.address, amount: lamports(bal - 5_000n) })]);
  return bal - 5_000n;
}

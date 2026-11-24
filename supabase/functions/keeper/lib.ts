// The keeper's logic, runnable in Deno (the Edge Function) and in Node (the tests). It does what
// app/scripts/keeper.mjs does: find credit lines that are past due with a balance, send `mark_default` on each.
// `mark_default` is permissionless and pays nothing; the fee payer only pays the network fee.
//
// Self-contained on purpose: a Supabase function is bundled on its own, so it cannot import app/src/notch.ts.
// enclave/test/supabase-keeper.test.js checks every constant and decoder below against app/src/notch.ts and the
// program, so a layout change in the program breaks that test instead of silently breaking the keeper.
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressDecoder,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

export const DEFAULT_PROGRAM_ID = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz'; // the devnet deployment (same default as the enclave)
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const CREDIT_LINE_MIN_LEN = 98;
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
/** Anchor account discriminator of CreditLine: sha256("account:CreditLine")[0..8]. */
export const LINE_DISCRIMINATOR = hex('dce2cd18dc978168');
/** Anchor instruction discriminator of mark_default: sha256("global:mark_default")[0..8]. */
export const MARK_DEFAULT_DISCRIMINATOR = hex('b6e77b8442d0898b');
/** Most lines handled per run; the next hourly run takes the rest. Keeps a run inside the function's time limit. */
export const MAX_SENDS_PER_RUN = 10;

export interface Line { wallet: string; drawn: bigint; due: bigint; defaulted: boolean }
export interface RawAccount { pubkey: string; data: Uint8Array }

/** Same fields and offsets as decodeLine in app/src/notch.ts (8 byte discriminator first). */
export function decodeLine(data: Uint8Array): Line {
  if (data.length < CREDIT_LINE_MIN_LEN) throw new Error('credit line account is too short');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    wallet: getAddressDecoder().decode(data.subarray(8, 40)),
    drawn: v.getBigUint64(56, true),
    due: v.getBigInt64(64, true),
    defaulted: data[88] === 1,
  };
}

/** The program's test for mark_default: a balance out, a due date set, the due date passed, not already defaulted. */
export const isPastDue = (l: Pick<Line, 'drawn' | 'due' | 'defaulted'>, now: bigint | number): boolean =>
  !l.defaulted && l.drawn > 0n && l.due > 0n && BigInt(now) > l.due;

export function selectOverdue(accounts: RawAccount[], now: bigint | number): { pubkey: string; line: Line }[] {
  const out: { pubkey: string; line: Line }[] = [];
  for (const { pubkey, data } of accounts) {
    let line: Line;
    try { line = decodeLine(data); } catch { continue; }
    if (isPastDue(line, now)) out.push({ pubkey, line });
  }
  return out;
}

export async function poolAddress(program: string): Promise<string> {
  const [pool] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [new TextEncoder().encode('pool-v2')] });
  return pool;
}

/** mark_default accounts: [credit line (writable), pool (writable)], data = discriminator. */
export function markDefaultInstruction(program: string, pool: string, line: string) {
  return {
    programAddress: address(program),
    accounts: [{ address: address(line), role: AccountRole.WRITABLE }, { address: address(pool), role: AccountRole.WRITABLE }],
    data: MARK_DEFAULT_DISCRIMINATOR,
  };
}

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bigintJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** Devnet or a local validator only. Never mainnet, by URL or by genesis hash. */
export async function assertDevnet(rpc: any, url: string): Promise<'devnet' | 'localnet'> {
  if (/mainnet/i.test(url)) throw new Error('refusing to run against a mainnet RPC URL. Devnet / local only.');
  const genesis = await rpc.getGenesisHash().send();
  if (genesis === MAINNET_GENESIS) throw new Error('refusing: this RPC is mainnet');
  if (genesis === DEVNET_GENESIS) return 'devnet';
  if (isLocal(url)) return 'localnet';
  throw new Error(`this RPC is not devnet (genesis ${genesis}) and not a local validator. Refusing to run.`);
}

export interface PassResult { cluster: string; linesSeen: number; overdue: number; marked: number; failed: number; signatures: string[]; dryRun: boolean; skipped: number }

/**
 * One keeper pass. `rpc` is a @solana/kit RPC client, `payer` a kit transaction signer (only needed when `send`).
 * `confirmAttempts` x `pollMs` bounds how long we wait for each transaction.
 */
export async function keeperPass(opts: {
  rpc: any; rpcUrl: string; program: string; payer?: any; send: boolean; confirmAttempts?: number; pollMs?: number; log?: (m: string) => void;
}): Promise<PassResult> {
  const { rpc, rpcUrl, program, payer, send } = opts;
  const log = opts.log ?? (() => {});
  const confirmAttempts = opts.confirmAttempts ?? 40;
  const pollMs = opts.pollMs ?? 1000;
  if (send && !payer) throw new Error('send needs a fee payer (KEEPER_KEYPAIR)');
  const cluster = await assertDevnet(rpc, rpcUrl);
  const pool = await poolAddress(program);

  const raw = await rpc.getProgramAccounts(address(program), {
    encoding: 'base64',
    commitment: 'confirmed',
    filters: [
      { dataSize: BigInt(CREDIT_LINE_MIN_LEN) },
      { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(LINE_DISCRIMINATOR), encoding: 'base58' } },
    ],
  }).send();
  const accounts: RawAccount[] = raw.map((a: any) => ({ pubkey: String(a.pubkey), data: Uint8Array.from(atob(a.account.data[0]), (c) => c.charCodeAt(0)) }));
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const chainTime = await rpc.getBlockTime(slot).send().catch(() => null);
  const now = chainTime !== null && chainTime !== undefined ? BigInt(chainTime) : BigInt(Math.floor(Date.now() / 1000));
  const overdue = selectOverdue(accounts, now);
  log(`${accounts.length} credit line(s), ${overdue.length} overdue and not yet marked`);

  const out: PassResult = { cluster, linesSeen: accounts.length, overdue: overdue.length, marked: 0, failed: 0, signatures: [], dryRun: !send, skipped: 0 };
  if (!send) return out;

  for (const { pubkey } of overdue.slice(0, MAX_SENDS_PER_RUN)) {
    try {
      const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const tx = await pipe(
        createTransactionMessage({ version: 0 }),
        (m: any) => setTransactionMessageFeePayerSigner(payer, m),
        (m: any) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
        (m: any) => appendTransactionMessageInstructions([markDefaultInstruction(program, pool, pubkey)], m),
        (m: any) => signTransactionMessageWithSigners(m),
      );
      const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
      let confirmed = false;
      for (let i = 0; i < confirmAttempts && !confirmed; i++) {
        const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
        if (st?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(st.err, bigintJson)}`);
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) confirmed = true;
        else await sleep(pollMs);
      }
      if (!confirmed) throw new Error(`not confirmed in time (${sig})`);
      out.marked++;
      out.signatures.push(String(sig));
      log(`marked ${pubkey} https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (e) {
      out.failed++;
      log(`FAILED ${pubkey}: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
    }
  }
  out.skipped = Math.max(0, overdue.length - MAX_SENDS_PER_RUN);
  return out;
}

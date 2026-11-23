// Small devnet helpers shared by register-underwriter.mjs and enclave/scripts/e2e-phala.mjs.
// Devnet only: the genesis hash is checked before anything is sent. Imports app/src/notch.ts read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { base64ToBytes, deriveAddresses, setUnderwriterIx } from '../../app/src/notch.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const LOCAL_KEY_FILE = process.env.NOTCH_KEY_FILE || path.join(here, '..', '..', '.underwriter-key.json');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jsonSafe = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export async function connect({ rpcUrl, programId, mint, keypair } = {}) {
  const env = { ...readEnvFile(path.join(here, '..', '..', 'app', '.env.local')), ...process.env };
  const opts = {
    rpc: rpcUrl || env.VITE_RPC_URL || 'https://api.devnet.solana.com',
    program: programId || env.VITE_PROGRAM_ID,
    mint: mint || env.VITE_USDC_MINT,
    keypair: keypair || path.join(os.homedir(), '.config/solana/id.json'),
  };
  if (/mainnet/i.test(opts.rpc)) throw new Error('refusing to run against a mainnet RPC URL. Devnet only.');
  if (!opts.program || !opts.mint) throw new Error('VITE_PROGRAM_ID / VITE_USDC_MINT missing (app/.env.local)');
  const rpc = createSolanaRpc(opts.rpc);
  const genesis = await call(rpc.getGenesisHash());
  if (genesis !== DEVNET_GENESIS) throw new Error(`this RPC is not devnet (genesis ${genesis}). Refusing to run.`);
  const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(opts.keypair, 'utf8'))));
  const program = address(opts.program);
  const A = await deriveAddresses(program, address(opts.mint));
  return { rpc, admin, program, mint: address(opts.mint), A, opts };
}

/** Public devnet RPC rate-limits; retry reads with backoff. */
export async function call(req) {
  let last;
  for (let i = 0; i < 8; i++) {
    try { return await req.send(); } catch (e) {
      last = e;
      const m = String(e?.message ?? e) + String(e?.cause?.message ?? '');
      if (!/429|too many|fetch failed|timed out|ECONNRESET|503|502/i.test(m)) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

export async function accountBytes(rpc, addr) {
  const r = await call(rpc.getAccountInfo(addr, { encoding: 'base64', commitment: 'confirmed' }));
  return r.value ? base64ToBytes(r.value.data[0]) : null;
}

/** The underwriter key and expiry currently trusted by the program (Config: disc 8, admin 32, mint 32, underwriter 32, expiry i64). */
export async function readUnderwriter(rpc, A) {
  const c = await accountBytes(rpc, A.config);
  if (!c) throw new Error('program is not initialised on this network (no config account)');
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  return { underwriter: getAddressDecoder().decode(c.subarray(72, 104)), expiry: dv.getBigInt64(104, true), admin: getAddressDecoder().decode(c.subarray(8, 40)) };
}

/** Send a transaction; resolves { sig, err, logs } (skipPreflight so a refused attack still lands and is inspectable). */
export async function send(ctx, label, payer, ixs, { expectFail = false, log = console.log } = {}) {
  const { rpc } = ctx;
  const { value: bh } = await call(rpc.getLatestBlockhash({ commitment: 'confirmed' }));
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  const sig = await call(rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight: true }));
  let status = null;
  for (let i = 0; i < 90; i++) {
    status = (await call(rpc.getSignatureStatuses([sig]))).value[0];
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) break;
    await sleep(1000);
  }
  if (!status || !(status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) throw new Error(`${label}: not confirmed in time (${sig})`);
  const err = status.err ? jsonSafe(status.err) : null;
  let logs = [];
  if (err) {
    for (let i = 0; i < 10 && !logs.length; i++) {
      const t = await call(rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }));
      logs = [...(t?.meta?.logMessages ?? [])];
      if (!logs.length) await sleep(700);
    }
  }
  log(`  tx  ${err ? (expectFail ? 'REFUSED' : 'FAILED') : 'ok    '}  ${label}\n      https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  if (err && !expectFail) throw new Error(`${label} failed on chain: ${err}\n${logs.join('\n')}`);
  return { sig, err, logs };
}

/** Admin-only: make `underwriterPubkey` the key the program trusts for `days` days. */
export async function setUnderwriter(ctx, underwriterPubkey, days = 30, log = console.log) {
  const expiry = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
  return send(ctx, `set_underwriter ${underwriterPubkey}`, ctx.admin, [setUnderwriterIx(ctx.A, ctx.admin.address, address(underwriterPubkey), expiry)], { log });
}

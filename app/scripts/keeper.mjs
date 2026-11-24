#!/usr/bin/env node
// Notch keeper: finds credit lines that are past due with a balance and calls `mark_default` on them.
//
//   node scripts/keeper.mjs                    # DRY RUN (default): lists overdue lines, sends nothing
//   node scripts/keeper.mjs --send             # actually sends mark_default, one transaction per line
//   node scripts/keeper.mjs --send --watch 3600   # repeat every hour (Ctrl-C to stop)
//   pnpm keeper [--send] [--watch <seconds>] [--rpc url] [--program addr] [--keypair path]
//
// Why it exists: a loan is overdue the second after `line.due`, but the loss only reaches the lenders'
// share price once someone calls `mark_default`. `claim_withdraw` pays out at the price at claim time,
// so the 3 day withdrawal cooldown only protects the lenders who stay if a keeper marks defaults inside
// that window. `mark_default` is permissionless and pays nothing: anyone can run this. Run it at least
// every few hours (WITHDRAW_COOLDOWN_S is 3 days, see programs/notch/src/lib.rs).
//
// Config (same as the app): VITE_RPC_URL, VITE_PROGRAM_ID in app/.env.local, or the flags above.
// The fee payer is a plain keypair file (default ~/.config/solana/id.json); a dry run does not need one.
//
// Safety: devnet / local validator ONLY. It refuses mainnet RPC URLs and any non-local RPC whose genesis
// hash is not devnet's. It never sends anything without --send. Needs Node 22.18+ (runs src/notch.ts directly).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { base64ToBytes, decodeLine, deriveAddresses, isPastDue, markDefaultIx } from '../src/notch.ts';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const here = path.dirname(fileURLToPath(import.meta.url));
/** Anchor account discriminator for CreditLine: sha256("account:CreditLine")[0..8]. */
const LINE_DISCRIMINATOR = crypto.createHash('sha256').update('account:CreditLine').digest().subarray(0, 8);

/**
 * The getProgramAccounts filter for credit lines: the Anchor discriminator ONLY, never `dataSize`. The account grew
 * (98 -> 106 -> 154 bytes) and a size filter hid every current line from the keeper (audit finding #1).
 */
export const lineFilters = () => [
  { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(LINE_DISCRIMINATOR), encoding: 'base58' } },
];

/**
 * Pure selection step (unit tested): which of these `{ pubkey, data }` accounts can be marked defaulted at
 * `nowSeconds`? Same test as the program's `mark_default`: balance out, due date set, due date passed, not
 * already defaulted. Accounts that fail to decode are skipped.
 */
export function selectOverdue(accounts, nowSeconds) {
  const out = [];
  for (const { pubkey, data } of accounts) {
    let line;
    try { line = decodeLine(data); } catch { continue; }
    if (isPastDue(line, nowSeconds)) out.push({ pubkey, line });
  }
  return out;
}

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);

async function main() {
  const env = { ...readEnvFile(path.join(here, '..', '.env.local')), ...process.env };
  const opts = {
    rpc: env.VITE_RPC_URL || 'https://api.devnet.solana.com',
    program: env.VITE_PROGRAM_ID,
    keypair: path.join(os.homedir(), '.config/solana/id.json'),
    send: false,
    watch: 0,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
    if (a === '--send') opts.send = true;
    else if (a === '--dry-run') opts.send = false;
    else if (a === '--watch') opts.watch = Number(next());
    else if (a === '--rpc') opts.rpc = next();
    else if (a === '--program') opts.program = next();
    else if (a === '--keypair') opts.keypair = next();
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/keeper.mjs [--send] [--watch seconds] [--rpc url] [--program addr] [--keypair path]\nDry run unless --send. Devnet / local validator only.');
      process.exit(0);
    } else die(`unknown option ${a}`);
  }
  if (!Number.isFinite(opts.watch) || opts.watch < 0) die('--watch needs a number of seconds');
  if (/mainnet/i.test(opts.rpc)) die('refusing to run against a mainnet RPC URL. Devnet / local only.');
  if (!opts.program) die('VITE_PROGRAM_ID missing (app/.env.local) and no --program given');

  const rpc = createSolanaRpc(opts.rpc);
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS && !isLocal(opts.rpc)) die(`this RPC is not devnet (genesis ${genesis}) and not a local validator. Refusing to run.`);

  const program = address(opts.program);
  // Only `program` and `pool` are used by mark_default; the mint does not enter either address.
  const A = await deriveAddresses(program, program);
  let payer = null;
  if (opts.send) {
    if (!fs.existsSync(opts.keypair)) die(`--send needs a fee-payer keypair, not found: ${opts.keypair}`);
    payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(opts.keypair, 'utf8'))));
  }
  console.log(`program ${program}\nrpc     ${opts.rpc}\nmode    ${opts.send ? `SEND (fee payer ${payer.address})` : 'dry run (add --send to mark defaults)'}`);

  const markDefault = async (linePk) => {
    const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = await pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions([markDefaultIx(A, linePk)], m),
      (m) => signTransactionMessageWithSigners(m),
    );
    const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
    for (let i = 0; i < 60; i++) {
      const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
      if (st?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
      await sleep(1000);
    }
    throw new Error(`not confirmed in time (${sig})`);
  };

  const pass = async () => {
    const accounts = (await rpc.getProgramAccounts(program, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: lineFilters(),
    }).send()).map((a) => ({ pubkey: a.pubkey, data: base64ToBytes(a.account.data[0]) }));
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    const chainTime = await rpc.getBlockTime(slot).send().catch(() => null);
    const now = chainTime !== null && chainTime !== undefined ? BigInt(chainTime) : BigInt(Math.floor(Date.now() / 1000));
    const overdue = selectOverdue(accounts, now);
    console.log(`\n[${new Date().toISOString()}] ${accounts.length} credit line(s), ${overdue.length} overdue and not yet marked`);
    let sent = 0;
    for (const { pubkey, line } of overdue) {
      const late = Number(now - line.due);
      const desc = `${pubkey}  borrower ${line.wallet}  drawn ${Number(line.drawn) / 1e6} USDC  ${Math.floor(late / 3600)}h past due`;
      if (!opts.send) { console.log(`  would mark_default  ${desc}`); continue; }
      try {
        const sig = await markDefault(pubkey);
        sent++;
        console.log(`  marked  ${desc}\n          https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      } catch (e) {
        console.log(`  FAILED  ${desc}\n          ${String(e?.message ?? e).split('\n')[0]}`);
      }
    }
    if (opts.send) console.log(`  ${sent}/${overdue.length} marked`);
  };

  await pass();
  while (opts.watch > 0) {
    await sleep(opts.watch * 1000);
    try { await pass(); } catch (e) { console.error(`pass failed: ${String(e?.message ?? e).split('\n')[0]}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(String(e?.message ?? e)));
}

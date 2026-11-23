#!/usr/bin/env node
// One-time devnet setup for the Notch app.
//
//   node scripts/devnet-setup.mjs --enclave-url http://localhost:8787            # dry run (default): prints the plan
//   node scripts/devnet-setup.mjs --enclave-url http://localhost:8787 --send     # actually sends devnet transactions
//
// What it does (with --send):
//   1. creates a TEST USDC mint (6 decimals, your wallet is the mint authority)   [skipped with --mint]
//   2. runs `init` on the Notch program with the underwriter's public key (skipped when the config exists)
//      and `init_pool` (skipped when the v2 tranche pool exists): vault + SENIOR and JUNIOR share mints
//   3. optionally mints test USDC to wallets (--mint-to) and seeds the pool: --seed-pool = JUNIOR tranche,
//      --seed-senior = SENIOR tranche (senior needs enough junior under it: junior >= 20% of the pool)
//   4. prints the VITE_* values for app/.env.local (or writes them with --write-env)
//
// Safety: devnet only. It checks the RPC's genesis hash and refuses anything else. It reads the
// payer key from ~/.config/solana/id.json (override with --keypair). Nothing is sent unless --send.
// Needs Node 22.18+ (it imports ../src/notch.ts directly so the app and script share one set of builders).
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
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getInitializeMint2Instruction, getMintSize, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  createAtaIdempotentIx,
  DEFAULT_JUNIOR_WEIGHT_BPS,
  DEFAULT_MIN_JUNIOR_BPS,
  depositIx,
  deriveAddresses,
  deriveAta,
  initIx,
  initPoolIx,
} from '../src/notch.ts';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEFAULT_PROGRAM = '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz';

function parseArgs(argv) {
  const o = { mintTo: [], enclaveUrl: 'http://localhost:8787', rpc: 'https://api.devnet.solana.com', program: DEFAULT_PROGRAM, expiryDays: 365, keypair: path.join(os.homedir(), '.config/solana/id.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    if (a === '--send') o.send = true;
    else if (a === '--write-env') o.writeEnv = true;
    else if (a === '--rpc') o.rpc = next();
    else if (a === '--program') o.program = next();
    else if (a === '--keypair') o.keypair = next();
    else if (a === '--enclave-url') o.enclaveUrl = next();
    else if (a === '--underwriter') o.underwriter = next();
    else if (a === '--expiry-days') o.expiryDays = Number(next());
    else if (a === '--mint') o.mint = next();
    else if (a === '--mint-to') o.mintTo.push(next());
    else if (a === '--seed-pool') o.seedPool = next();
    else if (a === '--seed-senior') o.seedSenior = next();
    else if (a === '--min-junior-bps') o.minJuniorBps = Number(next());
    else if (a === '--junior-weight-bps') o.juniorWeightBps = Number(next());
    else if (a === '-h' || a === '--help') { help(); process.exit(0); }
    else fail(`unknown option ${a}`);
  }
  return o;
}

function help() {
  console.log(`Usage: node scripts/devnet-setup.mjs [options]
  --send                 actually send devnet transactions (default is a dry run)
  --enclave-url <url>    read the underwriter key from <url>/attestation (default http://localhost:8787)
  --underwriter <pubkey> use this underwriter key instead of asking the enclave
  --expiry-days <n>      how long the program trusts the underwriter key (default 365)
  --mint <address>       use an existing test USDC mint (you must be its mint authority to use --mint-to/--seed-pool)
  --mint-to <addr[:usdc]> mint test USDC to a wallet (repeatable; default 100 USDC)
  --seed-pool <usdc>     deposit this much test USDC into the JUNIOR tranche from your wallet
  --seed-senior <usdc>   deposit this much test USDC into the SENIOR tranche (junior must be >= the floor first)
  --min-junior-bps <n>   pool creation only: junior floor in bps of the pool (default ${DEFAULT_MIN_JUNIOR_BPS} = 20%)
  --junior-weight-bps <n> pool creation only: how many bps a junior dollar counts in the fee split (default ${DEFAULT_JUNIOR_WEIGHT_BPS} = 2x)
  --program <address>    program id (default ${DEFAULT_PROGRAM})
  --rpc <url>            devnet RPC (default https://api.devnet.solana.com)
  --keypair <path>       payer/admin keypair (default ~/.config/solana/id.json)
  --write-env            write the env values to app/.env.local`);
}
function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

const toMicro = (s) => {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) fail(`bad USDC amount "${s}"`);
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, '0'));
};

const opts = parseArgs(process.argv.slice(2));
const dry = !opts.send;
if (/mainnet/i.test(opts.rpc)) fail('refusing to run against a mainnet RPC URL. This script is devnet only.');
// A local solana-test-validator (the browser e2e harness starts one) is allowed too: any chain on localhost
// whose genesis is not mainnet's. Everything else must be devnet.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(opts.rpc);
const rpc = createSolanaRpc(opts.rpc);

// --- load key + guard network -------------------------------------------------------------
let payer;
try {
  payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(opts.keypair, 'utf8'))));
} catch (e) { fail(`could not read keypair ${opts.keypair}: ${e.message}`); }
console.log(`wallet      ${payer.address}`);

if (!dry) {
  const genesis = await rpc.getGenesisHash().send();
  if (LOCAL ? genesis === MAINNET_GENESIS : genesis !== DEVNET_GENESIS) fail(`this RPC is not ${LOCAL ? 'a local test validator' : 'devnet'} (genesis ${genesis}). Refusing to send.`);
  const bal = await rpc.getBalance(payer.address).send();
  console.log(`balance     ${Number(bal.value) / 1e9} SOL (${LOCAL ? 'local test validator' : 'devnet'})`);
  if (bal.value < 100_000_000n) fail(LOCAL ? 'wallet needs at least 0.1 SOL on the local validator.' : 'wallet needs at least 0.1 devnet SOL. Run: solana airdrop 2 --url devnet');
}

// --- underwriter key ---------------------------------------------------------------------
let underwriter = opts.underwriter;
if (!underwriter) {
  try {
    const r = await fetch(`${opts.enclaveUrl.replace(/\/$/, '')}/attestation`);
    underwriter = (await r.json()).underwriter;
  } catch { fail(`could not reach the underwriter at ${opts.enclaveUrl}. Start it (cd ../enclave && pnpm start) or pass --underwriter <pubkey>.`); }
}
try { address(underwriter); } catch { fail(`"${underwriter}" is not a valid address`); }
console.log(`underwriter ${underwriter}`);

const program = address(opts.program);

async function send(label, ixs, extraSigners = []) {
  void extraSigners;
  if (dry) { console.log(`[dry run] would send: ${label}`); return null; }
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' }).send();
  for (let i = 0; i < 60; i++) {
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) fail(`${label} failed on chain: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n  signature ${sig}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { console.log(`ok          ${label}  ${sig}`); return sig; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label}: not confirmed after 60s (signature ${sig})`);
}

// --- 1. test USDC mint --------------------------------------------------------------------
let mint = opts.mint ? address(opts.mint) : null;
if (!mint) {
  const kp = await generateKeyPairSigner();
  mint = kp.address;
  const space = BigInt(getMintSize());
  const rent = dry ? 0n : await rpc.getMinimumBalanceForRentExemption(space).send();
  await send('create test USDC mint (6 decimals)', [
    getCreateAccountInstruction({ payer, newAccount: kp, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: kp.address, decimals: 6, mintAuthority: payer.address }),
  ]);
}
console.log(`test USDC   ${mint}`);

// --- 2. init -----------------------------------------------------------------------------
const addrs = await deriveAddresses(program, mint);
const existing = dry ? { value: null } : await rpc.getAccountInfo(addrs.config, { encoding: 'base64' }).send();
if (existing.value) {
  console.log('init        skipped: this program is already initialised (config account exists).');
  console.log('            To change the underwriter key later, call set_underwriter as the admin.');
} else {
  const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.round(opts.expiryDays * 86400));
  await send(`init (underwriter trusted for ${opts.expiryDays} days)`, [initIx(addrs, payer.address, address(underwriter), expiry)]);
}

// --- 2b. tranche pool (v2): vault + senior/junior share mints + waterfall parameters ----------------
const poolInfo = dry ? { value: null } : await rpc.getAccountInfo(addrs.pool, { encoding: 'base64' }).send();
if (poolInfo.value) {
  console.log('init_pool   skipped: the tranche pool already exists (its parameters are fixed at creation).');
} else {
  const minJ = opts.minJuniorBps ?? DEFAULT_MIN_JUNIOR_BPS;
  const wJ = opts.juniorWeightBps ?? DEFAULT_JUNIOR_WEIGHT_BPS;
  await send(`init_pool (junior floor ${minJ / 100}%, junior counts ${wJ / 10_000}x in the fee split)`, [initPoolIx(addrs, payer.address, minJ, wJ)]);
}

// --- 3. optional: fund wallets, seed pool -------------------------------------------------
const mintAmount = async (owner, amount, label) => {
  const ata = await deriveAta(owner, mint);
  await send(`mint ${label} test USDC to ${owner}`, [
    createAtaIdempotentIx(payer.address, ata, owner, mint),
    getMintToInstruction({ mint, token: ata, mintAuthority: payer, amount }),
  ]);
};
for (const spec of opts.mintTo) {
  const [who, amt = '100'] = spec.split(':');
  try { address(who); } catch { fail(`--mint-to: "${who}" is not a valid address`); }
  await mintAmount(address(who), toMicro(amt), amt);
}
const seedTranche = async (usdc, tranche) => {
  const amount = toMicro(usdc);
  const mintAddr = tranche === 'senior' ? addrs.seniorMint : addrs.juniorMint;
  const usdcAta = await deriveAta(payer.address, mint);
  const shareAta = await deriveAta(payer.address, mintAddr);
  await mintAmount(payer.address, amount, usdc);
  await send(`seed ${tranche.toUpperCase()} tranche with ${usdc} USDC`, [
    createAtaIdempotentIx(payer.address, shareAta, payer.address, mintAddr),
    depositIx(addrs, payer.address, usdcAta, shareAta, amount, tranche),
  ]);
};
if (opts.seedPool) await seedTranche(opts.seedPool, 'junior');
if (opts.seedSenior) await seedTranche(opts.seedSenior, 'senior');

// --- 4. env ------------------------------------------------------------------------------
const env = [
  `VITE_RPC_URL=${opts.rpc}`,
  `VITE_PROGRAM_ID=${program}`,
  `VITE_USDC_MINT=${mint}`,
  `VITE_ENCLAVE_URL=${opts.enclaveUrl}`,
].join('\n');
console.log(`\n${dry ? '# DRY RUN: nothing was sent. The mint below is a placeholder.\n' : ''}# app/.env.local\n${env}\n`);
if (opts.writeEnv && !dry) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
  fs.writeFileSync(file, `${env}\n`);
  console.log(`wrote ${file}`);
}

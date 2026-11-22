#!/usr/bin/env node
import crypto from 'node:crypto';
// Full end-to-end run of Notch on Solana DEVNET with fresh wallets. Real transactions, test money only.
//
//   pnpm e2e:devnet                 # reads app/.env.local, admin key ~/.config/solana/id.json
//   pnpm e2e:devnet --no-sweep      # keep the leftover SOL in the throwaway wallets
//
// What it does:
//   1  funds a fresh borrower with SOL (from the admin wallet) and test USDC (admin is the mint authority)
//   2  sends a DKIM-signed demo .eml to the underwriter over HTTP and gets a signed record back
//   3  posts the record (Ed25519 verify ix + post_limit) and reads the CreditLine back
//   4  deposit 20% -> draw -> repay principal + 2% fee -> deposit comes back, on-time counter +1 -> withdraw_borrower
//   5  a second fresh wallet lends; share maths is checked against PoolStats. It then requests a withdrawal
//      (shares go to escrow, still counted in supply), an early claim is refused (CooldownActive), and cancel
//      returns the shares. The claim payout itself needs a 3 day wait, so it is covered by the LiteSVM tests.
//   6  on-chain attacks, each must fail with the exact program error
//   7  underwriter attacks: edited email (DKIM) and the same email twice
//   8  the underwriter's reply contains only ok, extraction, limitUsdc, expiry, nonce, message, signature
//
// The underwriter runs inside this process (same Underwriter class and same key file as the demo
// enclave on :8787) because only the process that holds the synthetic DKIM key can sign fresh emails.
// The demo enclave on :8787 is untouched; its /attestation key is compared with the one used here.
//
// Safety: devnet only (genesis hash is checked, mainnet RPC URLs are refused). Needs Node 22.18+.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getMintToInstruction } from '@solana-program/token';
import {
  base64ToBytes,
  cancelWithdrawIx,
  claimWithdrawIx,
  createAtaIdempotentIx,
  decodeLine,
  decodeMintSupply,
  decodePool,
  decodeRecord,
  decodeTokenAmount,
  decodeWithdrawRequest,
  depositBorrowerIx,
  depositIx,
  deriveAddresses,
  deriveAta,
  deriveDedupe,
  deriveEscrow,
  deriveLine,
  deriveWithdrawRequest,
  drawIx,
  WITHDRAW_COOLDOWN_SECONDS,
  ed25519VerifyIx,
  feeFor,
  payoffFor,
  depositNeededFor,
  poolAssets,
  postLimitIx,
  markDefaultIx,
  postLimitIxs,
  repayIx,
  requestWithdrawIx,
  sharesForDeposit,
  withdrawBorrowerIx,
} from '../src/notch.ts';
import { fixtures, makeServer, makeUnderwriter } from './enclave-lib.mjs';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const here = path.dirname(fileURLToPath(import.meta.url));
const USDC = 1_000_000n;

// ---------------------------------------------------------------------------------------------
// options + env
// ---------------------------------------------------------------------------------------------
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = { ...readEnvFile(path.join(here, '..', '.env.local')), ...process.env };
const opts = {
  rpc: env.VITE_RPC_URL || 'https://api.devnet.solana.com',
  program: env.VITE_PROGRAM_ID,
  mint: env.VITE_USDC_MINT,
  enclaveUrl: env.VITE_ENCLAVE_URL || 'http://localhost:8787',
  keypair: path.join(os.homedir(), '.config/solana/id.json'),
  enclaveKey: env.NOTCH_KEY_FILE || path.join(here, '..', '..', '.underwriter-key.json'),
  sweep: true,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => { if (i + 1 >= argv.length) die(`${a} needs a value`); return argv[++i]; };
  if (a === '--no-sweep') opts.sweep = false;
  else if (a === '--rpc') opts.rpc = next();
  else if (a === '--program') opts.program = next();
  else if (a === '--mint') opts.mint = next();
  else if (a === '--keypair') opts.keypair = next();
  else if (a === '--enclave-key') opts.enclaveKey = next();
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node scripts/e2e-devnet.mjs [--no-sweep] [--rpc url] [--program addr] [--mint addr] [--keypair path] [--enclave-key path]');
    process.exit(0);
  } else die(`unknown option ${a}`);
}
function die(msg) { console.error(`error: ${msg}`); process.exit(1); }
if (/mainnet/i.test(opts.rpc)) die('refusing to run against a mainnet RPC URL. Devnet only.');
if (!opts.program || !opts.mint) die('VITE_PROGRAM_ID / VITE_USDC_MINT missing (app/.env.local)');

const rpc = createSolanaRpc(opts.rpc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonSafe = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Public devnet RPC rate-limits; retry reads with backoff. */
async function call(req) {
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

// ---------------------------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------------------------
const results = []; // { step, name, ok, detail }
const txLog = []; // { label, sig, ok }
let currentStep = '0';
const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const step = (id, title) => { currentStep = id; console.log(`\n=== ${id}. ${title}`); };
function check(name, cond, detail = '') {
  results.push({ step: currentStep, name, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return !!cond;
}
const usd = (n) => `${Number(n) / 1e6}`;

// ---------------------------------------------------------------------------------------------
// chain helpers
// ---------------------------------------------------------------------------------------------
async function send(label, payer, ixs, { expectFail = false } = {}) {
  const { value: bh } = await call(rpc.getLatestBlockhash({ commitment: 'confirmed' }));
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => signTransactionMessageWithSigners(m),
  );
  // skipPreflight: a failing attack must still land so it has a signature, logs and an explorer page.
  const sig = await call(rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight: true }));
  let status = null;
  for (let i = 0; i < 90; i++) {
    status = (await call(rpc.getSignatureStatuses([sig]))).value[0];
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) break;
    if (i > 40 && !status) {
      const h = await call(rpc.getBlockHeight({ commitment: 'confirmed' }));
      if (h > bh.lastValidBlockHeight) throw new Error(`${label}: blockhash expired before the transaction landed (${sig})`);
    }
    await sleep(1000);
  }
  if (!status || !(status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
    throw new Error(`${label}: not confirmed in time (${sig})`);
  }
  const err = status.err ? jsonSafe(status.err) : null;
  let logs = [];
  if (err || expectFail) {
    for (let i = 0; i < 10 && !logs.length; i++) {
      const t = await call(rpc.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }));
      logs = [...(t?.meta?.logMessages ?? [])];
      if (!logs.length) await sleep(700);
    }
  }
  txLog.push({ label, sig, ok: !err });
  console.log(`  tx  ${err ? (expectFail ? 'REFUSED' : 'FAILED') : 'ok    '}  ${label}\n      ${explorerTx(sig)}`);
  if (err && !expectFail) throw new Error(`${label} failed on chain: ${err}\n${logs.join('\n')}`);
  return { sig, err, logs };
}

const accountBytes = async (addr) => {
  const r = await call(rpc.getAccountInfo(addr, { encoding: 'base64', commitment: 'confirmed' }));
  return r.value ? base64ToBytes(r.value.data[0]) : null;
};
const tokenBal = async (owner, mint) => {
  const b = await accountBytes(await deriveAta(owner, mint));
  return b ? decodeTokenAmount(b) : 0n;
};
const vaultAmount = async () => decodeTokenAmount(await accountBytes(A.vault));
const solBal = async (addr) => (await call(rpc.getBalance(addr, { commitment: 'confirmed' }))).value;

// Program error names, in `NotchError` order (Anchor codes start at 6000).
const PROGRAM_ERRORS = [
  'BadRecord', 'BadSigIx', 'MissingSigIx', 'WrongUnderwriter', 'RecordMismatch', 'WrongWallet',
  'RecordExpired', 'StaleRecord', 'UnderwriterExpired', 'OverLimit', 'Defaulted', 'NotPastDue',
  'InvalidAmount', 'NothingToRepay', 'InsufficientDeposit', 'FeeRequired', 'InsufficientLiquidity',
  'InvalidPoolState', 'BalanceOutstanding', 'MathOverflow', 'CooldownActive',
];
/** Name of the Anchor error in the logs, plus the custom code number from the status. */
function programError(res) {
  const named = res.logs.join('\n').match(/Error Code: (\w+)/);
  const hex = res.err?.match(/"Custom":\s*(\d+)/) ?? res.err?.match(/Custom\D+(\d+)/);
  return { name: named?.[1] ?? null, code: hex ? Number(hex[1]) : null };
}
/** Assert that a transaction failed with exactly this Anchor error (name from logs AND code from the status). */
function expectProgramError(label, res, name) {
  const got = programError(res);
  const want = 6000 + PROGRAM_ERRORS.indexOf(name);
  return check(`${label} -> ${name}`, got.name === name && got.code === want, `got ${got.name ?? res.err ?? 'success'} / code ${got.code}, want ${name} / ${want}`);
}

// ---------------------------------------------------------------------------------------------
// setup: guard network, load admin, start the underwriter
// ---------------------------------------------------------------------------------------------
const genesis = await call(rpc.getGenesisHash());
if (genesis !== DEVNET_GENESIS) die(`this RPC is not devnet (genesis ${genesis}). Refusing to run.`);

const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(opts.keypair, 'utf8'))));
const program = address(opts.program);
const mint = address(opts.mint);
const A = await deriveAddresses(program, mint);
const adminSolStart = await solBal(admin.address);

console.log(`program     ${program}\nmint        ${mint}\nadmin       ${admin.address}  (${Number(adminSolStart) / 1e9} SOL)\nrpc         ${opts.rpc}`);

const underwriter = makeUnderwriter(opts.enclaveKey);
const server = makeServer(underwriter);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ENCLAVE = `http://127.0.0.1:${server.address().port}`;
const uwKey = new Uint8Array(getAddressEncoder().encode(address(underwriter.publicKey)));
console.log(`underwriter ${underwriter.publicKey}  (in-process, ${ENCLAVE})`);

const config = await accountBytes(A.config);
if (!config) die('program is not initialised on this network (no config account)');
const onChainUnderwriter = getAddressDecoder().decode(config.subarray(72, 104));
if (onChainUnderwriter !== underwriter.publicKey) {
  die(`on-chain underwriter ${onChainUnderwriter} != key in ${opts.enclaveKey} (${underwriter.publicKey})`);
}
try {
  const att = await (await fetch(`${opts.enclaveUrl.replace(/\/$/, '')}/attestation`, { signal: AbortSignal.timeout(3000) })).json();
  console.log(`demo enclave at ${opts.enclaveUrl}: ${att.underwriter === underwriter.publicKey ? 'same underwriter key' : `DIFFERENT key ${att.underwriter}`}`);
} catch { console.log(`demo enclave at ${opts.enclaveUrl}: not reachable (not needed for this run)`); }

// ---- underwriter client + email factory ----
async function underwrite(eml, wallet) {
  const r = await fetch(`${ENCLAVE}/underwrite`, { method: 'POST', headers: { 'content-type': 'message/rfc822', 'x-wallet': wallet }, body: eml });
  return { status: r.status, body: await r.json() };
}
// Real provider emails carry a unique transaction ID, so two payments never share a body.
// Dedupe keys on the body hash, so each run needs its own reference or it is (correctly) a duplicate.
const freshEmail = (f = fixtures.deelPayout) => fixtures.signedEmail({
  body: `${f.body}\r\nTransaction ID: ${crypto.randomUUID()}`, domain: f.domain, from: f.from, subject: f.subject,
});

// ---- wallets ----
const borrower = await generateKeyPairSigner();
const lender = await generateKeyPairSigner();
const attacker = await generateKeyPairSigner(); // only used as a wallet address for enclave-only attacks (never needs SOL)
const bAta = await deriveAta(borrower.address, mint);
const lAta = await deriveAta(lender.address, mint);
const lShareAta = await deriveAta(lender.address, A.shareMint);
const lEscrow = await deriveEscrow(program, lender.address);
const lRequest = await deriveWithdrawRequest(program, lender.address);
const line = await deriveLine(program, borrower.address);
console.log(`borrower    ${borrower.address}\nlender      ${lender.address}`);

let failed = false;
try {
  // -------------------------------------------------------------------------------------------
  step('1', 'Fund a fresh borrower (SOL + test USDC)');
  const mintAmount = 20n * USDC;
  const lenderUsdc = 5n * USDC;
  await send('admin -> borrower 0.05 SOL, lender 0.01 SOL', admin, [
    getTransferSolInstruction({ source: admin, destination: borrower.address, amount: lamports(50_000_000n) }),
    getTransferSolInstruction({ source: admin, destination: lender.address, amount: lamports(10_000_000n) }),
  ]);
  await send('mint test USDC to borrower (20) and lender (5)', admin, [
    createAtaIdempotentIx(admin.address, bAta, borrower.address, mint),
    getMintToInstruction({ mint, token: bAta, mintAuthority: admin, amount: mintAmount }),
    createAtaIdempotentIx(admin.address, lAta, lender.address, mint),
    getMintToInstruction({ mint, token: lAta, mintAuthority: admin, amount: lenderUsdc }),
  ]);
  check('borrower has ~0.05 SOL', (await solBal(borrower.address)) === 50_000_000n, `${await solBal(borrower.address)} lamports`);
  check('borrower has 20 test USDC', (await tokenBal(borrower.address, mint)) === mintAmount);

  // -------------------------------------------------------------------------------------------
  step('2', 'Underwriter: demo .eml -> signed record');
  const eml = await freshEmail(fixtures.deelPayout);
  const uw = await underwrite(eml, borrower.address);
  const reply = uw.body;
  check('underwriter accepted the email (HTTP 200, ok:true)', uw.status === 200 && reply.ok === true, jsonSafe(reply).slice(0, 120));
  const record = base64ToBytes(reply.message);
  const signature = base64ToBytes(reply.signature);
  const rec = decodeRecord(record);
  check('record is 96 bytes and signature is 64 bytes', record.length === 96 && signature.length === 64);
  check('record limit matches reply limitUsdc', rec.limitMicro === BigInt(Math.round(reply.limitUsdc * 1e6)), `${usd(rec.limitMicro)} USDC`);
  check('record is for the borrower wallet and the signature verifies off-chain',
    Buffer.from(record.subarray(8, 40)).equals(Buffer.from(getAddressEncoder().encode(borrower.address))) &&
      nacl.sign.detached.verify(record, signature, uwKey));
  const limit = rec.limitMicro;
  const dedupeAddr = await deriveDedupe(program, rec.dedupe);

  // -------------------------------------------------------------------------------------------
  step('3', 'post_limit (before that: record attacks that must be refused)');
  {
    // 6a. record signed by a different key
    const rogue = nacl.sign.keyPair();
    const rogueSig = nacl.sign.detached(record, rogue.secretKey);
    const r = await send('ATTACK post_limit signed by a different key', borrower,
      postLimitIxs(A, { payer: borrower.address, borrower: borrower.address, line, dedupe: dedupeAddr, record }, rogue.publicKey, rogueSig), { expectFail: true });
    expectProgramError('record signed by a different key', r, 'WrongUnderwriter');

    // 6b. the real signature, but the program is handed a different (bigger) record
    const tampered = record.slice();
    new DataView(tampered.buffer).setBigUint64(40, limit * 100n, true);
    const r2 = await send('ATTACK post_limit with a record that was not signed', borrower,
      [ed25519VerifyIx(uwKey, record, signature), postLimitIx(A, { payer: borrower.address, borrower: borrower.address, line, dedupe: dedupeAddr, record: tampered })], { expectFail: true });
    expectProgramError('record differs from the signed one (limit x100)', r2, 'RecordMismatch');
  }
  const lineBefore = await accountBytes(line);
  check('failed attacks left no credit line behind', lineBefore === null);

  const postIxs = postLimitIxs(A, { payer: borrower.address, borrower: borrower.address, line, dedupe: dedupeAddr, record }, uwKey, signature);
  await send('post_limit (Ed25519 verify + post_limit)', borrower, postIxs);
  const cl = decodeLine((await accountBytes(line)));
  check('CreditLine.wallet is the borrower', cl.wallet === borrower.address);
  check(`CreditLine.limit == ${usd(limit)} USDC`, cl.limit === limit, `${usd(cl.limit)}`);
  check('CreditLine.expiry == record expiry', cl.expiry === rec.expiry);
  check('CreditLine.lastNonce == record nonce', cl.lastNonce === rec.nonce);
  check('fresh line: drawn 0, deposit 0, no history', cl.drawn === 0n && cl.deposit === 0n && cl.repaidOnTime === 0 && !cl.defaulted);

  {
    // 6c. reused email: replay the exact same signed record (same dedupe hash)
    const r = await send('ATTACK post_limit replayed (same email / dedupe hash)', borrower, postIxs, { expectFail: true });
    check('reused email -> refused (dedupe account already in use)', !!r.err && /already in use/i.test(r.logs.join('\n')), r.err ?? 'succeeded');
  }

  // -------------------------------------------------------------------------------------------
  step('4', 'deposit 20% -> draw -> repay -> deposit back -> withdraw_borrower');
  const drawAmt = 10n * USDC;
  const needed = depositNeededFor(drawAmt); // 2 USDC
  const fee = feeFor(drawAmt); // 0.2 USDC (2% rounded up)
  const payoff = payoffFor(drawAmt);
  let pool0;

  {
    // 6d. draw over the limit
    const r = await send('ATTACK draw limit + 1 micro-USDC', borrower, [drawIx(A, borrower.address, line, bAta, limit + 1n)], { expectFail: true });
    expectProgramError(`draw ${usd(limit)} + 0.000001 USDC (over limit)`, r, 'OverLimit');
    // 6e. draw without a deposit
    const r2 = await send('ATTACK draw with no deposit', borrower, [drawIx(A, borrower.address, line, bAta, drawAmt)], { expectFail: true });
    expectProgramError(`draw ${usd(drawAmt)} USDC with no first-loss deposit`, r2, 'InsufficientDeposit');
    // and a deposit one micro short of 20%
    pool0 = decodePool(await accountBytes(A.pool));
    await send('deposit_borrower 20% minus 1 micro-USDC', borrower, [depositBorrowerIx(A, borrower.address, line, bAta, needed - 1n)]);
    const r3 = await send('ATTACK draw with deposit 1 micro-USDC short', borrower, [drawIx(A, borrower.address, line, bAta, drawAmt)], { expectFail: true });
    expectProgramError('draw with a deposit that is 1 micro-USDC short of 20%', r3, 'InsufficientDeposit');
  }

  await send('deposit_borrower top-up to exactly 20%', borrower, [depositBorrowerIx(A, borrower.address, line, bAta, 1n)]);
  let l = decodeLine(await accountBytes(line));
  const pool1 = decodePool(await accountBytes(A.pool));
  check(`line.deposit == ${usd(needed)} USDC (20% of ${usd(drawAmt)})`, l.deposit === needed, usd(l.deposit));
  check('pool.borrowerDeposits grew by the deposit', pool1.borrowerDeposits - pool0.borrowerDeposits === needed);
  check('borrower USDC = 20 - deposit', (await tokenBal(borrower.address, mint)) === mintAmount - needed);

  await send(`draw ${usd(drawAmt)} USDC`, borrower, [drawIx(A, borrower.address, line, bAta, drawAmt)]);
  l = decodeLine(await accountBytes(line));
  const pool2 = decodePool(await accountBytes(A.pool));
  check(`line.drawn == ${usd(drawAmt)}`, l.drawn === drawAmt);
  check('line.due is ~30 days out', l.due > BigInt(Math.floor(Date.now() / 1000)) + 29n * 86_400n && l.due < BigInt(Math.floor(Date.now() / 1000)) + 31n * 86_400n);
  check('borrower USDC = 20 - deposit + draw', (await tokenBal(borrower.address, mint)) === mintAmount - needed + drawAmt);
  check('pool.outstanding +draw, pool.idle -draw, totalLent +draw',
    pool2.outstanding - pool1.outstanding === drawAmt && pool1.idle - pool2.idle === drawAmt && pool2.totalLent - pool1.totalLent === drawAmt);

  {
    // bonus attacks while a balance is out
    const r = await send('ATTACK withdraw_borrower while a balance is outstanding', borrower, [withdrawBorrowerIx(A, borrower.address, line, bAta)], { expectFail: true });
    expectProgramError('withdraw deposit with a balance outstanding', r, 'BalanceOutstanding');
    // anyone can call mark_default, but not before the due date
    const rd = await send('ATTACK mark_default on a loan that is not overdue', lender, [markDefaultIx(A, line)], { expectFail: true });
    expectProgramError('mark_default before the due date (called by a third wallet)', rd, 'NotPastDue');
    // 6f. repay without the fee
    const r2 = await send('ATTACK repay principal only (no fee)', borrower, [repayIx(A, borrower.address, line, bAta, drawAmt)], { expectFail: true });
    expectProgramError(`repay ${usd(drawAmt)} (principal only, fee ${usd(fee)} missing)`, r2, 'FeeRequired');
    const r3 = await send('ATTACK repay 1 micro-USDC short of principal + fee', borrower, [repayIx(A, borrower.address, line, bAta, payoff - 1n)], { expectFail: true });
    expectProgramError('repay 1 micro-USDC short of principal + fee', r3, 'FeeRequired');
  }

  const balBeforeRepay = await tokenBal(borrower.address, mint);
  await send(`repay ${usd(payoff)} USDC (principal + ceil 2% fee)`, borrower, [repayIx(A, borrower.address, line, bAta, payoff)]);
  l = decodeLine(await accountBytes(line));
  const pool3 = decodePool(await accountBytes(A.pool));
  const balAfterRepay = await tokenBal(borrower.address, mint);
  check('line.drawn == 0 after repay', l.drawn === 0n);
  check('on-time counter +1', l.repaidOnTime === 1 && l.repaidLate === 0, `onTime ${l.repaidOnTime}, late ${l.repaidLate}`);
  check('deposit returned in the same instruction (line.deposit == 0)', l.deposit === 0n);
  check('borrower USDC change = -(payoff) + deposit returned', balAfterRepay === balBeforeRepay - payoff + needed, `${usd(balBeforeRepay)} -> ${usd(balAfterRepay)}`);
  check('borrower ended at 20 - fee', balAfterRepay === mintAmount - fee, usd(balAfterRepay));
  check('pool.outstanding back, fees +fee, idle +payoff, deposits -deposit',
    pool3.outstanding === pool1.outstanding && pool3.feesEarned - pool2.feesEarned === fee && pool3.idle - pool2.idle === payoff && pool2.borrowerDeposits - pool3.borrowerDeposits === needed);
  check('vault token balance == pool.idle + pool.borrowerDeposits (no stray tokens, no missing tokens)',
    (await vaultAmount()) === pool3.idle + pool3.borrowerDeposits, `${await vaultAmount()} vs ${pool3.idle + pool3.borrowerDeposits}`);

  // The program returns the deposit inside repay, so withdraw_borrower is exercised with a fresh deposit.
  const r0 = await send('ATTACK withdraw_borrower with nothing deposited', borrower, [withdrawBorrowerIx(A, borrower.address, line, bAta)], { expectFail: true });
  expectProgramError('withdraw_borrower with an empty deposit', r0, 'InvalidAmount');
  await send('deposit_borrower 1 USDC (no balance out)', borrower, [depositBorrowerIx(A, borrower.address, line, bAta, USDC)]);
  check('deposit is withdrawable: line.deposit == 1 USDC', decodeLine(await accountBytes(line)).deposit === USDC);
  const balPre = await tokenBal(borrower.address, mint);
  await send('withdraw_borrower', borrower, [withdrawBorrowerIx(A, borrower.address, line, bAta)]);
  check('withdraw_borrower returned the 1 USDC and zeroed line.deposit',
    (await tokenBal(borrower.address, mint)) === balPre + USDC && decodeLine(await accountBytes(line)).deposit === 0n);

  // -------------------------------------------------------------------------------------------
  step('5', 'Lender: second fresh wallet deposits, requests a withdrawal, is refused early, cancels');
  {
    const p0 = decodePool(await accountBytes(A.pool));
    const supply0 = decodeMintSupply(await accountBytes(A.shareMint));
    const assets0 = poolAssets(p0);
    const expShares = sharesForDeposit(lenderUsdc, supply0, assets0);
    await send(`lender deposit ${usd(lenderUsdc)} USDC`, lender, [
      createAtaIdempotentIx(lender.address, lShareAta, lender.address, A.shareMint),
      depositIx(A, lender.address, lAta, lShareAta, lenderUsdc),
    ]);
    const p1 = decodePool(await accountBytes(A.pool));
    const supply1 = decodeMintSupply(await accountBytes(A.shareMint));
    const shares = await tokenBal(lender.address, A.shareMint);
    check(`shares minted == floor(amount*supply/assets) = ${shares}`, shares === expShares, `expected ${expShares} (supply ${supply0}, assets ${assets0})`);
    check('share supply grew by the minted shares', supply1 - supply0 === shares);
    check('pool.idle grew by the deposit', p1.idle - p0.idle === lenderUsdc);
    check('lender USDC is 0 after depositing', (await tokenBal(lender.address, mint)) === 0n);
    check('vault token balance == pool.idle + pool.borrowerDeposits after the deposit',
      (await vaultAmount()) === p1.idle + p1.borrowerDeposits, `${await vaultAmount()} vs ${p1.idle + p1.borrowerDeposits}`);

    // Step 1 of leaving: shares move to the program's escrow. They are NOT burned, so supply is unchanged.
    await send(`lender request_withdraw ${shares} shares`, lender, [requestWithdrawIx(A, lender.address, lShareAta, lEscrow, lRequest, shares)]);
    const req = decodeWithdrawRequest(await accountBytes(lRequest));
    check('request records the lender, the shares and an unlock time', req.lender === lender.address && req.shares === shares);
    check(`unlock_ts is ~${WITHDRAW_COOLDOWN_SECONDS / 86_400n} days out`, req.unlockTs > BigInt(Math.floor(Date.now() / 1000)) + WITHDRAW_COOLDOWN_SECONDS - 600n && req.unlockTs < BigInt(Math.floor(Date.now() / 1000)) + WITHDRAW_COOLDOWN_SECONDS + 600n, String(req.unlockTs));
    check('lender wallet holds 0 shares, escrow holds them all', (await tokenBal(lender.address, A.shareMint)) === 0n && decodeTokenAmount(await accountBytes(lEscrow)) === shares);
    check('share supply is unchanged while shares sit in escrow', decodeMintSupply(await accountBytes(A.shareMint)) === supply1);
    const p2 = decodePool(await accountBytes(A.pool));
    check('pool accounting untouched by the request (idle, outstanding)', p2.idle === p1.idle && p2.outstanding === p1.outstanding);

    const early = await send('lender claim_withdraw before the cooldown (must be refused)', lender, [claimWithdrawIx(A, lender.address, lEscrow, lRequest, lAta)], { expectFail: true });
    expectProgramError('claim before the cooldown', early, 'CooldownActive');
    check('nothing was paid by the refused claim', (await tokenBal(lender.address, mint)) === 0n);

    await send('lender cancel_withdraw', lender, [cancelWithdrawIx(A, lender.address, lShareAta, lEscrow, lRequest)]);
    check('cancel returned every share to the lender', (await tokenBal(lender.address, A.shareMint)) === shares);
    check('escrow and request accounts are closed', (await accountBytes(lEscrow)) === null && (await accountBytes(lRequest)) === null);
    const p3 = decodePool(await accountBytes(A.pool));
    check('share supply and pool.idle are back to the post-deposit values', decodeMintSupply(await accountBytes(A.shareMint)) === supply1 && p3.idle === p1.idle);
    check('vault token balance == pool.idle + pool.borrowerDeposits after cancel',
      (await vaultAmount()) === p3.idle + p3.borrowerDeposits, `${await vaultAmount()} vs ${p3.idle + p3.borrowerDeposits}`);
    console.log(`  note  the lender's ${shares} shares stay in the devnet pool (the claim needs a ${WITHDRAW_COOLDOWN_SECONDS / 86_400n} day wait)`);
  }

  // -------------------------------------------------------------------------------------------
  step('7', 'Underwriter attacks: edited email, same email twice');
  {
    const good = await freshEmail(fixtures.deelPayout);
    // flip the first money amount in the body, leave headers and DKIM-Signature alone
    const s = good.toString('latin1');
    const split = s.search(/\r?\n\r?\n/);
    const body = s.slice(split);
    const m = body.match(/\d[\d,]*\.\d{2}/);
    const edited = Buffer.from(s.slice(0, split) + body.slice(0, m.index) + `9${m[0]}` + body.slice(m.index + m[0].length), 'latin1');
    const r = await underwrite(edited, attacker.address);
    check('edited email (amount changed after signing) is rejected: DKIM failure',
      r.status === 422 && r.body.ok === false && /dkim/i.test(r.body.reason), jsonSafe(r.body));

    const first = await underwrite(good, attacker.address);
    const second = await underwrite(good, attacker.address);
    check('same email the first time is accepted', first.status === 200 && first.body.ok === true);
    check('same email twice is rejected', second.status === 422 && second.body.ok === false && /already used/i.test(second.body.reason), jsonSafe(second.body));
    const third = await underwrite(good, borrower.address);
    check('same email from a different wallet is rejected too', third.status === 422 && third.body.ok === false && /already used/i.test(third.body.reason), jsonSafe(third.body));
    // the original email that produced the on-chain limit is also spent
    const fourth = await underwrite(eml, borrower.address);
    check('the email behind the on-chain limit is spent in the underwriter too', fourth.body.ok === false && /already used/i.test(fourth.body.reason), jsonSafe(fourth.body));
  }

  // -------------------------------------------------------------------------------------------
  step('8', 'Underwriter reply leaks no income or source fields');
  {
    const want = ['extraction', 'expiry', 'limitUsdc', 'message', 'nonce', 'ok', 'signature'].sort();
    const keys = Object.keys(reply).sort();
    check('reply keys are exactly ok, extraction, limitUsdc, expiry, nonce, message, signature', jsonSafe(keys) === jsonSafe(want), keys.join(','));
    const raw = jsonSafe(reply);
    const leaks = ['income', 'amount', 'source', 'sender', 'domain', 'deel', 'payment', 'payout', '2400', '2,400']
      .filter((w) => raw.toLowerCase().includes(w));
    check('reply text has no income / sender / amount words', leaks.length === 0, leaks.join(','));
    check('message is the 96-byte record (nothing else rides along)', base64ToBytes(reply.message).length === 96 && base64ToBytes(reply.signature).length === 64);
    check('only the limit bucket leaks: limitUsdc is a number, extraction is "rules" or "llm"', typeof reply.limitUsdc === 'number' && ['rules', 'llm'].includes(reply.extraction));
    const ok2 = await underwrite(await freshEmail(fixtures.momoGhana), attacker.address);
    check('same key set for a different provider email (momo)', ok2.body.ok === true && jsonSafe(Object.keys(ok2.body).sort()) === jsonSafe(want));
  }
} catch (e) {
  failed = true;
  console.error(`\nABORTED in step ${currentStep}: ${e.message}`);
  results.push({ step: currentStep, name: 'script ran to completion', ok: false, detail: e.message.split('\n')[0] });
} finally {
  // ---- cleanup: sweep leftover SOL back to the admin wallet ----
  if (opts.sweep) {
    for (const w of [borrower, lender]) {
      try {
        const bal = await solBal(w.address);
        if (bal > 10_000n) {
          await send(`sweep ${Number(bal - 5_000n) / 1e9} SOL back to admin`, w, [
            getTransferSolInstruction({ source: w, destination: admin.address, amount: lamports(bal - 5_000n) }),
          ]);
        }
      } catch (e) { console.error(`sweep failed for ${w.address}: ${e.message}`); }
    }
  }
  server.close();
}

// ---------------------------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------------------------
const adminSolEnd = await solBal(admin.address);
console.log('\n================ SUMMARY ================');
const steps = [...new Set(results.map((r) => r.step))].sort();
for (const s of steps) {
  const rs = results.filter((r) => r.step === s);
  console.log(`step ${s}: ${rs.every((r) => r.ok) ? 'PASS' : 'FAIL'}  (${rs.filter((r) => r.ok).length}/${rs.length})`);
  for (const r of rs.filter((x) => !x.ok)) console.log(`   FAIL ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
}
console.log(`\ntransactions (${txLog.length}):`);
for (const t of txLog) console.log(`  ${t.ok ? 'ok     ' : 'refused'} ${t.label}\n         ${explorerTx(t.sig)}`);
console.log(`\nadmin SOL: ${Number(adminSolStart) / 1e9} -> ${Number(adminSolEnd) / 1e9}  (net spent ${Number(adminSolStart - adminSolEnd) / 1e9} SOL)`);
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${bad === 0 && !failed ? 'ALL GREEN' : `${bad} CHECK(S) FAILED`}  (${results.length - bad}/${results.length} passed)`);
process.exit(bad === 0 && !failed ? 0 : 1);

#!/usr/bin/env node
// END-TO-END against the LIVE Phala confidential VM and Solana DEVNET. Test money only.
//
//   node enclave/scripts/e2e-phala.mjs [<cvm-url>] [--keep]
//
// 1  verify the TDX attestation of the CVM (quote, key binding, RTMR3 replay, compose hash, code == repo)
// 2  ask the CVM for a freshly DKIM-signed demo MoMo statement (demo mode: DEMO_FIXTURES=1, visible in the
//    attested compose) and POST it to /underwrite for a fresh wallet -> signed record
//    (this and the local-key record below are prepared BEFORE touching the chain, to keep step 3 short)
// 3  register the attested key on devnet (set_underwriter, admin = ~/.config/solana/id.json)
// 4  post_limit with the CVM-signed record (Ed25519 verify ix + program) and read the CreditLine back
// 5  negative: a record signed by the OLD local demo key is refused by the program (WrongUnderwriter)
// 6  ALWAYS restore the local demo key (register-underwriter.mjs --local) so the other devnet e2e keeps working
//    (--keep leaves the Phala key registered instead)
//
// Safety: devnet only (genesis hash checked). Reads app/src/notch.ts without editing it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder } from '@solana/kit';
import { signUnderwrite } from '../src/underwrite-http.js';
import { decodeLine, decodeRecord, deriveDedupe, deriveIdentity, deriveLine, ed25519VerifyIx, postLimitIxs, base64ToBytes } from '../../app/src/notch.ts';
import { signRecord } from '../src/record.js';
import { verifyAttestation } from './verify-attestation.mjs';
import { LOCAL_KEY_FILE, accountBytes, connect, readUnderwriter, send } from '../../deploy/phala/chain.mjs';
import { localUnderwriterPubkey, registerAttested, registerLocal } from '../../deploy/phala/register-underwriter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, '..', '..', 'deploy', 'phala', '.deploy-state.json');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
let url = argv.find((a) => !a.startsWith('-')) || process.env.NOTCH_PHALA_URL;
if (!url && fs.existsSync(stateFile)) url = JSON.parse(fs.readFileSync(stateFile, 'utf8')).url;
if (!url) { console.error('usage: e2e-phala.mjs <cvm-url> [--keep]  (or set NOTCH_PHALA_URL / deploy/phala/.deploy-state.json)'); process.exit(2); }
url = url.replace(/\/$/, '');

const results = [];
let currentStep = '0';
const step = (id, title) => { currentStep = id; console.log(`\n=== ${id}. ${title}`); };
function check(name, cond, detail = '') {
  results.push({ step: currentStep, name, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return !!cond;
}
const PROGRAM_ERRORS = [
  'BadRecord', 'BadSigIx', 'MissingSigIx', 'WrongUnderwriter', 'RecordMismatch', 'WrongWallet',
  'RecordExpired', 'StaleRecord', 'UnderwriterExpired', 'OverLimit', 'Defaulted', 'NotPastDue',
  'InvalidAmount', 'NothingToRepay', 'InsufficientDeposit', 'FeeRequired', 'InsufficientLiquidity',
  'InvalidPoolState', 'BalanceOutstanding', 'MathOverflow', 'CooldownActive', 'IdentityBound', 'IdentityRequired',
  'NoCreditLine', 'InsufficientCredit',
];
function expectProgramError(label, res, name) {
  const named = res.logs.join('\n').match(/Error Code: (\w+)/)?.[1] ?? null;
  const code = res.err?.match(/"Custom":\s*(\d+)/)?.[1] ?? res.err?.match(/Custom\D+(\d+)/)?.[1];
  const want = 6000 + PROGRAM_ERRORS.indexOf(name);
  return check(`${label} -> ${name}`, named === name && Number(code) === want, `got ${named ?? res.err ?? 'success'} / code ${code}, want ${name} / ${want}`);
}

let ctx;
let registeredPhala = false;
let failure = null;
try {
  ctx = await connect();
  console.log(`cvm         ${url}\nprogram     ${ctx.program}\nadmin       ${ctx.admin.address}`);
  const start = await readUnderwriter(ctx.rpc, ctx.A);
  const localPub = localUnderwriterPubkey();
  console.log(`on-chain underwriter at start: ${start.underwriter}  (local demo key: ${localPub})`);

  // ---- 1 attestation
  step('1', 'verify the TDX attestation of the CVM');
  const v = await verifyAttestation(url);
  for (const c of v.checks) check(c.name, c.ok, c.detail);
  if (!v.ok) throw new Error('attestation failed; stopping before anything touches the chain');
  check('CVM is in the declared DEMO mode (DEMO_FIXTURES=1 is in the attested compose)', v.demo === true);
  check('CVM key differs from the local demo key (the Phala key really is another key)', v.underwriter !== localPub);
  const uwKey = new Uint8Array(getAddressEncoder().encode(address(v.underwriter)));
  console.log(`  compose-hash ${v.measurement.composeHash}\n  underwriter  ${v.underwriter}`);

  // ---- 2 prepare records (no chain writes yet)
  step('2', 'fresh MoMo statement -> CVM /underwrite (signed inside the TEE)');
  // A plain Ed25519 keypair: /underwrite needs the wallet's own signature over the email (only the address is used on chain).
  const borrowerKp = nacl.sign.keyPair();
  const borrower = { address: getAddressDecoder().decode(borrowerKp.publicKey) };
  const sample = await fetch(`${url}/samples/momo.eml`, { signal: AbortSignal.timeout(60_000) });
  check('CVM serves a fresh signed demo MoMo statement email', sample.ok && (sample.headers.get('content-type') || '').includes('rfc822'), `HTTP ${sample.status}`);
  const eml = Buffer.from(await sample.arrayBuffer());
  // A MoMo statement may not be uploaded directly (audit #3): prove the CVM refuses it, then send it the real way.
  const direct = await fetch(`${url}/underwrite`, { method: 'POST', headers: { 'content-type': 'message/rfc822', ...signUnderwrite({ wallet: borrower.address, eml, secretKey: borrowerKp.secretKey }) }, body: eml, signal: AbortSignal.timeout(120_000) });
  const directReply = await direct.json();
  check('CVM refuses a MoMo statement uploaded directly (inbox only)', !directReply.ok && /inbox/i.test(String(directReply.reason)), String(directReply.reason).slice(0, 80));
  const t0 = Date.now();
  const ts = Date.now();
  const inboxSig = Buffer.from(nacl.sign.detached(Buffer.from(`notch-inbox-v1|${borrower.address}|${ts}`), borrowerKp.secretKey)).toString('base64');
  const ib = await (await fetch(`${url}/inbox/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: borrower.address, ts, signature: inboxSig }), signal: AbortSignal.timeout(60_000) })).json();
  check('CVM hands the wallet its own statement inbox address', ib.ok === true && typeof ib.address === 'string', ib.ok ? ib.address.replace(/^[^@]+/, '<code>') : ib.reason);
  if (!ib.ok) throw new Error(`inbox failed: ${ib.reason}`);
  const dl = await fetch(`${url}/demo/deliver`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: ib.address }), signal: AbortSignal.timeout(120_000) });
  check('CVM demo mailer delivers a signed statement to that inbox', dl.status < 300 || dl.status === 422, `HTTP ${dl.status}`);
  let reply = { ok: false, reason: 'timed out waiting for the inbox result' };
  for (let i = 0; i < 60; i++) {
    const p = await (await fetch(`${url}/record/${borrower.address}`, { headers: { 'x-notch-token': ib.pollToken }, signal: AbortSignal.timeout(30_000) })).json();
    if (p.status === 'ready') { const { status: _s, ...rest } = p; reply = rest; break; }
    if (p.status === 'refused' || p.status === 'locked') { reply = { ok: false, reason: p.reason }; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  check('CVM underwrites the statement from the inbox', reply.ok === true, `${Date.now() - t0} ms, reader ${reply.extraction}, limit ${reply.limitUsdc} USDC${reply.ok ? '' : `, reason ${reply.reason}`}`);
  if (!reply.ok) throw new Error(`underwrite failed: ${reply.reason}`);
  const record = base64ToBytes(reply.message);
  const signature = base64ToBytes(reply.signature);
  const rec = decodeRecord(record);
  check('record is 128 bytes (NOTCHv2), signature 64 bytes', record.length === 128 && signature.length === 64 && Buffer.from(record.subarray(0, 8)).toString('latin1') === 'NOTCHv2\0');
  check('signature verifies off-chain against the ATTESTED key', nacl.sign.detached.verify(record, signature, uwKey));
  check('record is for the borrower wallet', Buffer.from(record.subarray(8, 40)).equals(Buffer.from(getAddressEncoder().encode(borrower.address))));
  check('statement-backed record carries an identity hash (one MoMo number = one wallet)', rec.idHash.some((b) => b !== 0));
  const allowed = ['expiry', 'extraction', 'limitUsdc', 'message', 'nonce', 'ok', 'signature'];
  check('reply leaks nothing beyond the signed record fields', Object.keys(reply).every((k) => allowed.includes(k)), Object.keys(reply).sort().join(','));

  // A record signed by the OLD local demo key, for a different fresh wallet (negative check in step 5).
  const other = await generateKeyPairSigner();
  const localSecret = Uint8Array.from(JSON.parse(fs.readFileSync(LOCAL_KEY_FILE, 'utf8')));
  const oldKeyRec = signRecord({
    wallet: other.address, limitUsdc: 25, expiry: Math.floor(Date.now() / 1000) + 30 * 86400,
    dedupe: crypto.randomBytes(32), nonce: BigInt(Date.now()), idHash: Buffer.alloc(32),
  }, localSecret);
  const oldRecord = base64ToBytes(oldKeyRec.message);
  const oldSig = base64ToBytes(oldKeyRec.signature);
  const localKeyBytes = new Uint8Array(getAddressEncoder().encode(address(localPub)));

  const line = await deriveLine(ctx.program, borrower.address);
  const dedupeAddr = await deriveDedupe(ctx.program, rec.dedupe);
  const idAddr = await deriveIdentity(ctx.program, rec.idHash);

  // ---- 3 register the attested key
  step('3', 'register the attested key on devnet (admin set_underwriter after the check above)');
  const reg = await registerAttested(url, { allowDemo: true, ctx, log: (m) => console.log(m) });
  registeredPhala = true;
  const after = await readUnderwriter(ctx.rpc, ctx.A);
  check('program now trusts the CVM key', after.underwriter === v.underwriter, after.underwriter);
  check('registration re-verified the same compose-hash', reg.verification.measurement.composeHash === v.measurement.composeHash);

  // ---- 4 post the CVM-signed record
  step('4', 'post_limit with the CVM-signed record, read the CreditLine back');
  const post = await send(ctx, 'post_limit (record signed inside the TEE)', ctx.admin,
    postLimitIxs(ctx.A, { payer: ctx.admin.address, borrower: borrower.address, line, dedupe: dedupeAddr, record, identity: idAddr }, uwKey, signature));
  check('post_limit accepted', !post.err);
  const lineBytes = await accountBytes(ctx.rpc, line);
  check('CreditLine account exists', !!lineBytes);
  if (lineBytes) {
    const cl = decodeLine(lineBytes);
    check('CreditLine wallet == borrower', cl.wallet === borrower.address);
    check('CreditLine limit == the CVM-signed limit', cl.limit === rec.limitMicro, `${Number(cl.limit) / 1e6} USDC`);
    check('CreditLine limit == the limit the CVM replied with', Number(cl.limit) / 1e6 === reply.limitUsdc);
    check('CreditLine expiry == record expiry', cl.expiry === rec.expiry);
  }

  // ---- 5 negative: old local key
  step('5', 'negative: a record signed by the old local key is refused');
  const bad = await send(ctx, 'ATTACK post_limit signed by the old local demo key', ctx.admin,
    postLimitIxs(ctx.A, {
      payer: ctx.admin.address, borrower: other.address, line: await deriveLine(ctx.program, other.address),
      dedupe: await deriveDedupe(ctx.program, decodeRecord(oldRecord).dedupe), record: oldRecord,
    }, localKeyBytes, oldSig), { expectFail: true });
  expectProgramError('record signed by the old local key', bad, 'WrongUnderwriter');
  // and a replay of the CVM record (same email) is refused too: the dedupe account already exists
  const replay = await send(ctx, 'ATTACK replay of the same CVM-signed record', ctx.admin,
    postLimitIxs(ctx.A, { payer: ctx.admin.address, borrower: borrower.address, line, dedupe: dedupeAddr, record, identity: idAddr }, uwKey, signature), { expectFail: true });
  check('replaying the same signed record is refused', !!replay.err, replay.logs.join(' ').match(/Error Code: (\w+)|already in use/)?.[0] || replay.err);
} catch (e) {
  failure = e;
  console.error(`\nERROR: ${e.message}`);
} finally {
  // ---- 6 restore
  if (ctx && registeredPhala && !keep) {
    step('6', 'restore the local demo key (the other devnet e2e depends on it)');
    try {
      await registerLocal({ ctx });
      const now = await readUnderwriter(ctx.rpc, ctx.A);
      check('program trusts the local demo key again', now.underwriter === localUnderwriterPubkey(), now.underwriter);
    } catch (e) {
      console.error(`RESTORE FAILED: ${e.message}\nRun: node deploy/phala/register-underwriter.mjs --local`);
      failure ||= e;
    }
  } else if (keep && registeredPhala) {
    console.log('\n--keep: the Phala key is still registered. Restore with: node deploy/phala/register-underwriter.mjs --local');
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name} ${f.detail}`);
console.log(failed.length === 0 && !failure ? '\nE2E PHALA: GREEN' : '\nE2E PHALA: RED');
process.exit(failed.length === 0 && !failure ? 0 : 1);

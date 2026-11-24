#!/usr/bin/env node
// END-TO-END for the statement inbox, on Solana DEVNET (test money only), no cloud needed.
//
//   node enclave/scripts/e2e-inbox.mjs
//
// It plays every part itself, with the real code of each:
//   1  start the enclave HTTP app locally (same Underwriter + Inbox + routes as server.js) with the LOCAL demo key
//   2  POST /inbox/new for a fresh borrower wallet (wallet-signed) -> an address <code>@<domain>
//   3  build a DKIM-signed synthetic MTN statement email addressed to that address
//   4  hand it to deploy/cloudflare/email-worker.js, exactly as Cloudflare Email Routing would; the worker POSTs the raw
//      message to /inbound
//   5  fetch the signed record with the poll token, check it, post_limit on devnet (builders from app/src/notch.ts,
//      read-only) and read the CreditLine back
//   6  negatives: unknown code, wrong-wallet redirect, replayed statement, tampered PDF, replayed record on chain
// If the program trusts another underwriter key (WrongUnderwriter), the script re-registers the local demo key
// first (deploy/phala/register-underwriter.mjs --local; admin = ~/.config/solana/id.json).
import fs from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import crypto from 'node:crypto';
import { address, generateKeyPairSigner, getAddressEncoder, signBytes } from '@solana/kit';
import { decodeLine, decodeRecord, deriveDedupe, deriveIdentity, deriveLine, postLimitIxs, base64ToBytes } from '../../app/src/notch.ts';
import { Underwriter, DEFAULT_TRUSTED } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import worker from '../../deploy/cloudflare/email-worker.js';
import * as fixtures from '../test/fixtures/emails.js';
import { LOCAL_KEY_FILE, accountBytes, connect, readUnderwriter, send } from '../../deploy/phala/chain.mjs';
import { localUnderwriterPubkey, registerLocal } from '../../deploy/phala/register-underwriter.mjs';

const results = [];
let currentStep = '0';
const step = (id, title) => { currentStep = id; console.log(`\n=== ${id}. ${title}`); };
function check(name, cond, detail = '') {
  results.push({ step: currentStep, name, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return !!cond;
}

const SECRET = crypto.randomBytes(16).toString('hex');
const DOMAIN = 'inbox.notch.test';
let server;
let failure = null;
try {
  const ctx = await connect();
  console.log(`program ${ctx.program}\nadmin   ${ctx.admin.address}`);
  const localPub = localUnderwriterPubkey();
  const onChain = await readUnderwriter(ctx.rpc, ctx.A);
  console.log(`on-chain underwriter ${onChain.underwriter} (local demo key ${localPub})`);
  if (onChain.underwriter !== localPub) {
    console.log('  the program trusts another key: restoring the local demo key (register-underwriter --local)');
    await registerLocal({ ctx });
  }

  step('1', 'enclave HTTP app (real Underwriter + Inbox + routes) with the local demo key');
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(LOCAL_KEY_FILE, 'utf8')));
  const u = new Underwriter({ secretKey, resolver: fixtures.resolver, trusted: [...DEFAULT_TRUSTED], llm: null });
  const inbox = new Inbox({ domain: DOMAIN, secret: SECRET, requireWalletSig: true });
  server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  check('enclave key == the key the program trusts', u.publicKey === localPub);
  const uwKey = new Uint8Array(getAddressEncoder().encode(address(localPub)));

  const newInbox = async (signer, { sign = true } = {}) => {
    const ts = Date.now();
    const body = { wallet: signer.address };
    if (sign) { body.ts = ts; body.signature = Buffer.from(await signBytes(signer.keyPair.privateKey, Buffer.from(`notch-inbox-v1|${signer.address}|${ts}`))).toString('base64'); }
    const r = await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  // What Cloudflare Email Routing does: hand the raw message to the worker, which POSTs it to /inbound.
  const viaWorker = async (eml, rcpt) => {
    const env = { NOTCH_INBOUND_URL: `${base}/inbound`, NOTCH_INBOUND_SECRET: SECRET };
    const msg = { to: rcpt, rawSize: eml.length, raw: new Response(eml).body, rejected: null, setReject(r) { this.rejected = r; } };
    await worker.email(msg, env);
    return msg.rejected; // null = accepted
  };
  const fetchRecord = async (signer, token) => (await fetch(`${base}/record/${signer.address}`, { headers: { 'x-notch-token': token } })).json();

  step('2', 'a fresh borrower asks for its statement address');
  const borrower = await generateKeyPairSigner();
  const unsigned = await newInbox(borrower, { sign: false });
  check('without a wallet signature /inbox/new is refused (strict mode)', unsigned.status === 401);
  const inb = await newInbox(borrower);
  check('inbox address issued on the configured domain', inb.ok && new RegExp(`^[a-z2-7]{10}@${DOMAIN}$`).test(inb.address), inb.address);

  step('3', 'DKIM-signed synthetic MTN statement email addressed to that address -> Cloudflare worker -> /inbound');
  const msisdn = fixtures.randomMsisdn();
  const rows = fixtures.syntheticRows().map((r, i) => ({ ...r, txid: `7${String(10000000 + i)}${crypto.randomInt(10, 99)}` })); // fixed ids, so a re-sent statement overlaps
  const eml = await fixtures.momoStatementEmail({ to: inb.address, msisdn, rows });
  const rejected = await viaWorker(eml, inb.address);
  check('the worker forwarded it and the enclave accepted it', rejected === null, rejected || 'accepted');

  step('4', 'fetch the signed record with the poll token');
  const rec = await fetchRecord(borrower, inb.pollToken);
  check('record ready', rec.status === 'ready' && rec.ok === true, `limit ${rec.limitUsdc} USDC, reader ${rec.extraction}`);
  const record = base64ToBytes(rec.message);
  const signature = base64ToBytes(rec.signature);
  const dec = decodeRecord(record);
  check('signature verifies against the enclave key', nacl.sign.detached.verify(record, signature, uwKey));
  check('record is for the borrower wallet', Buffer.from(record.subarray(8, 40)).equals(Buffer.from(getAddressEncoder().encode(borrower.address))));
  check('identity hash present (one MoMo number = one wallet)', dec.idHash.some((b) => b !== 0));
  check('limit comes from classified income, below the first-timer cap', rec.limitUsdc > 0 && rec.limitUsdc < 50);

  step('5', 'post_limit on devnet, read the CreditLine back');
  const line = await deriveLine(ctx.program, borrower.address);
  const dedupeAddr = await deriveDedupe(ctx.program, dec.dedupe);
  const idAddr = await deriveIdentity(ctx.program, dec.idHash);
  const post = await send(ctx, 'post_limit (record from the statement inbox)', ctx.admin,
    postLimitIxs(ctx.A, { payer: ctx.admin.address, borrower: borrower.address, line, dedupe: dedupeAddr, record, identity: idAddr }, uwKey, signature));
  check('post_limit accepted', !post.err);
  const lineBytes = await accountBytes(ctx.rpc, line);
  check('CreditLine account exists', !!lineBytes);
  if (lineBytes) {
    const cl = decodeLine(lineBytes);
    check('CreditLine wallet == borrower', cl.wallet === borrower.address);
    check('CreditLine limit == the signed limit', cl.limit === dec.limitMicro && Number(cl.limit) / 1e6 === rec.limitUsdc, `${Number(cl.limit) / 1e6} USDC`);
    check('CreditLine expiry == record expiry', cl.expiry === dec.expiry);
  }

  step('6', 'negative cases');
  const bogus = await viaWorker(await fixtures.momoStatementEmail({ to: `aaaaaaaaaa@${DOMAIN}`, msisdn: fixtures.randomMsisdn() }), `aaaaaaaaaa@${DOMAIN}`);
  check('unknown code is bounced', /cannot take this message \(404\)/.test(bogus || ''), bogus);

  const alice = await generateKeyPairSigner();
  const mallory = await generateKeyPairSigner();
  const a = await newInbox(alice);
  const m = await newInbox(mallory);
  const aliceStatement = await fixtures.momoStatementEmail({ to: a.address, msisdn: fixtures.randomMsisdn() });
  const redirected = await viaWorker(aliceStatement, m.address);
  check("Alice's statement delivered to Mallory's code is refused (wrong-wallet redirect)", /\(422\)/.test(redirected || ''), redirected);
  check("Mallory's wallet gets no record out of it", (await fetchRecord(mallory, m.pollToken)).status === 'refused');

  const replaySame = await viaWorker(eml, inb.address);
  check('replay of the accepted statement to its own (spent) code is refused', /\(410\)/.test(replaySame || ''), replaySame);
  const fresh = await newInbox(borrower);
  const replayNew = await viaWorker(eml, fresh.address);
  check('the same mail at a fresh code of the same wallet is refused (To header names the old code)', /\(422\)/.test(replayNew || ''), replayNew);
  const resent = await viaWorker(await fixtures.momoStatementEmail({ to: fresh.address, msisdn, rows }), fresh.address);
  check('same MoMo number, new mail, nothing new: refused', /\(422\)/.test(resent || ''), resent);

  const t = await newInbox(await generateKeyPairSigner());
  const text = (await fixtures.momoStatementEmail({ to: t.address, msisdn: fixtures.randomMsisdn() })).toString('latin1');
  const at = text.indexOf('Content-Transfer-Encoding: base64') + 300;
  const tampered = Buffer.from(text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1), 'latin1');
  const tamperRes = await viaWorker(tampered, t.address);
  check('tampered PDF (DKIM breaks) is refused', /\(422\)/.test(tamperRes || ''), tamperRes);

  const replayChain = await send(ctx, 'ATTACK replay of the same signed record on chain', ctx.admin,
    postLimitIxs(ctx.A, { payer: ctx.admin.address, borrower: borrower.address, line, dedupe: dedupeAddr, record, identity: idAddr }, uwKey, signature), { expectFail: true });
  check('the same signed record cannot be posted twice (dedupe account exists)', !!replayChain.err, replayChain.logs.join(' ').match(/Error Code: (\w+)|already in use/)?.[0] || replayChain.err);
} catch (e) {
  failure = e;
  console.error(`\nERROR: ${e.stack || e.message}`);
} finally {
  server?.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL [${f.step}] ${f.name} ${f.detail}`);
console.log(failed.length === 0 && !failure ? '\nE2E INBOX: GREEN' : '\nE2E INBOX: RED');
process.exit(failed.length === 0 && !failure ? 0 : 1);

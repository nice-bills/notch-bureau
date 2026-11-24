// Permanent regression tests for audit finding #3 (HIGH): POST /underwrite accepted anyone's MTN statement and bound the
// victim's phone number to the CALLER's wallet. Repro: reviews/2026-11-24-audit/redirect.test.js.
//
// Rules now:
//  * a mobile-money statement (identity source) is accepted ONLY through the inbox, where the DKIM-signed To header must be the
//    wallet's own address (Underwriter.submit refuses it without a `recipient`);
//  * the direct path stays for sources without identity (Deel, bank demo, Superteam Earn), but the caller must sign
//    "notch-underwrite-v1|<wallet>|<sha256 of the email>|<ts>" with the wallet key (HTTP 401 otherwise).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter, DEFAULT_TRUSTED } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { signUnderwrite, verifyUnderwriteSig, underwriteMessage, emlSha256 } from '../src/underwrite-http.js';
import { resolver, momoStatementEmail, signedEmail, deelPayout, randomMsisdn } from './fixtures/emails.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));
const kp = () => { const k = nacl.sign.keyPair(); return { secretKey: k.secretKey, wallet: bs58.encode(k.publicKey) }; };

async function boot() {
  const u = new Underwriter({ resolver, llm: null, trusted: [...DEFAULT_TRUSTED] });
  const inbox = new Inbox({ domain: 'inbox.example.test', secret: 's3cret', insecureAllowUnsignedForTests: true });
  const server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (eml, wallet, headers = {}) => fetch(`${base}/underwrite`, { method: 'POST', headers: { 'content-type': 'message/rfc822', 'x-wallet': wallet, ...headers }, body: eml });
  return { u, inbox, base, post };
}
const deelEmail = () => signedEmail({ body: `${deelPayout.body}\r\nTransaction ID: ${crypto.randomUUID()}`, domain: deelPayout.domain, from: deelPayout.from, subject: deelPayout.subject });

test('#3 repro: a victim\'s statement submitted for an attacker wallet is refused at the Underwriter (no recipient = no statement)', async () => {
  const eml = await momoStatementEmail({ msisdn: randomMsisdn() });
  const u = new Underwriter({ resolver, llm: null });
  const attacker = kp();
  const r = await u.submit(eml, attacker.wallet); // what POST /underwrite does
  assert.equal(r.ok, false);
  assert.match(r.reason, /inbox/i);
  assert.equal(r.limitUsdc, undefined);
});

test('#3 repro over HTTP: POST /underwrite with a signed request still cannot carry a MoMo statement', async () => {
  const { post } = await boot();
  const attacker = kp();
  const eml = await momoStatementEmail({ msisdn: randomMsisdn() });
  const r = await post(eml, attacker.wallet, signUnderwrite({ wallet: attacker.wallet, eml, secretKey: attacker.secretKey }));
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.reason, /inbox/i);
});

test('#3: the same statement is accepted through the inbox, but only for the wallet whose address it was sent to', async () => {
  const { u, inbox, base } = await boot();
  const alice = kp(), mallory = kp();
  const mk = async (w) => (await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify({ wallet: w }) })).json();
  const a = await mk(alice.wallet), m = await mk(mallory.wallet);
  const eml = await momoStatementEmail({ to: a.address, msisdn: randomMsisdn() });
  const inbound = (rcpt) => fetch(`${base}/inbound`, { method: 'POST', body: eml, headers: { 'x-notch-rcpt': rcpt, 'x-notch-inbound-secret': 's3cret' } });
  // Mallory forwards Alice's mail into Mallory's own inbox: the signed To header names Alice's address, so it is refused.
  const bad = await inbound(m.address);
  assert.ok(bad.status >= 400 || (await bad.json()).ok === false);
  const rec = await (await fetch(`${base}/record/${mallory.wallet}`, { headers: { 'x-notch-token': m.pollToken } })).json();
  assert.notEqual(rec.status, 'ready');
  // Delivered to Alice's own address it works, and the record is Alice's.
  const ok = await inbound(a.address);
  assert.equal(ok.status, 200);
  const got = await (await fetch(`${base}/record/${alice.wallet}`, { headers: { 'x-notch-token': a.pollToken } })).json();
  assert.equal(got.status, 'ready');
  assert.ok(got.limitUsdc > 0);
  assert.ok(u && inbox);
});

test('#3: the direct path needs the wallet\'s signature: missing, wrong wallet, wrong email, stale all give 401', async () => {
  const { post } = await boot();
  const w = kp(), other = kp();
  const eml = await deelEmail();
  assert.equal((await post(eml, w.wallet)).status, 401, 'no signature');
  const wrongKey = signUnderwrite({ wallet: w.wallet, eml, secretKey: other.secretKey });
  assert.equal((await post(eml, w.wallet, wrongKey)).status, 401, 'signed by another key');
  const forOther = signUnderwrite({ wallet: w.wallet, eml: await deelEmail(), secretKey: w.secretKey });
  assert.equal((await post(eml, w.wallet, forOther)).status, 401, 'signature over a different email');
  const stale = signUnderwrite({ wallet: w.wallet, eml, secretKey: w.secretKey, ts: Date.now() - 11 * 60_000 });
  assert.equal((await post(eml, w.wallet, stale)).status, 401, 'older than 10 minutes');
  const asOther = signUnderwrite({ wallet: other.wallet, eml, secretKey: other.secretKey });
  assert.equal((await post(eml, w.wallet, { ...asOther, 'x-wallet': w.wallet })).status, 401, 'signed for a different wallet');
});

test('#3: a non-identity source (Deel payout) still works on the direct path, with the wallet\'s signature', async () => {
  const { post } = await boot();
  const w = kp();
  const eml = await deelEmail();
  const r = await post(eml, w.wallet, signUnderwrite({ wallet: w.wallet, eml, secretKey: w.secretKey }));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.limitUsdc > 0);
});

test('signature helpers: the message binds wallet, email hash and time', () => {
  const w = kp();
  const eml = Buffer.from('hello');
  const h = signUnderwrite({ wallet: w.wallet, eml, secretKey: w.secretKey, ts: 1000 });
  const args = { wallet: w.wallet, eml, ts: '1000', signature: h['x-notch-sig'], now: 1000 };
  assert.equal(verifyUnderwriteSig(args), true);
  assert.equal(verifyUnderwriteSig({ ...args, eml: Buffer.from('hellp') }), false);
  assert.equal(verifyUnderwriteSig({ ...args, ts: '1001' }), false);
  assert.equal(verifyUnderwriteSig({ ...args, now: 1000 + 11 * 60_000 }), false);
  assert.equal(verifyUnderwriteSig({ ...args, signature: 'AAAA' }), false);
  assert.equal(underwriteMessage('W', emlSha256(eml), 5), `notch-underwrite-v1|W|${emlSha256(eml)}|5`);
});

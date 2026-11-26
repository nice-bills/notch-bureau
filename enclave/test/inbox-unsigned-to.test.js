// A provider whose DKIM signature does NOT cover To (MTN does not): the mail is tied to the request by the envelope
// address, the signed Date (not older than the inbox code) and single-use keys. Plus the header tricks that must not
// turn an unsigned (or somebody else's) To into a signed one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter, DATE_SKEW_MS } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { parseMailDate } from '../src/dkim.js';
import { reasonCode } from '../src/status.js';
import { dkimSign } from 'mailauth';
import { resolver, privateKey, momoStatementEmail, randomMsisdn, MTN_SIGNED_HEADERS } from './fixtures/emails.js';

const SECRET = 'test-inbound-secret';
const DOMAIN = 'inbox.example.test';
const ALICE = `aliceaaaaa@${DOMAIN}`;
const MALLORY = `mallorymmm@${DOMAIN}`;
const servers = [];
after(() => servers.forEach((s) => s.close()));

const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const underwriter = () => new Underwriter({ resolver, llm: null });
const mtn = (extra = {}) => momoStatementEmail({ to: ALICE, msisdn: randomMsisdn(), headerList: MTN_SIGNED_HEADERS, ...extra });
const nowSecond = () => Math.floor(Date.now() / 1000) * 1000; // the Date header has no milliseconds
const submit = (eml, { recipient = ALICE, issuedAt = Date.now(), u = underwriter(), w = wallet() } = {}) => u.submit(eml, w, { recipient, issuedAt });
// Anyone holding a mail can do this to an unsigned header without breaking the signature.
const retarget = (eml, to, from = ALICE) => Buffer.from(eml.toString('latin1').replace(`\r\nTo: ${from}\r\n`, `\r\nTo: ${to}\r\n`), 'latin1');
const edit = (eml, fn) => Buffer.from(fn(eml.toString('latin1')), 'latin1');

const SENT_BEFORE = /sent before you asked/;
const NOT_ADDRESSED = /not addressed to this inbox/;
const UNTIED = /cannot be tied to your request/;

async function boot() {
  const u = underwriter();
  let offset = 0;
  const inbox = new Inbox({ domain: DOMAIN, secret: SECRET, insecureAllowUnsignedForTests: true, now: () => Date.now() + offset });
  const server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const newInbox = async (w = wallet()) => ({ wallet: w, ...(await (await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify({ wallet: w }) })).json()) });
  const inbound = async (eml, rcpt) => {
    const r = await fetch(`${base}/inbound`, { method: 'POST', body: eml, headers: { 'x-notch-rcpt': rcpt, 'x-notch-inbound-secret': SECRET } });
    return { status: r.status, ...(await r.json()) };
  };
  return { inbox, newInbox, inbound, later: (ms) => { offset += ms; } };
}

test('unsigned To: a statement sent for this address, after it was asked for, is accepted', async () => {
  const { newInbox, inbound } = await boot();
  const a = await newInbox();
  const eml = await momoStatementEmail({ to: a.address, msisdn: randomMsisdn(), headerList: MTN_SIGNED_HEADERS });
  assert.doesNotMatch(/\bh=([^;]+)/.exec(eml.toString())[1], /\bto\b/i, 'the fixture really leaves To unsigned');
  assert.equal((await inbound(eml, a.address)).status, 200);
});

test('replay: an old statement re-sent to a newly asked address is refused by its signed Date', async () => {
  const { newInbox, inbound } = await boot();
  const m = await newInbox();
  const old = await mtn({ date: new Date(Date.now() - 3 * 86400_000) });
  const r = await inbound(retarget(old, m.address), m.address);
  assert.equal(r.status, 422);
  assert.match(r.reason, SENT_BEFORE);
});

test('replay: the same statement twice is refused (spent address; used mail; later address)', async () => {
  const { newInbox, inbound, later } = await boot();
  const msisdn = randomMsisdn();
  const w = wallet();
  const a = await newInbox(w);
  const eml = await momoStatementEmail({ to: a.address, msisdn, headerList: MTN_SIGNED_HEADERS });
  assert.equal((await inbound(eml, a.address)).status, 200);
  assert.equal((await inbound(eml, a.address)).status, 410, 'the address is single use');
  // right away on a second address: still inside the clock skew, so the used-mail memory has to catch it
  const b = await newInbox(w);
  const again = await inbound(retarget(eml, b.address, a.address), b.address);
  assert.equal(again.status, 422);
  assert.equal(again.reason, 'email already used');
  // and an address asked for later refuses it on the Date alone
  later(10 * 60_000);
  const c = await newInbox(w);
  assert.match((await inbound(retarget(eml, c.address, a.address), c.address)).reason, SENT_BEFORE);
});

test('the signed Message-ID is single use, even with a different body', async () => {
  const u = underwriter();
  const w = wallet();
  const messageId = `<${crypto.randomUUID()}@mtn.com>`;
  const msisdn = randomMsisdn();
  assert.equal((await submit(await mtn({ messageId, msisdn }), { u, w })).ok, true);
  const second = await submit(await mtn({ messageId, msisdn }), { u, w });
  assert.deepEqual(second, { ok: false, reason: 'email already used' });
});

test('unsigned To: the Date window is the code issue time to now, with 2 minutes of clock skew', async () => {
  assert.equal(DATE_SKEW_MS, 120_000);
  const t = nowSecond();
  const eml = await mtn({ date: new Date(t) });
  assert.equal((await submit(eml, { issuedAt: t + DATE_SKEW_MS })).ok, true);
  assert.match((await submit(eml, { issuedAt: t + DATE_SKEW_MS + 1000 })).reason, SENT_BEFORE);
  const u = (now) => new Underwriter({ resolver, llm: null, now: () => new Date(now) });
  assert.equal((await submit(eml, { issuedAt: t - 3600_000, u: u(t - DATE_SKEW_MS) })).ok, true);
  assert.match((await submit(eml, { issuedAt: t - 3600_000, u: u(t - DATE_SKEW_MS - 1000) })).reason, /dated in the future/);
});

test('unsigned To: the envelope address and the one To address must be the same', async () => {
  const { newInbox, inbound } = await boot();
  const a = await newInbox();
  const m = await newInbox();
  const forAlice = await momoStatementEmail({ to: a.address, msisdn: randomMsisdn(), headerList: MTN_SIGNED_HEADERS });
  assert.match((await inbound(forAlice, m.address)).reason, NOT_ADDRESSED);
  for (const to of [`${m.address}, ${a.address}`, `"${a.address}" <${m.address}>`, 'undisclosed-recipients:;']) {
    assert.match((await submit(retarget(forAlice, to, a.address), { recipient: m.address })).reason, NOT_ADDRESSED, to);
  }
  const noTo = edit(forAlice, (s) => s.replace(`\r\nTo: ${a.address}`, ''));
  assert.match((await submit(noTo, { recipient: a.address })).reason, NOT_ADDRESSED);
  assert.equal((await inbound(forAlice, a.address)).status, 200, 'refusals did not spend anything');
});

test('a signed To naming someone else is refused however fresh the mail is; a signed To needs no Date window', async () => {
  const signedForAlice = await momoStatementEmail({ to: ALICE, msisdn: randomMsisdn() });
  assert.match((await submit(signedForAlice, { recipient: MALLORY })).reason, NOT_ADDRESSED);
  assert.match((await submit(retarget(signedForAlice, MALLORY), { recipient: MALLORY })).reason, /no passing DKIM/);
  const olderThanTheCode = await momoStatementEmail({ to: ALICE, msisdn: randomMsisdn(), date: new Date(Date.now() - 86400_000) });
  assert.equal((await submit(olderThanTheCode)).ok, true);
});

test('unsigned To: Date and Message-ID must be signed, and the code issue time known', async () => {
  for (const headerList of ['From:Subject:Message-ID:Content-Type:MIME-Version', 'From:Date:Subject:Content-Type:MIME-Version']) {
    assert.match((await submit(await mtn({ headerList }))).reason, UNTIED, headerList);
  }
  assert.match((await underwriter().submit(await mtn(), wallet(), { recipient: ALICE })).reason, UNTIED);
});

test('unsigned To: only for a trusted signer, and never on the direct upload path', async () => {
  const stranger = new Underwriter({ resolver, llm: null, trusted: ['other.test'] });
  assert.match((await submit(await mtn(), { u: stranger })).reason, /untrusted signer/);
  assert.match((await underwriter().submit(await mtn(), wallet())).reason, /only through your own Notch inbox/);
});

test('header trick: renaming the signed To to "To :" and adding another does not move the mail', async () => {
  const signedForAlice = await momoStatementEmail({ to: ALICE, msisdn: randomMsisdn() });
  const forged = edit(signedForAlice, (s) => `To: ${MALLORY}\r\n${s.replace(`\r\nTo: ${ALICE}`, `\r\nTo : ${ALICE}`)}`);
  assert.deepEqual(await submit(forged, { recipient: MALLORY }), { ok: false, reason: 'message has several To headers' });
});

test('header trick: a fresh Date added over the signed one does not make an old statement new', async () => {
  const old = await mtn({ date: new Date(Date.now() - 3 * 86400_000) });
  for (const name of ['Date :', 'Date:']) {
    const forged = edit(old, (s) => `Date: ${new Date().toUTCString()}\r\n${s.replace('\r\nDate:', `\r\n${name}`)}`);
    assert.deepEqual(await submit(forged), { ok: false, reason: 'message has several Date headers' }, name);
  }
  const added = edit(old, (s) => `Message-ID: <new@mtn.com>\r\n${s}`);
  assert.deepEqual(await submit(added), { ok: false, reason: 'message has several Message-ID headers' });
});

test('header trick: a fake DKIM-Signature with the same b= cannot claim that To or Date is signed', async () => {
  const eml = await mtn();
  const moved = retarget(eml, MALLORY).toString('latin1');
  const b = /\bb=([A-Za-z0-9+/=\s]+?)(;|\r\n(?![ \t]))/.exec(moved)[1].replace(/\s+/g, '');
  const forged = Buffer.from(`DKIM-Signature: v=1; a=rsa-sha256; d=mtn.com; s=nope; h=from:to:date:message-id:content-type; bh=AAAA; b=${b}\r\n${moved}`, 'latin1');
  // the real signature still leaves To unsigned, so the unsigned rules apply: an address asked for later is refused
  assert.match((await submit(forged, { recipient: MALLORY, issuedAt: Date.now() + 3600_000 })).reason, SENT_BEFORE);
});

test('Date parsing is strict: a zone is required', () => {
  assert.equal(parseMailDate('Thu, 26 Nov 2026 10:00:00 +0100').toISOString(), '2026-11-26T09:00:00.000Z');
  assert.equal(parseMailDate('26 Nov 2026 10:00 GMT (comment)').toISOString(), '2026-11-26T10:00:00.000Z');
  for (const bad of ['Thu, 26 Nov 2026 10:00:00', '2026-11-26T10:00:00Z', '31 Feb 2026 10:00:00 +0000', 'yesterday', '']) {
    assert.equal(parseMailDate(bad), null, bad);
  }
});

test('the new refusals never read as a broken signature', () => {
  for (const text of [
    'the statement was not addressed to this inbox',
    'the statement was sent before you asked for this address; request a new statement',
    'the statement is dated in the future, so it cannot be accepted',
    'the email provider did not sign a readable date and message ID, so this statement cannot be tied to your request',
  ]) assert.equal(reasonCode(text), 'wrong_inbox', text);
});

test('when one of two trusted signatures covers To, the strict To rule is the one used', async () => {
  const both = await momoStatementEmail({ to: ALICE, msisdn: randomMsisdn() });
  const { signatures } = await dkimSign(both, { signatureData: [{ signingDomain: 'mtn.com', selector: 'two', headerList: MTN_SIGNED_HEADERS, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }] });
  const eml = Buffer.concat([Buffer.from(signatures), both]);
  // strict path: no Date window, so a code asked for later does not matter
  assert.equal((await submit(eml, { issuedAt: Date.now() + 3600_000 })).ok, true);
});

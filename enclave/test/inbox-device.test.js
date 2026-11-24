// Seeker binding through the statement inbox. It is OPTIONAL, exactly as on /underwrite: /inbox/new may carry the same
// Sign-in-with-Solana proof; it is checked and bound to the address, and used when the statement arrives. Real HTTP, real
// signatures; only the Seeker-token reader (mainnet) is a stub, as in device.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createSignInMessage } from '@solana/wallet-standard-util';
import { Underwriter } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { SgtUnavailable, sgtHash } from '../src/sgt.js';
import { RECORD_LEN, RECORD_LEN_V3, verifyRecord } from '../src/record.js';
import { MemoryStore } from '../src/store.js';
import { resolver, momoStatementEmail, syntheticCashRows, randomMsisdn } from './fixtures/emails.js';

const SECRET = 'test-inbound-secret';
const DOMAIN = 'inbox.example.test';
const servers = [];
after(() => servers.forEach((s) => s.close()));

const wallet = () => { const kp = nacl.sign.keyPair(); return { kp, address: bs58.encode(kp.publicKey) }; };
const mint = () => bs58.encode(crypto.randomBytes(32));

async function boot(table = new Map()) {
  const u = new Underwriter({ resolver, llm: null, sgtReader: async (w) => { const v = table.get(w); if (v instanceof Error) throw v; return v || []; } });
  const store = new MemoryStore();
  const inbox = new Inbox({ domain: DOMAIN, secret: SECRET, store }); // strict: the wallet signature is required
  const server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const nonce = async () => { const { ok, ...issued } = await (await fetch(`${base}/device/nonce`, { method: 'POST' })).json(); return issued; };
  // what the wallet app does: sign the issued SIWS payload (plus its own address)
  const proof = async (w, { signer = w.kp, address = w.address, issued } = {}) => {
    const iss = issued || await nonce();
    const msg = createSignInMessage({ ...iss, address });
    return { nonce: iss.nonce, signature: Buffer.from(nacl.sign.detached(msg, signer.secretKey)).toString('base64'), signedMessage: Buffer.from(msg).toString('base64') };
  };
  const newInbox = async (w, { device, header } = {}) => {
    const ts = Date.now();
    const body = { wallet: w.address, ts, signature: Buffer.from(nacl.sign.detached(Buffer.from(`notch-inbox-v1|${w.address}|${ts}`), w.kp.secretKey)).toString('base64'), ...(device ? { device } : {}) };
    const r = await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify(body), headers: header ? { 'x-notch-device': Buffer.from(JSON.stringify(header)).toString('base64') } : {} });
    return { status: r.status, ...(await r.json()) };
  };
  const inbound = async (to, extra = {}) => {
    const eml = await momoStatementEmail({ to, msisdn: randomMsisdn(), rows: syntheticCashRows(), ...extra });
    const r = await fetch(`${base}/inbound`, { method: 'POST', body: eml, headers: { 'x-notch-rcpt': to, 'x-notch-inbound-secret': SECRET } });
    return { status: r.status, body: await r.json(), eml };
  };
  const record = async (w, token) => (await (await fetch(`${base}/record/${w.address}`, { headers: { 'x-notch-token': token } })).json());
  return { u, inbox, store, base, table, proof, newInbox, inbound, record, nonce };
}
const dev = (rec) => Buffer.from(rec.message, 'base64').subarray(128, 160);

test('a Seeker through the inbox: proof at /inbox/new, statement later -> v3 record with the device hash and the x1.5 limit', async () => {
  const t = await boot();
  const w = wallet(); const m = mint();
  t.table.set(w.address, [m]);
  const inb = await t.newInbox(w, { device: await t.proof(w) });
  assert.equal(inb.status, 200, inb.reason);
  assert.equal(inb.deviceProof, 'accepted');
  const got = await t.inbound(inb.address);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const rec = await t.record(w, inb.pollToken);
  assert.equal(rec.status, 'ready');
  assert.equal(rec.seeker, true);
  const bytes = Buffer.from(rec.message, 'base64');
  assert.equal(bytes.length, RECORD_LEN_V3);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), 'NOTCHv3\0');
  assert.deepEqual(dev(rec), sgtHash(m));
  assert.equal(verifyRecord(rec.message, rec.signature, bs58.decode(t.u.publicKey)), true);
  assert.ok(!JSON.stringify(rec).includes(m), 'the mint never leaves');
  // the hash stored for /posted is the hash of all 160 bytes
  assert.deepEqual([...t.store.records.keys()], [crypto.createHash('sha256').update(bytes).digest('hex')]);
  // the same statement without the proof is an ordinary limit; the Seeker's is 1.5x
  const w2 = wallet();
  const plain = await t.newInbox(w2);
  await t.inbound(plain.address);
  const prec = await t.record(w2, plain.pollToken);
  assert.ok(Math.abs(rec.limitUsdc - prec.limitUsdc * 1.5) <= 0.02, `${prec.limitUsdc} -> ${rec.limitUsdc}`);
});

test('the same proof in the x-notch-device header works too (same shape as /underwrite)', async () => {
  const t = await boot();
  const w = wallet(); t.table.set(w.address, [mint()]);
  const inb = await t.newInbox(w, { header: await t.proof(w) });
  assert.equal(inb.status, 200, inb.reason);
  await t.inbound(inb.address);
  assert.equal((await t.record(w, inb.pollToken)).seeker, true);
});

test('no proof: a plain v2 record, nothing asked of a non-Seeker, no `seeker` key in the reply; a Seeker who skips the proof gets no binding', async () => {
  const t = await boot();
  const w = wallet(); t.table.set(w.address, [mint()]); // it HAS a token, but did not prove it
  const inb = await t.newInbox(w);
  assert.equal(inb.status, 200);
  assert.equal(inb.deviceProof, undefined);
  await t.inbound(inb.address);
  const rec = await t.record(w, inb.pollToken);
  assert.equal(rec.ok, true);
  assert.equal(Buffer.from(rec.message, 'base64').length, RECORD_LEN);
  assert.equal(rec.seeker, undefined);
});

test('a proof but no Seeker token: an ordinary limit, v2 record, seeker=false (the address still works)', async () => {
  const t = await boot();
  const w = wallet();
  const inb = await t.newInbox(w, { device: await t.proof(w) });
  assert.equal(inb.status, 200);
  await t.inbound(inb.address);
  const rec = await t.record(w, inb.pollToken);
  assert.equal(rec.ok, true);
  assert.equal(rec.seeker, false);
  assert.equal(Buffer.from(rec.message, 'base64').length, RECORD_LEN);
});

test('bad proofs are refused at /inbox/new and issue no address: forged signature, someone else\'s proof, replay, junk, stale challenge', async () => {
  const t = await boot();
  const w = wallet(); const other = wallet(); const victim = wallet();
  t.table.set(victim.address, [mint()]);
  const forged = await t.newInbox(victim, { device: await t.proof(victim, { signer: other.kp }) });
  assert.equal(forged.status, 401); assert.match(forged.reason, /signature does not match/);
  // the victim's inbox request needs the victim's wallet signature too, so a proof signed by `other` for `w` is the cross-wallet case:
  const cross = await t.newInbox(w, { device: await t.proof(other) });
  assert.equal(cross.status, 401); assert.match(cross.reason, /signature does not match/);
  const good = await t.proof(w);
  assert.equal((await t.newInbox(w, { device: good })).status, 200);
  const replay = await t.newInbox(w, { device: good });
  assert.equal(replay.status, 401); assert.match(replay.reason, /unknown, already used or expired/);
  assert.equal((await t.newInbox(w, { device: 'junk' })).status, 400);
  assert.equal((await t.newInbox(w, { device: [1, 2] })).status, 400);
  assert.equal((await t.newInbox(w, { device: { nonce: 'f'.repeat(32), signature: 'AAAA', signedMessage: 'AAAA' } })).status, 401);
  assert.equal((await fetch(`${t.base}/inbox/new`, { method: 'POST', body: '{"wallet":"x"}', headers: { 'x-notch-device': 'not-base64-json' } })).status, 400);
  // only the one good request made an address
  assert.equal(t.inbox.codes.size, 1);
});

test('an expired challenge is refused (the wallet asked too late)', async () => {
  const t = await boot();
  const w = wallet();
  const issued = await t.nonce();
  const now = t.u.deviceNonces.now;
  t.u.deviceNonces.now = () => now() + 6 * 60_000; // six minutes pass
  const r = await t.newInbox(w, { device: await t.proof(w, { issued }) });
  assert.equal(r.status, 401); assert.match(r.reason, /unknown, already used or expired/);
});

test('one phone = one Seeker line, through the inbox: a second wallet holding the same token is refused when its statement arrives', async () => {
  const t = await boot();
  const a = wallet(); const b = wallet(); const m = mint();
  t.table.set(a.address, [m]); t.table.set(b.address, [m]);
  const ia = await t.newInbox(a, { device: await t.proof(a) });
  assert.equal((await t.inbound(ia.address)).status, 200);
  const ib = await t.newInbox(b, { device: await t.proof(b) });
  const got = await t.inbound(ib.address);
  assert.equal(got.status, 422);
  assert.match(got.body.reason, /already linked to a different wallet/);
  assert.ok(!JSON.stringify(got.body).includes(m));
  // wallet B without a proof is just an ordinary borrower: the phone rule applies to Seeker-bound lines only
  const c = wallet(); t.table.set(c.address, [m]);
  const ic = await t.newInbox(c);
  assert.equal((await t.inbound(ic.address)).status, 200);
  assert.equal((await t.record(c, ic.pollToken)).seeker, undefined);
});

test('the MoMo number rule still applies to everyone, Seeker or not', async () => {
  const t = await boot();
  const a = wallet(); const b = wallet();
  const msisdn = randomMsisdn();
  const ia = await t.newInbox(a);
  assert.equal((await t.inbound(ia.address, { msisdn })).status, 200);
  const ib = await t.newInbox(b, { device: await t.proof(b) });
  const got = await t.inbound(ib.address, { msisdn });
  assert.equal(got.status, 422);
  assert.match(got.body.reason, /mobile-money account is already linked to a different wallet/);
});

test('a Seeker-token lookup outage is 503 "try again", never "not a Seeker", and the address is not burnt or counted as a failure', async () => {
  const t = await boot();
  const w = wallet();
  t.table.set(w.address, new SgtUnavailable('mainnet RPC unreachable (simulated)'));
  const inb = await t.newInbox(w, { device: await t.proof(w) });
  const eml = await momoStatementEmail({ to: inb.address, msisdn: randomMsisdn(), rows: syntheticCashRows() });
  const send = () => fetch(`${t.base}/inbound`, { method: 'POST', body: eml, headers: { 'x-notch-rcpt': inb.address, 'x-notch-inbound-secret': SECRET } });
  for (let i = 0; i < 7; i++) { // more than the 5-failure lock
    const r = await send();
    assert.equal(r.status, 503);
    assert.equal((await r.json()).retry, true);
  }
  assert.equal((await t.record(w, inb.pollToken)).status, 'waiting');
  t.table.set(w.address, [mint()]); // the RPC is back
  const ok = await send();
  assert.equal(ok.status, 200, 'the very same statement goes through now');
  assert.equal((await t.record(w, inb.pollToken)).seeker, true);
});

test('the proof is bound to the address it was given for: another address of the same wallet does not inherit it', async () => {
  const t = await boot();
  const w = wallet(); t.table.set(w.address, [mint()]);
  const proven = await t.newInbox(w, { device: await t.proof(w) });
  const unproven = await t.newInbox(w);
  await t.inbound(unproven.address);
  const rec = await t.record(w, unproven.pollToken);
  assert.equal(rec.seeker, undefined, 'no proof on this address: no device binding');
  assert.equal(proven.ok, true);
});

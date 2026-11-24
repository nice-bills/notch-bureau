// One phone = one borrower: Sign-in-with-Solana (half 1) + a Seeker Genesis Token on mainnet (half 2).
// The SGT reader is a STUB here (we have no Seeker); the real mainnet read is scripts/sgt-real-read.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createSignInMessage } from '@solana/wallet-standard-util';
import { Underwriter } from '../src/underwriter.js';
import { InboxedUnderwriter } from './fixtures/inboxed.js';
import { createApp } from '../src/http-app.js';
import { DeviceNonces } from '../src/siws.js';
import { signUnderwrite } from '../src/underwrite-http.js';
import { SgtUnavailable, createSgtReader, sgtHash } from '../src/sgt.js';
import { RECORD_LEN, RECORD_LEN_V3, encodeRecord, verifyRecord } from '../src/record.js';
import { computeLimit, SEEKER_MULTIPLIER } from '../src/underwrite.js';
import { resolver, momoStatementEmail, syntheticCashRows, randomMsisdn } from './fixtures/emails.js';

const signed = (w, eml, h = {}) => ({ ...signUnderwrite({ wallet: w.address, eml, secretKey: w.kp.secretKey }), ...h });
const wallet = () => { const kp = nacl.sign.keyPair(); return { kp, address: bs58.encode(kp.publicKey) }; };
const mint = () => bs58.encode(crypto.randomBytes(32)); // looks like a mint address; the reader below is a stub
// stub for @solana-mobile/skr-genesis-token: wallet -> mints. `calls` records which wallet it was asked about.
const stubReader = (table, calls = []) => async (w) => { calls.push(w); const v = table.get(w); if (v instanceof Error) throw v; return v || []; };
const make = (extra = {}) => new InboxedUnderwriter({ resolver, llm: null, ...extra });
const email = async (msisdn = randomMsisdn()) => momoStatementEmail({ msisdn, rows: syntheticCashRows() });
// One wallet = one phone number (audit #10): a test that submits for the same wallet twice must use that wallet's own number.
const phones = new Map();
const emailFor = (w) => { if (!phones.has(w.address)) phones.set(w.address, randomMsisdn()); return email(phones.get(w.address)); };

// What a wallet does: SIWS signIn over the payload the underwriter issued (with its own address added).
function prove(u, w, { address = w.address, mutate = {}, signer = w.kp, challenge } = {}) {
  const issued = challenge || u.deviceChallenge();
  const msg = createSignInMessage({ ...issued, address, ...mutate });
  return { nonce: issued.nonce, signature: Array.from(nacl.sign.detached(msg, signer.secretKey)), signedMessage: Array.from(msg) };
}
const recordOf = (r) => Buffer.from(r.message, 'base64');
const deviceOf = (r) => recordOf(r).subarray(128, 160);

test('a non-Seeker works exactly as before: no proof, a plain 128 byte v2 record, same reply keys', async () => {
  const u = make();
  const w = wallet();
  const r = await u.submit(await email(), w.address);
  assert.equal(r.ok, true, r.reason);
  assert.equal(recordOf(r).length, RECORD_LEN);
  assert.equal(recordOf(r).subarray(0, 8).toString('latin1'), 'NOTCHv2\0');
  assert.deepEqual(Object.keys(r).sort(), ['expiry', 'extraction', 'limitUsdc', 'message', 'nonce', 'ok', 'signature']);
});

test('a Seeker: valid proof + SGT -> v3 record with sha256("notch-sgt"|mint), limit x1.5, mint never leaves', async () => {
  const m = mint();
  const w = wallet();
  const calls = [];
  const u = make({ sgtReader: stubReader(new Map([[w.address, [m]]]), calls) });
  const plain = await make().submit(await email(), wallet().address);
  const r = await u.submit(await email(), w.address, { device: prove(u, w) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.seeker, true);
  const rec = recordOf(r);
  assert.equal(rec.length, RECORD_LEN_V3);
  assert.equal(rec.subarray(0, 8).toString('latin1'), 'NOTCHv3\0');
  assert.deepEqual(deviceOf(r), crypto.createHash('sha256').update(`notch-sgt|${m}`).digest());
  assert.deepEqual(deviceOf(r), sgtHash(m));
  assert.equal(verifyRecord(r.message, r.signature, bs58.decode(u.publicKey)), true);
  // the limit is the same statement's limit x 1.5 (rounded down to cents)
  assert.equal(SEEKER_MULTIPLIER, 1.5);
  assert.ok(Math.abs(r.limitUsdc - plain.limitUsdc * 1.5) <= 0.02, `${plain.limitUsdc} -> ${r.limitUsdc}`);
  // the SGT is looked up for the wallet being underwritten, nothing else
  assert.deepEqual(calls, [w.address]);
  // no mint anywhere in what leaves the enclave
  assert.ok(!JSON.stringify(r).includes(m) && !rec.toString('latin1').includes(m));
});

test('the uplift is modest and bounded: x1.5 on share and first-timer cap, never past the hard cap', () => {
  const ev = [{ amount: 100_000_000, currency: 'GHS', date: new Date(), weight: 1 }]; // huge income: the cap binds
  assert.equal(computeLimit(ev).limitUsdc, 50);
  assert.equal(computeLimit(ev, { seeker: true }).limitUsdc, 75);
  assert.equal(computeLimit(ev, { seeker: true, repaidOnTime: 6 }).limitUsdc, 2000); // 50 x 1.5 x 64 > 2000
  const small = [{ amount: 3000, currency: 'GHS', date: new Date(), weight: 1 }];
  assert.equal(computeLimit(small, { seeker: true }).limitUsdc, 29.25); // 19.5 x 1.5
});

test('valid proof but the wallet holds no SGT: just a normal borrower (v2 record, no uplift, said so)', async () => {
  const w = wallet();
  const u = make({ sgtReader: stubReader(new Map()) });
  const r = await u.submit(await email(), w.address, { device: prove(u, w) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.seeker, false);
  assert.equal(recordOf(r).length, RECORD_LEN);
});

test('ATTACK claim a real Seeker owner\'s public address with your own key: refused', async () => {
  const victim = wallet();
  const thief = wallet();
  const u = make({ sgtReader: stubReader(new Map([[victim.address, [mint()]]])) });
  // the thief signs a message that names the victim's address with the thief's own key
  const r = await u.submit(await email(), victim.address, { device: prove(u, victim, { signer: thief.kp }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /signature does not match/);
  // the thief signs for the thief's own address but asks for the victim's wallet: also refused
  const r2 = await u.submit(await email(), victim.address, { device: prove(u, thief) });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /signature does not match/);
  // and a Seeker's address with no proof at all is just an ordinary borrower: nothing bound, no uplift
  const r3 = await u.submit(await email(), victim.address);
  assert.equal(r3.ok, true);
  assert.equal(recordOf(r3).length, RECORD_LEN);
});

test('ATTACK replay: a proof works once; an old or invented challenge is refused', async () => {
  const w = wallet();
  const u = make({ sgtReader: stubReader(new Map([[w.address, [mint()]]])) });
  const proof = prove(u, w);
  assert.equal((await u.submit(await emailFor(w), w.address, { device: proof })).ok, true);
  const again = await u.submit(await emailFor(w), w.address, { device: proof });
  assert.equal(again.ok, false);
  assert.match(again.reason, /unknown, already used or expired/);
  // a nonce the client made up
  const fake = u.deviceChallenge();
  const bad = await u.submit(await emailFor(w), w.address, { device: prove(u, w, { challenge: { ...fake, nonce: crypto.randomBytes(16).toString('hex') } }) });
  assert.equal(bad.ok, false);
});

test('ATTACK a challenge that expired is refused', async () => {
  let t = 1_800_000_000_000;
  const w = wallet();
  const u = make({ deviceNonces: new DeviceNonces({ now: () => t }), sgtReader: stubReader(new Map([[w.address, [mint()]]])) });
  const proof = prove(u, w);
  t += 6 * 60_000;
  const r = await u.submit(await email(), w.address, { device: proof });
  assert.equal(r.ok, false);
  assert.match(r.reason, /expired/);
});

test('ATTACK the client edits the challenge it signs (other domain, chain, statement, uri, nonce) or adds a field', async () => {
  const w = wallet();
  const u = make({ sgtReader: stubReader(new Map([[w.address, [mint()]]])) });
  for (const mutate of [{ domain: 'evil.example' }, { chainId: 'solana:devnet' }, { statement: 'send me money' }, { uri: 'https://evil.example' }, { version: '2' }, { requestId: 'x' }, { resources: ['https://evil.example'] }]) {
    const r = await u.submit(await email(), w.address, { device: prove(u, w, { mutate }) });
    assert.equal(r.ok, false, JSON.stringify(mutate));
    assert.match(r.reason, /signature does not match/);
  }
});

test('ATTACK malformed proofs (short signature, junk message, missing parts, wrong types) are refused without crashing', async () => {
  const w = wallet();
  const u = make({ sgtReader: stubReader(new Map([[w.address, [mint()]]])) });
  const good = prove(u, w);
  const cases = [
    { ...good, signature: good.signature.slice(0, 10) },
    { ...good, signature: 'not base64!!' },
    { ...good, signedMessage: 'x' },
    { ...good, signedMessage: new Array(5000).fill(1) },
    { ...good, signedMessage: [1, 2, 300] },
    { signature: good.signature, signedMessage: good.signedMessage },
    { ...good, nonce: { a: 1 } },
    'junk', 42, [],
  ];
  for (const device of cases) {
    const r = await u.submit(await email(), w.address, { device });
    assert.equal(r.ok, false);
    assert.match(r.reason, /device proof/);
  }
  // base64 forms are accepted too (what an HTTP client sends)
  const p = prove(u, w);
  const b64 = { nonce: p.nonce, signature: Buffer.from(p.signature).toString('base64'), signedMessage: Buffer.from(p.signedMessage).toString('base64') };
  assert.equal((await u.submit(await email(), w.address, { device: b64 })).ok, true);
});

test('ATTACK one phone, two wallets: the second wallet holding the same SGT is refused', async () => {
  const m = mint();
  const a = wallet();
  const b = wallet();
  const u = make({ sgtReader: stubReader(new Map([[a.address, [m]], [b.address, [m]]])) });
  assert.equal((await u.submit(await emailFor(a), a.address, { device: prove(u, a) })).ok, true);
  const r = await u.submit(await emailFor(b), b.address, { device: prove(u, b) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already linked to a different wallet/);
  assert.ok(!r.reason.includes(m));
  // the first wallet may come back (new statement, new proof): same phone, same wallet
  assert.equal((await u.submit(await emailFor(a), a.address, { device: prove(u, a) })).ok, true);
  // b without the device proof still works as an ordinary borrower
  assert.equal((await u.submit(await emailFor(b), b.address)).ok, true);
});

test('the chain decides too: a phone the program already bound to another wallet is refused after an enclave restart', async () => {
  const m = mint();
  const w = wallet();
  const seen = [];
  const u = make({ sgtReader: stubReader(new Map([[w.address, [m]]])), deviceProvider: async (h) => { seen.push(h.toString('hex')); return wallet().address; } });
  const r = await u.submit(await email(), w.address, { device: prove(u, w) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already linked to a different wallet/);
  assert.equal(seen[0], sgtHash(m).toString('hex'));
  const own = make({ sgtReader: stubReader(new Map([[w.address, [m]]])), deviceProvider: async () => w.address });
  assert.equal((await own.submit(await email(), w.address, { device: prove(own, w) })).ok, true);
});

test('a wallet that holds several phones\' tokens binds the first one nobody else uses', async () => {
  const [m1, m2] = [mint(), mint()].sort();
  const a = wallet();
  const b = wallet();
  const u = make({ sgtReader: stubReader(new Map([[a.address, [m1]], [b.address, [m2, m1]]])) });
  assert.equal((await u.submit(await email(), a.address, { device: prove(u, a) })).ok, true); // takes m1
  const r = await u.submit(await email(), b.address, { device: prove(u, b) });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deviceOf(r), sgtHash(m2));
});

test('an RPC outage is "try again", never "you do not own a Seeker"; nothing is spent', async () => {
  const w = wallet();
  const table = new Map([[w.address, new SgtUnavailable('mainnet RPC down')]]);
  const u = make({ sgtReader: stubReader(table) });
  const eml = await email();
  const r = await u.submit(eml, w.address, { device: prove(u, w) });
  assert.equal(r.ok, false);
  assert.equal(r.retry, true);
  assert.match(r.reason, /try again/);
  // the email was not used up: the same email goes through once the RPC is back
  table.set(w.address, [mint()]);
  const ok = await u.submit(eml, w.address, { device: prove(u, w) });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.seeker, true);
});

test('the SGT reader is mainnet only and read only', async () => {
  assert.throws(() => createSgtReader({ endpoint: 'https://api.devnet.solana.com' }), /MAINNET/);
  const bad = createSgtReader({ rpc: { getTokenAccountsByOwner: () => ({ send: async () => { throw new Error('boom'); } }) } });
  await assert.rejects(() => bad(bs58.encode(crypto.randomBytes(32))), SgtUnavailable);
});

// ---- the real HTTP app ---------------------------------------------------------------------------------------------

async function serve(u) {
  const server = createApp(u);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((res) => server.close(res)) };
}
const call = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, body: await r.json() }; };

test('HTTP: /device/nonce, then /underwrite with x-notch-device; outage is 503, junk header is 400', async () => {
  const m = mint();
  const w = wallet();
  const table = new Map([[w.address, [m]]]);
  const u = make({ sgtReader: stubReader(table) });
  const s = await serve(u);
  try {
    const ch = await call(`${s.base}/device/nonce`, { method: 'POST' });
    assert.equal(ch.status, 200);
    assert.equal(ch.body.chainId, 'solana:mainnet');
    assert.match(ch.body.nonce, /^[0-9a-f]{32}$/);
    const { ok, ...issued } = ch.body;
    const p = prove(u, w, { challenge: issued });
    const header = Buffer.from(JSON.stringify({ nonce: p.nonce, signature: Buffer.from(p.signature).toString('base64'), signedMessage: Buffer.from(p.signedMessage).toString('base64') })).toString('base64');
    const eml = await email();
    const res = await call(`${s.base}/underwrite`, { method: 'POST', body: eml, headers: signed(w, eml, { 'x-wallet': w.address, 'x-notch-device': header }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.seeker, true);
    assert.equal(Buffer.from(res.body.message, 'base64').length, RECORD_LEN_V3);
    // replaying the same header: refused
    const eml2 = await email();
    const again = await call(`${s.base}/underwrite`, { method: 'POST', body: eml2, headers: signed(w, eml2, { 'x-wallet': w.address, 'x-notch-device': header }) });
    assert.equal(again.status, 422);
    // junk header
    const junk = await call(`${s.base}/underwrite`, { method: 'POST', body: eml, headers: signed(w, eml, { 'x-wallet': w.address, 'x-notch-device': 'not-base64-json' }) });
    assert.equal(junk.status, 400);
    // outage
    const w2 = wallet();
    table.set(w2.address, new SgtUnavailable('down'));
    const issued2 = (await call(`${s.base}/device/nonce`, { method: 'POST' })).body;
    const p2 = prove(u, w2, { challenge: issued2 });
    const h2 = Buffer.from(JSON.stringify({ nonce: p2.nonce, signature: p2.signature, signedMessage: p2.signedMessage })).toString('base64');
    const eml3 = await email();
    const down = await call(`${s.base}/underwrite`, { method: 'POST', body: eml3, headers: signed(w2, eml3, { 'x-wallet': w2.address, 'x-notch-device': h2 }) });
    assert.equal(down.status, 503);
    assert.equal(down.body.retry, true);
  } finally {
    await s.close();
  }
});

test('record encoding: v3 only when a device is bound; zero device = plain v2', () => {
  const base = { wallet: wallet().address, limitUsdc: 10, expiry: 2_000_000_000, dedupe: crypto.randomBytes(32), nonce: 1n };
  assert.equal(encodeRecord(base).length, RECORD_LEN);
  assert.equal(encodeRecord({ ...base, deviceHash: Buffer.alloc(32) }).length, RECORD_LEN);
  const dev = crypto.randomBytes(32);
  const v3 = encodeRecord({ ...base, deviceHash: dev });
  assert.equal(v3.length, RECORD_LEN_V3);
  assert.deepEqual(v3.subarray(128), dev);
  assert.deepEqual(v3.subarray(8, 128), encodeRecord(base).subarray(8, 128)); // everything else is identical
  assert.throws(() => encodeRecord({ ...base, deviceHash: Buffer.alloc(31, 1) }), /32 bytes/);
});

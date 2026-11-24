// Statement inbox over real HTTP: /inbox/new, /inbound (what the Cloudflare worker calls), /record/<wallet>.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { verifyRecord } from '../src/record.js';
import { resolver, momoStatementEmail, syntheticRows, randomMsisdn } from './fixtures/emails.js';

const SECRET = 'test-inbound-secret';
const DOMAIN = 'inbox.example.test';
const servers = [];
after(() => servers.forEach((s) => s.close()));

async function boot(inboxOpts = {}) {
  const u = new Underwriter({ resolver, llm: null });
  const inbox = new Inbox({ domain: DOMAIN, secret: SECRET, ...inboxOpts });
  const server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
  const newInbox = async (w, extra = {}) => (await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify({ wallet: w, ...extra }) })).json();
  const inbound = (eml, rcpt, secret = SECRET) => fetch(`${base}/inbound`, { method: 'POST', body: eml, headers: { 'x-notch-rcpt': rcpt, ...(secret ? { 'x-notch-inbound-secret': secret } : {}) } });
  const record = async (w, token) => { const r = await fetch(`${base}/record/${w}`, { headers: token ? { 'x-notch-token': token } : {} }); return { status: r.status, body: await r.json() }; };
  return { u, inbox, base, wallet, newInbox, inbound, record };
}
const statement = (to, extra = {}) => momoStatementEmail({ to, msisdn: randomMsisdn(), ...extra });

test('/inbox/new gives each wallet its own address on the configured domain', async () => {
  const { wallet, newInbox, base } = await boot();
  const w = wallet();
  const a = await newInbox(w);
  const b = await newInbox(w);
  assert.equal(a.ok, true);
  assert.match(a.address, new RegExp(`^[a-z2-7]{10}@${DOMAIN.replace(/\./g, '\\.')}$`));
  assert.notEqual(a.address, b.address);
  assert.match(a.pollToken, /^[0-9a-f]{32}$/);
  assert.equal((await fetch(`${base}/inbox/new`, { method: 'POST', body: '{"wallet":"nope"}' })).status, 400);
  assert.equal((await fetch(`${base}/inbox/new`, { method: 'POST', body: 'x' })).status, 400);
});

test('a worker-forwarded statement becomes a signed record the wallet can fetch with its token', async () => {
  const { u, wallet, newInbox, inbound, record } = await boot();
  const w = wallet();
  const { address, pollToken } = await newInbox(w);
  assert.equal((await record(w, pollToken)).body.status, 'waiting');
  const r = await inbound(await statement(address), address);
  assert.equal(r.status, 200);
  const got = await record(w, pollToken);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, 'ready');
  assert.ok(got.body.limitUsdc > 20);
  assert.equal(verifyRecord(got.body.message, got.body.signature, bs58.decode(u.publicKey)), true);
  assert.equal(Buffer.from(got.body.message, 'base64').subarray(8, 40).toString('hex'), Buffer.from(bs58.decode(w)).toString('hex'));
  // the token is the only key to the result
  assert.equal((await record(w, 'f'.repeat(32))).status, 404);
  assert.equal((await record(w)).status, 404);
  assert.equal((await record(wallet(), pollToken)).status, 404);
});

test('the inbound endpoint needs the shared secret', async () => {
  const { wallet, newInbox, inbound } = await boot();
  const { address } = await newInbox(wallet());
  const eml = await statement(address);
  assert.equal((await inbound(eml, address, null)).status, 401);
  assert.equal((await inbound(eml, address, 'wrong')).status, 401);
  const off = await boot({ secret: '' });
  assert.equal((await off.inbound(eml, address, 'anything')).status, 503);
});

test('unknown codes, other domains and malformed recipients are refused', async () => {
  const { wallet, newInbox, inbound } = await boot();
  const { address } = await newInbox(wallet());
  const eml = await statement(address);
  for (const rcpt of [`aaaaaaaaaa@${DOMAIN}`, address.replace(/@.*/, '@other.example'), 'nobody', '', `${address.split('@')[0]}x@${DOMAIN}`]) {
    assert.equal((await inbound(eml, rcpt)).status, 404, rcpt);
  }
  assert.equal((await inbound(eml, address.toUpperCase())).status, 200, 'addresses are not case sensitive');
});

test('a code is single use: a second statement to the same address is refused', async () => {
  const { wallet, newInbox, inbound, record } = await boot();
  const w = wallet();
  const { address, pollToken } = await newInbox(w);
  assert.equal((await inbound(await statement(address), address)).status, 200);
  const again = await inbound(await statement(address), address);
  assert.equal(again.status, 410);
  assert.equal((await record(w, pollToken)).body.status, 'ready'); // the accepted record is untouched
});

test('a statement cannot be redirected to another wallet: the signed To header must name the address it arrived at', async () => {
  const { wallet, newInbox, inbound, record } = await boot();
  const alice = wallet();
  const mallory = wallet();
  const a = await newInbox(alice);
  const m = await newInbox(mallory);
  const forAlice = await statement(a.address);
  // Mallory got hold of Alice's statement and has the worker deliver it to Mallory's address
  const r = await inbound(forAlice, m.address);
  assert.equal(r.status, 422);
  assert.match((await r.json()).reason, /not addressed to this inbox/);
  assert.equal((await record(mallory, m.pollToken)).body.status, 'refused');
  // and Alice's own delivery still works
  assert.equal((await inbound(forAlice, a.address)).status, 200);
});

test('replays: the same statement again, or its rows re-sent to a fresh address, add nothing', async () => {
  const { wallet, newInbox, inbound } = await boot();
  const w = wallet();
  const msisdn = randomMsisdn();
  const rows = syntheticRows().map((r, i) => ({ ...r, txid: `8${String(100000000 + i)}` }));
  const a = await newInbox(w);
  const eml = await statement(a.address, { msisdn, rows });
  assert.equal((await inbound(eml, a.address)).status, 200);
  assert.equal((await inbound(eml, a.address)).status, 410); // same address
  const b = await newInbox(w);
  const resent = await inbound(await statement(b.address, { msisdn, rows }), b.address); // same rows, new mail
  assert.equal(resent.status, 422);
  assert.match((await resent.json()).reason, /no new income|already used/);
  const c = await newInbox(w);
  assert.equal((await inbound(eml, c.address)).status, 422); // the very same bytes at a new address: To mismatch
});

test('a tampered PDF breaks the DKIM signature and is refused', async () => {
  const { wallet, newInbox, inbound, record } = await boot();
  const w = wallet();
  const { address, pollToken } = await newInbox(w);
  const text = (await statement(address)).toString('latin1');
  const at = text.indexOf('Content-Transfer-Encoding: base64') + 300;
  const tampered = Buffer.from(text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1), 'latin1');
  const r = await inbound(tampered, address);
  assert.equal(r.status, 422);
  assert.match((await r.json()).reason, /DKIM/);
  assert.equal((await record(w, pollToken)).body.status, 'refused');
});

test('mail that is not from MTN, and wrong senders, never produce a record', async () => {
  const { wallet, newInbox, inbound } = await boot();
  const { address } = await newInbox(wallet());
  const r = await inbound(await statement(address, { domain: 'evil.example', from: 'MTN <ServiceMMStatement.GH@evil.example>' }), address);
  assert.equal(r.status, 422);
});

test('five refused messages lock the address', async () => {
  const { wallet, newInbox, inbound, record } = await boot();
  const w = wallet();
  const { address, pollToken } = await newInbox(w);
  for (let i = 0; i < 5; i++) assert.equal((await inbound(Buffer.from(`From: x@y.test\r\nTo: ${address}\r\n\r\nhi ${i}`), address)).status, 422);
  assert.equal((await inbound(await statement(address), address)).status, 429);
  assert.equal((await record(w, pollToken)).body.status, 'locked');
});

test('at most three open addresses per wallet: the oldest unused one is dropped', async () => {
  const { wallet, newInbox, inbound } = await boot();
  const w = wallet();
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await newInbox(w));
  assert.equal((await inbound(await statement(made[0].address), made[0].address)).status, 404);
  assert.equal((await inbound(await statement(made[3].address), made[3].address)).status, 200);
});

test('expired addresses are refused', async () => {
  let t = Date.now();
  const { wallet, newInbox, inbound } = await boot({ now: () => t, ttlMs: 1000 });
  const { address } = await newInbox(wallet());
  t += 2000;
  assert.equal((await inbound(await statement(address), address)).status, 410);
});

test('optional wallet proof: a signed request is accepted, a wrong or stale one is not, and it can be made mandatory', async () => {
  const { base, inbox } = await boot();
  void inbox;
  const kp = nacl.sign.keyPair();
  const w = bs58.encode(kp.publicKey);
  const ask = async (b) => (await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify(b) })).status;
  const sign = (wallet, ts, key = kp.secretKey) => Buffer.from(nacl.sign.detached(Buffer.from(`notch-inbox-v1|${wallet}|${ts}`), key)).toString('base64');
  const ts = Date.now();
  assert.equal(await ask({ wallet: w, ts, signature: sign(w, ts) }), 200);
  assert.equal(await ask({ wallet: w, ts, signature: sign(w, ts, nacl.sign.keyPair().secretKey) }), 401);
  assert.equal(await ask({ wallet: w, ts: ts - 3600_000, signature: sign(w, ts - 3600_000) }), 401);
  const strict = await boot({ requireWalletSig: true });
  const post = async (b) => (await fetch(`${strict.base}/inbox/new`, { method: 'POST', body: JSON.stringify(b) })).status;
  assert.equal(await post({ wallet: w }), 401);
  assert.equal(await post({ wallet: w, ts, signature: sign(w, ts) }), 200);
});

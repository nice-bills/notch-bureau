// Plus-address inbox (<local>+<code>@<domain>) and the AgentMail bridge. No network: AgentMail is a stub fetch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter } from '../src/underwriter.js';
import { Inbox, parseMailbox, recipientCode } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { AgentMailBridge, deliverOverHttp, handleAgentMailWebhook, realMailView, startAgentMailBridge } from '../src/agentmail-bridge.js';
import { resolver, momoStatementEmail, randomMsisdn } from './fixtures/emails.js';

const MAILBOX = 'notch-inbox@agentmail.to';
const KEY = 'am_test_key_do_not_log';
const servers = [];
after(() => servers.forEach((s) => s.close()));

const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const underwriter = () => new Underwriter({ resolver, llm: null });
const plusInbox = (extra = {}) => new Inbox({ address: MAILBOX, secret: 's', insecureAllowUnsignedForTests: true, ...extra });
const issue = async (inbox, w = wallet()) => ({ w, ...(await inbox.issue({ wallet: w })).body });
const statement = (to, extra = {}) => momoStatementEmail({ to, msisdn: randomMsisdn(), ...extra });
// the fixtures' key, for the bridge's own DKIM settings (real mail would use real DNS)
const fixtureDkim = { trusted: ['mtn.com'], resolver };

// A stub AgentMail: add(to, eml) puts a message in the inbox; every request is recorded.
function agentMail({ pageSize = 50 } = {}) {
  const messages = [];
  const calls = [];
  const fail = {}; // kind -> number of times to answer 500
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const kind = u.host === 'files.example.test' ? 'download' : u.pathname.endsWith('/raw') ? 'raw' : 'list';
    calls.push({ kind, url: String(url), auth: opts.headers?.authorization ?? null });
    if (fail[kind] > 0) { fail[kind]--; return json({}, 500); }
    if (kind === 'download') return new Response(messages.find((m) => u.pathname === `/${m.n}`).eml);
    if (kind === 'raw') {
      const id = decodeURIComponent(u.pathname.split('/').at(-2));
      const m = messages.find((x) => x.message_id === id);
      return json({ message_id: id, size: m.size ?? m.eml.length, download_url: `https://files.example.test/${m.n}?sig=SIGNED-LINK` });
    }
    const newest = [...messages].reverse();
    const from = Number(u.searchParams.get('page_token') || 0);
    return json({
      messages: newest.slice(from, from + pageSize).map(({ eml, n, size, ...m }) => m),
      ...(from + pageSize < newest.length ? { next_page_token: String(from + pageSize) } : {}),
    });
  };
  const add = (to, eml = Buffer.from('x'), extra = {}) => {
    const n = messages.length;
    messages.push({ n, message_id: `<m${n}/+@mail.example>`, to: [to], labels: ['received'], created_at: new Date().toISOString(), eml, ...extra });
  };
  return { fetchImpl, add, calls, fail, count: (kind) => calls.filter((c) => c.kind === kind).length };
}

function bridgeFor(mail, inbox, u, extra = {}) {
  const logs = [];
  const bridge = new AgentMailBridge({
    apiKey: KEY,
    address: MAILBOX,
    fetchImpl: mail.fetchImpl,
    deliver: (rcpt, eml) => inbox.receive(realMailView(u, fixtureDkim), { rcpt, eml, secret: inbox.secret }),
    knows: (rcpt) => inbox.knows(rcpt),
    log: (m) => logs.push(m),
    ...extra,
  });
  return { bridge, logs };
}

test('plus style: each code is <local>+<code>@<domain>; the default style is unchanged', async () => {
  const plus = await issue(plusInbox());
  assert.match(plus.address, /^notch-inbox\+[a-z2-7]{10}@agentmail\.to$/);
  assert.equal(plus.domainConfigured, true);
  const plain = await issue(new Inbox({ domain: 'inbox.example.test', insecureAllowUnsignedForTests: true }));
  assert.match(plain.address, /^[a-z2-7]{10}@inbox\.example\.test$/);
});

test('plus style: recipient -> code is case-insensitive and strict', () => {
  const inbox = plusInbox({ address: 'Notch-Inbox@AgentMail.to' });
  const code = 'abcde23456';
  assert.equal(inbox.codeOf(`NOTCH-INBOX+ABCDE23456@AGENTMAIL.TO`), code);
  for (const bad of [
    `${code}@agentmail.to`, `notch-inbox@agentmail.to`, `other+${code}@agentmail.to`, `notch-inbox+${code}@agentmail.com`,
    `notch-inbox+${code}x@agentmail.to`, `notch-inbox+x+${code}@agentmail.to`, `notch-inbox+abcde23451@agentmail.to`, `notch-inbox+${code}@agentmail.to@x`, '', undefined,
  ]) assert.equal(inbox.codeOf(bad), null, String(bad));
  assert.equal(recipientCode(`notch-inbox+${code}@agentmail.to`, { domain: 'agentmail.to' }), null, 'the default style refuses a plus address');
  assert.throws(() => parseMailbox('a+b@agentmail.to'), /NOTCH_INBOX_ADDRESS/);
  assert.throws(() => parseMailbox('nonsense'), /NOTCH_INBOX_ADDRESS/);
});

test('NOTCH_INBOX_ADDRESS switches the style; an explicit domain does not read it', () => {
  const before = process.env.NOTCH_INBOX_ADDRESS;
  process.env.NOTCH_INBOX_ADDRESS = MAILBOX;
  try {
    assert.equal(new Inbox().addressFor('abcde23456'), 'notch-inbox+abcde23456@agentmail.to');
    assert.equal(new Inbox({ domain: 'inbox.example.test' }).addressFor('abcde23456'), 'abcde23456@inbox.example.test');
  } finally {
    if (before === undefined) delete process.env.NOTCH_INBOX_ADDRESS; else process.env.NOTCH_INBOX_ADDRESS = before;
  }
});

test('plus style over /inbound: the DKIM-signed To must name this wallet address', async () => {
  const inbox = plusInbox();
  const server = createApp(underwriter(), inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const url = `http://127.0.0.1:${server.address().port}`;
  const alice = await issue(inbox);
  const bob = await issue(inbox);
  const deliver = deliverOverHttp({ url, secret: 's' });
  const forAlice = await statement(alice.address);
  const redirected = await deliver(bob.address, forAlice);
  assert.equal(redirected.status, 422);
  assert.match(redirected.body.reason, /not addressed to this inbox/);
  assert.equal((await deliver(alice.address.toUpperCase(), forAlice)).status, 200);
  assert.ok(inbox.poll(alice.w, alice.pollToken).body.limitUsdc > 0);
});

test('bridge: a trusted statement becomes a limit, once; the key never goes to the download link', async () => {
  const mail = agentMail();
  const inbox = plusInbox();
  const { w, address, pollToken } = await issue(inbox);
  const { bridge, logs } = bridgeFor(mail, inbox, underwriter());
  mail.add(address.toUpperCase(), await statement(address));
  assert.deepEqual(await bridge.pollOnce(), [{ status: 200, reason: null }]);
  assert.ok(inbox.poll(w, pollToken).body.limitUsdc > 0);
  assert.deepEqual(await bridge.pollOnce(), []);
  assert.equal(mail.count('raw'), 1);
  for (const c of mail.calls) assert.equal(c.auth, c.kind === 'download' ? null : `Bearer ${KEY}`, c.kind);
  assert.ok(mail.calls.find((c) => c.kind === 'raw').url.includes(encodeURIComponent('<m0/+@mail.example>')), 'message id is URL-encoded');
  assert.deepEqual(logs, ['agentmail: message handled: 200']);
});

test('bridge: an untrusted signer is refused and not retried; logs carry no mail details', async () => {
  const mail = agentMail();
  const inbox = plusInbox();
  const { address } = await issue(inbox);
  const { bridge, logs } = bridgeFor(mail, inbox, underwriter());
  mail.add(address, await statement(address, { domain: 'evil.example', from: 'x <x@evil.example>' }));
  const [r] = await bridge.pollOnce();
  assert.equal(r.status, 422);
  assert.match(r.reason, /untrusted signer/);
  assert.deepEqual(await bridge.pollOnce(), []);
  assert.deepEqual(logs, ['agentmail: message handled: 422 dkim_failed']);
});

test('bridge: mail for unknown codes, no code, or our own sending is never downloaded', async () => {
  const mail = agentMail();
  const inbox = plusInbox();
  const { address } = await issue(inbox);
  const { bridge } = bridgeFor(mail, inbox, underwriter());
  mail.add('notch-inbox+aaaaaaaaaa@agentmail.to');
  mail.add(MAILBOX);
  mail.add(address, Buffer.from('x'), { labels: ['sent'] });
  mail.add(address, Buffer.from('x'), { created_at: new Date(Date.now() - 3600_000).toISOString() }); // before the start-up horizon
  assert.deepEqual(await bridge.pollOnce(), []);
  assert.equal(mail.count('raw'), 0);
});

test('bridge: reads further pages', async () => {
  const mail = agentMail({ pageSize: 2 });
  const inbox = plusInbox();
  const { address } = await issue(inbox);
  const { bridge } = bridgeFor(mail, inbox, underwriter());
  mail.add(address, await statement(address));
  for (let i = 0; i < 4; i++) mail.add(MAILBOX);
  assert.deepEqual((await bridge.pollOnce()).map((r) => r.status), [200]);
});

test('bridge: failed downloads and busy or failing deliveries are retried with backoff, then dropped', async () => {
  const mail = agentMail();
  let t = Date.now();
  const answers = [503, 200];
  const logs = [];
  const bridge = new AgentMailBridge({ apiKey: KEY, address: MAILBOX, fetchImpl: mail.fetchImpl, now: () => t, log: (m) => logs.push(m), deliver: async () => ({ status: answers.shift(), body: {} }) });
  mail.add('notch-inbox+aaaaaaaaaa@agentmail.to');
  mail.fail.download = 1;
  assert.deepEqual(await bridge.pollOnce(), []); // download fails
  assert.deepEqual(await bridge.pollOnce(), []); // too soon
  assert.equal(mail.count('raw'), 1);
  t += 60_000;
  assert.deepEqual((await bridge.pollOnce()).map((r) => r.status), [503]);
  t += 60_000;
  assert.deepEqual((await bridge.pollOnce()).map((r) => r.status), [200]);
  t += 60_000;
  assert.deepEqual(await bridge.pollOnce(), []);

  const stubborn = new AgentMailBridge({ apiKey: KEY, address: MAILBOX, fetchImpl: mail.fetchImpl, now: () => t, maxAttempts: 2, log: (m) => logs.push(m), deliver: async () => { throw new Error(`secret text ${KEY}`); } });
  await stubborn.pollOnce();
  t += 60_000;
  await stubborn.pollOnce();
  t += 600_000;
  await stubborn.pollOnce();
  assert.equal(logs.at(-1), 'agentmail: gave up on a message');
  for (const line of logs) assert.ok(!line.includes(KEY) && !line.includes('SIGNED-LINK') && !line.includes('@'), line);
});

test('bridge: an oversized message is skipped', async () => {
  const mail = agentMail();
  const { bridge } = bridgeFor(mail, plusInbox(), underwriter(), { knows: null });
  mail.add('notch-inbox+aaaaaaaaaa@agentmail.to', Buffer.from('x'), { size: 6 * 1024 * 1024 });
  assert.deepEqual(await bridge.pollOnce(), []);
  assert.equal(mail.count('download'), 0);
});

test('real mail is checked with its own DKIM settings, never the demo underwriter test key', async () => {
  let seen;
  const u = { kinds: new Map([['mtn.com', 'statement-pdf'], ['wise.com', 'email-body']]), submit: async (e, w, opts) => { seen = opts; return {}; } };
  await realMailView(u).submit('eml', 'w', { recipient: 'r' });
  assert.deepEqual(seen, { recipient: 'r', dkim: { trusted: ['mtn.com', 'wise.com'] } });

  // end to end: an underwriter that trusts the fixture key refuses fixture mail when the delivery says "use this DNS instead"
  const inbox = plusInbox();
  const { address } = await issue(inbox);
  const noKeys = async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); };
  const r = await inbox.receive(realMailView(underwriter(), { trusted: ['mtn.com'], resolver: noKeys }), { rcpt: address, eml: await statement(address), secret: 's' });
  assert.equal(r.status, 422);
  assert.match(r.body.reason, /no passing DKIM signature/);
});

test('startAgentMailBridge: off without the env, refuses a mismatched inbox, gives itself a secret', () => {
  const env = { AGENTMAIL_API_KEY: KEY, NOTCH_INBOX_ADDRESS: MAILBOX };
  const quiet = { fetchImpl: async () => new Response('{"messages":[]}'), log: () => {} };
  assert.equal(startAgentMailBridge({ env: {}, inbox: plusInbox(), underwriter: underwriter() }), null);
  assert.equal(startAgentMailBridge({ env: { AGENTMAIL_API_KEY: KEY }, inbox: plusInbox(), underwriter: underwriter() }), null);
  assert.throws(() => startAgentMailBridge({ env, inbox: new Inbox({ domain: 'a.example.test' }), underwriter: underwriter() }), /same NOTCH_INBOX_ADDRESS/);
  const inbox = plusInbox({ secret: '' });
  const bridge = startAgentMailBridge({ env, inbox, underwriter: underwriter(), ...quiet });
  bridge.stop();
  assert.match(inbox.secret, /^[0-9a-f]{48}$/);
});

test('webhook: answers 202 and only asks for one poll', async () => {
  const mail = agentMail();
  const { bridge } = bridgeFor(mail, plusInbox(), underwriter());
  const sent = [];
  const req = { method: 'POST', resume() {} };
  const url = new URL('http://x/agentmail/webhook');
  for (let i = 0; i < 5; i++) assert.equal(handleAgentMailWebhook(bridge, req, url, (code) => sent.push(code)), true);
  assert.equal(handleAgentMailWebhook(null, req, url, () => {}), false);
  assert.equal(handleAgentMailWebhook(bridge, { method: 'GET' }, url, () => {}), false);
  await new Promise((r) => setTimeout(r, 30));
  bridge.stop();
  assert.deepEqual(sent, [202, 202, 202, 202, 202]);
  assert.equal(mail.count('list'), 1);
});

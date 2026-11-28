// "Forward as attachment" (src/forward.js): a statement that was only emailed to the borrower's own mailbox, attached to
// a mail from that mailbox to the wallet's inbox. Everything is synthetic and signed with the throwaway test key.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { dkimSign } from 'mailauth';
import { Underwriter } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { AgentMailBridge, deliverOverHttp, realMailView } from '../src/agentmail-bridge.js';
import { singleMailbox, verifyEmail } from '../src/dkim.js';
import { FORWARD_REASONS, MAX_ATTACHED_BYTES, attachedMessages, normaliseMailbox } from '../src/forward.js';
import { reasonCode } from '../src/status.js';
import { resolver, privateKey, momoStatementEmail, deelPayout, randomMsisdn, syntheticRows, MTN_SIGNED_HEADERS } from './fixtures/emails.js';

const SECRET = 'test-inbound-secret';
const MAILBOX = 'notch-inbox@agentmail.to';
const ME = 'ama.borrower@gmail.com';
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const servers = [];
after(() => servers.forEach((s) => s.close()));

const wallet = () => bs58.encode(nacl.sign.keyPair().publicKey);
const underwriter = () => new Underwriter({ resolver, llm: null });
const crlfB64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');

async function sign(msg, domain, headerList) {
  const { signatures } = await dkimSign(msg, { signatureData: [{ signingDomain: domain, selector: 'sel', privateKey: pem, ...(headerList ? { headerList } : {}) }] });
  return Buffer.from(signatures + msg.toString('latin1'), 'latin1');
}

// The original as the bank or provider sent it: to the borrower's own mailbox, To signed.
const original = ({ to = ME, ...extra } = {}) => momoStatementEmail({ to, msisdn: randomMsisdn(), ...extra });

const payout = ({ to = ME, body = deelPayout.body } = {}) => sign(Buffer.from([
  `From: ${deelPayout.from}`, `To: ${to}`, `Subject: ${deelPayout.subject}`, `Date: ${new Date().toUTCString()}`,
  `Message-ID: <${crypto.randomUUID()}@deel.com>`, '', body, '',
].join('\r\n')), 'deel.com');

// The borrower's mail, shaped like Gmail's "Forward as attachment".
async function forward(attached, {
  to,
  from = `Ama Borrower <${ME}>`,
  domain = /@([^>\s]+)>?$/.exec(from)[1],
  date = new Date(),
  headerList,
  encoding,
  text = 'See attached.',
} = {}) {
  const boundary = `000000000000${crypto.randomBytes(8).toString('hex')}`;
  const parts = [Buffer.from(`--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${text}\r\n`)];
  for (const eml of [attached].flat().filter(Boolean)) {
    parts.push(Buffer.from([
      `--${boundary}`,
      'Content-Type: message/rfc822; name="statement.eml"',
      'Content-Disposition: attachment; filename="statement.eml"',
      ...(encoding ? [`Content-Transfer-Encoding: ${encoding}`] : []),
      '', '',
    ].join('\r\n')), encoding === 'base64' ? Buffer.from(crlfB64(eml)) : eml, Buffer.from('\r\n'));
  }
  const head = [
    `From: ${from}`, `To: ${to}`, 'Subject: Fwd: your statement', `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@mail.example>`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '', '',
  ].join('\r\n');
  return sign(Buffer.concat([Buffer.from(head), ...parts, Buffer.from(`--${boundary}--\r\n`)]), domain, headerList);
}

const plusInbox = () => new Inbox({ address: MAILBOX, secret: SECRET, insecureAllowUnsignedForTests: true });
const issue = async (inbox, w = wallet()) => ({ w, ...(await inbox.issue({ wallet: w })).body });
// One delivery through the inbox's own receive path (what both servers call).
async function deliver(attached, { u = underwriter(), inbox = plusInbox(), w, ...opts } = {}) {
  const a = await issue(inbox, w);
  const eml = await forward(attached, { to: a.address, ...opts });
  const r = await inbox.receive(u, { rcpt: a.address, eml, secret: SECRET });
  return { ...a, eml, status: r.status, ...r.body, record: inbox.poll(a.w, a.pollToken).body };
}
const refused = (r, reason, note) => {
  assert.equal(r.status, 422, `${note ?? ''} ${r.reason ?? ''}`);
  assert.equal(r.reason, reason, note);
};

test('happy path over /inbound (local demo server): the forwarded original becomes a signed record', async () => {
  const inbox = plusInbox();
  const u = underwriter();
  const server = createApp(u, inbox);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const send = deliverOverHttp({ url: `http://127.0.0.1:${server.address().port}`, secret: SECRET });
  const a = await issue(inbox);
  const inner = await original();
  assert.equal((await send(a.address, await forward(inner, { to: a.address }))).status, 200);
  const got = inbox.poll(a.w, a.pollToken).body;
  assert.equal(got.status, 'ready');
  assert.ok(got.limitUsdc > 20);
  // the record's one-shot dedupe is the ORIGINAL's, so the chain refuses the same email however it arrives
  const { dedupe } = await verifyEmail(inner, { trusted: ['mtn.com'], resolver });
  assert.ok(Buffer.from(got.message, 'base64').includes(dedupe));
});

test('happy path over the AgentMail bridge (CVM and demo server): real-mail view, list and raw download', async () => {
  const inbox = plusInbox();
  const a = await issue(inbox);
  const eml = await forward(await original(), { to: a.address });
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const bridge = new AgentMailBridge({
    apiKey: 'am_test',
    address: MAILBOX,
    fetchImpl: async (url) => {
      const { host, pathname } = new URL(url);
      if (host === 'files.example.test') return new Response(eml);
      if (pathname.endsWith('/raw')) return json({ size: eml.length, download_url: 'https://files.example.test/0' });
      return json({ messages: [{ message_id: 'm0', to: [a.address], labels: ['received'], created_at: new Date().toISOString() }] });
    },
    deliver: (rcpt, mail) => inbox.receive(realMailView(underwriter(), { trusted: ['mtn.com'], resolver }), { rcpt, eml: mail, secret: SECRET }),
    knows: (rcpt) => inbox.knows(rcpt),
    log: () => {},
  });
  assert.deepEqual(await bridge.pollOnce(), [{ status: 200, reason: null }]);
  assert.ok(inbox.poll(a.w, a.pollToken).body.limitUsdc > 0);
});

test('accepted too: Gmail dots and +tags, a base64 attachment, a body-text payout, an original without its last line break', async () => {
  assert.equal((await deliver(await original({ to: 'A.m.a.borrower+bank@Gmail.com' }), { from: 'amaborrower@gmail.com' })).status, 200);
  assert.equal((await deliver(await original(), { encoding: 'base64' })).status, 200);
  assert.equal((await deliver(await payout())).status, 200);
  const inner = await original();
  assert.equal((await deliver(inner.subarray(0, inner.length - 2))).status, 200);
});

test('a provider that does not sign To on the forward (Outlook) falls under the unsigned-To date rule', async () => {
  const me = 'ama@outlook.com';
  const opts = { from: me, headerList: 'From:Date:Subject:Message-ID:Content-Type:MIME-Version' };
  assert.equal((await deliver(await original({ to: me }), opts)).status, 200);
  refused(await deliver(await original({ to: me }), { ...opts, date: new Date(Date.now() - 86400_000) }), FORWARD_REASONS.older);
});

test('an inline forward is refused with how to do it right', async () => {
  const r = await deliver(null, { text: '---------- Forwarded message ---------\r\nFrom: MTN MoMo <ServiceMMStatement.GH@mtn.com>' });
  refused(r, FORWARD_REASONS.inline);
  assert.match(r.reason, /forward it as an attachment, not inline/);
});

test('an attached original whose signature is missing or broken is refused', async () => {
  const inner = (await original()).toString('latin1');
  const edited = Buffer.from(inner.replace('Dear Customer', 'Dear Costumer'), 'latin1');
  const unsigned = Buffer.from(inner.slice(inner.indexOf('From: ')), 'latin1');
  for (const bad of [edited, unsigned]) refused(await deliver(bad), FORWARD_REASONS.brokenInner);
});

test('audit #3 stays closed: a copy of somebody else\'s statement cannot be forwarded from another mailbox', async () => {
  const stolen = await original({ to: 'victim@gmail.com' });
  const r = await deliver(stolen, { from: 'mallory@gmail.com' });
  refused(r, FORWARD_REASONS.otherMailbox);
  assert.match(r.reason, /different email than the one that forwarded it/);
  // dots are only ignored by Gmail
  refused(await deliver(await original({ to: 'a.ma@yahoo.com' }), { from: 'ama@yahoo.com' }), FORWARD_REASONS.otherMailbox);
  // a display name that quotes the victim does not make the forwarder the victim
  refused(await deliver(stolen, { from: '"victim@gmail.com" <mallory@gmail.com>', domain: 'gmail.com' }), FORWARD_REASONS.otherMailbox);
  // nor does listing the victim as well as somebody else in To, or the forwarder next to the victim
  refused(await deliver(await original({ to: 'victim@gmail.com, mallory@gmail.com' }), { from: 'mallory@gmail.com' }), FORWARD_REASONS.otherMailbox);
  refused(await deliver(stolen, { from: 'victim@gmail.com, mallory@gmail.com', domain: 'gmail.com' }), FORWARD_REASONS.outerSignature);
});

test('MTN does not sign To: a forwarded copy of its statement is refused (anyone could have rewritten To)', async () => {
  const mtn = await original({ headerList: MTN_SIGNED_HEADERS });
  refused(await deliver(mtn), FORWARD_REASONS.unsignedTo);
  const rewritten = Buffer.from(mtn.toString('latin1').replace(`To: ${ME}`, 'To: mallory@gmail.com'), 'latin1');
  refused(await deliver(rewritten, { from: 'mallory@gmail.com' }), FORWARD_REASONS.unsignedTo);
});

test('outer DKIM failures are refused: edited, unsigned, or signed by a domain that is not the From domain', async () => {
  const inbox = plusInbox();
  const u = underwriter();
  const inner = await original();
  const send = async (change) => {
    const a = await issue(inbox);
    const eml = change(await forward(inner, { to: a.address }));
    return (await inbox.receive(u, { rcpt: a.address, eml, secret: SECRET })).body.reason;
  };
  assert.equal(await send((e) => Buffer.from(e.toString('latin1').replace('See attached.', 'See attached!'), 'latin1')), FORWARD_REASONS.outerSignature);
  assert.equal(await send((e) => e.subarray(e.indexOf('From: '))), FORWARD_REASONS.outerSignature);
  for (const domain of ['evil.example', 'yahoo.com']) refused(await deliver(inner, { domain }), FORWARD_REASONS.outerSignature, domain);
});

test('a signing key that cannot be fetched is a retry, not a refusal', async () => {
  const flaky = async (name, rr) => {
    if (name.endsWith('gmail.com')) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    return resolver(name, rr);
  };
  const r = await deliver(await original(), { u: new Underwriter({ resolver: flaky, llm: null }) });
  assert.equal(r.status, 503);
  assert.equal(r.reason, FORWARD_REASONS.retry);
});

test('a forwarder domain that is not on the list is refused', async () => {
  for (const me of ['ama@evil.example', 'ama@sub.gmail.com', 'ama@gmail.com.evil.example']) {
    refused(await deliver(await original({ to: me }), { from: me }), FORWARD_REASONS.provider, me);
  }
});

test('an attached mail that no trusted income sender signed is refused', async () => {
  const fake = await original({ domain: 'evil.example', from: 'MTN MoMo <statements@evil.example>' });
  refused(await deliver(fake), FORWARD_REASONS.innerSigner);
  const stranger = new Underwriter({ resolver, llm: null, trusted: ['bank.test'] });
  refused(await deliver(await original(), { u: stranger }), FORWARD_REASONS.innerSigner);
});

test('the forward must be addressed to this wallet\'s inbox: it cannot be redirected', async () => {
  const inbox = plusInbox();
  const alice = await issue(inbox);
  const mallory = await issue(inbox);
  const eml = await forward(await original(), { to: alice.address });
  const r = await inbox.receive(underwriter(), { rcpt: mallory.address, eml, secret: SECRET });
  assert.equal(r.body.reason, FORWARD_REASONS.notThisInbox);
});

test('replay: the same original uploaded directly, then forwarded, counts once', async () => {
  const u = underwriter();
  const w = wallet();
  const inner = await payout();
  assert.equal((await u.submit(inner, w)).ok, true);
  refused(await deliver(inner, { u, w }), 'email already used');
});

test('replay: a forwarded original is spent: forwarded again, to another wallet, or sent directly', async () => {
  const u = underwriter();
  const inbox = plusInbox();
  const w = wallet();
  const inner = await payout();
  assert.equal((await deliver(inner, { u, inbox, w })).status, 200);
  refused(await deliver(inner, { u, inbox, w }), 'email already used');
  refused(await deliver(inner, { u, inbox }), 'email already used');
  assert.deepEqual(await u.submit(inner, w), { ok: false, reason: 'email already used' });
});

test('replay: the same statement rows in a second original add nothing, forwarded or sent to the inbox', async () => {
  const u = underwriter();
  const inbox = plusInbox();
  const w = wallet();
  const msisdn = randomMsisdn();
  const rows = syntheticRows().map((r, i) => ({ ...r, txid: `7${String(100000000 + i)}` }));
  const a = await issue(inbox, w);
  assert.equal((await inbox.receive(u, { rcpt: a.address, eml: await original({ to: a.address, msisdn, rows }), secret: SECRET })).status, 200);
  assert.match((await deliver(await original({ msisdn, rows }), { u, inbox, w })).reason, /already counted/);
});

test('one mobile-money account still backs one wallet through a forward', async () => {
  const u = underwriter();
  const msisdn = randomMsisdn();
  assert.equal((await deliver(await original({ msisdn }), { u })).status, 200);
  assert.match((await deliver(await original({ msisdn }), { u })).reason, /already linked to a different wallet/);
});

test('exactly one attachment, no nested forwards, size limits', async () => {
  refused(await deliver([await original(), await original()]), FORWARD_REASONS.tooMany);
  const nested = await forward(await original(), { to: ME });
  refused(await deliver(nested), FORWARD_REASONS.nested);
  const huge = await payout({ body: `${deelPayout.body}\r\n${'x'.repeat(70).concat('\r\n').repeat(Math.ceil(MAX_ATTACHED_BYTES / 72))}` });
  refused(await deliver(huge), FORWARD_REASONS.tooLarge);
});

test('a forward is never accepted by the direct upload path', async () => {
  const r = await underwriter().submit(await forward(await original(), { to: ME }), wallet());
  assert.equal(r.ok, false);
  assert.match(r.reason, /untrusted signer/);
});

test('refusal reasons carry no address, and map to the fixed public status words', () => {
  const words = {
    inline: 'no_statement', brokenInner: 'no_statement', tooMany: 'no_statement', nested: 'no_statement',
    notThisInbox: 'wrong_inbox', older: 'wrong_inbox', ahead: 'wrong_inbox', untied: 'wrong_inbox', unsignedTo: 'wrong_inbox', otherMailbox: 'wrong_inbox',
    provider: 'dkim_failed', outerSignature: 'dkim_failed', innerSigner: 'dkim_failed',
    unreadable: 'unreadable', tooLarge: 'other', retry: 'unreadable',
  };
  assert.deepEqual(Object.keys(words).sort(), Object.keys(FORWARD_REASONS).sort());
  for (const [key, text] of Object.entries(FORWARD_REASONS)) {
    assert.equal(reasonCode(text), words[key], key);
    assert.doesNotMatch(text, /@|dkim/i, key);
  }
});

test('mailbox parsing and the attachment cutter', () => {
  assert.equal(singleMailbox('Ama <Ama@Gmail.com>'), 'ama@gmail.com');
  assert.equal(singleMailbox('"Mensah, Ama" <ama@gmail.com>'), 'ama@gmail.com');
  assert.equal(singleMailbox('ama@gmail.com'), 'ama@gmail.com');
  for (const bad of ['a@x.com, b@x.com', 'A <a@x.com>, B <b@x.com>', 'group: a@x.com;', '"a@x.com"@evil.example', 'a@x.com <b@x.com>', '', null]) {
    assert.equal(singleMailbox(bad), null, String(bad));
  }
  assert.equal(normaliseMailbox('A.B+c@gmail.com'), 'ab@gmail.com');
  assert.equal(normaliseMailbox('A.B+c@outlook.com'), 'a.b+c@outlook.com');
  const inner = 'From: x@y.test\r\n\r\nhello\r\n';
  const mail = `Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\nContent-Type: multipart/mixed;\r\n boundary=i\r\n\r\n--i\r\nContent-Type: message/rfc822\r\n\r\n${inner}\r\n--i--\r\n--o--\r\n`;
  assert.deepEqual(attachedMessages(Buffer.from(mail)).map(String), [inner]);
});

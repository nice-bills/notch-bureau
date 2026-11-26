#!/usr/bin/env node
// End to end over the REAL AgentMail service, with an underwriter started in this process (nothing is deployed).
//
//   set -a; . ~/.config/notch/agentmail.env; set +a
//   node enclave/scripts/e2e-agentmail.mjs
//
//  A. LIVE: a wallet gets <mailbox>+<code>@..., a second AgentMail inbox mails it, the bridge fetches the raw message and
//     the pipeline runs. It must be REFUSED as an untrusted signer: agentmail.to is not a statement provider.
//  B. STUBBED mail service, same bridge code: a synthetic MoMo statement signed with the test key (trusted for this part
//     only) gives a limit. AgentMail cannot send one: only the provider can sign as the provider.
//
// PRIVACY: the shared mailbox may hold real statements. Only messages addressed to the codes issued here are downloaded,
// and nothing about any message is printed.
//
// Env: NOTCH_INBOX_ADDRESS (default notch-inbox@agentmail.to), AGENTMAIL_SENDER_INBOX (default doesnotexist@agentmail.to).
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Underwriter } from '../src/underwriter.js';
import { Inbox } from '../src/inbox.js';
import { createApp } from '../src/http-app.js';
import { AgentMailBridge, deliverInProcess, startAgentMailBridge } from '../src/agentmail-bridge.js';
import { resolver, momoStatementEmail, randomMsisdn } from '../test/fixtures/emails.js';

const apiKey = process.env.AGENTMAIL_API_KEY;
if (!apiKey) {
  console.error('set AGENTMAIL_API_KEY (set -a; . ~/.config/notch/agentmail.env; set +a)');
  process.exit(1);
}
const address = process.env.NOTCH_INBOX_ADDRESS || 'notch-inbox@agentmail.to';
const sender = process.env.AGENTMAIL_SENDER_INBOX || 'doesnotexist@agentmail.to';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

const u = new Underwriter({ resolver, llm: null, idPepper: crypto.randomBytes(32).toString('hex') });
const inbox = new Inbox({ address, secret: crypto.randomBytes(24).toString('hex') });
const server = createApp(u, inbox);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function newCode() {
  const kp = nacl.sign.keyPair();
  const wallet = bs58.encode(kp.publicKey);
  const ts = Date.now();
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(`notch-inbox-v1|${wallet}|${ts}`), kp.secretKey)).toString('base64');
  const j = await (await fetch(`${base}/inbox/new`, { method: 'POST', body: JSON.stringify({ wallet, ts, signature }) })).json();
  const record = async () => (await fetch(`${base}/record/${wallet}`, { headers: { 'x-notch-token': j.pollToken } })).json();
  return { ...j, record };
}

// A. the live path, wired exactly as the demo and CVM servers wire it
const live = await newCode();
const [local, domain] = address.toLowerCase().split('@');
check('A the wallet gets its own plus address', live.ok === true && new RegExp(`^${local.replace(/\./g, '\\.')}\\+[a-z2-7]{10}@${domain.replace(/\./g, '\\.')}$`).test(live.address));
const bridge = startAgentMailBridge({ env: { ...process.env, NOTCH_INBOX_ADDRESS: address }, inbox, underwriter: u, pollMs: 5000 });
try {
  const started = Date.now();
  const sent = await fetch(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(sender)}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: [live.address], subject: 'Notch inbox test', text: 'Automated test of the statement inbox. Not a statement.' }),
    signal: AbortSignal.timeout(30_000),
  });
  check('A test mail sent from the second inbox', sent.ok, `HTTP ${sent.status}`);
  let got = { status: 'waiting' };
  while (sent.ok && got.status === 'waiting' && Date.now() - started < 180_000) {
    await new Promise((r) => setTimeout(r, 3000));
    got = await live.record();
  }
  check('A the bridge picked it up and the pipeline ran', got.status === 'refused', `${got.status} after ${Math.round((Date.now() - started) / 1000)} s`);
  // the reason names only signing domains of our own test mail
  check('A refused as an untrusted signer', /^untrusted signer/.test(got.reason || ''), got.reason || '');
} finally {
  bridge.stop();
}

// B. the same bridge, a stubbed mail service, a statement signed by a trusted domain (test key)
const good = await newCode();
const eml = await momoStatementEmail({ to: good.address, msisdn: randomMsisdn() });
const stub = async (url) => {
  const { host, pathname } = new URL(url);
  if (host === 'files.invalid') return new Response(eml);
  if (pathname.endsWith('/raw')) return Response.json({ size: eml.length, download_url: 'https://files.invalid/raw' });
  return Response.json({ messages: [{ message_id: '<fixture@mtn.com>', to: [good.address], labels: ['received'], created_at: new Date().toISOString() }] });
};
const fixtureBridge = new AgentMailBridge({
  apiKey: 'stub',
  address,
  fetchImpl: stub,
  deliver: deliverInProcess({ inbox, underwriter: u, dkim: { trusted: ['mtn.com'], resolver } }),
  knows: (rcpt) => inbox.knows(rcpt),
});
const results = await fixtureBridge.pollOnce();
check('B the bridge delivered the trusted fixture', results.length === 1 && results[0].status === 200);
const ready = await good.record();
check('B it gives a signed limit', ready.status === 'ready' && ready.limitUsdc > 0 && Boolean(ready.signature), `status ${ready.status}${ready.limitUsdc ? `, synthetic limit ${ready.limitUsdc} USDC` : ''}`);

server.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

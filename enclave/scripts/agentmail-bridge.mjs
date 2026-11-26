#!/usr/bin/env node
// Runs the AgentMail bridge on its own, in front of an underwriter that is already up (enclave/src/server.js): new mail in
// the shared inbox is posted to its /inbound with the shared secret. The demo and CVM servers do not need this: they run
// the bridge inside their own process when AGENTMAIL_API_KEY and NOTCH_INBOX_ADDRESS are set (do not run both).
//
//   set -a; . ~/.config/notch/agentmail.env; set +a
//   NOTCH_INBOX_ADDRESS=notch-inbox@agentmail.to NOTCH_INBOUND_SECRET=... node enclave/scripts/agentmail-bridge.mjs
//
// NOTCH_UNDERWRITER_URL (default http://localhost:8787); the underwriter needs the same NOTCH_INBOX_ADDRESS and secret.
import { AgentMailBridge, deliverOverHttp } from '../src/agentmail-bridge.js';

const { AGENTMAIL_API_KEY, NOTCH_INBOX_ADDRESS, NOTCH_INBOUND_SECRET } = process.env;
const missing = Object.entries({ AGENTMAIL_API_KEY, NOTCH_INBOX_ADDRESS, NOTCH_INBOUND_SECRET }).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`set ${missing.join(', ')}`);
  process.exit(1);
}
const url = process.env.NOTCH_UNDERWRITER_URL || 'http://localhost:8787';
new AgentMailBridge({
  apiKey: AGENTMAIL_API_KEY,
  address: NOTCH_INBOX_ADDRESS,
  deliver: deliverOverHttp({ url, secret: NOTCH_INBOUND_SECRET }),
  pollMs: Number(process.env.NOTCH_AGENTMAIL_POLL_MS) || 10_000,
  lookbackMs: 60 * 60_000,
}).start();
console.log(`agentmail bridge on: polling, delivering to ${url}/inbound`);

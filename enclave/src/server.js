import fs from 'node:fs';
import { Underwriter } from './underwriter.js';
import { llmConfigFromEnv } from './llm-extract.js';
import { getCreditHistory, getIdentityOwner } from './chain-history.js';
import { Inbox } from './inbox.js';
import { createStoreFromEnv } from './store.js';
import { createAuthFromEnv } from './supabase-auth.js';
import { createApp } from './http-app.js';

// Key persistence for the prototype. Inside TDX this key is generated in the enclave and never written out.
const KEY_FILE = process.env.NOTCH_KEY_FILE || '.underwriter-key.json';
let secretKey;
if (fs.existsSync(KEY_FILE)) secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')));
const u = new Underwriter({ secretKey, historyProvider: getCreditHistory, identityProvider: getIdentityOwner, llm: llmConfigFromEnv() });
if (!secretKey) fs.writeFileSync(KEY_FILE, JSON.stringify(Array.from(u.keys.secretKey)), { mode: 0o600 });

const inbox = new Inbox({ store: createStoreFromEnv(), auth: createAuthFromEnv() }); // memory + wallet-signature only unless NOTCH_STORE / SUPABASE_* are set

const port = Number(process.env.PORT || 8787);
createApp(u, inbox).listen(port, () =>
  console.log(`notch underwriter ${u.publicKey} on :${port} (extraction: ${u.llm ? `llm ${u.llm.model}` : 'rules'}; inbox ${inbox.domain}${inbox.secret ? '' : ', inbound DISABLED: set NOTCH_INBOUND_SECRET'})`));

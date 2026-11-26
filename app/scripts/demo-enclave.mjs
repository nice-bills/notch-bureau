#!/usr/bin/env node
// Demo underwriter for local rehearsals and the live demo.
//
// The real enclave (enclave/src/server.js) checks DKIM against real DNS, so a synthetic email
// cannot pass it. This script reuses the same Underwriter class and the same test fixtures, but
// resolves DKIM keys from a throwaway key made at start-up. It also writes three sample .eml
// files into app/public/samples/ so the Borrow screen's "demo sample" buttons work.
//
//   pnpm demo:enclave          # serves on :8787 (PORT=... to change)
//
// Samples are re-signed on every start with a fresh key, so restart => regenerate => reload the page.
// The Underwriter keeps its signing key in memory only (new key every start), so run
// `pnpm setup:devnet --send --enclave-url http://localhost:8787` AFTER starting this, or the program
// will trust a different key. Use NOTCH_KEY_FILE=... to keep one key across restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeUnderwriter, makeServer, fixtures, readEnv } from './enclave-lib.mjs';
import { InboxedUnderwriter } from '../../enclave/test/fixtures/inboxed.js';
import { llmConfigFromEnv } from '../../enclave/src/llm-extract.js';
import { pepperOrExit } from '../../enclave/src/pepper.js';
import { Inbox } from '../../enclave/src/inbox.js';
import { createStoreFromEnv } from '../../enclave/src/store.js';
import { createAuthFromEnv } from '../../enclave/src/supabase-auth.js';
import crypto from 'node:crypto';
import os from 'node:os';
import { createFaucet } from './faucet.mjs';

// A secret pepper is required (NOTCH_ID_PEPPER, `openssl rand -hex 32`): without it the phone-number hash on chain can be
// brute-forced. For a local rehearsal ONLY, NOTCH_INSECURE_NO_PEPPER=1 starts without one and prints a loud warning.
// Checked first, before this script writes anything.
const idPepper = pepperOrExit();

const { signedEmail, momoStatementEmail, randomMsisdn, deelPayout, bankStatement } = fixtures;
const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(here, '..', 'public', 'samples');
fs.mkdirSync(samplesDir, { recursive: true });

// MTN MoMo Ghana sends a statement (PDF on a signed email), not a per-payment email.
fs.writeFileSync(path.join(samplesDir, 'momo.eml'), await momoStatementEmail({ msisdn: randomMsisdn() }));
for (const [file, f] of [['deel.eml', deelPayout], ['bank.eml', bankStatement]]) {
  const eml = await signedEmail({ body: f.body, domain: f.domain, from: f.from, subject: f.subject });
  fs.writeFileSync(path.join(samplesDir, file), eml);
}

// The AI reader is on when enclave/.env (or the shell) sets NOTCH_LLM_URL + NOTCH_LLM_MODEL; NOTCH_LLM=off forces rules only.
const llm = process.env.NOTCH_LLM === 'off' ? null : llmConfigFromEnv({ ...readEnv(path.join(here, '..', '..', 'enclave', '.env')), ...process.env });
// DEMO ONLY: the frozen UI's "MTN MoMo payment" button posts a fixture statement straight to /underwrite. A real enclave refuses that
// (statements only through the inbox, audit #3); this local demo server treats its own fixtures as delivered to the fixtures' inbox.
const u = makeUnderwriter(process.env.NOTCH_KEY_FILE, { llm, idPepper, cls: InboxedUnderwriter });
// The statement inbox, as on the real enclave. Status rows go to memory, or to Supabase when NOTCH_STORE=supabase and
// SUPABASE_* are set (then the app can watch them live over Realtime). The inbound secret is random per start: only this
// process (its demo mailer) can deliver, there is no mail worker in a local demo.
const inbox = new Inbox({ domain: process.env.NOTCH_INBOX_DOMAIN || 'inbox.notch.invalid', secret: crypto.randomBytes(24).toString('hex'), store: createStoreFromEnv(), auth: createAuthFromEnv() });
// DEMO ONLY: a devnet faucet (SOL for fees + test USDC) when a mint-authority key is around: NOTCH_FAUCET_KEYPAIR, the e2e admin,
// or ~/.config/solana/id.json (the key devnet-setup.mjs used). RPC and mint come from app/.env.local unless the shell overrides them.
const appEnv = { ...readEnv(path.join(here, '..', '.env.local')), ...process.env };
const faucet = await createFaucet({
  keypairFile: process.env.NOTCH_FAUCET_KEYPAIR || process.env.E2E_ADMIN_KEYPAIR || path.join(os.homedir(), '.config/solana/id.json'),
  rpcUrl: appEnv.VITE_RPC_URL || 'https://api.devnet.solana.com',
  mint: appEnv.VITE_USDC_MINT,
}).catch((e) => { console.warn(`faucet off: ${e.message}`); return null; });
const server = makeServer(u, { inbox, faucet });
const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`demo underwriter ${u.publicKey} on :${port} (reader: ${u.llm ? `AI ${u.llm.model}` : 'rules'}; fresh samples at /samples/{momo,deel,bank}.eml)`);
  console.log(`sample emails written to ${samplesDir}`);
  console.log(`statement inbox: ${inbox.domain} (status store: ${inbox.store.kind || 'memory'}${inbox.auth ? ', Sign in with Solana on' : ''}); demo mailer at POST /demo/deliver`);
  console.log(faucet ? `devnet faucet on (POST /demo/faucet, key ${faucet.admin})` : 'devnet faucet off (no mint-authority key or mainnet RPC)');
});

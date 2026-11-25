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
const server = makeServer(u);
const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`demo underwriter ${u.publicKey} on :${port} (reader: ${u.llm ? `AI ${u.llm.model}` : 'rules'}; fresh samples at /samples/{momo,deel,bank}.eml)`);
  console.log(`sample emails written to ${samplesDir}`);
});

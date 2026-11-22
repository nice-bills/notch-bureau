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
import { llmConfigFromEnv } from '../../enclave/src/llm-extract.js';

const { signedEmail, momoGhana, deelPayout, bankStatement } = fixtures;
const here = path.dirname(fileURLToPath(import.meta.url));
const samplesDir = path.join(here, '..', 'public', 'samples');
fs.mkdirSync(samplesDir, { recursive: true });

for (const [file, f] of [['momo.eml', momoGhana], ['deel.eml', deelPayout], ['bank.eml', bankStatement]]) {
  const eml = await signedEmail({ body: f.body, domain: f.domain, from: f.from, subject: f.subject });
  fs.writeFileSync(path.join(samplesDir, file), eml);
}

// The AI reader is on when enclave/.env (or the shell) sets NOTCH_LLM_URL + NOTCH_LLM_MODEL; NOTCH_LLM=off forces rules only.
const llm = process.env.NOTCH_LLM === 'off' ? null : llmConfigFromEnv({ ...readEnv(path.join(here, '..', '..', 'enclave', '.env')), ...process.env });
const u = makeUnderwriter(process.env.NOTCH_KEY_FILE, { llm });
const server = makeServer(u);
const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`demo underwriter ${u.publicKey} on :${port} (reader: ${u.llm ? `AI ${u.llm.model}` : 'rules'}; fresh samples at /samples/{momo,deel,bank}.eml)`);
  console.log(`sample emails written to ${samplesDir}`);
});

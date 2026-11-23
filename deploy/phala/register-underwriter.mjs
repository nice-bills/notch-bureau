#!/usr/bin/env node
// Point the devnet Notch program at an underwriter key, but only after the attestation check passes.
//
//   node deploy/phala/register-underwriter.mjs <cvm-url> [--allow-demo] [--expect-compose-hash <hex>] [--days 30]
//   node deploy/phala/register-underwriter.mjs --local          # restore the local demo key (.underwriter-key.json)
//
// What this is, honestly: the program's `set_underwriter` is still ADMIN-set. This script makes that admin step
// conditional on a public, reproducible check (enclave/scripts/verify-attestation.mjs: real Intel TDX quote, key
// bound in report_data, code bundle == this repo). Anyone can rerun the same check against the same URL and
// compare compose-hash and key. The program itself does not verify any quote; that waits for Solana Confidential
// Compute's on-chain verifier + SDK. Devnet only (genesis hash checked), admin = ~/.config/solana/id.json.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { verifyAttestation } from '../../enclave/scripts/verify-attestation.mjs';
import { LOCAL_KEY_FILE, connect, readUnderwriter, setUnderwriter } from './chain.mjs';

export function localUnderwriterPubkey(file = LOCAL_KEY_FILE) {
  const sk = Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')));
  return bs58.encode(nacl.sign.keyPair.fromSecretKey(sk).publicKey);
}

/** Verify the CVM, then register its key. Throws (and sends nothing) if verification fails. */
export async function registerAttested(url, { allowDemo = false, expectComposeHash, days = 30, ctx, log = console.log } = {}) {
  const v = await verifyAttestation(url, { expectComposeHash });
  for (const c of v.checks) log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!v.ok) throw new Error('attestation did not verify; nothing was registered');
  if (v.demo && !allowDemo) throw new Error('this CVM runs DEMO_FIXTURES=1 (synthetic DKIM key); pass --allow-demo to register it on devnet anyway');
  ctx ||= await connect();
  const before = await readUnderwriter(ctx.rpc, ctx.A);
  log(`on-chain underwriter before: ${before.underwriter}`);
  const tx = await setUnderwriter(ctx, v.underwriter, days, log);
  return { verification: v, before, ...tx };
}

export async function registerLocal({ ctx, log = console.log } = {}) {
  ctx ||= await connect();
  const pub = localUnderwriterPubkey();
  const before = await readUnderwriter(ctx.rpc, ctx.A);
  log(`on-chain underwriter before: ${before.underwriter}`);
  if (before.underwriter === pub) { log('already the local demo key; nothing to do'); return { before }; }
  const tx = await setUnderwriter(ctx, pub, 365, log);
  return { before, ...tx };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const o = { days: 30 };
  let url = null;
  let local = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') local = true;
    else if (a === '--allow-demo') o.allowDemo = true;
    else if (a === '--expect-compose-hash') o.expectComposeHash = argv[++i];
    else if (a === '--days') o.days = Number(argv[++i]);
    else if (!a.startsWith('-') && !url) url = a;
    else { console.error('unknown option ' + a); process.exit(2); }
  }
  try {
    if (local) {
      const r = await registerLocal();
      console.log(`registered local demo key ${localUnderwriterPubkey()}${r.sig ? `  (${r.sig})` : ''}`);
    } else {
      if (!url) { console.error('usage: register-underwriter.mjs <cvm-url> [--allow-demo] | --local'); process.exit(2); }
      const r = await registerAttested(url, o);
      console.log(`registered ${r.verification.underwriter} (compose-hash ${r.verification.measurement.composeHash}) tx ${r.sig}`);
    }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exit(1);
  }
}

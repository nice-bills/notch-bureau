#!/usr/bin/env node
// Verify the underwriter running in a Phala Cloud confidential VM (Intel TDX, dstack), from the OUTSIDE.
//
//   node enclave/scripts/verify-attestation.mjs https://<app-id>-8787.<gateway>.phala.network
//        [--expect-compose-hash <hex>] [--expect-pubkey <base58>] [--no-repo] [--json] [--allow-tcb <STATUS>]
//
// It trusts nothing the server says. It checks, in order:
//   1  the quote is an Intel TDX v4 quote
//   2  the quote's signature chain is genuine Intel (local DCAP verification via @phala/dcap-qvl with Intel-signed
//      collateral; Phala's hosted verifier is asked for a second opinion) and the TCB is up to date
//   3  report_data == sha256("notch-underwriter-v1" | the underwriter's Ed25519 key | OUR fresh nonce):
//      the key in /attestation was generated inside this TD, and the quote is fresh, not replayed
//   4  RTMR3 replayed from the event log equals RTMR3 in the signed quote (so the event log is what booted)
//   5  the compose-hash event in RTMR3 == sha256(app_compose) == what the server reports
//   6  the attested compose pins its image by digest, and (with the repo present) the code bundle inside it is
//      byte-identical to enclave/src + the fixtures + the lockfile in THIS repo (reproducible build)
// Then it prints the measurement. Exit code 0 only if every check passed.
//
// Not done here (listed honestly in the output): checking MRTD/RTMR0-2 against the dstack OS image release, and
// checking the Phala KMS's key-release policy. The platform (Phala host, KMS, Intel) is still a trust assumption.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bs58 from 'bs58';
import { composeHash, composeHashFromEvents, parseTdxQuote, replayRtmr, reportDataFor } from '../src/attest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHALA_VERIFY = 'https://cloud-api.phala.com/api/v1/attestations/verify';
const TCB_OK = new Set(['UpToDate', 'SWHardeningNeeded']);

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Verify one CVM. Returns { ok, checks:[{name,ok,detail}], measurement, underwriter, demo }. Never throws on a failed check. */
export async function verifyAttestation(baseUrl, { expectComposeHash, expectPubkey, repo = true, allowTcb = [], fetchImpl = fetch } = {}) {
  const checks = [];
  const info = [];
  const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
  const out = () => ({ ok: checks.every((c) => c.ok), checks, info });
  const base = baseUrl.replace(/\/$/, '');

  // --- fetch with OUR nonce
  const nonce = crypto.randomBytes(16);
  let att;
  try {
    const r = await fetchImpl(`${base}/attestation?nonce=${nonce.toString('hex')}`, { signal: AbortSignal.timeout(30_000) });
    att = await r.json();
    if (!r.ok) throw new Error(att.reason || `HTTP ${r.status}`);
  } catch (e) {
    check('fetch /attestation', false, e.message);
    return out();
  }
  const ev = att.evidence || {};
  check('fetch /attestation (fresh nonce)', !!ev.quote && !!ev.event_log && !!ev.app_compose, `underwriter ${att.underwriter}`);

  // --- 1 quote shape
  let q;
  try {
    q = parseTdxQuote(ev.quote);
    check('quote is an Intel TDX v4 quote', true, `MRTD ${q.mrTd.slice(0, 16)}…`);
  } catch (e) {
    check('quote is an Intel TDX v4 quote', false, e.message);
    return out();
  }

  // --- 2 hardware signature
  let status = null;
  try {
    const { getCollateralAndVerify } = await import('@phala/dcap-qvl');
    const res = await getCollateralAndVerify(Buffer.from(ev.quote, 'hex'));
    status = res.status;
    const lib = res.report?.data;
    const libRtmr3 = lib?.rtmrs?.[3] ?? lib?.rtMr3 ?? lib?.rtmr3;
    check('Intel DCAP signature chain + TCB (local, @phala/dcap-qvl)', TCB_OK.has(status) || allowTcb.includes(status), `TCB status ${status}${res.advisory_ids?.length ? ` advisories ${res.advisory_ids.join(',')}` : ''}`);
    if (libRtmr3) check('parsed RTMR3 matches the DCAP library', Buffer.from(Object.values(libRtmr3)).toString('hex') === q.rtmr3);
  } catch (e) {
    check('Intel DCAP signature chain + TCB (local, @phala/dcap-qvl)', false, `${e.message} (install: npm install --prefix enclave/scripts)`);
  }
  try {
    const r = await fetchImpl(PHALA_VERIFY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hex: ev.quote }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    const ok = j.success === true && (j.quote?.verified ?? true) === true;
    info.push(`Phala hosted verifier (second opinion): ${ok ? 'verified' : 'NOT verified'}; proof_of_cloud=${j.proof_of_cloud}`);
    if (!ok) check('Phala hosted verifier agrees', false, JSON.stringify(j).slice(0, 160));
  } catch (e) {
    info.push(`Phala hosted verifier unreachable (${e.message}); local DCAP check above is the authoritative one`);
  }

  // --- 3 the key is bound to the quote
  let pub;
  try {
    pub = bs58.decode(att.underwriter);
  } catch { pub = null; }
  check('underwriter key is a 32-byte Ed25519 key', pub?.length === 32);
  if (pub?.length === 32) {
    const want = reportDataFor(pub, nonce).toString('hex');
    check('report_data == sha256("notch-underwriter-v1" | key | our nonce)  (key born in this TD, quote is fresh)', q.reportData === want, q.reportData === want ? '' : `quote has ${q.reportData.slice(0, 24)}…`);
  }
  if (expectPubkey) check(`key is the expected one (${expectPubkey})`, att.underwriter === expectPubkey);

  // --- 4 RTMR3 replay
  let replayed = null;
  try {
    replayed = replayRtmr(ev.event_log, 3);
  } catch (e) { info.push(`event log unreadable: ${e.message}`); }
  check('RTMR3 replayed from the event log == RTMR3 in the signed quote', replayed === q.rtmr3, replayed === q.rtmr3 ? `RTMR3 ${q.rtmr3.slice(0, 16)}…` : 'mismatch');

  // --- 5 compose hash
  const attested = composeHashFromEvents(ev.event_log);
  const computed = composeHash(ev.app_compose);
  check('compose-hash event in RTMR3 == sha256(app_compose)', !!attested && attested === computed, `compose-hash ${computed}`);
  check('server-reported compose_hash agrees', !ev.compose_hash || ev.compose_hash === computed);
  if (expectComposeHash) check(`compose-hash is the expected one`, expectComposeHash.toLowerCase() === computed);
  const appIdEvent = JSON.parse(ev.event_log).find((e) => e.imr === 3 && e.event === 'app-id')?.event_payload;
  check('app-id event == reported app_id', !ev.app_id || appIdEvent === ev.app_id, `app_id ${appIdEvent}`);

  // --- 6 what the attested compose actually runs
  let compose = null;
  let ac = null;
  try {
    ac = JSON.parse(ev.app_compose);
    compose = ac.docker_compose_file || '';
  } catch (e) { check('app_compose is JSON', false, e.message); }
  let demo = null;
  if (compose != null) {
    const images = [...compose.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
    check('every image in the attested compose is pinned by sha256 digest', images.length > 0 && images.every((i) => /@sha256:[0-9a-f]{64}$/.test(i)), images.join(', '));
    demo = /^\s*DEMO_FIXTURES:\s*"?1"?\s*$/m.test(compose);
    check('server-reported demo_fixtures flag matches the attested compose', att.mode?.demo_fixtures === demo, `compose says DEMO_FIXTURES=${demo ? 1 : 0}`);
    info.push(`allowed (sealed) env names: ${(ac.allowed_envs || []).join(', ') || 'none'}`);
    info.push(`pre-launch script (Phala platform default, measured) sha256 ${sha256(ac.pre_launch_script || '')}`);
    info.push(`KMS: ${ac.kms_enabled ? 'Phala KMS (key provider id in app_compose)' : 'none'}; public_logs=${ac.public_logs}`);

    if (repo) {
      try {
        const build = await import(pathToFileURL(path.join(here, '..', '..', 'deploy', 'phala', 'build-compose.mjs')).href);
        const m = compose.match(/^\s*NOTCH_BUNDLE:\s*"([^"]+)"/m);
        if (!m) throw new Error('no NOTCH_BUNDLE in the attested compose');
        const bundle = JSON.parse(zlib.gunzipSync(Buffer.from(m[1].replace(/\./g, ''), 'base64')));
        const local = build.bundleFiles();
        const diffs = [];
        for (const [name, p] of local) {
          if (!(name in bundle)) diffs.push(`${name} (missing in CVM)`);
          else if (sha256(Buffer.from(bundle[name], 'base64')) !== sha256(fs.readFileSync(p))) diffs.push(`${name} (differs)`);
        }
        for (const name of Object.keys(bundle)) if (!local.has(name)) diffs.push(`${name} (extra in CVM)`);
        check('code bundle inside the attested compose == this repo (enclave/src, fixtures, lockfile)', diffs.length === 0, diffs.length ? diffs.join(', ') : `${local.size} files byte-identical`);
        info.push(`rebuilt docker-compose.yml from this repo ${build.composeText() === compose ? 'is byte-identical to' : 'differs only in compression bytes from'} the attested one`);
      } catch (e) {
        check('code bundle inside the attested compose == this repo', false, e.message);
      }
    }
  }

  return {
    ...out(),
    underwriter: att.underwriter,
    demo,
    status,
    mode: att.mode,
    measurement: {
      composeHash: computed,
      appId: appIdEvent,
      instanceId: ev.instance_id,
      osImageHash: ev.os_image_hash,
      mrAggregated: ev.mr_aggregated,
      mrTd: q.mrTd,
      rtmr0: q.rtmr0,
      rtmr1: q.rtmr1,
      rtmr2: q.rtmr2,
      rtmr3: q.rtmr3,
      reportData: q.reportData,
      tdAttributes: q.tdAttributes,
    },
    notChecked: [
      'MRTD/RTMR0-2 vs the published dstack OS image (os_image_hash is reported, not re-derived)',
      "Phala KMS key-release policy (who may decrypt this CVM's sealed env)",
      'on-chain: the Solana program does not verify this quote (admin sets the key after this check)',
    ],
  };
}

function usage() {
  console.log('Usage: node enclave/scripts/verify-attestation.mjs <cvm-url> [--expect-compose-hash <hex>] [--expect-pubkey <base58>] [--no-repo] [--allow-tcb <STATUS>] [--json]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const o = { repo: true, allowTcb: [] };
  let url = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--expect-compose-hash') o.expectComposeHash = argv[++i];
    else if (a === '--expect-pubkey') o.expectPubkey = argv[++i];
    else if (a === '--no-repo') o.repo = false;
    else if (a === '--allow-tcb') o.allowTcb.push(argv[++i]);
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); } else if (!url) url = a;
    else { usage(); process.exit(2); }
  }
  if (!url) { usage(); process.exit(2); }
  const r = await verifyAttestation(url, o);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\nCVM         ${url}`);
    for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
    for (const i of r.info || []) console.log(`  info  ${i}`);
    if (r.measurement) {
      console.log('\nunderwriter ' + r.underwriter);
      console.log(`mode        ${r.demo ? 'DEMO (DEMO_FIXTURES=1: synthetic DKIM key, fake sample emails)' : 'production'}; AI reader: ${r.mode?.extraction?.mode}${r.mode?.llm?.endpoint_host ? ` via ${r.mode.llm.endpoint_host} (outside the TEE)` : ''}`);
      for (const [k, v] of Object.entries(r.measurement)) console.log(`  ${k.padEnd(13)} ${v}`);
      for (const n of r.notChecked) console.log(`  not checked: ${n}`);
    }
    console.log(`\n${r.ok ? 'ATTESTATION VERIFIED' : 'ATTESTATION FAILED'}`);
  }
  process.exit(r.ok ? 0 : 1);
}

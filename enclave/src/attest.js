import crypto from 'node:crypto';

// Pure helpers for the TDX attestation of the underwriter (no network, no dstack socket), shared by the
// CVM server (which builds the binding) and enclave/scripts/verify-attestation.mjs (which checks it).

/** report_data = sha256(BINDING_DOMAIN | ed25519 public key [| nonce]), zero-padded to 64 bytes. */
export const BINDING_DOMAIN = 'notch-underwriter-v1';

/** The 64 bytes the CVM asks the TDX hardware to put in the quote. `nonce` (<= 32 bytes) is optional freshness. */
export function reportDataFor(publicKey, nonce) {
  const h = crypto.createHash('sha256').update(BINDING_DOMAIN).update(Buffer.from(publicKey));
  if (nonce && nonce.length) h.update(Buffer.from(nonce));
  return Buffer.concat([h.digest(), Buffer.alloc(32)]);
}

// Intel TDX quote v4 (DCAP): 48-byte header, 584-byte TD report body, then the signature data.
// Offsets inside the body: tee_tcb_svn 0, mrseam 16, mrsignerseam 64, seamattributes 112, tdattributes 120,
// xfam 128, mrtd 136, mrconfigid 184, mrowner 232, mrownerconfig 280, rtmr0 328, rtmr1 376, rtmr2 424,
// rtmr3 472, report_data 520.
const HEADER = 48;
const body = (o, n) => [HEADER + o, HEADER + o + n];
const FIELDS = {
  teeTcbSvn: body(0, 16), mrSeam: body(16, 48), mrSignerSeam: body(64, 48), seamAttributes: body(112, 8),
  tdAttributes: body(120, 8), xfam: body(128, 8), mrTd: body(136, 48), mrConfigId: body(184, 48),
  mrOwner: body(232, 48), mrOwnerConfig: body(280, 48), rtmr0: body(328, 48), rtmr1: body(376, 48),
  rtmr2: body(424, 48), rtmr3: body(472, 48), reportData: body(520, 64),
};

/** Parse the measurements out of a raw TDX quote. Does NOT check the signature: that is the DCAP verifier's job. */
export function parseTdxQuote(quote) {
  const buf = Buffer.isBuffer(quote) ? quote : Buffer.from(String(quote).replace(/^0x/, ''), 'hex');
  if (buf.length < HEADER + 584) throw new Error('quote too short for a TDX quote');
  const version = buf.readUInt16LE(0);
  const teeType = buf.readUInt32LE(4);
  if (version !== 4 || teeType !== 0x81) throw new Error(`not a TDX v4 quote (version ${version}, tee_type 0x${teeType.toString(16)})`);
  const out = { version, teeType };
  for (const [k, [a, b]] of Object.entries(FIELDS)) out[k] = buf.subarray(a, b).toString('hex');
  return out;
}

const sha384 = (...parts) => {
  const h = crypto.createHash('sha384');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Replay RTMR `imr` from a dstack event log (array or JSON string). RTMR_new = SHA384(RTMR_old | digest). */
export function replayRtmr(eventLog, imr = 3) {
  const events = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog;
  let rtmr = Buffer.alloc(48);
  for (const e of events) {
    if (e.imr !== imr) continue;
    const digest = Buffer.from(e.digest, 'hex');
    const padded = Buffer.concat([digest, Buffer.alloc(Math.max(0, 48 - digest.length))]);
    rtmr = sha384(rtmr, padded);
  }
  return rtmr.toString('hex');
}

/** The runtime event dstack extends into RTMR3: digest = SHA384(event_type_le32 | ":" | name | ":" | payload). */
export function runtimeEventDigest(eventType, name, payloadHex) {
  const t = Buffer.alloc(4);
  t.writeUInt32LE(eventType >>> 0);
  return sha384(t, Buffer.from(':'), Buffer.from(name), Buffer.from(':'), Buffer.from(payloadHex, 'hex')).toString('hex');
}

/** Pull the attested app configuration hash out of the event log. */
export function composeHashFromEvents(eventLog) {
  const events = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog;
  const e = events.find((x) => x.imr === 3 && x.event === 'compose-hash');
  return e ? e.event_payload : null;
}

/** sha256 of the app-compose JSON string, exactly as dstack hashes it for the compose-hash event. */
export const composeHash = (appCompose) => crypto.createHash('sha256').update(appCompose).digest('hex');

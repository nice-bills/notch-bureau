import crypto from 'node:crypto';
import { dkimVerify } from 'mailauth';

// Verify the DKIM signatures on a raw .eml and return the passing one we trust.
// `trusted` is a list of signing domains whose emails count as income evidence.
export async function verifyEmail(eml, { trusted, resolver } = {}) {
  const res = await dkimVerify(eml, resolver ? { resolver } : {});
  const passing = (res.results || []).filter((r) => r.status?.result === 'pass');
  const hit = passing.find((r) => isTrusted(r.signingDomain, trusted));
  if (!hit) {
    const seen = (res.results || []).map((r) => `${r.signingDomain}:${r.status?.result}`).join(', ');
    return { ok: false, reason: passing.length ? `untrusted signer (${seen})` : `no passing DKIM signature (${seen || 'none'})` };
  }
  // l= means only a prefix of the body is signed, so anyone could append text (e.g. a fake
  // "received USD 50,000" line) after it. Refuse those signatures outright.
  const tags = signatureTags(eml, hit.signature);
  if (!tags) return { ok: false, reason: 'could not locate the passing DKIM signature' };
  if ('l' in tags) return { ok: false, reason: 'DKIM signature covers only part of the body (l= tag)' };
  if (!hit.bodyHash) return { ok: false, reason: 'DKIM body hash missing' };
  // Dedupe on the verified body hash, not the signature: re-signing the same message
  // (new selector or timestamp) yields a new b= but the same body, so it stays a duplicate.
  const domain = hit.signingDomain.toLowerCase();
  const dedupe = crypto.createHash('sha256').update(`${domain}|${hit.bodyHash}`).digest();
  return { ok: true, domain, selector: hit.selector, dedupe };
}

function isTrusted(domain, trusted) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return (trusted || []).some((t) => d === t.toLowerCase());
}

// Tags of the DKIM-Signature header whose b= equals the verified signature.
function signatureTags(eml, signature) {
  const raw = eml.toString();
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end >= 0 ? raw.slice(0, end) : raw).replace(/\r?\n[ \t]+/g, ' ');
  const want = String(signature || '').replace(/\s+/g, '');
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^DKIM-Signature:\s*(.*)$/i);
    if (!m) continue;
    const tags = {};
    for (const part of m[1].split(';')) {
      const i = part.indexOf('=');
      if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).replace(/\s+/g, '');
    }
    if (tags.b === want) return tags;
  }
  return null;
}

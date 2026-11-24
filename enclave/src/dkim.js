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
  // The signature must cover the From header (RFC 6376 requires it) and, when the message declares a
  // MIME structure, the Content-Type that says where each part starts. bh= covers every byte of the
  // body, attachments included, so a signed multipart message cannot have its PDF swapped or edited.
  const signed = (tags.h || '').toLowerCase().split(':').map((x) => x.trim());
  if (!signed.includes('from')) return { ok: false, reason: 'DKIM signature does not cover the From header' };
  if (hasHeader(eml, 'content-type') && !signed.includes('content-type')) {
    return { ok: false, reason: 'DKIM signature does not cover the Content-Type header' };
  }
  // Alignment: the signing domain must be the From domain (or a parent of it). Otherwise anyone who
  // owns any domain could sign mail that merely *claims* to be from the provider.
  const from = fromDomain(eml);
  if (!from.ok) return { ok: false, reason: from.reason };
  const d = hit.signingDomain.toLowerCase();
  if (from.domain !== d && !from.domain.endsWith(`.${d}`)) {
    return { ok: false, reason: `From domain (${from.domain}) is not aligned with the DKIM signer (${d})` };
  }
  // Dedupe on the verified body hash, not the signature: re-signing the same message
  // (new selector or timestamp) yields a new b= but the same body, so it stays a duplicate.
  const domain = d;
  const dedupe = crypto.createHash('sha256').update(`${domain}|${hit.bodyHash}`).digest();
  return { ok: true, domain, selector: hit.selector, dedupe, signedHeaders: signed };
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

function headBlock(eml) {
  const raw = eml.toString('latin1');
  const end = raw.search(/\r?\n\r?\n/);
  return (end >= 0 ? raw.slice(0, end) : raw).replace(/\r?\n[ \t]+/g, ' ');
}

function hasHeader(eml, name) {
  return headBlock(eml).split(/\r?\n/).some((l) => l.toLowerCase().startsWith(`${name}:`));
}

// The one From header's domain. Zero or several From headers are refused: a second one added in
// front of the signed one is the classic way to show a different sender.
function fromDomain(eml) {
  const froms = headBlock(eml).split(/\r?\n/).filter((l) => /^from:/i.test(l));
  if (froms.length !== 1) return { ok: false, reason: froms.length ? 'message has several From headers' : 'message has no From header' };
  const value = froms[0].replace(/^from:/i, '').trim();
  const m = value.match(/<\s*[^<>@\s]+@([^<>@\s]+)\s*>\s*$/) || value.match(/^[^<>@\s"]+@([^<>@\s]+)$/);
  if (!m) return { ok: false, reason: 'could not read the From address' };
  return { ok: true, domain: m[1].toLowerCase() };
}

// The addresses on the (single) To header, lower-cased. Several To headers are refused: like From, a second one
// added in front of the signed one could show a different recipient.
export function toAddresses(eml) {
  const tos = headBlock(eml).split(/\r?\n/).filter((l) => /^to:/i.test(l));
  if (tos.length !== 1) return { ok: false, reason: tos.length ? 'message has several To headers' : 'message has no To header' };
  return { ok: true, addresses: [...tos[0].replace(/^to:/i, '').matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase()) };
}

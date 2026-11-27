import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { dkimVerify } from 'mailauth';

// DKIM key lookup: the system resolver first, then DNS over HTTPS. Plain DNS (UDP port 53) is often slow or blocked on
// phone hotspots and cloud hosts, and a lookup that times out must not turn a genuine statement into a refusal.
const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const TYPES = { TXT: 16, MX: 15, A: 1, AAAA: 28, CNAME: 5 };
const dnsErr = (code) => Object.assign(new Error(`DNS ${code}`), { code });
async function dohResolve(name, rrtype, fetchImpl = fetch) {
  let last = dnsErr('ETIMEOUT');
  for (const base of DOH) {
    try {
      const r = await fetchImpl(`${base}?name=${encodeURIComponent(name)}&type=${rrtype}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) { last = dnsErr('ESERVFAIL'); continue; }
      const j = await r.json();
      if (j.Status === 3) throw dnsErr('ENOTFOUND');
      if (j.Status !== 0) { last = dnsErr('ESERVFAIL'); continue; }
      const rows = (j.Answer || []).filter((a) => a.type === TYPES[rrtype]).map((a) => String(a.data));
      if (!rows.length) throw dnsErr('ENODATA');
      // TXT data comes as one or more quoted chunks: "v=DKIM1; k=rsa; " "p=MIIB..."
      return rrtype === 'TXT' ? rows.map((d) => (d.match(/"((?:[^"\\]|\\.)*)"/g) || [d]).map((c) => c.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'))) : rows;
    } catch (e) {
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') throw e;
      last = e.code ? e : dnsErr('ETIMEOUT');
    }
  }
  throw last;
}
export async function fallbackResolver(name, rrtype, { system = (n, t) => dns.resolve(n, t), fetchImpl } = {}) {
  try { return await system(name, rrtype); } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') throw e; // a real answer: the record does not exist
    return dohResolve(name, rrtype, fetchImpl);
  }
}

// Verify the DKIM signatures on a raw .eml and return the passing one we trust.
// `trusted` is a list of signing domains whose emails count as income evidence.
export async function verifyEmail(eml, { trusted, resolver } = {}) {
  const res = await dkimVerify(eml, { resolver: resolver ?? fallbackResolver });
  const passing = (res.results || []).filter((r) => r.status?.result === 'pass');
  // With several trusted signatures, take one that covers To: the strict recipient rule applies whenever To IS signed.
  const ours = passing.filter((r) => isTrusted(r.signingDomain, trusted));
  const hit = ours.find((r) => signedNames(r).includes('to')) ?? ours[0];
  if (!hit) {
    const seen = (res.results || []).map((r) => `${r.signingDomain}:${r.status?.result}`).join(', ');
    // The signer's key could not be fetched right now: not the email's fault, so the inbox keeps the address open and retries.
    if (!passing.length && (res.results || []).some((r) => r.status?.result === 'temperror' && isTrusted(r.signingDomain, trusted))) {
      return { ok: false, retry: true, reason: `could not fetch the sender's signing key right now (${seen}); it will be retried` };
    }
    return { ok: false, reason: passing.length ? `untrusted signer (${seen})` : `no passing DKIM signature (${seen || 'none'})` };
  }
  // Everything below is read from what the VERIFIER saw: its split of the header block (res.headers) and the list of
  // header lines it actually hashed for THIS signature (hit.signingHeaders). Never re-parse those by hand: a second
  // parser can be made to disagree ("To : x" is a To header to DKIM, and a fake DKIM-Signature header carrying the same
  // b= can claim any h= list).
  // l= means only a prefix of the body is signed, so anyone could append text (e.g. a fake
  // "received USD 50,000" line) after it. Refuse those signatures outright.
  if (hit.canonBodyLengthLimited !== false) return { ok: false, reason: 'DKIM signature covers only part of the body (l= tag)' };
  if (!hit.bodyHash) return { ok: false, reason: 'DKIM body hash missing' };
  if (!res.headers?.parsed || typeof hit.signingHeaders?.keys !== 'string') return { ok: false, reason: 'could not read the signed headers of the DKIM signature' };
  // One of each, so the line we read is the line that was signed (a signature takes the bottom-most one; a second one
  // added on top could show a different sender, recipient, date or MIME layout).
  const fields = {};
  for (const [name, label] of SINGLE_HEADERS) {
    const values = headerValues(res.headers.parsed, name);
    if (values.length > 1) return { ok: false, reason: `message has several ${label} headers` };
    fields[name] = values[0] ?? null;
  }
  // The signature must cover the From header (RFC 6376 requires it) and, when the message declares a
  // MIME structure, the Content-Type that says where each part starts. bh= covers every byte of the
  // body, attachments included, so a signed multipart message cannot have its PDF swapped or edited.
  const signed = signedNames(hit);
  if (!signed.includes('from')) return { ok: false, reason: 'DKIM signature does not cover the From header' };
  if (fields['content-type'] !== null && !signed.includes('content-type')) {
    return { ok: false, reason: 'DKIM signature does not cover the Content-Type header' };
  }
  // Alignment: the signing domain must be the From domain (or a parent of it). Otherwise anyone who
  // owns any domain could sign mail that merely *claims* to be from the provider.
  const from = fromDomain(fields.from);
  if (!from.ok) return { ok: false, reason: from.reason };
  const d = hit.signingDomain.toLowerCase();
  if (from.domain !== d && !from.domain.endsWith(`.${d}`)) {
    return { ok: false, reason: `From domain (${from.domain}) is not aligned with the DKIM signer (${d})` };
  }
  // Dedupe on the verified body hash, not the signature: re-signing the same message
  // (new selector or timestamp) yields a new b= but the same body, so it stays a duplicate.
  const domain = d;
  const dedupe = crypto.createHash('sha256').update(`${domain}|${hit.bodyHash}`).digest();
  // A signed Message-ID is a second, independent "seen it" key.
  const messageId = signed.includes('message-id') && fields['message-id'] ? fields['message-id'] : null;
  return {
    ok: true,
    domain,
    selector: hit.selector,
    dedupe,
    messageDedupe: messageId ? crypto.createHash('sha256').update(`notch-mid-v1|${domain}|${messageId}`).digest() : null,
    signedHeaders: signed,
    to: fields.to === null ? [] : addressesIn(fields.to), // trust it only when signedHeaders has 'to'
    signedDate: signed.includes('date') && fields.date ? parseMailDate(fields.date) : null,
  };
}

const SINGLE_HEADERS = [['from', 'From'], ['to', 'To'], ['date', 'Date'], ['message-id', 'Message-ID'], ['content-type', 'Content-Type']];

function isTrusted(domain, trusted) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return (trusted || []).some((t) => d === t.toLowerCase());
}

// Names of the header lines the verifier hashed for this signature (only headers that exist in the message).
const signedNames = (result) => String(result.signingHeaders?.keys || '').split(':').map((x) => x.trim().toLowerCase()).filter(Boolean);

// The unfolded values of every header called `name`, as the verifier split the header block.
function headerValues(parsed, name) {
  return parsed.filter((h) => h.key === name).map((h) => {
    const line = h.line.toString('utf8');
    return line.slice(line.indexOf(':') + 1).replace(/\r?\n/g, '').trim();
  });
}

// Zero or several From headers are refused: a second one added in front of the signed one is the
// classic way to show a different sender.
function fromDomain(value) {
  if (value === null) return { ok: false, reason: 'message has no From header' };
  const m = value.match(/<\s*[^<>@\s]+@([^<>@\s]+)\s*>\s*$/) || value.match(/^[^<>@\s"]+@([^<>@\s]+)$/);
  if (!m) return { ok: false, reason: 'could not read the From address' };
  return { ok: true, domain: m[1].toLowerCase() };
}

// The addresses on a To value, lower-cased.
const addressesIn = (value) => [...value.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());

// RFC 5322 date with an explicit zone -> Date, or null. Strict: a date without a zone would be read in local time.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseMailDate(value) {
  const m = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(?:([+-])(\d{2})(\d{2})|GMT|UTC|UT)(?:\s*\([^()]*\))?$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, day, mon, year, h, mi, s = '0', sign, zh = '0', zm = '0'] = m;
  const month = MONTHS.indexOf(mon.toLowerCase());
  if (month < 0 || +h > 23 || +mi > 59 || +s > 60 || +zh > 14 || +zm > 59) return null;
  const local = Date.UTC(+year, month, +day, +h, +mi, +s);
  if (new Date(Date.UTC(+year, month, +day)).getUTCDate() !== +day) return null;
  return new Date(local - (sign === '-' ? -1 : 1) * (+zh * 60 + +zm) * 60_000);
}

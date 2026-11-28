// "Forward as attachment": the way in for a statement that was only emailed to the borrower's OWN mailbox (a bank mails
// the address on file). The borrower attaches the original email to a new one and sends that to their Notch inbox:
//
//   outer  signed by the borrower's mail provider. From = their mailbox, To = this wallet's inbox address.
//   inner  the original message/rfc822, signed by the bank or provider. To = that same mailbox.
//
// All of these must hold, and only the INNER message is ever read, counted or deduplicated:
//   1. outer DKIM passes, d= equal to the From domain, and that domain is a listed consumer provider (sources.js);
//   2. outer To is this wallet's inbox address (the caller's recipient rule, underwriter.js recipientRefusal);
//   3. exactly one attached message, within the size limit, which is not itself a forward;
//   4. inner DKIM passes for a trusted income signer;
//   5. inner To is SIGNED, is one address, and is the outer From mailbox.
// Rule 5 keeps audit #3 closed: somebody holding a copy of your statement cannot sign mail as your mailbox.
// A sender that does not sign To (MTN) cannot use this path: anybody could rewrite the To of a copy.
import { singleMailbox, verifyEmail } from './dkim.js';

export const MAX_FORWARD_BYTES = 5 * 1024 * 1024; // the whole mail (same as the inbox's own limit)
export const MAX_ATTACHED_BYTES = 4 * 1024 * 1024; // the original inside it
const MAX_PARTS = 50;
const MAX_DEPTH = 5;

export const FORWARD_REASONS = Object.freeze({
  inline: 'forward it as an attachment, not inline: open the original email, then More, then Forward as attachment',
  brokenInner: 'forward it as an attachment, not inline: the signature of the original email is missing or no longer matches',
  provider: 'forward it from a Gmail, Outlook, Hotmail, Live, Yahoo or iCloud address: other mail services are not accepted yet',
  outerSignature: 'the signature of your mail provider on this forward does not check out, so it cannot be told which mailbox sent it',
  notThisInbox: 'the forward was not sent to this inbox address: send it to the address shown for this wallet',
  older: 'the forward is older than this inbox address: forward the original email again',
  ahead: 'the forward is dated ahead of the current time: forward the original email again',
  untied: 'your mail provider did not sign a readable date and message ID, so the forward cannot be tied to your request',
  tooMany: 'attach exactly one original email to the forward',
  nested: 'the attached email is itself a forward: attach the original email from your bank or provider',
  tooLarge: 'the forwarded email is too large: forward only the one statement email',
  unreadable: 'could not read the attached email',
  innerSigner: 'the attached email is not signed by a sender that is accepted as proof of income',
  unsignedTo: 'the sender did not sign who this statement was sent to, so a forwarded copy proves nothing: ask for it to be emailed straight to your inbox address',
  otherMailbox: 'the statement was sent to a different email than the one that forwarded it',
  retry: 'could not fetch a signing key right now; it will be retried',
});

// The recipient rule's sentences speak of "the statement"; here they are about the forward.
const OUTER_RECIPIENT = [
  [/not addressed to this inbox/, FORWARD_REASONS.notThisInbox],
  [/sent before you asked/, FORWARD_REASONS.older],
  [/dated in the future/, FORWARD_REASONS.ahead],
  [/tied to your request/, FORWARD_REASONS.untied],
];

// Gmail ignores dots and +tags in the local part; everybody else only gets case folding.
export function normaliseMailbox(address) {
  const [local, domain] = String(address).toLowerCase().split('@');
  return `${domain === 'gmail.com' ? local.split('+')[0].replace(/\./g, '') : local}@${domain}`;
}

// ---- MIME: only enough to cut the attached message out, byte for byte (latin1 keeps every byte) --------------------
// Nothing found here is trusted: the outer body hash is the mail provider's, and the inner message must pass its own DKIM.

function splitEntity(s) {
  if (/^\r?\n/.test(s)) return { head: '', body: s.replace(/^\r?\n/, '') };
  const m = /\r?\n\r?\n/.exec(s);
  return m ? { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) } : { head: s, body: '' };
}

function headerOf(head, name) {
  const unfolded = head.replace(/\r?\n(?=[ \t])/g, '');
  return new RegExp(`^${name}[ \\t]*:(.*)$`, 'im').exec(unfolded)?.[1].trim() ?? '';
}

function multipartParts(body, boundary) {
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const parts = [];
  let start = null;
  for (let m = delimiter.exec(body); m; m = delimiter.exec(body)) {
    if (start !== null) parts.push(body.slice(start, m.index)); // the line break before a delimiter belongs to the delimiter
    if (m[1]) return parts;
    start = delimiter.lastIndex + (/^\r?\n/.exec(body.slice(delimiter.lastIndex, delimiter.lastIndex + 2))?.[0].length ?? 0);
    if (parts.length > MAX_PARTS) break;
  }
  if (start !== null) parts.push(body.slice(start));
  return parts;
}

// Every message/rfc822 part (not looking inside them). Throws FORWARD_REASONS sentences.
export function attachedMessages(eml) {
  const found = [];
  let seen = 0;
  const walk = (entity, depth) => {
    if (++seen > MAX_PARTS || depth > MAX_DEPTH) throw new Error(FORWARD_REASONS.tooLarge);
    const { head, body } = splitEntity(entity);
    const contentType = headerOf(head, 'content-type');
    const type = contentType.split(';')[0].trim().toLowerCase();
    if (type === 'message/rfc822') {
      const encoding = headerOf(head, 'content-transfer-encoding').toLowerCase();
      if (encoding === 'base64') found.push(Buffer.from(body, 'base64'));
      else if (['', '7bit', '8bit', 'binary'].includes(encoding)) found.push(Buffer.from(body, 'latin1'));
      else throw new Error(FORWARD_REASONS.unreadable);
      return;
    }
    if (!type.startsWith('multipart/')) return;
    const b = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (!b || (b[1] ?? b[2]).length > 200) return; // RFC 2046 allows 70
    for (const part of multipartParts(body, b[1] ?? b[2])) walk(part, depth + 1);
  };
  walk(Buffer.from(eml).toString('latin1'), 0);
  return found;
}

// The From address as written, unverified: only used to choose which refusal to give.
function claimedDomain(eml) {
  const { head } = splitEntity(Buffer.from(eml).subarray(0, 64 * 1024).toString('latin1'));
  return /@([A-Za-z0-9.-]+)(?:\s{0,8}>)?$/.exec(headerOf(head, 'from'))?.[1].toLowerCase() ?? null;
}

// Is this mail (which no income source signed) meant as a forward? It has an attached message, or it comes from a
// consumer mailbox (then it was most likely forwarded inline, and the borrower should hear how to do it right).
export function looksForwarded(eml, forwarders) {
  if (forwarders.includes(claimedDomain(eml))) return true;
  try { return attachedMessages(eml).length > 0; } catch { return true; }
}

const no = (reason) => ({ ok: false, reason });
const later = () => ({ ok: false, retry: true, reason: FORWARD_REASONS.retry });

// -> { ok: true, eml: <the original message>, v: <its DKIM verification> } | { ok: false, reason, retry? }
// `refuseRecipient(outerVerification)` -> null, or why the forward does not belong to this inbox request.
export async function openForward(eml, { trusted, resolver, forwarders, refuseRecipient }) {
  if (eml.length > MAX_FORWARD_BYTES) return no(FORWARD_REASONS.tooLarge);
  if (!forwarders.includes(claimedDomain(eml))) return no(FORWARD_REASONS.provider);

  const outer = await verifyEmail(eml, { trusted: [...forwarders], resolver });
  if (!outer.ok) return outer.retry ? later() : no(FORWARD_REASONS.outerSignature);
  const mailbox = singleMailbox(outer.from);
  // d= must BE the From domain, and that domain must be listed (a parent or another listed provider is not enough).
  if (!mailbox || mailbox.split('@')[1] !== outer.domain || !forwarders.includes(outer.domain)) return no(FORWARD_REASONS.outerSignature);
  const why = refuseRecipient(outer);
  if (why) return no(OUTER_RECIPIENT.find(([re]) => re.test(why))?.[1] ?? why);

  let inner;
  try {
    const attached = attachedMessages(eml);
    if (!attached.length) return no(FORWARD_REASONS.inline);
    if (attached.length > 1) return no(FORWARD_REASONS.tooMany);
    [inner] = attached;
    if (inner.length > MAX_ATTACHED_BYTES) return no(FORWARD_REASONS.tooLarge);
    if (attachedMessages(inner).length) return no(FORWARD_REASONS.nested);
  } catch (e) {
    return no(e.message);
  }

  const v = await verifyEmail(inner, { trusted, resolver });
  if (!v.ok) {
    if (v.retry) return later();
    if (v.reason.startsWith('no passing DKIM')) return no(FORWARD_REASONS.brokenInner);
    if (v.reason.startsWith('untrusted signer')) return no(FORWARD_REASONS.innerSigner);
    return no(`the attached email could not be verified: ${v.reason}`);
  }
  if (!v.signedHeaders.includes('to')) return no(FORWARD_REASONS.unsignedTo);
  const sentTo = singleMailbox(v.toLine);
  if (!sentTo || normaliseMailbox(sentTo) !== normaliseMailbox(mailbox)) return no(FORWARD_REASONS.otherMailbox);
  return { ok: true, eml: inner, v };
}

// Income sources the underwriter accepts. One row per DKIM signing domain.
//
// `kind` picks the reader:
//   statement-pdf  amounts live in a PDF attachment; account phone number binds the wallet
//   earn-payout    email names a payout; an on-chain USDC transfer to the wallet must back it
//   email-body     amounts are in the email text itself
//
// `status` is how far we trust our model of the provider (details and evidence: enclave/README.md SOURCES):
//   modelled-from-secondary-sample  a real message was seen second-hand, no raw headers inspected
//   sender-confirmed                sending address and DKIM key confirmed from the provider's own source code + DNS;
//                                   email wording not public, so amounts fall back to the generic grammar
//   unverified                      domain from DNS (DMARC/DKIM selectors), format never seen; confirm with a real sample
export const SOURCES = Object.freeze([
  { domain: 'mtn.com', name: 'MTN MoMo Ghana', kind: 'statement-pdf', status: 'modelled-from-secondary-sample' },
  { domain: 'superteam.fun', name: 'Superteam Earn', kind: 'earn-payout', status: 'sender-confirmed' },
  { domain: 'wise.com', name: 'Wise', kind: 'email-body', status: 'unverified' },
  { domain: 'payoneer.com', name: 'Payoneer', kind: 'email-body', status: 'unverified' },
  { domain: 'deel.com', name: 'Deel', kind: 'email-body', status: 'unverified' },
  { domain: 'upwork.com', name: 'Upwork', kind: 'email-body', status: 'unverified' },
]);

export const DEFAULT_SUPERTEAM_DOMAIN = 'superteam.fun';

// Earn sends as `Superteam <hello@superteam.fun>` via Resend (SuperteamDAO/earn src/features/emails/utils/fromEmails.ts),
// DKIM key at resend._domainkey.superteam.fun. Still configurable (NOTCH_SUPERTEAM_DOMAIN) in case Earn changes sender.
export function sourceTable({ superteamDomain = DEFAULT_SUPERTEAM_DOMAIN } = {}) {
  return SOURCES.map((s) => (s.kind === 'earn-payout' ? { ...s, domain: superteamDomain.toLowerCase() } : s));
}

export const DEFAULT_TRUSTED = SOURCES.map((s) => s.domain);

// Consumer mail providers whose DKIM signature is taken as proof of which MAILBOX sent a "forward as attachment"
// (forward.js). Never an income source. Add one only if it signs every message with d= its own domain and lets a user
// send only from their own address.
export const FORWARDERS = Object.freeze(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com']);

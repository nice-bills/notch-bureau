// Pull income events out of an email body. This is the rule-based extractor: it runs when
// the LLM path is unconfigured, fails, or returns something that does not check out, and it
// is also the cross-check every LLM event must pass (see src/llm-extract.js).
//
// SECURITY MODEL. The email is DKIM-valid, but parts of its body are written by a third
// party (a sender's transfer reference, a counterparty name, a memo). So an amount counts
// as income only when it sits inside the *provider's own sentence*:
//   * the line STARTS with a credit phrase ("You have received ...", "Your payment of ...",
//     "05 Oct SALARY CREDIT ..."): memo lines start with "Reference:", "Note:" ... and so
//     never match, and a keyword like "salary" somewhere in a line is worthless;
//   * the amount follows that phrase directly, in the same line;
//   * instruction-like lines ("ignore previous instructions", "SYSTEM: ...") are dropped;
//   * debit-looking text before the amount (card, fee, withdrawal ...) drops the line.
// Known providers get an exact template for their domain; anything else (or a known
// provider whose template found nothing) goes through a strict generic grammar.

const CUR_SRC = '(?:GHS|GH₵|USDC|USD|US\\$|\\$|NGN|₦|KES|KSh|EUR|€|GBP|£)';
const NUM_SRC = '(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?(?![0-9])';
// One money token, either "GHS 1,250.00" or "1,250.00 GHS". Groups: 1 cur, 2 num | 3 num, 4 cur.
const MONEY_SRC = `(?:(${CUR_SRC})\\s?(${NUM_SRC})|(${NUM_SRC})\\s?(${CUR_SRC})(?![A-Za-z]))`;
const SYMBOL = { 'GH₵': 'GHS', 'US$': 'USD', $: 'USD', '₦': 'NGN', KSh: 'KES', '€': 'EUR', '£': 'GBP' };

const MAX_LINE = 300;
// Lines that talk to a model/reader instead of describing a transaction.
const INSTRUCTION = /\b(ignore|disregard|instructions?|system|assistant|prompt|override|report|pretend|forget|previous|developer|admin|you must|you should|act as|output|respond|json|regardless|as income|treat)\b/i;
// Debit-ish words before the amount ("CARD PAYMENT TO", "fee", "withdrawal" ...).
const DEBIT = /\b(debit(?:ed)?|withdraw\w*|card|purchase|charges?|charged|fees?|paid to|sent to|payment to(?! you)|transfer out|cash out|bill|reversal|refund|balance|bal)\b/i;
// A line that opens with a free-text label is a memo/reference field, never a statement line.
const MEMO_LABEL = /^(?:reference|ref|note|notes|memo|message|narration|description|remarks?|comment|purpose|subject|from|to|sender|details|payment reference|transaction id)\s*[:\-]/i;
const DATE_PREFIX = '(?:\\d{1,2}\\s+[A-Za-z]{3,9}(?:\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{2}/\\d{2}/\\d{4})';
const RECEIVED_VERB = "(?:received|been credited with|been credited)";

const re = (src) => new RegExp(src.replaceAll('{M}', MONEY_SRC), 'i');

// Each template is anchored at the line start and puts the amount right behind a credit
// phrase. {M} is one money token.
const PROVIDER_TEMPLATES = [
  {
    domains: ['mtn.com.gh', 'mtn.com'],
    // "You have received GHS 1,250.00 from KWAME ASANTE (024 ...)." / "Cash In of GHS 50.00"
    patterns: [
      re(`^you have ${RECEIVED_VERB}\\s+{M}(?:\\s+from\\b.*)?$`),
      re('^(?:payment received for|cash in(?: of)?)\\s+{M}(?:\\s+from\\b.*)?$'),
    ],
  },
  {
    domains: ['deel.com'],
    patterns: [
      re('^your (?:payment|payout) of\\s+{M}\\s+(?:has been|was)\\s+(?:sent|paid|deposited|released|initiated)\\b'),
      re(`^you(?:'ve| have) (?:been paid|received (?:a )?(?:payment of )?)\\s*{M}`),
    ],
  },
  {
    domains: ['wise.com'],
    patterns: [
      re(`^you(?:'ve| have) ${RECEIVED_VERB}\\s+{M}`),
      re('^[A-Za-z][A-Za-z .&\'-]{0,40}\\s+sent you\\s+{M}'),
      re('^{M}\\s+(?:has |have )?(?:arrived|landed|been (?:added|deposited|credited))\\b'),
    ],
  },
  {
    domains: ['payoneer.com'],
    patterns: [
      re(`^you(?:'ve| have) ${RECEIVED_VERB}\\s+(?:a payment of\\s+)?{M}`),
      re('^(?:a )?payment of\\s+{M}(?:\\s+from\\s+[^\\n]{1,60}?)?\\s+(?:has been|was)\\s+(?:approved|received|credited|deposited)\\b'),
    ],
  },
  {
    domains: ['superteam.fun'],
    patterns: [
      re(`^you(?:'ve| have) (?:been paid|${RECEIVED_VERB})\\s+{M}`),
      re('^payment of\\s+{M}\\s+(?:has been|was)\\s+(?:sent|released|paid)\\b'),
      re('^{M}\\s+(?:has been|was)\\s+(?:sent|paid)\\s+to you\\b'),
    ],
  },
];

// Strict generic grammar for any other signer (banks, unknown providers).
const GENERIC_PATTERNS = [
  re('^your (?:payment|payout) of\\s+{M}\\s+(?:has been|was)\\s+(?:sent|paid|deposited|released|initiated)\\b'),
  re('^(?:payment|payout) received:?\\s*{M}'),
  // "You have received GHS 100" / "Received: USD 5" / "You've been credited with 5 USD"
  re(`^(?:you(?:'ve| have)\\s+)?(?:just\\s+)?${RECEIVED_VERB}\\s*:?\\s*(?:an? (?:payment|payout|transfer|deposit|credit) of\\s+)?{M}`),
  // "Payment to you: GHS 500.00 received from ACME" / "GHS 5.00 credited"
  re('^(?:payment to you:?\\s*)?{M}\\s+(?:has been |was |have been )?(?:received|credited|deposited)\\b'),
  // "ACME LTD paid you USD 100" / "KOFI sent you GHS 50"
  re('^[A-Za-z][A-Za-z .&\'-]{0,40}\\s+(?:paid you|sent you)\\s+{M}'),
  // "Salary credited 4,000.00 GHS", "Payroll deposited: ..."
  re('^(?:salary|payroll|wages)\\s+(?:credited|received|paid|deposited)\\s*(?:with|of|:)?\\s*{M}'),
  // Dated statement line: "05 Oct  SALARY CREDIT - ACME LTD    GHS 4,000.00". Exactly one
  // money token on the line, and the amount closes it.
  re(`^${DATE_PREFIX}\\s+(?:salary credit|salary|payroll|credit(?!\\s*card)|deposit|cash in|transfer in|incoming transfer|mobile money received|momo received|received|payout)\\b[^\\n]{0,60}?\\s{M}\\s*(?:cr)?$`),
];

export function extractIncome(eml, { domain, now = new Date() } = {}) {
  const text = decodeEmailText(eml);
  const date = headerDate(eml.toString(), now);
  return scanCreditAmounts(text, { domain }).map(({ amount, currency, line }) => ({
    amount,
    currency,
    date,
    kind: /^\W*(?:\d[^A-Za-z]*)?salary\b|\bsalary (?:credit|paid|received|deposited)/i.test(line) ? 'salary' : 'other_credit',
  }));
}

// Every (amount, currency) pair the provider's own sentences say was credited. Shared by
// the rules extractor and by the LLM cross-check, so both agree on what counts as a credit.
export function scanCreditAmounts(text, { domain } = {}) {
  const lines = String(text)
    .normalize('NFKC')
    .replace(/[​-‏‪-‮⁠﻿]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean);
  const eligible = lines.filter(isEligible);
  const tpl = templatesFor(domain);
  if (tpl.length) {
    const hits = matchAll(eligible, tpl, { list: false });
    if (hits.length) return hits;
  }
  return matchAll(eligible, GENERIC_PATTERNS, { list: true });
}

function templatesFor(domain) {
  const d = String(domain || '').toLowerCase();
  return PROVIDER_TEMPLATES.filter((t) => t.domains.includes(d)).flatMap((t) => t.patterns);
}

function isEligible(line) {
  if (line.length > MAX_LINE) return false;
  if (line.startsWith('>')) return false; // quoted text
  if (MEMO_LABEL.test(line)) return false;
  // If a line contains both a genuine statement clause and injected prose, inspect each
  // clause independently; never let later attacker text erase an earlier credit.
  return true;
}

function matchAll(lines, patterns, { list }) {
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((part) => !INSTRUCTION.test(part)).join(' ');
    if (!line) continue;
    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (!m) continue;
      const before = line.slice(0, m.index + m[0].indexOf(m.find((g, i) => i > 0 && g !== undefined) ?? m[0]));
      // The text in front of the amount must not describe a debit.
      if (DEBIT.test(before.replace(/payment to you/i, ''))) break;
      const first = money(m, 1);
      if (first) out.push({ ...first, line });
      if (list) out.push(...continuation(line, m.index + m[0].length).map((e) => ({ ...e, line })));
      break;
    }
  }
  return out;
}

// "... 4,000.00 GHS and 1,250 GHS bonus": further amounts joined directly by and/&/comma.
function continuation(line, from) {
  const out = [];
  const next = new RegExp(`^\\s*(?:,|and|&)\\s*${MONEY_SRC}`, 'i');
  let pos = from;
  for (;;) {
    const m = next.exec(line.slice(pos));
    if (!m) return out;
    const e = money(m, 1);
    if (e) out.push(e);
    pos += m[0].length;
  }
}

// Pull {amount, currency} out of a match whose money token starts at capture group `g`.
function money(m, g) {
  const cur = m[g] || m[g + 3];
  const num = m[g + 1] || m[g + 2];
  if (!cur || !num) return null;
  const amount = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const key = Object.keys(SYMBOL).find((k) => k.toLowerCase() === cur.toLowerCase());
  return { amount, currency: key ? SYMBOL[key] : cur.toUpperCase() };
}

// The email's own Date header is the only date we trust (the LLM may not know today's
// date). It is never later than `now`, so a forged future header cannot make income look
// fresh forever.
export function headerDate(raw, now = new Date()) {
  const m = raw.match(/^Date:\s*(.+)$/im);
  const d = m ? new Date(m[1].trim()) : now;
  if (Number.isNaN(d.getTime())) return now;
  return d.getTime() > now.getTime() ? now : d;
}

// Decoded, tag-stripped body. This is the only part of the email that ever leaves the
// process (it is what the LLM endpoint sees). Block-level tags become newlines so each
// statement row stays on its own line.
export function decodeEmailText(eml) {
  const raw = eml.toString();
  const i = raw.search(/\r?\n\r?\n/);
  let body = i >= 0 ? raw.slice(i) : raw;
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(raw)) {
    body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body
    .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

// Money in is not income. This module sorts every credit on a mobile-money statement into a class and keeps only
// what an underwriter may lend against.
//
// RULES FIRST, DETERMINISTIC, TESTED. The one trust rule: **free text can only LOWER what a credit counts for.**
// The memo and the counterparty's registered name are written by other people (a sender can type "salary" in a
// memo). So a credit only becomes `earned_income` through STRUCTURE: it comes from a system account (the To/From
// cell holds no phone number) whose Account Name is on the payer list, or its Payment Type is a payroll type.
// Words in the memo/name can only push a credit DOWN (loan, betting, interest, refund, savings, own name).
// The AI reader (src/llm-extract.js) is held to the same rule: it may only downgrade, never upgrade.
//
// CLASSES (first matching rule wins, in this order)
//   refund            Payment Type / name / memo says reversal or refund, or it returns an earlier debit of the same
//                     amount to the same counterparty within 3 days.
//   interest          a system account named "Interest ...".
//   betting           bookmaker names (SportyBet, Betway, 1xBet, ...), "Credit.Inv" / "Debit.Inv" gaming invoices.
//   loan_disbursement a lender (QwikLoan, Fido, ...) or the word "loan".
//   self_transfer     the holder's OWN money coming back: their own name in the account name/memo (own bank over GIPS,
//                     own other wallet), own savings or investment wallets (Yellosave "ysavedep", trust/equities, susu).
//   cash_deposit      Payment Type CASH IN: cash put in at an agent. Cannot be told apart from the holder funding
//                     the wallet themselves, so it never counts.
//   earned_income     structural payer match (see above): payout processors and freelance/payroll platforms.
//   peer_transfer     a person-to-person credit (the To/From cell holds a phone number). Counts only in part, see below.
//   unknown           anything else (a business account we do not recognise). Never counts.
// AFTER the rules: pass_through. A credit of earned/peer/unknown class that is large (>= PASS_MIN) and followed
// within 48 hours by debits of similar size (>= 90% of it, each debit used once, earliest credit first) is money that
// moved through the wallet, not money earned: it becomes `pass_through`.
//
// WHAT COUNTS (the only thing the limit uses)
//   earned_income                               counts in full.
//   peer_transfer from a REGULAR payer          counts at PEER_WEIGHT (50%). Regular = the same counterparty paid in at
//                                               least two different calendar months. A one-off peer credit counts 0.
//                                               If only ONE regular payer exists their share is halved again (25%):
//                                               one source is easy to fake (your own second wallet).
//   everything else                             counts 0.
//
// BEHAVIOUR SIGNALS (computed here, used by src/underwrite.js, never leave the enclave): months with income, income
// regularity, average end-of-day balance, share of spend on betting, existing loan repayments.
import { USD_PER } from './underwrite.js';

const DAY = 86400_000;
export const CLASSES = Object.freeze([
  'earned_income', 'peer_transfer', 'self_transfer', 'loan_disbursement', 'betting', 'interest', 'refund',
  'pass_through', 'cash_deposit', 'unknown',
]);
// How much a class may count for. The AI reader may only move a credit to a LOWER rank.
export const RANK = Object.freeze({ earned_income: 3, peer_transfer: 2, unknown: 1 });
export const rankOf = (cls) => RANK[cls] ?? 0;

export const PEER_WEIGHT = 0.5;
export const SINGLE_PAYER_FACTOR = 0.5;
export const PASS_WINDOW_MS = 48 * 3600_000;
export const PASS_SHARE = 0.9;
export const PASS_MIN = 100; // in statement currency units (GHS); smaller credits are never judged pass-through
export const WINDOW_DAYS = 90;
export const BUCKETS = 3; // 30-day buckets in the window

const BETTING = /sporty\s*bet|betway|1x\s*bet|bet9ja|betpawa|msport|premier\s*bet|betking|bet365|supabets|lotto|casino|jackpot|football\s*internet|\bbetting\b|^(?:credit|debit)\.?\s*inv\d*$/i;
const LOAN = /qwik\s*loan|quick\s*loan|\bloan\b|\bfido\b|zenka|cash\s*now|credit\s*now|mazzuma|branch\.co|okash|opay\s*loan/i;
const SAVINGS = /ysavedep|yellosave|\bsusu\b|\bsavings?\b|trust\s*account|\bequities\b|mutual\s*fund|treasury\s*bill|piggy/i;
const REFUND = /\b(?:reversal|reversed|refund(?:ed)?)\b/i;
const PAYER = /paystack|flutterwave|\bdeel\b|payoneer|\bwise\b|upwork|stripe|paypal|\bpayroll\b|\bsalary\b|superteam|remote\.com|fiverr|\bbolt\b|\buber\b/i;
const PAYROLL_TYPE = /\b(?:salary|payroll)\b/i;
const INTEROP = /interoperab|\bgips\b/i;

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter((t) => t.length >= 2));

// The holder's own name in some text: at least two of their name parts (all of them when they have one).
export function mentionsHolder(text, holder) {
  const mine = [...tokens(holder)];
  if (!mine.length) return false;
  const seen = tokens(text);
  const hits = mine.filter((t) => seen.has(t)).length;
  return hits >= Math.min(2, mine.length);
}

// Who sent/received it: the phone number when there is one, else the name (for interop pulls the name sits in the
// memo before the first comma).
function counterparty(r) {
  if (r.party) return `P${r.party.slice(-9)}`;
  if (INTEROP.test(r.acct) && r.ref.includes(',')) return `N${norm(r.ref.split(',')[0])}`;
  return `A${norm(r.acct)}`;
}

function creditClass(r, holder) {
  const text = `${r.acct} ${r.ref}`;
  const system = !r.party;
  if (REFUND.test(r.type) || REFUND.test(text)) return 'refund';
  if (system && /^interest\b/i.test(r.acct)) return 'interest';
  if (BETTING.test(r.acct) || BETTING.test(r.ref)) return 'betting';
  if (LOAN.test(text)) return 'loan_disbursement';
  if ((system && SAVINGS.test(text)) || mentionsHolder(text, holder)) return 'self_transfer';
  if (/^cash\s*in$/i.test(r.type)) return 'cash_deposit';
  if (system && (PAYER.test(r.acct) || PAYROLL_TYPE.test(r.type))) return 'earned_income';
  if (r.party) return 'peer_transfer';
  return 'unknown';
}

function debitClass(r, holder) {
  const text = `${r.acct} ${r.ref}`;
  if (BETTING.test(r.acct) || BETTING.test(r.ref)) return 'betting';
  if (LOAN.test(text)) return 'loan_repayment'; // a debit to a lender
  if (SAVINGS.test(text) || mentionsHolder(text, holder)) return 'own_money'; // moving money to oneself is not spending
  return 'spend';
}

// Step 1: the deterministic classes. Rows come in newest first (statement order); the result keeps that order.
export function classifyRows(rows, { holder = '' } = {}) {
  const out = rows.map((r) => ({ ...r, cls: null, dcls: null }));
  for (const r of out) {
    if (r.future || !r.date || !r.balanceOk) {
      // a row that breaks the running balance (or sits in the future) is not trusted: it can never count
      r.cls = r.amount > 0 ? 'unknown' : null;
      r.dcls = r.amount < 0 ? debitClass(r, holder) : null;
      r.untrusted = true;
      continue;
    }
    if (r.amount > 0) r.cls = creditClass(r, holder);
    else r.dcls = debitClass(r, holder);
  }
  const asc = [...out].sort((a, b) => a.date - b.date || out.indexOf(b) - out.indexOf(a)); // oldest first

  // refund by structure: the money came back from where it went, within 3 days
  const usedDebit = new Set();
  for (const c of asc) {
    if (c.amount <= 0 || c.untrusted || rankOf(c.cls) === 0) continue;
    const d = asc.find((x) => x.amount < 0 && !usedDebit.has(x) && Math.abs(-x.amount - c.amount) < 0.005
      && counterparty(x) === counterparty(c) && x.date <= c.date && c.date - x.date <= 3 * DAY);
    if (d) { usedDebit.add(d); c.cls = 'refund'; }
  }

  // pass-through: large credit, similar-size debits within 48 hours, every debit used once
  const spent = new Map(); // debit row -> amount already assigned
  for (const c of asc) {
    if (c.amount < PASS_MIN || c.untrusted || rankOf(c.cls) === 0) continue;
    const need = c.amount * PASS_SHARE;
    let got = 0;
    const take = [];
    for (const d of asc) {
      if (d.amount >= 0 || d.date <= c.date || d.date - c.date > PASS_WINDOW_MS) continue;
      const free = -d.amount - (spent.get(d) || 0);
      if (free <= 0) continue;
      const use = Math.min(free, c.amount - got);
      got += use;
      take.push([d, use]);
      if (got >= c.amount) break;
    }
    if (got >= need) {
      c.cls = 'pass_through';
      for (const [d, use] of take) spent.set(d, (spent.get(d) || 0) + use);
    }
  }
  return out;
}

// Step 2 (optional): the AI reader's downgrades. `changes` = [{ row (index into rows), cls }]. Only a strictly lower
// rank is applied; everything else is ignored. Returns how many were applied.
export function applyDowngrades(rows, changes) {
  let n = 0;
  for (const { row, cls } of changes) {
    const r = rows[row];
    if (!r || r.amount <= 0 || !CLASSES.includes(cls)) continue;
    if (rankOf(cls) < rankOf(r.cls)) { r.cls = cls; r.llm = true; n++; }
  }
  return n;
}

const bucketOf = (date, now) => Math.floor((now - date) / (30 * DAY));
const monthKey = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;

// Step 3: what counts, and the behaviour signals. Amounts are in the statement currency; the limit converts.
export function finalizeIncome(rows, { now = new Date() } = {}) {
  const inWindow = (r) => r.date && !r.future && now - r.date <= WINDOW_DAYS * DAY && r.date <= now;
  const credits = rows.filter((r) => r.amount > 0);

  // regular peers: the same counterparty in >= 2 distinct calendar months (over everything on the statement)
  const months = new Map();
  for (const r of credits) {
    if (r.cls !== 'peer_transfer') continue;
    const k = counterparty(r);
    (months.get(k) || months.set(k, new Set()).get(k)).add(monthKey(r.date));
  }
  const regular = new Set([...months].filter(([, m]) => m.size >= 2).map(([k]) => k));
  const peerWeight = regular.size >= 2 ? PEER_WEIGHT : PEER_WEIGHT * SINGLE_PAYER_FACTOR;

  const totals = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, amount: 0 }]));
  const events = [];
  for (const r of credits) {
    const cls = r.cls || 'unknown';
    totals[cls].count++;
    totals[cls].amount = round2(totals[cls].amount + r.amount);
    let weight = 0;
    if (cls === 'earned_income') weight = 1;
    else if (cls === 'peer_transfer' && regular.has(counterparty(r))) weight = peerWeight;
    r.weight = weight;
    if (weight > 0 && inWindow(r)) {
      events.push({ amount: r.amount, currency: r.currency, date: r.date, kind: cls === 'earned_income' ? 'salary' : 'transfer_in', txKey: r.txKey, cls, weight });
    }
  }

  // ---- signals
  const buckets = new Set(events.map((e) => bucketOf(e.date, now)).filter((b) => b >= 0 && b < BUCKETS));
  const debits = rows.filter((r) => r.amount < 0 && inWindow(r));
  const spend = debits.filter((r) => r.dcls !== 'own_money');
  const spendTotal = sum(spend.map((r) => -r.amount));
  const betting = sum(spend.filter((r) => r.dcls === 'betting').map((r) => -r.amount));
  const loans = sum(debits.filter((r) => r.dcls === 'loan_repayment').map((r) => -r.amount));
  const signals = {
    monthsWithIncome: buckets.size,
    incomeRegularity: round2(buckets.size / BUCKETS),
    avgEodBalance: averageEodBalance(rows, now),
    bettingShareOfSpend: spendTotal > 0 ? round2(betting / spendTotal) : 0,
    loanRepaymentsPerMonth: round2(loans / BUCKETS),
    currency: rows[0]?.currency || 'GHS',
  };
  const counted = round2(sum(events.map((e) => e.amount * e.weight)));
  return { events, totals, signals, countedTotal: counted, regularPeers: regular.size };
}

// Average of the end-of-day balances over the last 90 days (or the statement's span if shorter). Rows are newest first.
function averageEodBalance(rows, now) {
  const ok = rows.filter((r) => r.date && !r.future);
  if (!ok.length) return 0;
  const asc = [...ok].reverse();
  const startDay = Math.max(Math.floor(asc[0].date / DAY), Math.floor(now / DAY) - WINDOW_DAYS + 1);
  const endDay = Math.min(Math.floor(now / DAY), Math.floor(asc[asc.length - 1].date / DAY));
  if (endDay < startDay) return round2(asc[asc.length - 1].balance);
  let i = 0;
  let bal = asc[0].balance - (asc[0].amount - asc[0].fee - asc[0].tax); // balance before the first row
  let total = 0;
  let days = 0;
  for (let d = startDay; d <= endDay; d++) {
    while (i < asc.length && Math.floor(asc[i].date / DAY) <= d) bal = asc[i++].balance;
    total += bal;
    days++;
  }
  return round2(total / days);
}

// Convenience: rules only, then finalize.
export function assessRules(statement, { now = new Date() } = {}) {
  const rows = classifyRows(statement.rows, { holder: statement.holder });
  return { rows, ...finalizeIncome(rows, { now }) };
}

export const toUsd = (amount, currency) => amount * (USD_PER[currency] ?? 0);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const round2 = (x) => Math.round(x * 100) / 100;

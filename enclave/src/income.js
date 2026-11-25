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
//   cash_deposit      Payment Type CASH IN: cash put in at an agent. A market trader's takings arrive this way, but it
//                     cannot be told apart from the holder funding the wallet from their own pocket, so it counts only
//                     under the CASH RULES below.
//   earned_income     structural payer match (see above): payout processors and freelance/payroll platforms.
//   peer_transfer     a person-to-person credit (the To/From cell holds a phone number). Counts only in part, see below.
//   unknown           anything else (a business account we do not recognise). Never counts.
// AFTER the rules: pass_through. A credit of earned/peer/unknown class that is large (>= PASS_MIN) and followed
// within 48 hours by debits of similar size (>= 90% of it, each debit used once, earliest credit first) is money that
// moved through the wallet, not money earned: it becomes `pass_through`.
//
// WHAT COUNTS (the only thing the limit uses)
//   earned_income                               counts in full.
//   cash_deposit                                counts at CASH_WEIGHT (50%) of what is left after the CASH RULES.
//   peer_transfer from a REGULAR payer          counts at PEER_WEIGHT (50%). Regular = the same counterparty paid in at
//                                               least two different calendar months. A one-off peer credit counts 0.
//                                               If only ONE regular payer exists their share is halved again (25%):
//                                               one source is easy to fake (your own second wallet).
//   everything else                             counts 0.
//
// CASH RULES (steady cash deposits ARE income for a trader, but cash is the easiest thing to fake, so each rule below
// only ever LOWERS what a deposit counts for; the AI reader can never move a credit INTO this class)
//   1. Cycling. A deposit is matched, oldest deposit first, against money that LEAVES the wallet: cash-outs, person-to-
//      person and other-network transfers, moves to the holder's own savings/bank. A debit up to 7 days AFTER the
//      deposit counts (a cash-out up to 7 days BEFORE it counts too: take cash out, put it back in). Every debit is
//      used once and in proportion, with no minimum size, so splitting a deposit into small pieces buys nothing and
//      leaving 90% behind does not pass a 90% test. Spending on merchants, bills and airtime is not cycling.
//   2. Net cash. Every debit that leaves the wallet (cash-out, person-to-person or other-network transfer, move to the holder's own bank)
//      that no deposit used up (waiting 8 days to move it on beats rule 1) is taken off what is left, however late it happens in the window.
//   3. Regularity. What is left must fall in at least CASH_MIN_MONTHS of the 3 thirty-day months of the window, or
//      nothing counts. One big deposit in one month is not income.
//   4. Evenness. A month may count for at most CASH_MONTH_CAP times the (lower) median month, so a token deposit in a
//      second month cannot unlock one huge deposit.
//
// PEER RETURNS (audit #7: helper SIMs send money in and the holder sends it straight back). A peer credit whose money goes back
// to the SAME counterparty within PEER_RETURN_WINDOW_MS (14 days, before or after the credit) counts only for the part that did not
// go back (each debit used once). A return under PEER_RETURN_DEADZONE (10%) of the credit is change, not a loop.
// MONEY PASSED BACK (final gate #2: a merchant-till loop). A peer credit that arrives within PASSBACK_WINDOW_MS (7 days) AFTER a debit of
// similar size (a merchant/till payment, a bill, or a transfer to anyone; min/max of the two amounts >= PASSBACK_SIMILAR) is the same
// money coming back: it counts only for the part not covered (each debit used once), and the debit it undoes no longer counts as
// real spending. For CASH, every unmatched outgoing debit of the window (cash-outs, transfers, other networks, moves to the holder's own
// bank that no rule above used up) is subtracted (CASH RULE 2). It is NOT subtracted from peer income: an honest earner pays rent and
// family by transfer too, and the passed-back match plus the cap below already bound a peer loop. SOFT CAP: whatever is left of soft
// income (peers + cash) is capped at SOFT_CAP_USD_PER_MONTH, because no soft rule can tell a genuine float loop from honest trade.
// SPEND BACKING (audits #6 and #7: anything that waits longer than the windows above). Soft income, cash deposits plus peer
// transfers, may not exceed SPEND_BACKING (2x) the REAL spending of the window: merchant payments, bills, airtime, i.e. money that
// left for goods. Transfers, cash-outs, savings, betting and loan repayments prove nothing and do not count as spending. So
// cycling money through a wallet buys a limit only for as much real money as it spends. Result: `netFlow` {realSpend, backing}.
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
export const RANK = Object.freeze({ earned_income: 3, peer_transfer: 2, cash_deposit: 1.5, unknown: 1 });
export const rankOf = (cls) => RANK[cls] ?? 0;

export const PEER_WEIGHT = 0.5;
export const SINGLE_PAYER_FACTOR = 0.5;
export const PASS_WINDOW_MS = 48 * 3600_000;
export const PASS_SHARE = 0.9;
export const CASH_WEIGHT = 0.5;
export const CASH_MIN_MONTHS = 2;
export const CASH_CYCLE_WINDOW_MS = 7 * DAY;
export const CASH_MONTH_CAP = 2;
// Audit #7 (peer income cycled through helper SIMs): a peer credit whose money goes back to the same counterparty within
// PEER_RETURN_WINDOW_MS (before or after) counts only for the part that did NOT go back; returns under PEER_RETURN_DEADZONE of
// the credit are change, not a loop. Audit #6/#7 (cash and peers): soft income (cash deposits + peer transfers) may not
// exceed SPEND_BACKING x the REAL spending of the window (merchant payments, bills, airtime: money that left for goods and
// services, not transfers, cash-outs, own accounts, betting or loans). A real earner spends most of what they earn, so this
// never touches an honest statement, but a float that only ever moves between wallets backs nothing.
export const PEER_RETURN_WINDOW_MS = 14 * DAY;
export const PEER_RETURN_DEADZONE = 0.1;
export const SPEND_BACKING = 2;
// Final gate #2 (merchant-till loop): a peer credit that follows a similar-size debit (a merchant/till payment, or any debit to a
// party) within PASSBACK_WINDOW_MS is money passed back, not income (see PEER RETURNS above), and the debit it undoes is not real
// spending either. Soft income (peers + cash) is also capped at SOFT_CAP_USD_PER_MONTH (any currency, converted), because
// every soft rule above can be gamed a little by looping a float through enough hands; a cap bounds what is left to a number
// that no float can scale. Verified income (earned_income: payers and payroll the rules recognise) is never capped.
export const PASSBACK_WINDOW_MS = 7 * DAY;
export const PASSBACK_SIMILAR = 0.5; // a debit is "similar" to a credit when min/max of the two amounts is at least this
export const SOFT_CAP_USD_PER_MONTH = 250;
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
    else {
      r.dcls = debitClass(r, holder);
      r.savingsProduct = r.dcls === 'own_money' && !r.party && SAVINGS.test(r.acct) && !mentionsHolder(`${r.acct} ${r.ref}`, holder);
    }
  }
  const asc = [...out].sort((a, b) => a.date - b.date || out.indexOf(b) - out.indexOf(a)); // oldest first

  // refund by structure: the money came back from where it went, within 3 days
  const usedDebit = new Set();
  for (const c of asc) {
    if (c.amount <= 0 || c.untrusted || rankOf(c.cls) === 0 || c.cls === 'cash_deposit') continue;
    const d = asc.find((x) => x.amount < 0 && !usedDebit.has(x) && Math.abs(-x.amount - c.amount) < 0.005
      && counterparty(x) === counterparty(c) && x.date <= c.date && c.date - x.date <= 3 * DAY);
    if (d) { usedDebit.add(d); d.refunded = true; c.cls = 'refund'; }
  }

  // pass-through: large credit, similar-size debits within 48 hours, every debit used once
  const spent = new Map(); // debit row -> amount already assigned
  for (const c of asc) {
    // cash deposits have their own, stricter cycling rule (finalizeIncome); the 48h rule would punish a trader who spends takings
    if (c.amount < PASS_MIN || c.untrusted || rankOf(c.cls) === 0 || c.cls === 'cash_deposit') continue;
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
  for (const [d, use] of spent) d.passUsed = round2(use); // debits already used up by a pass-through credit
  return out;
}

// Step 2 (optional): the AI reader's downgrades. `changes` = [{ row (index into rows), cls }]. Only a strictly lower
// rank is applied; everything else is ignored. Returns how many were applied.
export function applyDowngrades(rows, changes) {
  let n = 0;
  for (const { row, cls } of changes) {
    const r = rows[row];
    if (!r || r.amount <= 0 || !CLASSES.includes(cls) || cls === 'cash_deposit') continue; // only the rules may file a credit as cash
    if (rankOf(cls) < rankOf(r.cls)) { r.cls = cls; r.llm = true; n++; }
  }
  return n;
}

const bucketOf = (date, now) => Math.floor((now - date) / (30 * DAY));
const monthKey = (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;

// Step 3: what counts, and the behaviour signals. Amounts are in the statement currency; the limit converts.
export function finalizeIncome(rows, { now = new Date(), cashOwnMoney = 'bank' } = {}) {
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
  const { share: returned, backUsed } = peerReturns(rows);

  const cash = cashStep(rows, now, inWindow, { cashOwnMoney }, backUsed);

  const totals = Object.fromEntries(CLASSES.map((c) => [c, { count: 0, amount: 0 }]));
  const events = [];
  for (const r of credits) {
    const cls = r.cls || 'unknown';
    totals[cls].count++;
    totals[cls].amount = round2(totals[cls].amount + r.amount);
    let weight = 0;
    if (cls === 'earned_income') weight = 1;
    else if (cls === 'peer_transfer' && regular.has(counterparty(r))) weight = peerWeight * (1 - (returned.get(r) || 0));
    else if (cls === 'cash_deposit') weight = cash.weights.get(r) || 0;
    r.weight = weight;
  }
  // Net-flow check over the window: soft income needs real spending behind it.
  const soft = credits.filter((r) => (r.cls === 'peer_transfer' || r.cls === 'cash_deposit') && r.weight > 0 && inWindow(r));
  const softCounted = sum(soft.map((r) => r.amount * r.weight));
  const realSpend = sum(rows.filter((d) => d.amount < 0 && inWindow(d) && isRealSpend(d)).map((d) => -d.amount - (d.passUsed || 0) - (backUsed.get(d) || 0)));
  const spendLimit = SPEND_BACKING * Math.max(0, realSpend);
  const backing = softCounted > spendLimit ? (softCounted > 0 ? spendLimit / softCounted : 0) : 1;
  if (backing < 1) for (const r of soft) r.weight *= backing;
  // Soft cap: whatever soft income is left may not exceed SOFT_CAP_USD_PER_MONTH over the window (no float can scale it).
  const softUsd = sum(soft.map((r) => r.amount * r.weight * (USD_PER[r.currency] ?? 0)));
  const capUsd = SOFT_CAP_USD_PER_MONTH * (WINDOW_DAYS / 30);
  const capFactor = softUsd > capUsd ? capUsd / softUsd : 1;
  if (capFactor < 1) for (const r of soft) r.weight *= capFactor;
  for (const r of credits) {
    const cls = r.cls || 'unknown';
    const weight = r.weight || 0;
    if (weight > 0 && inWindow(r)) {
      events.push({ amount: r.amount, currency: r.currency, date: r.date, kind: cls === 'earned_income' ? 'salary' : cls === 'cash_deposit' ? 'cash_deposit' : 'transfer_in', txKey: r.txKey, cls, weight });
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
  return {
    events, totals, signals, countedTotal: counted, regularPeers: regular.size, cash: cash.summary,
    netFlow: { softCounted: round2(softCounted), realSpend: round2(realSpend), backing: round2(backing), capFactor: round2(capFactor) },
  };
}

// Money that left for goods and services: a payment to a merchant, a bill, airtime or data. NOT a person-to-person
// transfer, a cash-out, a move to the holder's own accounts, betting or a loan repayment (none of those prove the holder
// earned anything: they can all be undone or looped back).
function isRealSpend(d) {
  return d.dcls === 'spend' && !isCashOut(d) && !LEAVING_TYPE.test(d.type) && !d.untrusted;
}

// For each peer credit: the share (0..1) that went back, in two ways. (1) Straight back to the same counterparty within
// PEER_RETURN_WINDOW_MS, before or after it. (2) MONEY PASSED BACK: covered by earlier debits of similar size (a merchant/till
// payment, a bill, a transfer to anyone) within PASSBACK_WINDOW_MS before it. Every debit is used once (oldest credit first), so
// splitting buys nothing. Shares under the dead zone read as 0 (change, small repayments). Also returns `backUsed`: how much of
// each debit a credit used up, so it stops counting as real spending.
function peerReturns(rows) {
  const peers = rows.filter((r) => r.amount > 0 && r.cls === 'peer_transfer' && !r.untrusted && r.date).sort((a, b) => a.date - b.date);
  const debits = rows.filter((r) => r.amount < 0 && r.date).sort((a, b) => a.date - b.date);
  const used = new Map();
  const share = new Map();
  const backUsed = new Map();
  const change = new Map(); // small returns under the dead zone: change, not a loop and not outflow either
  const free = (d) => -d.amount - (d.passUsed || 0) - (used.get(d) || 0);
  for (const c of peers) {
    let need = c.amount;
    const take = [];
    const grab = (d) => {
      const t = Math.min(free(d), need);
      used.set(d, (used.get(d) || 0) + t);
      take.push([d, t]);
      need -= t;
    };
    for (const d of debits) {
      if (need <= 0.004) break;
      if (!d.party || counterparty(d) !== counterparty(c) || Math.abs(d.date - c.date) > PEER_RETURN_WINDOW_MS || free(d) <= 0.004) continue;
      grab(d);
    }
    for (const d of debits) {
      if (need <= 0.004) break;
      const similar = Math.min(-d.amount, c.amount) / Math.max(-d.amount, c.amount) >= PASSBACK_SIMILAR;
      if (d.untrusted || !(d.date <= c.date && c.date - d.date <= PASSBACK_WINDOW_MS) || !(d.dcls === 'spend' || d.party) || !similar || free(d) <= 0.004) continue;
      grab(d);
    }
    const s = (c.amount - need) / c.amount;
    share.set(c, s < PEER_RETURN_DEADZONE ? 0 : s);
    if (s < PEER_RETURN_DEADZONE) { for (const [d, t] of take) { used.set(d, used.get(d) - t); change.set(d, (change.get(d) || 0) + t); } continue; }
    for (const [d, t] of take) backUsed.set(d, (backUsed.get(d) || 0) + t);
  }
  return { share, backUsed, change };
}

// ---- cash deposits (see CASH RULES at the top) ------------------------------------------------------------------------
const CASH_OUT = /^(?:cash\s*out|withdraw\w*)$/i;
const LEAVING_TYPE = /^(?:momo user|other networks?|transfer\w*)$/i;
const isCashOut = (d) => CASH_OUT.test(d.type);
// Money that leaves the wallet as cash or as a transfer. NOT: airtime, bills, merchant payments (that is spending).
// Moves to the holder's OWN money (`cashOwnMoney`):
//   'bank' (default) own bank, own other wallet, anything with the holder's name leaves: that is the tell-tale of the loop
//                    "own bank -> ATM cash -> agent deposit -> own bank", which no statement can show in full. A savings
//                    PRODUCT (a system account whose registered name says savings/trust/equities, no phone number) does
//                    not: that money can only turn back into cash THROUGH this wallet, where a cash-out shows (rule 2).
//                    Only the account name decides, never the memo: the borrower writes their own memos.
//   'all'            every own-money move leaves (strictest).
//   'none'           none does (what-if only).
const leaves = (d, mode) => isCashOut(d) || LEAVING_TYPE.test(d.type) || (d.dcls === 'own_money' && (mode === 'all' || (mode === 'bank' && !d.savingsProduct)));

// -> { weights: Map(row -> weight 0..CASH_WEIGHT), summary }. Every step only lowers.
function cashStep(rows, now, inWindow, { cashOwnMoney }, backUsed = new Map()) {
  const deposits = rows.filter((r) => r.amount > 0 && r.cls === 'cash_deposit' && !r.untrusted && inWindow(r)).sort((a, b) => a.date - b.date);
  const summary = { deposits: deposits.length, total: round2(sum(deposits.map((r) => r.amount))), cycled: 0, unmatchedCashOut: 0, monthsWithCash: 0, countable: 0, counted: 0 };
  const weights = new Map();
  if (!deposits.length) return { weights, summary, used: new Map() };

  // 1. cycling: oldest deposit first, earliest debit first, every debit used once and only up to its size
  const debits = rows.filter((r) => r.amount < 0 && r.date).sort((a, b) => a.date - b.date);
  const used = new Map();
  const free = (d) => -d.amount - (d.passUsed || 0) - (used.get(d) || 0);
  const left = new Map(); // deposit -> amount that did not cycle
  for (const c of deposits) {
    let need = c.amount;
    for (const d of debits) {
      if (need <= 0.004) break;
      const after = d.date > c.date && d.date - c.date <= CASH_CYCLE_WINDOW_MS;
      const before = d.date <= c.date && c.date - d.date <= CASH_CYCLE_WINDOW_MS && isCashOut(d);
      if (!(after || before) || !leaves(d, cashOwnMoney) || free(d) <= 0.004) continue;
      const take = Math.min(free(d), need);
      used.set(d, (used.get(d) || 0) + take);
      need -= take;
    }
    left.set(c, Math.max(0, need));
  }
  summary.cycled = round2(summary.total - sum([...left.values()]));

  // 2. net cash: every debit that LEAVES the wallet (cash-outs, transfers, other networks, own bank) and that no deposit used up
  // comes off what is left, however long after the deposit it happens (final gate #2; the 7 day rule above only matches
  // timing, this is the net of the whole window). Refunded debits (the money came back) and passed-back payments are not outflow.
  const unmatched = sum(debits.filter((d) => inWindow(d) && !d.untrusted && !d.refunded && leaves(d, cashOwnMoney)).map((d) => Math.max(0, free(d) - (backUsed.get(d) || 0))));
  summary.unmatchedCashOut = round2(unmatched);
  const afterCycling = sum([...left.values()]);
  const net = afterCycling > 0 ? Math.max(0, afterCycling - unmatched) / afterCycling : 0;
  const countable = new Map(deposits.map((c) => [c, left.get(c) * net]));

  // 3. regularity: at least CASH_MIN_MONTHS of the 3 thirty-day months
  const perMonth = new Map();
  for (const c of deposits) {
    const b = bucketOf(c.date, now);
    if (b >= 0 && b < BUCKETS) perMonth.set(b, (perMonth.get(b) || 0) + countable.get(c));
  }
  const filled = [...perMonth.values()].filter((v) => v > 0.004).sort((a, b) => a - b);
  summary.monthsWithCash = filled.length;
  summary.countable = round2(sum(filled));
  if (filled.length < CASH_MIN_MONTHS) return { weights, summary, used };

  // 4. evenness: a month counts for at most CASH_MONTH_CAP x the lower median month
  const cap = CASH_MONTH_CAP * filled[Math.floor((filled.length - 1) / 2)];
  for (const c of deposits) {
    const b = bucketOf(c.date, now);
    const month = perMonth.get(b) || 0;
    if (!(b >= 0 && b < BUCKETS) || month <= 0.004) continue;
    const frac = (countable.get(c) * Math.min(1, cap / month)) / c.amount;
    weights.set(c, CASH_WEIGHT * frac);
  }
  summary.counted = round2(sum(deposits.map((c) => c.amount * (weights.get(c) || 0))));
  return { weights, summary, used };
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

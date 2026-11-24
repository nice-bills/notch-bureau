# Notch core review: last check before UI work (2026-11-24, HEAD c478bdc)

Repo test suites: `pnpm test` 74/74, `test:enclave` 206/206, `test:sdk` 6/6, all passing.
Repro tests (scratch, outside the repo): `prog.test.js` (LiteSVM), `income.test.js`, `redirect.test.js`, `size.test.js` in this folder.
Earlier fixes be7b93d / c478bdc: the inbox device proof is bound to its wallet, a pepper is required (taken from the TEE in the CVM), and /posted reads v2 and v3 records. All verified in place.

## Ranked findings

### 1. CRITICAL: the keeper never sees a current credit line (CONFIRMED)
- `supabase/functions/keeper/lib.ts:26,113`, `app/scripts/keeper.mjs:140` (and `CREDIT_LINE_MIN_LEN` in `app/src/notch.ts`).
- The `getProgramAccounts` filter is `dataSize: 98`. A `CreditLine` built by the current program is **106 bytes**, because `posted_at` was added (measured in LiteSVM, see `size.test.js`). Only old 98-byte lines match the filter.
- What goes wrong: a borrower draws and never repays, and the hourly keeper reports "0 overdue" forever. No `mark_default` ever runs, so the loss never reaches the share price. Lenders who exit early get paid in full and leave the hole to the ones who stay (this makes #4 much worse). The keeper test passes only because it builds a fake 98-byte buffer (`enclave/test/supabase-keeper.test.js:16`).
- Fix: drop the `dataSize` filter and keep only the discriminator `memcmp`. `decodeLine` already accepts both sizes (it checks `>= 98`). Change the test to build 106-byte lines plus one legacy 98-byte line.

### 2. HIGH: 6 micro-USDC of dust loans max out the reputation cap (CONFIRMED, LiteSVM)
- `programs/notch/src/lib.rs:367-368` (`repaid_on_time += 1` on any full repay, whatever the size), read by `enclave/src/chain-history.js:47` → `underwrite.js:28` (`cap = 50 * 2^min(repaidOnTime,6)`).
- Repro (`prog.test.js` F1): in ONE transaction, `deposit_borrower(1)` + 6 × [`draw(1)`, `repay(2)`, `deposit_borrower(1)`] → `repaid_on_time = 6`. Total cost: 6 micro-USDC.
- What goes wrong: a first-time borrower's cap jumps from $50 to $2000 straight away. `check_credit` also hands `on_time_repayments` to third parties (the hostel) as a trust signal, and that number is fake.
- Fix: count an on-time repayment only when principal ≥ a floor (for example ≥ 25% of `limit` and ≥ 5 USDC) AND the loan was held ≥ some minimum time. Count at most one per posted record: store `counted_nonce` and require `line.last_nonce > counted_nonce`. Better still, have the underwriter use repaid *volume* rather than a count.

### 3. HIGH: `/underwrite` takes anyone's MTN statement for any wallet (CONFIRMED)
- `enclave/src/cvm-server.js:194`, `http-app.js:37` → `underwriter.js:73,78` (the To-header check runs only when `recipient` is set, which only the inbox sets). `x-wallet` is not authenticated.
- Repro (`redirect.test.js`): a DKIM-valid MTN statement addressed to `student@example.com`, posted with a random attacker wallet → `ok: true`, limit 27.76. The same email through the inbox To check → refused.
- What goes wrong: anyone holding a copy of a victim's statement (a forwarded email, a loan app that collected it, a shared laptop) posts it first. The victim's phone number's `IdentityLink` is then bound to the attacker **forever**: the victim can never use Notch, and the attacker borrows on the victim's income. The claim in `inbox.js:12-18` that a statement "cannot be redirected" does not hold for this route.
- Fix: in `submit`, refuse `statement-pdf` (and anything that carries an identity) unless `recipient` is set, so statements come in through the inbox only. Require a wallet signature (or the Supabase SIWS token) on `/underwrite` for the other kinds as well.

### 4. HIGH: a "ready" withdraw request makes the 3-day cooldown pointless (CONFIRMED, LiteSVM)
- `lib.rs:414-487`. A request never expires after `unlock_ts`, and shares in escrow keep earning.
- Repro (`prog.test.js` F2): lender A puts 100 into junior, requests a withdraw at once and waits out the cooldown. A borrower draws 50 and goes overdue. A claims **100 (in full)** before `mark_default`. After the default the other junior holder has 60 left, so they took the whole net loss of 40. A's fair share of the loss was 20 (A should have got back 80).
- What goes wrong: a smart lender always keeps a request ready, earns the full yield, and leaves the moment any loan is overdue, at the latest by front-running `mark_default`. With #1 there is no keeper at all, so the window never closes.
- Fix (do both): (a) a claim window: the claim must happen within `unlock_ts .. unlock_ts + 1 day`, otherwise the request is dead and must be cancelled and filed again; (b) shares stop earning in escrow: save `nav/supply` at request time and pay `min(price at request, price at claim)`.

### 5. MEDIUM: an overdue borrower can keep drawing (CONFIRMED, LiteSVM)
- `lib.rs:535-555` (`do_draw` never checks `now <= due`). `post_limit` and the underwriter's history check do not look at "overdue" either (`chain-history.js` returns only `repaidOnTime` and `frozen`).
- Repro (`prog.test.js` F3): draw 10 with a 10-second term, wait 100 s, draw 40 more → succeeds.
- What goes wrong: once a borrower knows they will default, they take the rest of the limit (or of a freshly re-underwritten, higher limit) before the keeper acts.
- Fix: `require!(line.drawn == 0 || now <= line.due)` in `do_draw`. Make `getCreditHistory` return `overdue` (drawn > 0 and now > due), and refuse to underwrite while it is true.

### 6. MEDIUM: cash cycled out by P2P transfer after 8+ days counts as income (CONFIRMED, rules test)
- `enclave/src/income.js:316-339`. Rule 1 looks only 7 days ahead. Rule 2 ("net cash") subtracts only unmatched **cash-outs**, not transfers that leave.
- Repro (`income.test.js`): a 10,000 GHS float, deposited in cash then sent P2P 8 days later, 11 times → 110,000 deposited, `cycled 0`, 55,000 counted, limit $357.50 with the cap from #2 (it hits the $50 cap without it). The float itself is never at risk.
- Fix: rule 2 should subtract every unmatched debit that counts as `leaves()` (P2P, other networks, own bank), not just cash-outs. Or use a 30-day cycling window for transfers.

### 7. MEDIUM: peer income can be faked by cycling with two helper SIMs (CONFIRMED, rules test)
- `income.js:228-236` (being "regular" needs only 2 calendar months; pass-through looks only 48 h ahead).
- Repro: two numbers each send 1000 GHS, the holder sends it back 4 days later, repeated every 9 days → 50% weight on all of it, 10,000 GHS counted, limit $65 with the pumped cap. The volume is unbounded.
- Fix: count each counterparty's *net* inflow over the window (credits minus debits to that same party), and cap peer income at the net amount.

### 8. MEDIUM (PLAUSIBLE): email-body sources count at full weight with no binding or cycling checks
- `underwriter.js:159-162`, `extract.js:120` (`#plain` calls `extractIncome(eml)` with no `domain`, so the provider templates are never used and only the generic grammar runs, including `^X sent you {M}`).
- What goes wrong: Wise/Payoneer "X sent you $1000" emails from a person's own second account, or from friends, each count at 100% with no identity (`id_hash = 0`). The same money cycles N times a month, and the emails can be spread across several wallets.
- Fix: pass `domain` into the extractor. Weight person-to-person phrasing like `peer_transfer`. Bind an account id (for example the recipient address hash) the way the phone number is bound.

### 9. LOW: underwriter dedupe state lives only in memory
- `underwriter.js:44-50` (`payoutTxs`, `rows`, `wallets`, `used`). After a restart, one on-chain Earn payout can back a second, different Earn email (different body hash, so a different dedupe PDA).
- Fix: put the payout tx signature into the record's dedupe input, or persist `payoutTxs`.

### 10. LOW: one wallet can stack many phone numbers
- The `IdentityLink` maps phone number → wallet only, so one wallet can combine statements from N numbers (`underwriter.js:113`), which multiplies #6 and #7.
- Fix: add a wallet → identity PDA, or cap distinct identities per wallet.

### 11. LOW (PLAUSIBLE, traced): first-depositor inflation on an empty tranche through fee compounding
- `lib.rs:270-276`. While supply is 0, an attacker deposits 1 micro-unit, then as a borrower loops draw/repay. Each fee goes into NAV (and back to the attacker), so the share price compounds about 2% per loop for free. A later depositor's share count rounds down (rounding is in the pool's favour, so there are no free shares, but the depositor loses value). It is slow (about 1000 tx to reach about $1000) and only works on an empty tranche.
- Fix: have `init_pool` mint dead shares (1e6) to the pool, or require a minimum first deposit.

### 12. NOTE: privacy of the exact limit
- `CreditLine.limit` and the `LimitPosted` event are public and exact. The limit is about 0.3 × monthly income, so anyone can read a borrower's income band from chain even though `check_credit` returns only a coarse bucket. If that is accepted, say so in the docs. Otherwise post only the bucket, or a commitment to the limit.

## Area by area
- **Program, Ed25519 introspection**: nothing serious. The index is `u16::MAX` on all three offsets, the previous instruction must be the precompile, the key must equal `config.underwriter`, and the message must equal the record byte for byte.
- **Record v2/v3 parsing, expiry, nonce, dedupe PDA, IdentityLink/DeviceLink PDAs**: nothing serious. The seeds come from the verified record, the optional accounts are required whenever a hash is non-zero, and a negative expiry fails.
- **Repay/fee/20% deposit, mark_default waterfall, NAV invariant, rounding, junior floor, idle cap, check_credit, hostel CPI**: math correct. Issues: #2, #4, #5, #11.
- **dkim.js** (`l=`, From alignment, covered headers, body-hash dedupe), **mime/pdf-text**, **statement.js** (column geometry, balance chain): nothing serious.
- **income.js**: #6, #7. The AI downgrade-only rule holds (`corroborateClasses` and `applyDowngrades` both check rank, and cash cannot be assigned).
- **underwriter.js**: #3, #8, #9, #10. Replies leak nothing beyond the limit.
- **SGT reader**: nothing serious.
- **Supabase** (RLS, grants, the definer function's search_path, keeper secret): nothing serious except the keeper bug #1.
- **SDK**: nothing serious. Offsets and the 38-byte return decode match.

## Verdict
**Not ready for UI.** Must fix first: #1 (keeper filter), #2 (dust repayments), #3 (statements only via the inbox; sign `/underwrite`), #4 (claim window plus no earning in escrow), #5 (no draw while overdue). Each fix is small. #6 and #7 should be fixed before any demo that claims fraud resistance.

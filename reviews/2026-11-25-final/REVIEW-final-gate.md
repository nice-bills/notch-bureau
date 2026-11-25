# Notch final gate review (2026-11-25, HEAD a4192b4)

Suites run locally: `pnpm test` 89/89, `test:enclave` 234/234, `test:sdk` green. No e2e, no devnet/Supabase/Phala writes.
Scratch proofs (outside the repo), in this folder:
- `prog-rev.test.mjs` (LiteSVM on target/deploy/notch.so, sha 37e72d7d... = the deployed build). R1 and R2 both pass, which means both holes are real.
- `merchant-loop.mjs` (income rules).

## Ranked findings

### 1. HIGH, CONFIRMED: the repayment count can still be pumped with dust limits and cheap emails
- Where: `programs/notch/src/lib.rs:835-843` (`floor = max(limit/4, 5 USDC).min(limit)`, hold check against `MIN_COUNTED_HOLD_S = 30` at :40, once per `last_nonce`). The underwriter signs a new record for any fresh email (`enclave/src/underwriter.js:94-203`). The cap is `50 * 2^min(n,6)` (`enclave/src/underwrite.js:29`).
- What is wrong: the bound is "one count per record", and records are cheap. Because of `.min(limit)`, a dust limit earns a full count. A 30-second hold says nothing about credit.
- Scenario (R2): six records at a 0.05 USDC limit. For each one: draw 0.05, wait 31 s, repay. Result: `repaid_on_time = 6` in about 4 minutes for a few cents. The cap goes from $50 to $2000, and `check_credit` tells the hostel "6 on-time repayments".
  - In production the records come from any small Wise or Payoneer credit email (one dollar from a friend).
  - On the live demo CVM (`DEMO_FIXTURES=1`) it is free: `GET /samples/deel.eml` returns unlimited fresh signed emails (`enclave/src/cvm-server.js:181-191`).
  - The permanent test F1 "a small limit still works" (`tests/audit.test.js:91`) locks this behaviour in.
- Fix:
  - Use an absolute floor (drop `.min(limit)`): a line with a limit under 5 USDC never earns a count.
  - Require a real hold (for example 7 days or 25% of the term).
  - Allow at most one count per 14 to 30 days, stored as `counted_at` in `LineExt`, whatever the number of records.
  - Better still, have the underwriter use repaid volume times days held.

### 2. HIGH, CONFIRMED: a merchant-till loop beats the #6/#7 fixes, and FIXES.md overstates #6
- Where:
  - `enclave/src/income.js:283` (`isRealSpend`: any `PAYMENT` counts as real spending);
  - `peerReturns` in `income.js` (only matches a return to the SAME counterparty);
  - `income.js:354` (step 2 still subtracts only cash-outs).
- Scenario (`merchant-loop.mjs`): the holder pays a friendly MoMoPay till 1000 GHS. Its owner sends the money back by P2P from one of two personal SIMs a day later. This repeats every 3 days.
  - Each loop adds both "real spend" and "peer income", so the spend-backing never bites (backing = 1).
  - A 1000 GHS float counts 14,500 GHS over 90 days. A 5000 GHS float counts 72,500 GHS and gives a 471 USDC limit with the pumped cap from #1.
  - It scales in a straight line up to the 2000 USDC hard cap (about a 25k GHS float, never at risk). Add #1, borrow 2000 and walk away: the attacker loses only the 400 deposit.
- Doc error: FIXES.md says "any unmatched `leaves()` debit subtracts". The code does not do that. #6 rests on spend-backing alone.
- Fix:
  - Treat a peer credit that arrives within 7 days after a merchant payment of a similar size as money passed back.
  - Cap soft income (peer plus cash) at a fixed monthly amount and/or a share of earned income.
  - Correct FIXES.md.

### 3. MEDIUM-HIGH, CONFIRMED: an armed withdraw request costs nothing, so the escape at "overdue" is easy, not rare
- Where: `lib.rs:580-593` (`cancel_withdraw` hands the shares back at their full current value; the lower locked price applies only on claim). Also the comments at `lib.rs:94-99` and FIXES #4.
- Scenario (R1): A requests a withdraw, a fee arrives, A cancels and still holds the fee (shares worth 101). A bot does this:
  - keeps a request rolling (cancel and file again every 5 days, or two wallets staggered so one is always armed);
  - arms it around public `due` timestamps;
  - at `due + 1` sends `claim_withdraw` (then `mark_default` itself) and takes the pre-loss price.
  It always beats an hourly keeper that sends at most 10 per run.
- The documented residual is accurate, but it says "earns nothing while armed" and "has to time a 2-day window". Both understate it: arming is free and due dates are on chain.
- Fix:
  - On cancel, give up the gain made while in escrow (burn shares worth `shares*(p_now-p_req)/p_now`).
  - Mark defaults on a schedule, not by polling: `mark_default` at `due+1` (keeper at minute cadence, sorted by drawn).
  - Rewrite the residual note honestly.

### 4. MEDIUM, PLAUSIBLE: honest lenders can get stuck in a cancel-and-refile loop
- Where: `lib.rs:546` (a claim is all or nothing against idle cash) plus the lapse at `:520-523`.
- Scenario: when the pool is mostly lent out, a large request cannot be paid, lapses after 2 days, and the 3-day cooldown starts again. Nothing is lost, but the lender cannot exit.
- The frozen UI (`app/src/Lend.tsx:65-67,158,160`) does not know about the window. It shows "Ready / Claim" forever after the lapse, and the hint still says "paid at the share price when you claim", which is now min(request price, claim price).
- Fix: a partial claim (pay what idle allows and keep the rest under the same lock), or no lapse while `idle < amount`. In the UI, show the window and the locked price.

### 5. LOW, CONFIRMED: old devnet WithdrawRequest accounts are bricked
- Where: `lib.rs:943-952`. The struct grew by 16 bytes, so Anchor cannot deserialize the old accounts: both claim and cancel fail. The same PDA also blocks a new request (`init`).
- Effect: the escrowed shares are locked forever and stay in the supply. Those lenders can never withdraw from that tranche again. FIXES says "abandoned" but not this. Devnet only.
- Fix: a `close_legacy_request` instruction, or say it plainly in FIXES.md.

### 6. LOW, CONFIRMED: check_credit passes an overdue line
- Where: `lib.rs:284-315` and the SDK's `active` (`sdk/src/index.js`). A borrower who is already past due passes the hostel check until the keeper runs.
- Fix: `require!(line.drawn == 0 || now <= line.due)` in `check_credit`, and mirror it in the SDK.

### 7. LOW, PLAUSIBLE: keeper throughput
- Where: `supabase/functions/keeper/lib.ts:34,134`. At most 10 sends per hourly run, in arbitrary order. A batch of loans due on the same day stretches the #3 window to hours, and lines that fail are retried first every run.
- Fix: sort by drawn, loop until the time budget runs out, run more often.

## Checked and OK
- **Line growth 106/98 → 154:** `resize` happens once (new bytes are zero), rent is topped up from the payer to `minimum_balance(154)`, `posted_at` stays at offset 98, `write_ext` refuses to drop non-zero bytes, legacy draw/repay work, and a legacy repayment never counts.
- **Pool:** NAV invariant, min(request, claim) price, rounding, junior floor, dust-supply check and loss waterfall are all correct.
- **Bureau and keeper:** `check_credit` / hostel CPI and the 38-byte return are unchanged. SDK offsets are fine.
- **Keeper details:** the discriminators are correct (`dce2cd18dc978168`, `b6e77b8442d0898b`, verified by hash), the `Buffer` shim works, and `isPastDue` matches `mark_default`.
- **Statements only via the inbox:** this holds. `recipient` is set only by `Inbox.receive` (behind the worker secret) and by `InboxedUnderwriter` (local demo-enclave and tests only). The CVM uses the strict class.
- **#5, #8, #9, #10, #11:** fixed.

## Remaining gaps as documented
- **#12 exact limit public:** honestly described (README:62, :76).
- **Claim between overdue and mark_default:** described, but understated (see #3).
- **Demo-enclave inbox shortcut:** honest. It is local only, and the fixture resolver means real mail cannot pass. Not mentioned anywhere: the deployed CVM (DEMO_FIXTURES=1) hands out unlimited fresh Deel and bank emails (this feeds #1), and its strict server now refuses the frozen UI's MoMo sample button.

## Verdict
NOT ready for UI. Must fix:
1. **#1:** absolute floor, a real hold, and one count per time window.
2. **#3:** cancel gives up the escrow gain, and the residual note is rewritten.
3. **#2:** either fix it, or change FIXES.md and the pitch so they no longer claim #6/#7 are fixed.

Each is small. Fold #4 (the lapse and the UI window display) into the UI work.

# Final gate 2026-11-25: what was fixed, and the proof

One line per finding in `REVIEW-final-gate.md`. BEFORE = the permanent test run against the old code (fails), AFTER = the same test on the fix (passes). Files are in `proof/`. The scratch repros in this folder (`prog-rev.test.mjs`, `merchant-loop.mjs`) now have permanent twins in the repo suites named below.

| # | Finding | State | Permanent test (fails before, passes after) | Proof |
|---|---------|-------|---------------------------------------------|-------|
| 1 | HIGH: repayment count pumped with dust limits and cheap emails | **fixed** | `tests/audit.test.js` "final gate #1" (4 tests: dust limit never counts; R2 six 0.05 USDC records count 0; cheapest remaining pump = 3 counts in 48 days; the old "small limit still works" test that locked the bug in is gone) plus the rewritten F1 tests (7 day hold, fixed 5 USDC) | `proof/program-BEFORE.txt` (13 fail) / `proof/program-AFTER.txt` (44/44) |
| 1b | Demo server hands one wallet unlimited fresh income emails | **fixed (demo only)** | `enclave/test/sample-limit.test.js` (3) | new file, no BEFORE (the limiter did not exist); the CVM needs a redeploy to pick it up (see Left) |
| 2 | HIGH: merchant-till loop beats the income rules; FIXES overstated #6 | **fixed** | `enclave/test/final-gate-income.test.js` (5) | `proof/income-BEFORE.txt` (3 fail: 14,500 and 72,500 GHS counted) / `proof/income-AFTER.txt` (5/5) |
| 3 | MEDIUM-HIGH: free rolling withdraw requests | **mostly fixed, residual rewritten honestly** | `tests/final-gate.test.js` R1, price-fell, sole-holder, no-dust-burn (found by the devnet e2e), mark_default at due+1 | `proof/program-BEFORE.txt` / `-AFTER.txt` |
| 4 | MEDIUM: honest lenders stuck behind an all-or-nothing claim | **fixed on chain** (partial claim); the frozen UI does not show the window or the locked price | `tests/final-gate.test.js` #4; `tests/notch.test.js` and `tests/tranches.test.js` (3 old tests that asserted all-or-nothing were rewritten) | same |
| 5 | LOW: old devnet `WithdrawRequest`s bricked | **fixed in the program, 2 requests still stuck** | `tests/final-gate.test.js` #5 | same |
| 6 | LOW: `check_credit` / SDK pass an overdue line | **fixed** | `tests/bureau.test.js` "final gate #6"; `sdk/test/sdk.test.js` | same; SDK 7/7 |
| 7 | LOW: keeper throughput | **fixed** | `enclave/test/supabase-keeper.test.js` "final gate #7" (2) | `proof/keeper-BEFORE.txt` (2 fail) / `proof/keeper-AFTER.txt` (8/8) |

## What each fix does

**#1 program (`lib.rs`).** A repayment counts only when ALL hold: principal >= **5 USDC fixed** (`.min(limit)` and `limit/4` removed, so a line with a limit under 5 USDC never counts); held **>= 7 days from the LAST draw**; first count under the current posted record (`counted_nonce`, unchanged); and **>= 14 days after the previous count of the line** (`ext.counted_at`, new). `draw_with_term` is unchanged and still works for demos (a demo-length loan simply never counts). Cheapest pump left: 3 counts in 48 days with six records (test above), i.e. the 6 counts that lift the cap to 2000 USDC need at least 84 days, a real 5 USDC loan held 7+ days each time, six fresh signed records, 0.10 USDC fee per count. That is a long, visible, but not impossible path: it is a cost, not a wall. `LineExt` grew 56 -> 64 bytes, so a line is now **162 bytes** (was 154). Old lines (98, 106, 154 bytes) still draw and repay but cannot count until their next `post_limit` grows them (tested for 154 too). Offsets read by the SDK, keeper and `chain-history` are unchanged.

**#1b demo samples.** `GET /samples/*.eml` on the deployed CVM (`DEMO_FIXTURES=1`) and on the local demo server is rate limited (6 per caller per hour, 120 for everyone, HTTP 429 with `retry-after`). The local demo server exempts a direct loopback caller so the local e2e and the developer's own browser are not throttled. Demo only: it is a speed bump, memory only, resets on restart. The program-side 14-day rule is what actually bounds the pump.

**#2 income (`enclave/src/income.js`).**
- *Money passed back:* a peer credit that follows a debit of similar size (min/max >= 0.5; a merchant/till payment, a bill, or a transfer to anyone) within 7 days is the same money coming back. It counts only for the part not covered, and the debit it undoes no longer counts as real spending (so spend-backing finally bites).
- *Unmatched outgoing debits now subtract from CASH* (every debit that leaves: cash-out, transfer, other network, own bank, however late; refunded debits and passed-back payments excluded). **This is what the old FIXES.md claimed and the code did not do.** It is NOT applied to peer income: an honest earner pays rent and family by transfer, and the passed-back match plus the cap already bound a peer loop (the old audit control test with a landlord proves it).
- *Soft cap:* peer + cash income together may not exceed **250 USD per month** (any currency, converted; verified `earned_income` is never capped). So a loop that evades the size match (ten small payments out, one big credit back) is bounded: limit <= 0.3 x 250 = 75 USDC whatever the float (tested at 5k, 50k and 500k GHS).
- Cost to honest users: a soft-income-only wallet earning more than 250 USD a month on peer/cash is capped at about a 75 USDC limit until it has verified income.
- Real MoMo statement (aggregates only, `NOTCH_LLM=off`): counted income **7,440 -> 6,842 GHS**, limit **47.25 -> 43.44 USDC** (-8%). All of the drop is cash net-out: unmatched cash-out/transfer outflow in the window went 310 -> 1,048 GHS. Real spend 4,682 GHS, spend-backing 1 (untouched), cap factor 1 (untouched), 4 regular peers. Not collapsed.

**#3 withdraw (`lib.rs`).** `cancel_withdraw` now returns shares worth **at most the request-time value** and burns the rest (the gain made while in escrow stays in the NAV for the lenders who stay). If the price fell (a loss was marked) every share comes back and the lender carries the loss; if the lender is the only holder of the tranche everything comes back (nobody to give it to). The share mint is now **writable** in `cancel_withdraw` (`app/src/notch.ts` and its reference test updated; nothing visual changed). Proven: escrowed value after cancel <= 100.000000 USDC where the old build returned 101.
`mark_default` was already callable from `due + 1 second` (`now > due`); there is no grace period. A test now pins it (fails `NotPastDue` at `due`, works at `due + 1`).
**Honest residual (written in `lib.rs`, TRANCHES-REPORT.md, audit FIXES.md):** a lender whose request is matured and armed when a loan goes overdue can still send `claim_withdraw` before anyone sends `mark_default` and leave at the pre-loss price. Arming is no longer free (an armed request earns nothing, whether it ends in claim or cancel), but it is cheap: due dates are public, so a lender willing to hold no yield, or two staggered wallets, can time it. It is mitigated, not closed: the keeper now marks every minute (see #7), so the gap is about a minute, not an hour. Closing it on chain needs a pool-level "oldest unpaid due date" kept by every draw and repay (not built).

**#4 partial claim.** If idle cash covers only part of the request, `claim_withdraw` pays that part at the same locked price, burns that part of the shares and leaves the rest in escrow inside the same claim window (the request account stays open). After the window, cancel and re-file the remainder. The frozen UI still shows "Ready / Claim" with no window or locked-price hint (UI is frozen; fold into the UI phase).

**#5 legacy requests.** New `cancel_legacy_withdraw`: gives the shares of a pre-price-lock request (58 bytes) back in full and closes the escrow and request. Tested on a request cut down to the old layout. On devnet **two such requests still exist** (about 5 USDC of test shares each); they belong to two throwaway test wallets, and the instruction needs the owner's signature, so they stay stuck. Devnet test data only.

**#6 overdue.** `check_credit` fails `LoanOverdue` when `drawn > 0 && now > due` (so the hostel CPI fails too). SDK `getCredit` returns `overdue` and `active` is false while overdue.

**#7 keeper.** Overdue lines are sorted most overdue first (oldest due, then biggest loan) in both the Edge Function and the CLI keeper; per-run cap 10 -> 40; the run stops at a 45 s budget; the cron runs **every minute** (`20261125000001_keeper_every_minute.sql`, applied to the live project: `notch-keeper-every-minute`, the hourly job removed). Edge Function redeployed.

## Real devnet state
- Program upgraded 2026-11-25 (SHA-256 of the deployed bytes equals the local build `d5953286...`; the first upgrade of the day was replaced after the devnet e2e found a rounding bug in cancel). It needed 14,400 more bytes first. No buffers left.
- Keeper Edge Function redeployed and the cron changed to every minute.
- The deployed CVM (Phala) was NOT redeployed: it still serves unlimited demo samples until it is.

## Gates
See `proof/gates-2026-11-25-final.txt`.

## Left
- Redeploy the CVM so the sample limiter is live (needs the Phala deploy, not done here).
- Close the claim-before-mark window on chain (needs a pool-level oldest-due value).
- UI: show the claim window, the locked price and the partial claim (UI frozen).
- Two stuck legacy requests on devnet.
- Tuning to decide: the 250 USD/month soft cap and the 7 day / 14 day windows are judgement calls; every honest soft-income wallet above that is capped at ~75 USDC.

# Audit 2026-11-24: what was fixed, and the proof

One line per item in `REVIEW.md`. "Proof" files are in `proof/`: the BEFORE file is the permanent repo test run against the code before the fix (fails), the AFTER file is the same test after the fix (passes). The scratch repro files in this folder (`prog.test.js`, `income.test.js`, `redirect.test.js`, `size.test.js`) are kept as the original reproductions; every one of them now has a permanent twin inside the repo test suites listed below.

## Must-fix (5)

| # | Item | State | Commit | Permanent test (fails before, passes after) | Proof |
|---|------|-------|--------|---------------------------------------------|-------|
| 1 | Keeper never saw a current (154-byte) line | fixed | 538187c | `enclave/test/keeper-real-layout.test.js` (3 tests, built from a line the real program produced) | `proof/keeper-before-fix.txt` 0/3, `proof/keeper-after-fix.txt` 3/3. **Live:** deployed keeper marked a real overdue devnet line, see `proof/devnet-keeper-live.txt` |
| 2 | Dust repayments max the reputation cap | fixed | 6e1105b | `tests/audit.test.js` F1 (5 tests): size floor `min(limit, max(5 USDC, limit/4))`, held >= 30 s, once per posted record (`counted_nonce`) | `proof/program-before-fix.txt` (2 pass / 13 fail), `proof/program-after-fix.txt` 15/15 |
| 3 | `/underwrite` took anyone's statement for any wallet | fixed | f3e93b5 (server) + this commit (frozen UI signs) | `enclave/test/audit-underwrite.test.js` (6): statements only through the inbox, direct path needs the wallet's Ed25519 signature over wallet + email hash + time | `proof/audit-underwrite.BEFORE.txt` 3 fail, `.AFTER.txt` 6/6. UI side: browser e2e `app/e2e/notch.spec.ts` (the test wallet now has `signMessage`; the app signs every direct /underwrite) |
| 4 | "Ready" withdraw request makes the cooldown pointless | fixed | 6e1105b | `tests/audit.test.js` F2 (5): claim window `[unlock, unlock + 2 days]`, escrowed shares earn nothing and carry losses (`min(price at request, price at claim)`) | same program proof files. **Known residual (documented in `lib.rs`, tested):** a claim between "overdue" and `mark_default` still pays the pre-loss price; the window is the keeper's latency (hourly) |
| 5 | Overdue borrower can keep drawing | fixed | 6e1105b (program) + dfb0c13 (underwriter) | `tests/audit.test.js` F3; `enclave/test/audit-small.test.js` "#5 (enclave side)": no new limit while overdue; `chain-history` returns `overdue` | program proof files; `proof/audit-small.BEFORE.txt` / `.AFTER.txt` |

## Income gaming

| # | Item | State | Commit | Permanent test | Proof |
|---|------|-------|--------|----------------|-------|
| 6 | Cash cycled out by P2P after 8+ days counts as income | fixed | f3e93b5 | `enclave/test/audit-income.test.js` (#6, 4 tests): cash counts only up to 2x real spending (spend-backing), any unmatched `leaves()` debit subtracts | `proof/income-before-fix.txt` 0/11, `proof/income-after-fix.txt` 11/11 |
| 7 | Peer income faked with two helper SIMs | fixed | f3e93b5 | same file (#7, 6 tests): payer returns inside 14 days, money sent to the payer shortly before, and net flow per counterparty; honest peers and a spending trader untouched (controls) | same |

## Smaller (6)

| # | Item | State | Commit | Permanent test | Proof |
|---|------|-------|--------|----------------|-------|
| 8 | Email-body sources at full weight | fixed | dfb0c13 | `enclave/test/audit-small.test.js` #8 (2): "X sent you ..." counts at the `peer_transfer` weight; free text cannot promote it | `proof/audit-small.BEFORE.txt` (6 fail), `.AFTER.txt` 8/8 |
| 9 | Dedupe state only in memory (Earn payout) | fixed | dfb0c13 | same file #9 (2): the dedupe comes from the on-chain payout tx, so a restart changes nothing | same |
| 10 | One wallet can stack many phone numbers | fixed | 6e1105b (program pins the identity in the line: `WalletIdentityPinned`) + dfb0c13 (enclave reads the pinned `id_hash`) | `tests/audit.test.js` F10; `audit-small.test.js` #10 (2) | program + small proof files |
| 11 | First-depositor inflation on an empty tranche | fixed | 6e1105b | `tests/audit.test.js` F11: first deposit into an empty tranche >= 1 USDC, a claim cannot leave a dust supply | program proof files |
| 12 | Exact limit is public on chain | **not fixed, accepted and written down** | this commit (`README.md`, "Bureau" and "Mainnet bar") | n/a | Why: lenders must see what they are exposed to and the program checks the signed record. Before mainnet: post a bucket or a hash commitment. |
| - | Earlier fixes be7b93d / c478bdc | verified in the review | - | existing | - |

## Things that changed because of the fixes (so nothing silently broke)

- Frozen UI (`app/src/enclave.ts`, `wallet.tsx`, `Borrow.tsx`, `Attacks.tsx`): wallet `signMessage`, direct `/underwrite` now sent with `x-notch-ts` and `x-notch-sig`. No visual change. A wallet without `signMessage` gets a plain message ("Try Phantom, Backpack or Solflare").
- `app/scripts/demo-enclave.mjs` (local demo server only, fixtures): treats its MoMo sample as delivered to the fixtures' inbox, because the frozen "MTN MoMo payment" button posts straight to `/underwrite`, which a real enclave now refuses for statements. The production servers are unchanged and strict.
- `app/scripts/e2e-devnet.mjs`: step 4 waits 32 s before repaying (a repayment counts only if held >= 30 s); the in-process underwriter is an `InboxedUnderwriter` and its HTTP server skips the wallet signature (kit signers cannot be read); new **step 14** proves the signed path on a strict server and the deployed keeper.

## Devnet program

Upgraded on 2026-11-25 to the 6e1105b code (SHA-256 of the deployed program equals the build, `37e72d7d...`). It needed 4,792 more bytes, so the program account was extended by 10,240 bytes first (minimum extension). No stray buffers were left (`solana program show --buffers` is empty).

- **Migrates (kept):** config, pool v2, vault, senior and junior mints and all share balances, dedupe and identity accounts. Old 98 and 106-byte credit lines still decode: draw and repay still work on them, a legacy repayment can never count as on-time, and the next `post_limit` grows the line to 154 bytes (the borrower pays the extra rent).
- **Abandoned:** open `WithdrawRequest` accounts made by the old program (they have no `nav_at_request` / `supply_at_request`; devnet test data only, no real funds). `posted_at` moved into the new trailing block of the line. Nothing on devnet holds real value.

## Live keeper

See `proof/devnet-keeper-live.txt` (permanent e2e step 14 of `app/scripts/e2e-devnet.mjs`: a fresh devnet borrower, `draw_with_term` 10 s, never repaid, the DEPLOYED Supabase Edge Function called with `{"send": true}`, line read back as defaulted on chain).

The live run also found a SECOND keeper bug the unit tests could not see: the deployed function died with `Buffer is not defined` on its first real send (Deno has no global `Buffer`). Fixed in `supabase/functions/keeper/index.ts`, redeployed, proven by the step above. Until then the hourly cron could not have marked anything.

## Gates (2026-11-25): see `proof/gates-2026-11-25.txt`
`pnpm e2e:all` green (89 + 234 + 6 + 44, devnet 206/206, browser 6/6) and `e2e-supabase.mjs --require` 21/21 (one earlier Realtime timing flake, rerun green). Real statement, aggregates only: 47.47 -> 47.25 USDC.

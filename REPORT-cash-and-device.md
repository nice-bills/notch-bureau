# Report: cash deposits as income + one phone = one borrower

Commits (local, not pushed): `009055d` (job 1), `9cbeca2` (job 2).

## Job 1: cash deposits as trading income
Rules (enclave/src/income.js, tests in enclave/test/cash.test.js, 21 tests):
- Cash deposit counts at 50%, only if it shows up in 2 of the 3 thirty-day months.
- Cash that leaves again within 7 days (cash-out, person-to-person, other-network, own bank; also a cash-out just before a deposit) does not count. Each debit is used once, proportional, no minimum size.
- Cash-outs no deposit used up are subtracted (net cash). Each month capped at 2x the lower median month.
- Moves into a savings product do not count as "leaving" (default `cashOwnMoney: 'bank'`; `'all'` is the strict what-if).
- Free text can only lower; the AI reader can never file a credit as cash.

Real statement (aggregates only, run with NOTCH_LLM=off, nothing copied):
- Cash in: 23,467 GHS; cycled 9,811; countable 13,346; counted after 50% + caps 5,628.
- Counted income 1,847 -> 7,475 GHS. Limit 11.62 -> 47.47 USDC.
- Strict what-if (own-savings moves also cycle): stays 11.62.

Attacks covered (all refused or zeroed): same cash in and out every month; one big month; ten deposits of 99 (under 100); 90% cliff; withdrawal on day 8; cash-out first; P2P inside/outside 7 days; own bank vs savings product; memo tricks; one debit reused; untrusted rows; AI trying to file cash; PDF trader fixture (counts 1,350 GHS, about 8.77 USDC); PDF loop refused.

## Job 2: Seeker Genesis Token
- Optional device proof on /underwrite: SIWS (server-issued single-use challenge, chain pinned to mainnet, key = the wallet being underwritten) + SGT held on mainnet.
- Record NOTCHv3 (160 bytes): v2 + `device_hash = sha256("notch-sgt"|mint)`. Mint never appears in the record. v2 and non-Seekers unchanged.
- Program: `["device", device_hash]` PDA made in `post_limit`; second wallet gets `DeviceBound`; missing account gets `DeviceRequired`.
- Seeker limit multiplier x1.5 (share and first-timer cap, never past the hard cap).
- RPC failure gives 503, never "not a Seeker".

REAL: SIWS signatures, HTTP server, signed records, devnet program (upgraded), mainnet read of public holder `D2ehKL...` (`node enclave/scripts/sgt-real-read.mjs`).
STUBBED: the SGT reader in the full-flow tests (test wallets -> fake mints; nobody here owns a Seeker).

## Test gate: `cd app && pnpm e2e:all` -> EXIT 0
- LiteSVM: tests 74, pass 74, fail 0
- enclave: tests 171, pass 171, fail 0
- sdk: tests 6, pass 6, fail 0
- vitest: Test Files 2 passed, Tests 44 passed
- devnet (steps 1-12): ALL GREEN (176/176 passed), includes step 12 (29 checks: cash attacks + device flow)
- browser (Playwright): 6 passed

## Not done / caveats
- Statement inbox path has no device proof yet.
- `enclave/src/chain-posted.js` (other agent) assumes 128-byte v2 records; a v3 record there is read as v2 prefix.
- `post_limit` now takes 9 accounts (ABI change). `app/src/notch.ts` and `tests/lib.js` pass the placeholder; other clients must too.
- The first-timer cap (50 USDC, 75 for Seekers) still binds the limit for new borrowers.
- Left uncommitted on purpose: `app/e2e-devnet.log`, `app/e2e-browser.log`, screenshots, `SPONSORS.md`, `supabase/` (other agent's).
- CORE.md rows 11 and 12 added (file is outside the repo).

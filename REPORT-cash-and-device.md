# Report: cash deposits as income + one Seeker phone = one credit line

The phone rule is optional and binds Seeker-bound lines only; the MoMo-number rule (one number = one wallet) applies to everyone.

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
- (fixed in the review follow-up below: the inbox now carries the device proof; `/posted` reads v2 and v3.)
- `post_limit` now takes 9 accounts (ABI change). `app/src/notch.ts` and `tests/lib.js` pass the placeholder; other clients must too.
- The first-timer cap (50 USDC, 75 for Seekers) still binds the limit for new borrowers.
- Left uncommitted on purpose: `app/e2e-devnet.log`, `app/e2e-browser.log`, screenshots, `SPONSORS.md`, `supabase/` (other agent's).
- CORE.md rows 11 and 12 added (file is outside the repo).

## Review follow-up (Nov 24): three fixes + one
1. **`/posted` and v3 records.** `chain-posted.js` now reads the Ed25519 instruction by its own offsets (one signature, message in the same instruction) and accepts exactly `NOTCHv2` (128 B) or `NOTCHv3` (160 B), hashing the whole signed record: the same digest `recordSha256` stored. Tests: `test/chain-posted.test.js` (synthetic layouts + 4 captured REAL devnet transactions, v2 and v3, `test/fixtures/devnet-posted/`), devnet e2e steps 12 and 13 verify live transactions and link them.
2. **Brute-forceable MoMo hash.** A secret pepper is required: `server.js`, `cvm-server.js`, `demo-enclave.mjs` exit 1 without `NOTCH_ID_PEPPER` (>= 32 chars), except under `NOTCH_INSECURE_NO_PEPPER=1` (loud warning). In the Phala CVM the pepper is derived inside the TEE (dstack `getKey`, path `notch/id-pepper/v1`); `build-compose.mjs` refuses to carry it; compose regenerated, **not deployed**. Changing the pepper changes every `id_hash`, so devnet lines made before this are no longer matched (test data, fine). Not verified on a real CVM (stub dstack client in tests).
3. **Device proof in the inbox.** `/inbox/new` takes the optional SIWS proof (body `device` or `x-notch-device`), verifies it at issue time, binds it to the address, and `receive` uses it (v3 record, x1.5, `DeviceLink`). Non-Seekers unchanged. Token-lookup outage = 503 retry, not a failure. Docs fixed: the phone rule is for Seeker-bound lines; the MoMo rule is for all.
4. **Phone UI and Realtime.** `supabase-watch.mjs` (`watchJobs`) reads the current row right after `SUBSCRIBED`; documented in `supabase/README.md` "The phone". The live check (`e2e-supabase.mjs`) now tests what the phone shows; it had failed once on the cold-channel miss.

# Notch

**Private, portable income proofs for on-chain credit.** A student proves income from a signed payment email; Notch releases only a wallet-bound credit limit, never the email or employer details. A demo lending app shows how another Solana app can use that limit.

## Status

This is a local prototype. The underwriter currently runs as a normal Node.js process, and its key is stored on disk. It is **not** a trusted enclave, production credit bureau, audited lending protocol, or live testnet deployment. The devnet entry in `Anchor.toml` is configuration only; it does not mean the program has been deployed there.

## What works locally

- DKIM verification for trusted sender domains and income extraction from sample emails.
- Wallet-bound, signed credit records with email deduplication and per-wallet replay protection.
- An Anchor program for limit posting, a lender pool with share mint (deposit, then a two-step withdraw: request, 3 day cooldown, claim at the request-day price, or the claim-day price if a loss made it lower), borrower first-loss deposits, draws, repayments with a 2% fee, and default marking.
- LiteSVM transaction tests, including forged-signature, changed-record, replay, duplicate-email, wrong-wallet, over-limit, and default cases.
- Exact DKIM signer-domain allowlisting; subdomains need their own explicit entry.

Repayment totals are recorded on-chain, but are **not yet read by the underwriter**. A repayment does not currently raise a later credit limit.

## Run locally

```sh
pnpm install
pnpm test
pnpm test:enclave
```

On-chain tests load the compiled `target/deploy/notch.so`; rebuild it after changing Rust code with the Solana/Anchor toolchain before interpreting test results.

Run the local underwriter with:

```sh
cd enclave
pnpm install
pnpm start
```

`GET /attestation` explicitly reports `local-dev`. Do not submit real financial emails to this prototype.

### AI extraction (optional)

Income extraction is rule-based by default. To use a model, point the underwriter at an
OpenAI-compatible chat-completions endpoint:

```sh
NOTCH_LLM_URL=https://your-endpoint/v1/chat/completions \
NOTCH_LLM_MODEL=your-model \
NOTCH_LLM_KEY=optional-bearer-token \
NOTCH_LLM_TIMEOUT_MS=10000 \
pnpm start
```

The endpoint sees the decoded email body, so in production it **must** be a confidential
(attested) model endpoint, such as Tinfoil's attested inference or a model running inside the
same TDX enclave. Pointing this at a normal hosted LLM breaks the privacy claim. Model output
is schema-checked and every amount must appear in the email next to a credit keyword;
otherwise the service falls back to the rule-based extractor.

## Bureau: any app can check a wallet

`check_credit(min_available, max_age_s)` on the Notch program is read-only. It succeeds only if the wallet has a line, is not defaulted, its signed record has not expired, was posted within `max_age_s`, and has at least `min_available` left. Otherwise it fails with `NoCreditLine`, `Defaulted`, `RecordExpired`, `InsufficientCredit` or `StaleRecord`. On success it returns and logs `{ wallet, available_bucket, on_time_repayments, defaulted: false }` where the bucket is coarse (0: under 25, 1: 25 to 100, 2: 100 to 500, 3: 500+ USDC), never the exact limit.

**Privacy of the exact limit (accepted, audit #12).** `check_credit` returns only a coarse bucket, but the credit line account (`CreditLine.limit`) and the `LimitPosted` event are public on chain and hold the exact limit. The limit is about 0.3 x monthly counted income, so anyone who knows a wallet can read an income band from chain. We accept this for the devnet demo: a lender must be able to see the limit it is exposed to, and the signed record is what the program checks. Before mainnet, either post only the bucket plus a hash commitment to the limit (the borrower reveals it when drawing), or keep the line in a confidential account. Tracked in "Mainnet bar" below.

- `programs/hostel-deposit`: a minimal consumer that CPIs `check_credit` before it records a booking.
- `sdk/` (`@notch/bureau`): `getCredit(rpc, wallet)` and `buildCheckCreditIx(...)`, with a 10-line integration example in its README.
- Tests: `tests/bureau.test.js` (LiteSVM), `sdk/test`, and step 10 of `app/scripts/e2e-devnet.mjs`.
- Lines created before this change are 8 bytes shorter (no `posted_at`). They keep working for draw, repay and default; `check_credit` reads them as "posted long ago", so only an unlimited `max_age_s` passes for them.

## Project notes

- [Research and differentiation](RESEARCH.md)
- [Original build plan](../PLAN.md)

## Mainnet bar

Passing local or devnet tests does not establish mainnet safety. Before any real funds: implement and remotely verify confidential-compute attestation; replace static currency conversion; bind repayment history to verified on-chain state; hide the exact limit on chain (bucket or commitment, audit #12); add a real borrower experience and repayment terms; deploy against the intended stablecoin; obtain independent Solana security review; and handle lending, privacy, and consumer-credit requirements for the launch jurisdiction.

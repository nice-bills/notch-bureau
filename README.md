# Notch

**Private, portable income proofs for on-chain credit.** A student proves income from a signed payment email; Notch releases only a wallet-bound credit limit, never the email or employer details. A demo lending app shows how another Solana app can use that limit.

## Status

This is a local prototype. The underwriter currently runs as a normal Node.js process, and its key is stored on disk. It is **not** a trusted enclave, production credit bureau, audited lending protocol, or live testnet deployment. The devnet entry in `Anchor.toml` is configuration only; it does not mean the program has been deployed there.

## What works locally

- DKIM verification for trusted sender domains and income extraction from sample emails.
- Wallet-bound, signed credit records with email deduplication and per-wallet replay protection.
- An Anchor program for limit posting, a lender pool with share mint (deposit, then a two-step withdraw: request, 3 day cooldown, claim at the price of that moment), borrower first-loss deposits, draws, repayments with a 2% fee, and default marking.
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

## Project notes

- [Research and differentiation](RESEARCH.md)
- [Original build plan](../PLAN.md)

## Mainnet bar

Passing local or devnet tests does not establish mainnet safety. Before any real funds: implement and remotely verify confidential-compute attestation; replace static currency conversion; bind repayment history to verified on-chain state; add a real borrower experience and repayment terms; deploy against the intended stablecoin; obtain independent Solana security review; and handle lending, privacy, and consumer-credit requirements for the launch jurisdiction.

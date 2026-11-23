# Notch core research (CORE items 3, 4, 5)

Checked 23 Nov 2026. `dig` is not installed here, so DNS was read over Cloudflare DNS-over-HTTPS (same data). Labels: **[V]** verified from a primary source or DNS today; **[S]** single sample or secondary source; **[U]** unverified, my inference.

## Top 3 design changes

1. **MoMo (and M-Pesa) proof is a statement PDF the user requests to their own email, not a transaction email.** The signing domain is `mtn.com`, not `mtn.com.gh`. Remove `mtn.com.gh` from the trusted list and fix the synthetic fixture (`enclave/test/fixtures/emails.js:43` uses `noreply@mtn.com.gh`). The email body has no amounts, so the enclave must parse the PDF attachment (DKIM covers attachment bytes). The statement goes to any email the user types, so we must also bind the mailbox to the wallet.
2. **Drop "known Superteam payer wallet".** Earn has no single payer. External sponsors pay from their own wallets straight to the winner's profile wallet; Superteam-sponsored bounties go through a KYC form and a manual payment. Replace the rule with: an Earn email (DKIM `superteam.fun`) that names a tx signature, plus an on-chain check that this tx paid the borrower's wallet that amount of USDC.
3. **Don't make Solana Confidential Compute the critical path for Nov 27–29.** It is a devnet beta, unaudited, and I could not find a public repo, program ID or package names. Keep `set_underwriter` but make it measurable: run the underwriter in a real confidential VM (Phala CVM is the quickest signup, GCP C3 TDX is the safe fallback), publish the quote and measurement, verify it off-chain in the demo, and add a thin "attestation record" account check in the program that can be switched to the Solana verifier when its ID/SDK is public. Run the LLM inside the same VM, or use Tinfoil, so email text never leaves a TEE.

---

## A. Income sources

### Key facts
- Everything is **ranked by usefulness to Notch**. "Email?" means a notification or statement reaches the user's mailbox from the provider.
- DMARC values are **[V]** from DNS. The DKIM `d=` is inferred from published selectors, aligned with the From domain, so confirm it on a real message before trusting it **[U]** unless noted.
- Current trusted list `['deel.com','mtn.com.gh','mtn.com','wise.com','payoneer.com','superteam.fun']`: five entries are plausible, **`mtn.com.gh` is wrong** (no MX, no DMARC, only a stray DKIM-looking TXT at the apex **[V]**).

| # | Source | Email? | DKIM `d=` (From domain) | Body has amount+currency+date? | Usable | Notes / better alternative |
|---|---|---|---|---|---|---|
| 1 | **Wise** | Yes: Wise states it emails when money is received and when it is paid out [Wise help](https://wise.com/help/articles/2553293/how-do-you-notify-me-about-a-transfer) | `wise.com`. DMARC `p=reject` **[V]**; selectors `google`, `s1`, `s2` (SendGrid CNAMEs), `mandrill`, `k1` exist **[V]** | Recipient sees sender, amount, date, reference, transaction number per [Wise](https://wise.com/us/blog/recipient-see-account-details-wise); exact email layout **[U]** | **Yes** | Best-signed source. Borrower must be the recipient. |
| 2 | **Payoneer** | Payment-received emails **[U]** | `payoneer.com`. DMARC `p=reject` **[V]**; `selector1/2` (Microsoft 365) and `mandrill` exist **[V]** | **[U]** | **Yes** (confirm one sample) | Common for freelancers. |
| 3 | **Deel** | Payment emails **[U]** | `deel.com`. DMARC `p=reject` **[V]**; `s1`, `s2` (SendGrid), `google`, `mail` exist **[V]** | **[U]** | **Yes** (confirm one sample) | Deel also issues payslips/invoices as PDFs **[U]**. |
| 4 | **MTN MoMo Ghana** | **Statement only, on request**, with PDF attachment. Sample (Scribd, 27 May 2025): from `ServiceMMStatement.GH@mtn.com`, subject "MTN MoMo Statement", body is a boilerplate and a 34 KB `MomoStatementReport.pdf` ([Scribd sample](https://www.scribd.com/document/895457761/Gmail-Momo-Transaction-History)) **[S]** | `mtn.com`. DMARC `p=reject` **[V]**; `selector1/2` (Microsoft 365) and `s1/s2` (SendGrid) exist **[V]**. SPF redirects to an Oracle email-delivery include, so the actual signer may be Oracle with `d=mtn.com` **[U]** | **No.** Amounts are only inside the PDF | **Partial** | Per-transaction notices are SMS ([MTN T&Cs §7.5](https://momo.mtn.com/terms-conditions/)). Request path: MyMTN app → MoMo → Statement ([MTN help](https://mtn4186.zendesk.com/hc/en-us/articles/4772853863570-How-do-I-request-for-a-Mobile-Money-statement)), or `*170#` → My Wallet → Statement ([SplitPay guide](https://splitpaygh.com/how-to-request-statement)). A Ghana BNPL firm already takes these PDFs by email as its credit input, so the pattern is real. |
| 5 | **M-Pesa (Kenya)** | Yes, **on request**: `*334#` → statement → type any email; free; arrives in about 5 minutes ([Safaricom](https://www.safaricom.co.ke/main-mpesa/m-pesa-for-you/manage-your-account/m-pesa-statement)) | Safaricom DMARC `p=reject` **[V]**; sending domain/selector not checked **[U]** | PDF, password-protected (password arrives by SMS, per [Safaricom on X](https://x.com/SafaricomPLC/status/1955908859773530515)) | **Partial** | Enclave needs the PDF password from the user. DKIM still covers the encrypted attachment bytes. |
| 6 | **Superteam Earn** | Yes: Earn queues `addPayment`, `announceWinners`, `STWinners`, `grantPaymentReceived` emails ([queueEmail.ts](https://github.com/SuperteamDAO/earn/blob/main/src/features/emails/utils/queueEmail.ts)); sent through Resend ([resend.ts](https://github.com/SuperteamDAO/earn/blob/main/src/features/emails/utils/resend.ts)) | `superteam.fun` likely (`resend._domainkey` exists, `s1/s2` SendGrid exist, `google` exists) **[V]**. DMARC is only `p=none` **[V]**, so unsigned spoofs aren't rejected by receivers (irrelevant for us if we require a valid DKIM signature) | Body text **[U]** (templates live in a separate email-worker repo I could not read) | **Partial** | See Part B. Pair with the on-chain tx. |
| 7 | **Upwork** | Payment emails **[U]** | `upwork.com`. DMARC `p=reject` **[V]**; selectors not probed | **[U]** | Likely yes | |
| 8 | **Remote.com** | Payslip emails **[U]** | `remote.com`. DMARC `p=reject` **[V]** | **[U]** | Likely yes | |
| 9 | **Moniepoint** (NG) | Statement is downloaded in-app as PDF/Excel ([support](https://support.moniepoint.com/topics/account-information-and-updates-234/how-do-i-download-my-statement-of-account-430)); emailed notices **[U]** | `moniepoint.com`. DMARC `p=reject` **[V]** | **[U]** | Partial | Statement saved in app is not provider-signed email. |
| 10 | **Absa Ghana** | e-statements **[U]** | `absa.com.gh`. DMARC `p=reject` **[V]** | **[U]** | Partial | |
| 11 | **Ecobank, Fidelity, CalBank** | e-statements **[U]** | `ecobank.com` / `myfidelitybank.net` / `calbank.net`: DMARC `p=quarantine` **[V]** | **[U]** | Partial | |
| 12 | **Stanbic Ghana** | e-statements **[U]** | `stanbicbank.com.gh`: DMARC `p=none` **[V]** | **[U]** | Partial (weak policy) | |
| 13 | **GCB** | **[U]** | `gcbbank.com.gh` has **no DMARC record** **[V]** | **[U]** | No (unproven) | |
| 14 | **Telecel / Vodafone Cash** | Statement via `*110#` → Account → Statement ([SplitPay guide](https://splitpaygh.com/how-to-request-statement)); email delivery **not confirmed** | `telecel.com.gh`: DMARC `p=quarantine` **[V]** | **[U]** | **No (unproven)** | Use zkTLS/TLSNotary on the provider web portal, or a manual PDF path with human review. |
| 15 | **AirtelTigo Money (AT)** | Statement via `*500#` ([SplitPay guide](https://splitpaygh.com/how-to-request-statement)); email **not confirmed** | `at.com.gh`: **no DMARC** **[V]** | **[U]** | **No (unproven)** | Same as Telecel. |
| 16 | **Opay / Palmpay** (NG) | **[U]** | `opay-nigeria.com` and `palmpay.com`: DMARC `p=none` **[V]** | **[U]** | No (unproven) | |
| 17 | **Grey** | **[U]** | `grey.co`: DMARC `p=none` **[V]** | **[U]** | No (unproven) | |
| 18 | **Chipper Cash** | **[U]** | `chipper.com`: **no DMARC** **[V]** | **[U]** | No (unproven) | |

### Not found or not possible
- No evidence that MTN, Telecel or AT send a per-transaction email. Plan on SMS only for live notices and email only for statements.
- **MTN MoMo open API** (`momo.mtn.com/api`) covers merchant collections, disbursements and balance, not a personal statement feed **[S]**.
- **zkTLS (Reclaim, TLSNotary)**: Reclaim is live and YC-backed ([Reclaim](https://reclaimprotocol.org/), [paper](https://eprint.iacr.org/2026/2187)). I could **not** confirm a provider for MoMo, Telecel, AT, M-Pesa or Opay. Treat it as a build-your-own-provider option, not a ready fallback.

### Cross-cutting risks (all email sources)
- DKIM proves "provider's server signed these bytes", not "this mailbox belongs to this wallet". The statement can be mailed to any address, so the enclave needs a mailbox proof (email OTP) and should hash the `To:` address into the dedupe key.
- The `d=` must equal the From domain (alignment), otherwise any sender can sign with a domain they own. Verify alignment explicitly.
- Fetch DKIM keys over DNS-over-HTTPS inside the enclave, from two resolvers. A tampered DNS answer is otherwise the easy attack on a "sealed" verifier.
- Providers rotate selectors. Old emails can stop verifying; keep a freshness window.

---

## B. Superteam Earn payouts

| Question | Finding |
|---|---|
| How are winners paid? | **External sponsors:** "paid out to the wallet associated with the winner's Superteam Earn account" ([Earn FAQ](https://docs.superteam.fun/the-superteam-handbook/community/faqs/superteam-earn-faq)). **Superteam/Solana-sponsored:** a lead sends a payment form, KYC is required, payment within 7 days (same FAQ). Teams are paid to the submitter's wallet. |
| Fixed payer wallet? | **No.** The sponsor records a `txId`; Earn only checks that the tx paid the winner's wallet the listed token and about the listed amount (0.5% tolerance), and that the tx id wasn't reused ([paymentRPCValidation.ts](https://github.com/SuperteamDAO/earn/blob/main/src/features/sponsor-dashboard/utils/paymentRPCValidation.ts), [add-payment.ts](https://github.com/SuperteamDAO/earn/blob/main/src/pages/api/sponsor-dashboard/submission/add-payment.ts)). Payer is whoever the sponsor is. |
| Token | Listings pay in the listing token (USDC common, SOL also supported); native SOL and SPL transfers are both accepted by the validator. |
| Public API for winners/payouts? | Public: `GET /api/listings/live`, `/api/listings/[id]/winners` (id, position, username/name/photo only) and `/api/homepage/recent-earners` (title, reward, token, date, user). **No wallet address, no tx id.** Payment details (`Submission.paymentDetails`, `isPaid`) are only exposed through the authenticated sponsor dashboard ([schema](https://github.com/SuperteamDAO/earn/blob/main/prisma/schema.prisma), [winners.ts](https://github.com/SuperteamDAO/earn/blob/main/src/pages/api/listings/%5BlistingId%5D/winners.ts)). Public `GET https://superteam.fun/api/listings/live` works (tested). |
| Prove "wallet X received a Superteam payout" from chain alone? | **No.** Nothing on chain marks a transfer as an Earn payout. Any wallet can send USDC. Anyone can also create a sponsor and a listing and pay themselves, so a "Superteam" label can't come from chain data. |
| What does work? | (a) DKIM-signed Earn email to the winner (`addPayment` / winners emails) naming the listing, plus (b) the tx the email references (or any tx to the borrower's wallet) checked on chain for recipient, mint and amount, plus (c) optional sponsor allowlist (e.g. Superteam, Solana Foundation, well-known sponsors) read from the public listing API (`sponsor.slug`). Email body wording **[U]**: I could not see the templates. |
| Side note | There is an agent API (`/api/agents/...`) that lets bots submit; payout to a human via claim code. It doesn't expose payouts. |

---

## C. Real sealed computer

### Solana Confidential Compute (SCC)

| Item | Finding |
|---|---|
| Status | Announced **13 Nov 2026** by the Solana Foundation with Nito. Open-source SDK + on-chain verifier. **Devnet beta, unaudited, "for development use only"; mainnet after the audit, no date** ([launch post](https://solana.ai/blog/nito-solana-confidential-compute), [Solana Compass](https://solanacompass.com/news/solana-foundation-and-nito-launch-solana-confidential-compute-on-devnet-to-verify-private-ai-onchain)). |
| What it checks | Chip signature is genuine; code measurement is on an **approved list set by the developer**; attestation is fresh (bound to a recent Solana slot). Writes a record with signing key, hardware type, expiry. Reading the record costs ≤ **1,500 compute units** ([product page text](https://solana.ai/confidential-compute), [analysis](https://aisecureplatform.com/blog/solana-confidential-compute-tee-attestation-onchain-tdx-sev-snp)). |
| Flow | (1) Machine inside a confidential VM generates a key that never leaves; (2) hardware report binds key + recent slot; (3) on-chain program verifies, records key/hardware/expiry; (4) machine signs outputs with the key; consumers check the signature and look up the key record. |
| Hardware | Launch post: Intel TDX and AMD SEV-SNP, NVIDIA GPU in development. Product page FAQ lists: **AMD SEV-SNP on Google Cloud Confidential VMs, AWS Nitro Enclaves, Google Confidential Space.** TDX isn't in that list, so the two sources disagree on TDX **[S]**. |
| Kit | Verifier program on devnet, Rust + TypeScript SDKs with on-chain helpers to check the record, an enclave daemon, a CLI, and a Docker image (product page). |
| **Program ID / package names / repo** | **Not found.** No public repo under `solana-foundation` or search results; the product page does not print them; I could not read the SDK. **Do not assume names.** Ask the Solana Foundation Discord / the Nito team, or look for the repo link from the template at [solana.com/developers/templates/confidential-chat](https://solana.com/developers/templates/confidential-chat). |
| Does Confidential Chat use it? | **No**, today. The browser verifies Tinfoil's attestation itself (product FAQ). So there is no public reference app that reads the SCC record from another program. |
| Known weakness | TEE.fail (Oct 2025): physical attackers can extract Intel/AMD attestation keys with a cheap bus interposer. Out of scope for a hackathon demo; say so in the README. |
| Related but different | [Solana Attestation Service](https://github.com/solana-foundation/solana-attestation-service) (issuer-signed credentials with expiry, Rust `solana-attestation`, TS `@solana/attestation`) is **not hardware attestation**, but it is a public, working pattern for "program reads an attestation account, checks owner/schema/expiry". |
| Other on-chain TEE attempts | Solrouter stores TDX receipts on Solana, but its program does **not** verify the signature or quote on chain ([docs](https://docs.solrouter.com/docs/how-it-works/proof)). Not a verifier. |

### Minimal integration path for the Anchor program (design, not verified against SCC code)
Today `config.underwriter` is a pubkey set by an admin (`set_underwriter`). Replace with:
1. `config` keeps `attestation_program: Pubkey` and `allowed_measurement` (or a pointer to the SCC allowlist account).
2. `record_limit` takes the SCC **record account** for the signing key as an extra account. The program checks: owner == SCC program, derived from the underwriter pubkey, not expired, hardware type allowed, measurement == `allowed_measurement`. Then it verifies the existing ed25519 signature over the 96-byte record against that key.
3. Keep `set_underwriter` as a **devnet-only fallback** feature flag until the SCC program ID and record layout are public.
4. The SCC record layout and PDA seeds are unknown to me; get them from the SDK's on-chain helper crate and mirror them in a small `scc` module.

### Where to run it (nothing here needs the SCC program to start)

| Option | Hardware | Cost (published) | Signup friction | Fit |
|---|---|---|---|---|
| **Phala Cloud CVM** | Intel TDX; GPU TEE too | CVM from **$0.06/h**; medium $0.12/h; large $0.23/h; H100 TEE about $2.38–3.08/GPU-h ([pricing](https://phala.com/pricing), [GPU TEE](https://phala.com/gpu-tee)) | Account + prepaid balance; fastest to try; open-source `dstack` SDK with attestation docs | Best for the hackathon timeline |
| **GCP Confidential VM, C3 Intel TDX** | Intel TDX; GA in 10+ regions | Confidential surcharge $0.0034/vCPU-h + $0.00046/GiB-h on top of normal Compute Engine price ([GCP pricing](https://cloud.google.com/confidential-computing/confidential-vm/pricing)); can use Intel Trust Authority free tier for attestation ([GCP blog](https://cloud.google.com/blog/products/identity-security/from-clicks-to-clusters-confidential-computing-expands-with-intel-tdx)) | GCP account with billing; needs a supported region ([supported configs](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/supported-configurations)) | Safe fallback; matches PLAN's "TDX VM" |
| **GCP Confidential VM (AMD SEV-SNP, N2D)** | SEV-SNP | Same family of pricing | Same as above | Matches SCC product-page hardware list **[S]** |
| **GCP Confidential Space** | SEV-SNP or TDX | Same | Stricter workload-image model, which is good for fixed measurements | Cleanest measurement story |
| **AWS Nitro Enclaves** | Nitro | Standard EC2 prices **[U]** | AWS account | Listed by SCC **[S]** |
| **Azure confidential VMs** | SEV-SNP / TDX | **[U]** | Azure subscription | Not researched |
| **Nito / Tinfoil / others** | managed | See below | API key | Managed inference only |

### Confidential LLM inference (so email text never leaves a TEE)

| Option | What it is | Cost / signup | Notes |
|---|---|---|---|
| **Run the model in our own CVM** | Small open model on CPU/GPU inside the same enclave as the DKIM check | Phala/GCP compute only | Best privacy story: one trust boundary. CPU-only is slow but parsing a short email/PDF is small. |
| **Tinfoil** | Open models on GPU enclaves; OpenAI-style API; browser/Node can verify attestation offline with `@tinfoilsh/verifier` and send end-to-end encrypted requests with `ehbp` ([template](https://solana.com/developers/templates/confidential-chat)) | API pay-as-you-go; inputs from $0.02/M tokens per [aggregator page](https://confidentialinference.net/providers/tinfoil) **[S]**; account via [tinfoil.sh/pricing](https://tinfoil.sh/pricing) | Router code is public ([confidential-model-router](https://github.com/tinfoilsh/confidential-model-router)). Enclave verifies the attested key, so our underwriter can pin it. |
| **Nito API** | Relay in front of Tinfoil's router; prepaid; sign up at [app.trynito.ai/signup](https://app.trynito.ai/signup); key starts `z_sk_` | Prepaid funds required | Same enclave under the hood per the template. |
| **Phala private AI** | GPU TEE inference | [phala.com/pricing](https://phala.com/pricing) | Includes dstack verification docs ([verification](https://github.com/dstack-tee/dstack/blob/c87303818753e7abb3233bd1f5a4b611cb981154/docs/verification.md)). |
| **Confidential.ai (Lunal)** | Confidential VMs + GPU licences | $0.05/vCPU-h TDX; H100 licence $3,876/GPU-year ([pricing](https://confidential.ai/pricing)) | Not tested. |

Hardening notes: the template itself warns the attestation is not tied to a fresh challenge, and that the page code you serve can be changed. For Notch, the *enclave* calls the LLM (not a browser), so pin the repository/measurement and re-verify per session.

---

## What I could not confirm
- SCC program ID, repo, and exact SDK package names; whether TDX is truly supported by the verifier today.
- Real sample emails from Wise, Payoneer, Deel, Upwork, Remote, Grey, Chipper, Opay, Palmpay and the Ghana banks (body format, `d=`, sender local-parts).
- Superteam Earn email templates.
- Whether Telecel Cash or AT Money can email statements.
- Whether zkTLS providers exist for any Ghana/Nigeria/Kenya mobile-money portal.

## Recommended next 3 actions
1. Get one real MoMo statement email (the team's own number) and one Wise email; inspect the raw `DKIM-Signature` headers for `d=` and the PDF structure. Then fix `DEFAULT_TRUSTED` and the fixtures.
2. Ask the Solana Foundation / Nito team for the SCC program ID and the SDK repo (Discord or the Confidential Chat template maintainers).
3. Stand up a Phala CVM (or GCP C3 TDX) and run the underwriter there, publishing the quote and measurement for the demo.

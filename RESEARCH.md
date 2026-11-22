# Hackathon research: Notch

**Checked 22 November 2026.** Dev3pack's event runs 27–29 November 2026. The official event page lists a $10,000+ Best App Overall prize, a Solana Mobile award, and local prizes. Its public page does not show a detailed judging rubric, so treat demo quality and technical proof as our own priorities, not published judging criteria. [Dev3pack event page](https://hack.dev3pack.xyz/)

## The idea needs a sharper edge

“Student loans on-chain” is already a proven category. Pencil Finance was a fourth-place Solana Cypherpunk RWA winner; it tokenizes student-loan portfolios through lending partners. Yumi Finance won the DeFi track with on-chain BNPL and underwriting. Rebuilding either as a smaller loan pool is not a distinctive pitch. [Cypherpunk winners](https://blog.colosseum.com/announcing-the-winners-of-the-solana-cypherpunk-hackathon/) · [Pencil Finance](https://www.pencilfinance.io/)

**Keep the user problem; make the product the privacy-preserving credit bureau.** The differentiator is a reusable, wallet-bound proof of income that lets independent Solana apps assess credit without receiving the student's raw email or bank statement. Student checkout is the first proof that the bureau is useful, not the whole product.

## What strong projects suggest

- Solana's recent winners span consumer, DeFi, infrastructure, stablecoins, and real-world assets; the archive records 1,412 submissions in Breakout 2025 and 1,576 in Cypherpunk 2025. A narrow product with a working demo needs a clear reason to exist inside that crowded field. [Solana hackathon archive](https://solana.com/hackathons)
- Yumi paired a familiar user action (buy now, pay later) with an explicit underwriting-to-origination flow. Notch should show its full proof chain in one demo: private evidence → signed limit → independent on-chain check → loan action → repayment event.
- Winning projects' descriptions lead with a concrete user outcome and show why their technical choice matters. For Notch, show that the email is parsed locally, the content is discarded, and only the signed limit is readable on-chain. Do not claim privacy from a normal server process; today the code labels itself `local-dev`.

## Recommended demo

1. Connect a fresh wallet and upload a synthetic, DKIM-valid income email.
2. Show the parser's income result, then show that the raw message is not returned or written to disk.
3. Post the signed limit on devnet and show a second app reading the public credit-line account.
4. Draw a small test-token amount, repay it, and show the repayment counter.
5. Replay the same email or alter the signed amount; show both transactions fail.
6. State clearly which parts are mocked: enclave attestation, stablecoin, currency rates, and production lending.

Do not claim that repayment changes a later limit yet: that counter is stored on-chain, but the underwriter does not read it.

## Research caveats

- The official event page currently publishes dates and prizes but not submission rules or scoring weights; recheck its FAQ/dashboard before final submission.
- This review used public web pages. It did not inspect X/Twitter posts requiring login.
- A successful testnet transaction only proves that a specific build and configuration ran under testnet conditions. It does not establish mainnet safety, economic viability, legal compliance, or trusted execution.

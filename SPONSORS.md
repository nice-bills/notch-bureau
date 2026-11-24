# Sponsor plan: deep integrations only

Rule: each sponsor must do a job Notch cannot do without it. If removing it leaves the demo unchanged, it is surface level and we drop it.

Status: plan only. Mobile and Pollar are UI-phase work and wait for the user's go. Supabase and the device check are core and can start now.

## 1. Solana Mobile (Seeker phones for Best Mobile App)

Job it does: **one phone = one borrower**.

- The Seeker Genesis Token (SGT) is a Token-2022 NFT minted once per Seeker device (docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token).
- Today one MoMo number = one wallet. A fraudster with five SIM cards can still open five credit lines. Adding SGT closes that hole: the sealed underwriter checks Sign-in-with-Solana plus SGT ownership (mainnet read only, `@solana-mobile/skr-genesis-token`). It then writes `sgt_hash` into the signed record. The program keeps a `["device", sgt_hash]` PDA, the same pattern as `IdentityLink`, so one device backs one credit line.
- Seeker owners get a higher starting limit, because a $450 phone is skin in the game. Non-Seeker users still work.
- App: Android app (Expo + Mobile Wallet Adapter / Seeker Connect one-tap). Signing goes through Seed Vault. A push notification fires when the statement lands and the limit is posted.
- Honest gap: SGT lives on mainnet; Notch runs on devnet. The check reads mainnet and writes devnet. We need a Seeker (or a wallet that holds an SGT) to demo the real path.

## 2. Pollar (payments track, $500)

What Pollar is: an onboarding-to-payment layer. It does Google/email login, which creates a Solana wallet; sponsored fees (the user never holds SOL); `signSolanaTransaction(base64)` for any program call; ramps; cards funded from USDC; and KYC through Didit.

Jobs it does:
- **No seed phrase, no SOL:** a MoMo user signs in with Google. Pollar makes the wallet, and Pollar's gas wallet pays the fees. Our draw, repay and deposit instructions are signed through `signSolanaTransaction`. This removes the biggest onboarding wall for a first-time borrower.
- **Spend the credit without crypto:** this answers "MTN doesn't take USDC". The borrower funds a Pollar card from the drawn USDC and pays any merchant. Repayment is a Pollar payment back into the Notch vault.
- **Not bounded by geography:** Pollar's ramp corridors today are LATAM (BRL via Pix, MXN via SPEI, COP, BOB). A borrower in Brazil draws USDC and cashes out to Pix in one flow. Ghana cash-out is not in Pollar's list, so for Ghana we say so and use the card.
- Pitch line (user's call, Nov 24): we built on Pollar, and it works today where Pollar has rails. Ghana has no Pollar rail yet, so we will work with the Pollar team on Ghana support. The user is registering the Pollar account.
- Honest gaps: card availability per country and devnet support for ramps and cards are unverified. These must be confirmed in the Pollar dashboard before we promise them in the demo.

## 3. Supabase ($100 per member)

Job it does: **the bureau's public nervous system, holding nothing private**.

- **Sign in with Solana** (Supabase Web3 auth) guards `/inbox/new`. This answers the inbox agent's question: the wallet signature becomes required by default.
- **Postgres** holds only non-sensitive state: inbox code → wallet, job status, and the hash of each posted record. Row-level security means a wallet sees only its own rows. No statement, number or amount is ever stored. That is a provable claim: we show the table.
- **Realtime** pushes "statement received, then checked, then limit posted" to the phone live. This is the demo's best moment.
- **pg_cron + Edge Function** replace the systemd keeper (marks overdue loans hourly), so it runs without this laptop.
- The sealed underwriter stays the only thing that reads a statement. Supabase never sees one.

## 4. Best DeFi App and Best App Overall

Already built: senior/junior tranches, timed withdraw, and the `check_credit` bureau CPI with the hostel-deposit example. Nothing to add.

## 5. Ghana local track

Already built: the real MoMo statement parser and income sorting. See the finding below.

## Finding from the real statement (Nov 24)

A real Ghanaian MoMo statement (aggregates only) holds **0 earned income** under our current rules. The money comes in as **cash deposits: 23,467 GHS of 42,985 GHS**, plus peer transfers. The limit came out at 11.62 USDC.

For a trader, cash deposits ARE income. As built, Notch would turn down the typical person it is for. Next core fix: treat steady cash deposits as trading income when they are regular across months and not followed by a matching outflow. Keep the "text can only lower" rule.

## Pollar setup (Nov 24)
- Test app `notch-bureau` (id cmwurt405002g0hskgkyy67fl), created through Pollar's MCP gateway with the user's token. It has a publishable key, 1000 free test credits, allowed origin localhost:5173 and redirect URI /auth/callback. Keys are in `.env.pollar` (git-ignored).
- Still needed: Solana must be enabled under Wallets > Settings > Enabled chains. The gateway has no tool for that, so it is done in the dashboard.

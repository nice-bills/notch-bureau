# Notch Bureau app

Vite + React + TypeScript front end for the Notch program (devnet only, test money only).

## Run

```sh
pnpm install
cp .env.example .env.local        # then fill VITE_USDC_MINT (see below)
pnpm dev                          # http://localhost:5173
pnpm build                        # type-check + production build
pnpm test                         # notch.ts vs tests/notch.test.js, error messages, maths
pnpm e2e:devnet                   # full real run on devnet (see below)
```

## First-time devnet setup (nothing is sent unless you pass `--send`)

1. Start an underwriter: `pnpm demo:enclave` (synthetic DKIM emails, also writes `public/samples/*.eml`),
   or the real one with `cd ../enclave && pnpm start`.
2. Fund your CLI wallet: `solana airdrop 2 --url devnet`.
3. Dry run first: `pnpm setup:devnet` (prints the plan). Then:
   `pnpm setup:devnet --send --write-env --seed-pool 500 --mint-to <your-browser-wallet>:200`
   (creates a test USDC mint, runs `init` with the underwriter's public key, funds wallets, seeds the pool).
4. Make sure the program is deployed at `VITE_PROGRAM_ID` (deploying is not part of this app).
5. Open the app, connect Phantom/Backpack/Solflare on devnet.

Env: `VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_USDC_MINT`, `VITE_ENCLAVE_URL`.
The setup script needs Node 22.18+ (it imports `src/notch.ts` so app and script share one set of builders).

## Keeper (`pnpm keeper`)

`claim_withdraw` pays at the share price at claim time, so a default marked during a lender's 3 day cooldown is priced in. That
only works if somebody calls `mark_default` on overdue loans. `scripts/keeper.mjs` scans every `CreditLine` account
(`getProgramAccounts`, filtered by size and discriminator), picks the ones with a balance whose due date has passed, and sends
`mark_default` (permissionless, the fee payer pays only the network fee).

```
pnpm keeper                       # dry run: lists what it would mark, sends nothing
pnpm keeper --send                # marks them (fee payer: ~/.config/solana/id.json, or --keypair)
pnpm keeper --send --watch 3600   # repeat every hour
```

Reads `VITE_RPC_URL` and `VITE_PROGRAM_ID` from `.env.local` (or `--rpc`, `--program`). Devnet or a local validator only: it
refuses mainnet URLs and any non-local RPC whose genesis hash is not devnet's. Run it at least every few hours.

## End-to-end test on devnet (`pnpm e2e:devnet`)

Sends real devnet transactions with test money only. Needs the program deployed and initialised (values read from
`.env.local`), the admin/mint-authority key at `~/.config/solana/id.json`, and the underwriter key file
(`../.underwriter-key.json`, the same one the demo enclave uses). It refuses anything that is not devnet.

What it does, with fresh wallets each run: funds a borrower (SOL from the admin wallet, test USDC minted), gets a signed
limit from the underwriter, posts it, deposits 20%, draws, repays principal + 2%, checks the deposit comes back and the
on-time counter goes up, withdraws a deposit, then has a second wallet lend (share maths checked against pool accounting), request a withdrawal (shares to escrow, supply
unchanged), get an early claim refused with `CooldownActive`, and cancel (shares back, accounts closed). The claim payout needs the
3 day cooldown, so it is covered by the LiteSVM tests (`pnpm test` in the repo root), not by devnet. It also fires the attacks and asserts the exact program error: signed by another key (`WrongUnderwriter`), record
changed after signing (`RecordMismatch`), same email again (dedupe account already in use), draw over limit (`OverLimit`),
draw without deposit (`InsufficientDeposit`), repay without fee (`FeeRequired`), early `mark_default` (`NotPastDue`),
`withdraw_borrower` with a balance out (`BalanceOutstanding`). On the underwriter side it checks an edited email fails DKIM,
the same email twice is refused, and the reply carries only `ok, extraction, limitUsdc, expiry, nonce, message, signature`.

Every transaction prints with an Explorer link (`?cluster=devnet`); failed attack transactions are sent on purpose (skip
preflight) so they appear on-chain with their logs. Leftover SOL in the throwaway wallets is swept back to the admin wallet
(`--no-sweep` to keep it). A run costs about 0.0065 devnet SOL of fees and account rent. Exit code is 0 only if every check passes.

The underwriter runs **inside the script** (same `Underwriter` class and key as `pnpm demo:enclave`, shared code in
`scripts/enclave-lib.mjs`) because only the process that holds the synthetic DKIM key can sign fresh emails. It also prints
whether the demo enclave at `VITE_ENCLAVE_URL` reports the same underwriter key. Needs Node 22.18+.

## Layout

- `src/notch.ts`: instruction builders, PDAs, record encoding, account readers, fee/deposit/share maths. No network.
- `src/chain.ts`: RPC reads, simulate, sign, send, confirm. `src/errors.ts`: program errors in plain English.
- `src/Borrow.tsx`, `Lend.tsx`, `Book.tsx`, `Attacks.tsx`: the four screens.
- `src/MarkDefault.tsx`: “Mark overdue loan as defaulted” panel on the Book screen (anyone can call `mark_default` once a loan is past due).
- `scripts/devnet-setup.mjs`, `scripts/demo-enclave.mjs`, `scripts/enclave-lib.mjs`, `scripts/e2e-devnet.mjs`, `scripts/keeper.mjs`.

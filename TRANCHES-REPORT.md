# Senior / junior tranches: report

## Rules in plain words
- Two share tokens over one vault: **SENIOR** and **JUNIOR**. A deposit picks one by which token account you pass.
- **Losses:** a default loss (principal lost minus the seized borrower deposit) comes off JUNIOR first. Senior loses only what is left after junior hits zero.
- **Fees:** the 2% fee is split by capital, but a junior dollar counts 2x (config `junior_weight_bps`, 20000). Example 80/20 pool: senior gets 2/3 of fees, junior 1/3, so junior earns about 2x per dollar. Rounding dust goes to junior. A tranche at zero gets nothing; the other takes it all. No clocks, no APR bookkeeping. Fees do not refill an earlier hole (no make-whole).
- **Floor:** junior must stay at least 20% of the pool (config `min_junior_bps`, 2000). Senior deposits that would break it are refused (so the first senior needs junior first). Junior withdrawals that would break it are refused at claim time. Senior exits are never blocked. A loss can push junior under the floor: senior deposits and junior exits stay refused until junior is topped up.
- **Timed withdraw:** request / claim / cancel with the 3-day cooldown, per tranche (own escrow and request account per share mint). Paid at that tranche's NAV at claim time, capped by idle cash and by the tranche's own NAV.
- **Safety kept per tranche:** price = tracked NAV / supply (never the vault balance), so donations and first-depositor tricks do nothing. Invariant `senior_nav + junior_nav == idle + outstanding` is checked on every pool touch. A tranche wiped to zero while shares exist is dead (no new deposits).
- Parameters are fixed at `init_pool` (admin, once). Math block comment: top of `programs/notch/src/lib.rs`.

## Migration
v1 pool PDAs (`pool`, `vault`, `share-mint`) are abandoned, no migration. v2 uses `pool-v2`, `vault-v2`, `senior-mint`, `junior-mint`. Config, credit lines, dedupe and identity accounts are shared and untouched. v1 had only test USDC. Devnet pool v2 was created with 20% floor and 2x weight and seeded with 1000 junior + 200 senior test USDC.

## Forced default
Normal loans are due in 30 days. New instruction `draw_with_term(amount, term_s)` lets a borrower pick 10 s to 30 d (first draw of a loan only). It can only hurt the borrower. The app still uses plain `draw`. Devnet step 11 draws with a 10 s term and calls `mark_default`.

## Known gaps
- Frozen UI is single-tranche: it deposits into JUNIOR (`addrs.shareMint` = junior mint) and its share price uses total pool assets / junior supply, so it is exact only while senior is empty. Tranche UI is a later phase.
- Devnet does not force a loss bigger than junior (it would drain the shared pool), and the 3-day claim itself cannot run on devnet. Both are covered by LiteSVM (`tests/tranches.test.js`).
- Dust: if a tranche supply is 0 with rounding-dust NAV left, the next depositor inherits the dust.

## Tests
- LiteSVM: 68 (49 old + 19 tranche tests: loss < junior, loss > junior, exact boundary, fee numbers (2x, 1x, junior-only, senior-only), fees after a loss, floor both ways, loss under the floor, timed withdraw per tranche, both pending at once, idle cap, wrong mints, donation attack per tranche, init params, draw_with_term).
- `pnpm e2e:all`: node tests 68, enclave 71, sdk 6, vitest 43, devnet 147/147 (step 11: 33 checks), browser (local validator) 6 passed.

## Devnet transactions (step 11, run 1; full log `app/e2e-devnet-tranches.log`)
- ok: fund tranche demo wallets (0.015 SOL each; junior lender 30 USDC, borrower 10 USDC)
  https://explorer.solana.com/tx/3BA1roQPdgnKBz4YaQQhB5nHgf6bUuCk5gJcxDqvMEhMiadz3S9WL4Jh6yv1pmEUSYSBdnzdQ6uxSdRuwMfdJcBn?cluster=devnet
- ok: junior lender deposits 30 USDC into the JUNIOR tranche
  https://explorer.solana.com/tx/4MzqN2QvGbJLB935fVU4y1krcYubjz8EXNr1EKwktrCok9FNcWjdXDuNw4ivk3eQdJJYmWP64Jr9RChGkBSAqLMZ?cluster=devnet
- ok: fund the senior lender with 3981.063851 test USDC (headroom 3941.06385)
  https://explorer.solana.com/tx/iWmEVeaNDFeqvHzZs3HnnqgDMA4gDRTudz1H978qxAadi38P5bjxAYGtUpKZSkfg6JkobYJWdpeMwGf24zwCojJ?cluster=devnet
- REFUSED: ATTACK senior deposit of headroom + 1 micro-USDC (3941.063851 USDC)
  https://explorer.solana.com/tx/B5XVXHfsvoA3MfHEBFKdKvc3H5VrrhDT4iv5tBLpJxnDhmuJAoWvqMrmuXTrEkcjVsHubjQYdFWEKJXLa6JP2ef?cluster=devnet
- ok: senior lender deposits 40 USDC into the SENIOR tranche
  https://explorer.solana.com/tx/3ArBXvAfaEkuTBdScbmenuS7h9CvVxmdghfkWsHbxJBqH93PLBPauuwYb3X8XQGsNvM2auEQKYVEXEUHwuxx8HkV?cluster=devnet
- ok: tranche borrower: post_limit
  https://explorer.solana.com/tx/3dNG4Sm84gdkp1ZHJa33te8rM8DuieUb6WzNoCWa2Pyyy21KvzNFJ5M3Wb487XGRrpJKWVuuYfFXmZudo3Suve1n?cluster=devnet
- ok: borrower: deposit 1 + draw 5
  https://explorer.solana.com/tx/3nbH4hETEi6mgHuDs5TF54kQP1Gf7c1WmBP5EzauvdsEUKNWe3SEwKn2kpdjKiryyP3ej7kBDcHxt4FtdGmJhLfn?cluster=devnet
- ok: borrower: repay 5.1 USDC (principal + 2% fee)
  https://explorer.solana.com/tx/sz3zY4KSNac134rGeHdyb1jKxrYcEqLxpCxnGtgzVgb78bVR85B1GakYBbE7FD4S5vvNYU4Mgd3HpuVETo4ujTq?cluster=devnet
- REFUSED: ATTACK draw_with_term with a 9 second term (minimum is 10)
  https://explorer.solana.com/tx/tAT5GVQFNX9A55wofyTvy9H4msSabnnxnc2pTw97MqjFmYmbTLU1zW7nq1CWYQfZaGpjvN9bPpA9396aHKahxhe?cluster=devnet
- REFUSED: ATTACK draw_with_term with a 30 day + 1 second term
  https://explorer.solana.com/tx/2hkjfUTKCUfhTWvPTounCBknwuDfX3VtZ81bNLp2eC5wSB7aNNtEotbEEtemzuVCd9z5TWS6TgtFLZ4HPn3mE6PN?cluster=devnet
- ok: borrower: deposit 1 + draw_with_term 5 USDC due in 10 s
  https://explorer.solana.com/tx/4eqeB3FZ87rjgrWsk7NXaByWAsTZxUEk55sfUoyxBaaK4a5P3jUAAo9TavE7P6nsBg4592kwtqxEpGoqWZ5ZEpG?cluster=devnet
- ok: mark_default (attempt 1)
  https://explorer.solana.com/tx/3BSCnuev3e8ANKjtuTuTvpsgyLef7QFDHrD4ZjSF7avKoNa7aaEhuGEje2BCCM5HW7ynm7KBmLnroE2jSpYnHZRf?cluster=devnet
- ok: junior lender request_withdraw 29991832 JUNIOR shares
  https://explorer.solana.com/tx/ott4L94z53v83mmvDyUhQHDs8GME74WQvt5fMaBcuWoDwgMNPi8CViBKvZcU7KMTheqihB6jP1tCZtjXXnUJsza?cluster=devnet
- ok: senior lender request_withdraw 39994554 SENIOR shares
  https://explorer.solana.com/tx/345SEsmZ9tgZQumJRJzvJeHrQe61fZEEjJZZDNUSjeZfrB6EeuvLCCXpwWLYRxjNASA4qyDSvbehjJYCVfvQRyV3?cluster=devnet
- REFUSED: junior lender claim_withdraw before the cooldown (must be refused)
  https://explorer.solana.com/tx/bdhguZSMqkmpsikHWYbzbVm4n9aXPYoLSopzpcB1VLgFYDb96XLa9zWxdCdSqXEyvN8o5wYJ1hYpZMoH27Ez7Bp?cluster=devnet
- REFUSED: senior lender claim_withdraw before the cooldown (must be refused)
  https://explorer.solana.com/tx/4RjaZUJ88PS5yuFJkRLoU8CoCSRVzkELG3XNcjgdA17PdMfDVfackBTWuyqGk3V1oMtzbsnwdtMRyr3ppfCsyAP1?cluster=devnet
- REFUSED: ATTACK senior lender claims against the JUNIOR escrow/request
  https://explorer.solana.com/tx/4PTfBF2141CgSJ7S95q6vN65bdwwHXPvqhzdsQ83RfDZbySv7zP8rzcKELi7Yfu4vy2i2zMq8VHVKoB12UpduUQ2?cluster=devnet
- ok: junior lender cancel_withdraw
  https://explorer.solana.com/tx/cof59LhXdLKLJfJsJAgiLmHf7NGtQD3iszQosBbpkKtPs3GG4kP5nUZXcGXUsdcAoM2K1uVzuUcogtFtzkqRSKC?cluster=devnet
- ok: senior lender cancel_withdraw
  https://explorer.solana.com/tx/LmQqeiMenZ2X8RD6EAr2w9KRCcVwydWZtoZENVuqmhK1biG5FDYsYhYKv9S3obQ1Djte57Cfxb6JBnraQxbABsY?cluster=devnet

# @notch/bureau

Ask the Notch credit bureau "is this wallet good for X?" without ever seeing income, emails or exact limits.
Apps get a coarse bucket of **available** credit (limit minus what is already drawn):

| bucket | available |
|---|---|
| 0 | under 25 USDC |
| 1 | 25 to 100 USDC |
| 2 | 100 to 500 USDC |
| 3 | 500 USDC or more |

## Integrate in 10 lines (TypeScript / JS, `@solana/kit`)

```js
import { createSolanaRpc } from '@solana/kit';
import { getCredit, buildCheckCreditIx } from '@notch/bureau';

const rpc = createSolanaRpc('https://api.devnet.solana.com');

// 1. Read it (free, no transaction): good for rent?
const c = await getCredit(rpc, studentWallet);
if (!c.exists || !c.active || c.availableBucket < 1) throw new Error('not good for 25+ USDC');

// 2. Or enforce it on chain: put this in your transaction BEFORE your own instruction.
// It fails the whole transaction unless the wallet has >= 30 USDC left on a record posted in the last 7 days.
const check = await buildCheckCreditIx({ wallet: studentWallet, minAvailable: 30_000_000n, maxAgeSeconds: 7 * 86_400 });
```

`getCredit` returns `{ exists, availableBucket, availableBucketLabel, onTimeRepayments, defaulted, expiresAt, postedAt, expired, active }`
(`{ exists: false }` for a wallet with no line). `check_credit` fails with one of `NoCreditLine`, `Defaulted`,
`RecordExpired`, `InsufficientCredit`, `StaleRecord`.

## From your own Anchor program (CPI)

`programs/hostel-deposit` in this repo is a complete example (about 40 lines). In short:

```rust
// Cargo.toml: notch = { path = "../notch", features = ["cpi"] }   (or declare_program!(notch) from the IDL)
let check = notch::cpi::check_credit(
    CpiContext::new(notch_program.key(), notch::cpi::accounts::CheckCredit { borrower: student.to_account_info(), line: line.to_account_info() }),
    rent,            // min_available, base units
    7 * 86_400,      // max_age_s
)?.get();            // CreditCheck { wallet, available_bucket, on_time_repayments, defaulted }
```

Pass the student's line PDA (`["line", student]` under the Notch program) as `line`; `check_credit` is read-only and
needs no signature, so the wallet doesn't have to sign for the check itself.

## What it does and does not tell you

- It tells you the wallet *can* borrow at least the amount you asked, right now, against a fresh signed record
  from the sealed underwriter. It does not reserve the credit: the wallet can still draw it from Notch afterwards.
- Buckets are coarse on purpose. An app that asks `minAvailable` many times can still narrow the exact number;
  ask for the amount you actually need, not a ladder of probes.
- Devnet only for now. Pass `programAddress` to point at another deployment.

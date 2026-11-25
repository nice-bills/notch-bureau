# Review of 3fe3bca (deposit DustSupply guard)

## (a) Rounding loss at supply >= 1e6 — OK (negligible)
A depositor loses less than one share's value: N / S < N / 1e6 base units.
- NAV 1k USDC: < 0.001 USDC per deposit
- NAV 100k USDC: < 0.1 USDC
- NAV 10M USDC: < 10 USDC (needs the attacker to own all 10M and burn down to 1e6 shares; the gain is split pro rata across holders)
- An honest pool sits near 1:1 (S ≈ N), so the loss there is < 1 base unit.
You don't need a virtual offset to fix (a). A `min_shares` argument would be a nice extra, not a blocker.

## (c) CONFIRMED — 1 USDC griefer permanently bricks a tranche (new problem from this fix)
- Where: programs/notch/src/lib.rs:357 (`require!(supply == 0 || supply >= MIN_FIRST_DEPOSIT)`)
- Scenario: the tranche is empty (fresh pool, or every holder has left). The griefer deposits 1 USDC, then burns 1 share
  through the SPL token program. Supply is now 999,999, so every deposit fails with DustSupply forever. Only the griefer
  can undo it, and they keep their 1 USDC. If junior is locked, senior is capped by subordination at 4x junior (about 4 USDC).
  The pool PDAs are fixed, so there is no re-init. Proof (passes): scratchpad brick.test.mjs. Honest 1 USDC and
  1000 USDC junior deposits are refused, and so is a senior deposit.
- It works on senior too, and in any tranche where the other holders own < 1e6 shares in total.
- Dust deadlock: two holders with dust left cannot claim each other out. Each claim leaves the other's dust, which is
  < 1e6 (lib.rs:589). The workaround is an off-program SPL transfer to consolidate.
- Minimal fix: use dead shares instead of the refusal. On the first deposit (supply == 0), mint MIN_FIRST_DEPOSIT
  (or e.g. 1e3) shares to a program PDA token account that has no burn path. Supply can then never fall below
  that floor, so the burn attack is capped at the rounding bound in (a). Then drop lib.rs:357 and the dust checks at
  lib.rs:589 / 670. The first depositor pays that floor once. An OpenZeppelin-style virtual offset
  (shares = a*(S+V)/(N+V) in deposit, claim and cancel) also works but touches more code.

## (b) Other ways supply shrinks without NAV
- Claim and cancel: OK, both guarded (lib.rs:589, 670). The escrow is PDA-owned and cannot be burned directly.
- NAV == 0 with supply > 0 (junior wiped by a default, or senior after junior): deposit refuses at lib.rs:359
  (InvalidPoolState), and claims pay 0 so they fail with InvalidAmount (lib.rs:570). PLAUSIBLE permanent lock, already
  there before this commit and documented as "DEAD TRANCHE". Supply only returns to 0 if every holder burns by hand. With a
  dead junior, senior deposits are also blocked by subordination. Minimal fix: let deposit treat (nav == 0, supply > 0)
  as a reset. Mint 1:1 and have old shares count as worthless, e.g. via an epoch/mint rotation. Or have an admin
  `retire_dead_tranche`.
- Near-zero NAV (e.g. junior_nav = 1 base unit, supply 1e8 after a loss): deposits mint huge share counts, and u64 overflows
  at about 180k USDC NAV (MathOverflow at lib.rs:360/mint). PLAUSIBLE, low impact. Minimal fix: treat
  nav * 1e6 < supply as dead (same path as nav == 0).

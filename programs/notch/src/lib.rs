use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

mod record;
use record::{ed25519_pubkey_and_message, Record};

declare_id!("4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz");

/// Native Ed25519 signature-verify program.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const LOAN_TERM_S: i64 = 30 * 86_400;
/// How long a lender's shares sit in escrow between `request_withdraw` and `claim_withdraw`.
///
/// Why it exists: a loan is "overdue" the second after `line.due`, but the loss only reaches the
/// share price when someone calls `mark_default`. With an instant withdraw a lender who sees an
/// overdue loan could pull out at full price and leave the loss to the lenders who stay. The
/// claim is paid at the share price *at claim time*, so any `mark_default` that lands during the
/// cooldown is priced in first.
///
/// `mark_default` is permissionless and has no grace period (it works the moment `now > due`), so
/// the window a keeper needs is its polling interval plus transaction landing time. 3 days gives a
/// keeper polling hourly ~72 attempts to catch any loan that was already overdue (or goes overdue
/// during the cooldown) before the claim unlocks. It is deliberately a small fraction of
/// `LOAN_TERM_S` so honest lenders are not locked up for long.
pub const WITHDRAW_COOLDOWN_S: i64 = 3 * 86_400;

#[program]
pub mod notch {
    use super::*;

    /// One-time setup: who may rotate the underwriter, and which mint the pool lends.
    pub fn init(ctx: Context<Init>, underwriter: Pubkey, underwriter_expiry: i64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.mint = ctx.accounts.mint.key();
        c.underwriter = underwriter;
        c.underwriter_expiry = underwriter_expiry;
        c.bump = ctx.bumps.config;
        c.vault_bump = ctx.bumps.vault;
        c.share_mint_bump = ctx.bumps.share_mint;
        ctx.accounts.pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Stand-in for the Solana Confidential Compute verifier: in production the underwriter key
    /// is read from the verifier's attestation record (code hash + TDX + expiry) instead.
    pub fn set_underwriter(
        ctx: Context<AdminOnly>,
        underwriter: Pubkey,
        expiry: i64,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.underwriter = underwriter;
        c.underwriter_expiry = expiry;
        Ok(())
    }

    /// The bureau write. The instruction right before this one must be a native Ed25519 verify
    /// of `record` by the current underwriter key. Each email (dedupe hash) can only count once.
    pub fn post_limit(ctx: Context<PostLimit>, record: Vec<u8>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.config;
        require!(now < c.underwriter_expiry, NotchError::UnderwriterExpired);

        let ixs = ctx.accounts.instructions.to_account_info();
        let here = load_current_index_checked(&ixs)? as usize;
        require!(here > 0, NotchError::MissingSigIx);
        let prev = load_instruction_at_checked(here - 1, &ixs)?;
        require_keys_eq!(
            prev.program_id,
            ED25519_PROGRAM_ID,
            NotchError::MissingSigIx
        );
        let (signer, signed_msg) = ed25519_pubkey_and_message(&prev.data)?;
        require_keys_eq!(signer, c.underwriter, NotchError::WrongUnderwriter);
        require!(signed_msg == record, NotchError::RecordMismatch);

        let r = Record::parse(&record)?;
        require_keys_eq!(
            r.wallet,
            ctx.accounts.borrower.key(),
            NotchError::WrongWallet
        );
        require!(r.expiry > now, NotchError::RecordExpired);

        // One mobile-money account (id_hash) may back ONE wallet, ever. The first wallet to present
        // it claims the IdentityLink; any other wallet is refused. All-zero means "no identity"
        // (the source cannot be bound) and skips the link entirely.
        if r.id_hash != [0u8; 32] {
            let link = ctx
                .accounts
                .identity
                .as_mut()
                .ok_or(NotchError::IdentityRequired)?;
            if link.wallet == Pubkey::default() {
                link.wallet = r.wallet;
                link.bump = ctx.bumps.identity.ok_or(NotchError::IdentityRequired)?;
            } else {
                require_keys_eq!(link.wallet, r.wallet, NotchError::IdentityBound);
            }
        }

        let line = &mut ctx.accounts.line;
        if line.wallet == Pubkey::default() {
            line.wallet = r.wallet;
            line.bump = ctx.bumps.line;
        }
        require!(!line.defaulted, NotchError::Defaulted);
        // Per-wallet ordering: an older signed record can't overwrite a newer one.
        require!(r.nonce > line.last_nonce, NotchError::StaleRecord);
        line.last_nonce = r.nonce;
        line.limit = r.limit;
        line.expiry = r.expiry;
        line.posted_at = now;
        ctx.accounts.dedupe.used_at = now;
        emit!(LimitPosted {
            wallet: r.wallet,
            limit: r.limit,
            expiry: r.expiry,
            nonce: r.nonce
        });
        Ok(())
    }

    /// The bureau read. Any program (via CPI) or client (same transaction) can ask "is this wallet good for at
    /// least `min_available` base units, on a record posted within the last `max_age_s` seconds?".
    /// Read-only: it changes nothing. It fails with a specific error otherwise, and on success returns and
    /// logs a coarse bucket, never the exact limit or balance.
    pub fn check_credit(ctx: Context<CheckCredit>, min_available: u64, max_age_s: i64) -> Result<CreditCheck> {
        let now = Clock::get()?.unix_timestamp;
        let info = ctx.accounts.line.to_account_info();
        // A wallet nobody has posted a record for has no account yet; report that as NoCreditLine.
        require!(
            info.owner == &crate::ID && info.data_len() > 8,
            NotchError::NoCreditLine
        );
        let line = CreditLine::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        require_keys_eq!(line.wallet, ctx.accounts.borrower.key(), NotchError::NoCreditLine);
        require!(!line.defaulted, NotchError::Defaulted);
        require!(now < line.expiry, NotchError::RecordExpired);
        let available = line.limit.saturating_sub(line.drawn);
        require!(available >= min_available, NotchError::InsufficientCredit);
        require!(
            now.saturating_sub(line.posted_at) <= max_age_s,
            NotchError::StaleRecord
        );
        let out = CreditCheck {
            wallet: line.wallet,
            available_bucket: available_bucket(available),
            on_time_repayments: line.repaid_on_time,
            defaulted: false,
        };
        emit!(CreditChecked {
            wallet: out.wallet,
            available_bucket: out.available_bucket,
            on_time_repayments: out.on_time_repayments,
            defaulted: false,
        });
        Ok(out)
    }

    /// Deposit USDC and mint shares at the current net asset value.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, NotchError::InvalidAmount);
        // Share price comes from tracked accounting, never from the raw vault balance, so a direct
        // token donation to the vault cannot move it (no first-depositor inflation attack).
        let assets = pool_assets(&ctx.accounts.pool)?;
        let supply = ctx.accounts.share_mint.supply;
        let shares = if supply == 0 { amount } else {
            require!(assets > 0, NotchError::InvalidPoolState);
            let s = (amount as u128).checked_mul(supply as u128).ok_or(NotchError::MathOverflow)?
                .checked_div(assets as u128).ok_or(NotchError::MathOverflow)?;
            u64::try_from(s).map_err(|_| NotchError::MathOverflow)?
        };
        require!(shares > 0, NotchError::InvalidAmount);
        ctx.accounts.pool.idle = ctx.accounts.pool.idle.checked_add(amount).ok_or(NotchError::MathOverflow)?;
        let decimals = ctx.accounts.mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;
        let bump = [ctx.accounts.config.share_mint_bump];
        let seeds: &[&[&[u8]]] = &[&[b"share-mint", &bump]];
        token_interface::mint_to_checked(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(), token_interface::MintToChecked {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.share_account.to_account_info(),
                authority: ctx.accounts.share_mint.to_account_info(),
            }, seeds), shares, ctx.accounts.share_mint.decimals)
    }

    /// Borrow against the bureau limit.
    pub fn draw(ctx: Context<Draw>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(amount > 0, NotchError::InvalidAmount);
        let line = &mut ctx.accounts.line;
        require!(!line.defaulted, NotchError::Defaulted);
        require!(now < line.expiry, NotchError::RecordExpired);
        let drawn = line
            .drawn
            .checked_add(amount)
            .ok_or(NotchError::OverLimit)?;
        require!(drawn <= line.limit, NotchError::OverLimit);
        // First-loss deposit must cover 20% (rounded up) of the TOTAL balance after this draw.
        require!(
            line.borrower_deposit >= drawn.checked_add(4).ok_or(NotchError::MathOverflow)? / 5,
            NotchError::InsufficientDeposit
        );
        // Only lender liquidity can be lent; never other borrowers' deposits or stray donations.
        require!(amount <= ctx.accounts.pool.idle, NotchError::InsufficientLiquidity);
        if line.drawn == 0 {
            line.due = now.checked_add(LOAN_TERM_S).ok_or(NotchError::MathOverflow)?;
        }
        line.drawn = drawn;
        ctx.accounts.pool.idle = ctx.accounts.pool.idle.checked_sub(amount).ok_or(NotchError::MathOverflow)?;
        ctx.accounts.pool.total_lent = ctx.accounts.pool.total_lent.checked_add(amount).ok_or(NotchError::MathOverflow)?;
        ctx.accounts.pool.outstanding = ctx.accounts.pool.outstanding.checked_add(amount).ok_or(NotchError::MathOverflow)?;

        let bump = [ctx.accounts.config.vault_bump];
        let seeds: &[&[&[u8]]] = &[&[b"vault", &bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
    }

    /// Pay back. Clearing the balance before the due date counts as an on-time repayment,
    /// which the underwriter reads to raise the next limit cap.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let line = &mut ctx.accounts.line;
        require!(amount > 0, NotchError::InvalidAmount);
        require!(line.drawn > 0, NotchError::NothingToRepay);
        // Flat 2% of the balance drawn, rounded up so dust draws still pay a fee.
        let fee_due = line.drawn.checked_mul(2).ok_or(NotchError::MathOverflow)?.checked_add(99).ok_or(NotchError::MathOverflow)? / 100;
        let payoff = line.drawn.checked_add(fee_due).ok_or(NotchError::MathOverflow)?;
        require!(amount >= payoff, NotchError::FeeRequired);
        let principal = line.drawn;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            payoff,
            ctx.accounts.mint.decimals,
        )?;
        line.drawn = 0;
        let pool = &mut ctx.accounts.pool;
        pool.outstanding = pool.outstanding.checked_sub(principal).ok_or(NotchError::MathOverflow)?;
        pool.idle = pool.idle.checked_add(payoff).ok_or(NotchError::MathOverflow)?;
        pool.fees_earned = pool.fees_earned.checked_add(fee_due).ok_or(NotchError::MathOverflow)?;
        // Full repayment frees the first-loss deposit; it goes back to the borrower in this same instruction.
        let deposit_return = line.borrower_deposit;
        line.borrower_deposit = 0;
        pool.borrower_deposits = pool.borrower_deposits.checked_sub(deposit_return).ok_or(NotchError::MathOverflow)?;
        if now <= line.due {
            line.repaid_on_time = line.repaid_on_time.checked_add(1).ok_or(NotchError::MathOverflow)?;
        } else {
            line.repaid_late = line.repaid_late.checked_add(1).ok_or(NotchError::MathOverflow)?;
        }
        line.due = 0;
        let bump = [ctx.accounts.config.vault_bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.deposit_return.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
        }, &[&[b"vault", &bump]]), deposit_return, ctx.accounts.mint.decimals)?;
        Ok(())
    }

    /// Anyone can mark a line defaulted once it is past due with a balance; it can never borrow again.
    pub fn mark_default(ctx: Context<MarkDefault>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let line = &mut ctx.accounts.line;
        require!(
            line.drawn > 0 && line.due > 0 && now > line.due,
            NotchError::NotPastDue
        );
        line.defaulted = true;
        line.limit = 0;
        let lost = line.drawn;
        line.drawn = 0;
        line.due = 0;
        // The first-loss deposit is seized, up to the amount lost, and becomes lender assets.
        // Any excess the borrower over-deposited stays theirs (withdraw_borrower).
        let seized = line.borrower_deposit.min(lost);
        line.borrower_deposit -= seized;
        let pool = &mut ctx.accounts.pool;
        pool.outstanding = pool.outstanding.checked_sub(lost).ok_or(NotchError::MathOverflow)?;
        pool.borrower_deposits = pool.borrower_deposits.checked_sub(seized).ok_or(NotchError::MathOverflow)?;
        pool.idle = pool.idle.checked_add(seized).ok_or(NotchError::MathOverflow)?;
        pool.defaults = pool.defaults.checked_add(1).ok_or(NotchError::MathOverflow)?;
        pool.default_amount = pool.default_amount.checked_add(lost).ok_or(NotchError::MathOverflow)?;
        Ok(())
    }

    /// Step 1 of leaving the pool: move `shares` into a program-owned escrow and start the cooldown.
    /// The shares are NOT burned, so they still count in the supply (and keep earning/losing with the
    /// pool) until `claim_withdraw`. One pending request per lender; cancel to change the amount.
    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        require!(shares > 0 && shares <= ctx.accounts.share_account.amount, NotchError::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.request;
        r.lender = ctx.accounts.lender.key();
        r.shares = shares;
        r.unlock_ts = now.checked_add(WITHDRAW_COOLDOWN_S).ok_or(NotchError::MathOverflow)?;
        r.bump = ctx.bumps.request;
        r.escrow_bump = ctx.bumps.escrow;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.share_account.to_account_info(),
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            shares,
            ctx.accounts.share_mint.decimals,
        )
    }

    /// Step 2: once the cooldown has passed, burn the escrowed shares and pay out at the share price
    /// of THIS moment (so a default marked during the cooldown is already reflected). The payout can
    /// never exceed lender cash that is actually idle; if the pool is short the claim fails and the
    /// request stays open (retry later, or cancel).
    pub fn claim_withdraw(ctx: Context<ClaimWithdraw>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.request.unlock_ts, NotchError::CooldownActive);
        let shares = ctx.accounts.request.shares;
        // Escrowed shares are still in `supply`, so the price per share is unaffected by the escrow.
        let assets = pool_assets(&ctx.accounts.pool)?;
        let amount = (shares as u128).checked_mul(assets as u128).ok_or(NotchError::MathOverflow)?
            .checked_div(ctx.accounts.share_mint.supply as u128).ok_or(NotchError::MathOverflow)?;
        let amount = u64::try_from(amount).map_err(|_| NotchError::MathOverflow)?;
        require!(amount > 0, NotchError::InvalidAmount);
        // Only idle lender cash can leave; USDC out on loan and borrower deposits cannot.
        require!(amount <= ctx.accounts.pool.idle, NotchError::InsufficientLiquidity);
        ctx.accounts.pool.idle = ctx.accounts.pool.idle.checked_sub(amount).ok_or(NotchError::MathOverflow)?;

        let lender_key = ctx.accounts.lender.key();
        let escrow_bump = [ctx.accounts.request.escrow_bump];
        let escrow_seeds: &[&[&[u8]]] = &[&[b"escrow", lender_key.as_ref(), &escrow_bump]];
        // Burn everything in escrow (the request amount, plus any shares a stranger sent in): the
        // account must be empty to be closed, and nobody else can pull from it.
        let escrowed = ctx.accounts.escrow.amount;
        token_interface::burn_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token_interface::BurnChecked {
            mint: ctx.accounts.share_mint.to_account_info(), from: ctx.accounts.escrow.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        }, escrow_seeds), escrowed, ctx.accounts.share_mint.decimals)?;
        token_interface::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token_interface::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(), destination: ctx.accounts.lender.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        }, escrow_seeds))?;
        let vbump = [ctx.accounts.config.vault_bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
        }, &[&[b"vault", &vbump]]), amount, ctx.accounts.mint.decimals)
    }

    /// Change of mind (allowed any time, before or after the cooldown): shares go back to the lender.
    pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
        let lender_key = ctx.accounts.lender.key();
        let escrow_bump = [ctx.accounts.request.escrow_bump];
        let escrow_seeds: &[&[&[u8]]] = &[&[b"escrow", lender_key.as_ref(), &escrow_bump]];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.escrow.to_account_info(), mint: ctx.accounts.share_mint.to_account_info(),
            to: ctx.accounts.share_account.to_account_info(), authority: ctx.accounts.escrow.to_account_info(),
        }, escrow_seeds), ctx.accounts.escrow.amount, ctx.accounts.share_mint.decimals)?;
        token_interface::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token_interface::CloseAccount {
            account: ctx.accounts.escrow.to_account_info(), destination: ctx.accounts.lender.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        }, escrow_seeds))
    }

    pub fn deposit_borrower(ctx: Context<BorrowerDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, NotchError::InvalidAmount);
        require!(!ctx.accounts.line.defaulted, NotchError::Defaulted);
        token_interface::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.from.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.borrower.to_account_info(),
        }), amount, ctx.accounts.mint.decimals)?;
        ctx.accounts.line.borrower_deposit = ctx.accounts.line.borrower_deposit.checked_add(amount).ok_or(NotchError::MathOverflow)?;
        ctx.accounts.pool.borrower_deposits = ctx.accounts.pool.borrower_deposits.checked_add(amount).ok_or(NotchError::MathOverflow)?;
        Ok(())
    }

    /// Take back the first-loss deposit when there is no balance outstanding (for example a deposit
    /// made before any draw, or the excess left after a default). Repaying in full already returns it.
    pub fn withdraw_borrower(ctx: Context<WithdrawBorrower>) -> Result<()> {
        let line = &mut ctx.accounts.line;
        require!(line.drawn == 0, NotchError::BalanceOutstanding);
        let amount = line.borrower_deposit;
        require!(amount > 0, NotchError::InvalidAmount);
        line.borrower_deposit = 0;
        ctx.accounts.pool.borrower_deposits = ctx.accounts.pool.borrower_deposits.checked_sub(amount).ok_or(NotchError::MathOverflow)?;
        let bump = [ctx.accounts.config.vault_bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.to.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
        }, &[&[b"vault", &bump]]), amount, ctx.accounts.mint.decimals)
    }
}

/// Bytes 56..88 of the record (the email's dedupe hash); a short record yields an empty seed and fails parsing later.
pub fn dedupe_seed(record: &[u8]) -> &[u8] {
    record.get(56..88).unwrap_or(&[])
}

/// Bytes 96..128 of the record (the identity hash); same short-record behaviour as `dedupe_seed`.
pub fn identity_seed(record: &[u8]) -> &[u8] {
    record.get(96..128).unwrap_or(&[])
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub underwriter: Pubkey,
    pub underwriter_expiry: i64,
    pub bump: u8,
    pub vault_bump: u8,
    pub share_mint_bump: u8,
}

/// The bureau entry any Solana app can read: limit, usage and repayment history. No raw data.
#[account]
#[derive(InitSpace)]
pub struct CreditLine {
    pub wallet: Pubkey,
    pub limit: u64,
    pub expiry: i64,
    pub drawn: u64,
    pub due: i64,
    pub repaid_on_time: u32,
    pub repaid_late: u32,
    pub last_nonce: u64,
    pub defaulted: bool,
    pub bump: u8,
    /// First-loss deposit held in the vault for this borrower. Not lender money.
    pub borrower_deposit: u64,
    /// Unix time the current signed record was posted (`post_limit`). Appended last so older readers keep working.
    /// Lines created before this field existed are 8 bytes shorter: they read as 0 here and, because a zero is
    /// never written, they can still be saved. (`check_credit` treats 0 as "posted long ago".)
    #[borsh(deserialize_with = "read_trailing_i64", serialize_with = "write_trailing_i64")]
    pub posted_at: i64,
}

/// Read the last field; a legacy account that ends before it reads as 0.
fn read_trailing_i64<R: std::io::Read>(reader: &mut R) -> std::io::Result<i64> {
    let mut b = [0u8; 8];
    let mut n = 0;
    while n < 8 {
        match reader.read(&mut b[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(if n == 8 { i64::from_le_bytes(b) } else { 0 })
}

/// Write the last field only when it is non-zero. New accounts are zero-filled, so skipping a zero is the same
/// bytes, and it keeps a legacy (shorter) account from overflowing its buffer when the line is saved.
fn write_trailing_i64<W: std::io::Write>(v: &i64, writer: &mut W) -> std::io::Result<()> {
    if *v != 0 {
        writer.write_all(&v.to_le_bytes())?;
    }
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct PoolStats {
    pub total_lent: u64,
    pub outstanding: u64,
    pub defaults: u64,
    pub default_amount: u64,
    pub fees_earned: u64,
    /// Sum of borrower first-loss deposits sitting in the vault. Never counted as lender assets.
    pub borrower_deposits: u64,
    /// Lender-owned cash in the vault (deposits + fees + seized deposits - draws - withdrawals).
    /// Tracked, not read from the vault, so stray token donations to the vault are ignored.
    pub idle: u64,
    pub bump: u8,
}

/// Net asset value backing the shares: idle lender cash plus principal out on loan.
fn pool_assets(pool: &PoolStats) -> Result<u64> {
    pool.idle.checked_add(pool.outstanding).ok_or(error!(NotchError::InvalidPoolState))
}

/// A lender's pending exit. PDA ["withdraw", lender]; the shares sit in the token account
/// ["escrow", lender] (owned by itself) until claimed or cancelled.
#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub lender: Pubkey,
    pub shares: u64,
    pub unlock_ts: i64,
    pub bump: u8,
    pub escrow_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Dedupe {
    pub used_at: i64,
}

/// Sybil binding. PDA ["identity", id_hash]: the one wallet a mobile-money account (hashed, never the
/// raw number) is allowed to back. Created by `post_limit`; never reassigned.
#[account]
#[derive(InitSpace)]
pub struct IdentityLink {
    pub wallet: Pubkey,
    pub bump: u8,
}

/// Coarse bucket for available credit, in base units of the 6-decimal USDC mint:
/// 0 = under 25, 1 = 25 to under 100, 2 = 100 to under 500, 3 = 500 or more.
pub fn available_bucket(available: u64) -> u8 {
    const USDC: u64 = 1_000_000;
    match available {
        a if a < 25 * USDC => 0,
        a if a < 100 * USDC => 1,
        a if a < 500 * USDC => 2,
        _ => 3,
    }
}

/// What `check_credit` returns (as return data) and logs. Deliberately coarse.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CreditCheck {
    pub wallet: Pubkey,
    pub available_bucket: u8,
    pub on_time_repayments: u32,
    pub defaulted: bool,
}

#[event]
pub struct CreditChecked {
    pub wallet: Pubkey,
    pub available_bucket: u8,
    pub on_time_repayments: u32,
    pub defaulted: bool,
}

/// Read-only. `line` is unchecked on purpose: a wallet with no line has no account, and that must
/// surface as `NoCreditLine`, not as a generic Anchor deserialization error.
#[derive(Accounts)]
pub struct CheckCredit<'info> {
    /// CHECK: only its address is used, to derive the line PDA.
    pub borrower: UncheckedAccount<'info>,
    /// CHECK: PDA ["line", borrower]; owner and contents are checked in the handler.
    #[account(seeds = [b"line", borrower.key().as_ref()], bump)]
    pub line: UncheckedAccount<'info>,
}

#[event]
pub struct LimitPosted {
    pub wallet: Pubkey,
    pub limit: u64,
    pub expiry: i64,
    pub nonce: u64,
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, seeds = [b"vault"], bump, token::mint = mint, token::authority = vault, token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [b"pool"], bump, space = 8 + PoolStats::INIT_SPACE)]
    pub pool: Account<'info, PoolStats>,
    #[account(init, payer = admin, seeds = [b"share-mint"], bump, mint::decimals = mint.decimals, mint::authority = share_mint, token::token_program = token_program)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(record: Vec<u8>)]
pub struct PostLimit<'info> {
    /// Anyone may relay the signed record and pay rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only used as the line owner; must equal the wallet inside the signed record.
    pub borrower: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = payer, space = 8 + CreditLine::INIT_SPACE, seeds = [b"line", borrower.key().as_ref()], bump)]
    pub line: Account<'info, CreditLine>,
    /// `init` fails if this email was already used.
    #[account(init, payer = payer, space = 8 + Dedupe::INIT_SPACE, seeds = [b"dedupe", dedupe_seed(&record)], bump)]
    pub dedupe: Account<'info, Dedupe>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// Trailing and optional (pass this program's own id as the "None" placeholder): required only when the record carries a
    /// non-zero id_hash. Created on first use; a different wallet presenting the same id_hash fails.
    #[account(init_if_needed, payer = payer, space = 8 + IdentityLink::INIT_SPACE, seeds = [b"identity", identity_seed(&record)], bump)]
    pub identity: Option<Account<'info, IdentityLink>>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub lender: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = lender)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)] pub pool: Account<'info, PoolStats>,
    #[account(mut, seeds = [b"share-mint"], bump = config.share_mint_bump)] pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = share_mint, token::authority = lender)] pub share_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Draw<'info> {
    pub borrower: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"line", borrower.key().as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = borrower)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)] pub pool: Account<'info, PoolStats>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    pub borrower: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"line", borrower.key().as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = borrower)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)] pub pool: Account<'info, PoolStats>,
    #[account(mut, dup, token::mint = mint, token::authority = borrower)] pub deposit_return: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct MarkDefault<'info> {
    #[account(mut, seeds = [b"line", line.wallet.as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)] pub pool: Account<'info, PoolStats>,
}

#[derive(Accounts)]
pub struct BorrowerDeposit<'info> {
    pub borrower: Signer<'info>, #[account(seeds=[b"config"], bump=config.bump, has_one=mint)] pub config: Account<'info,Config>,
    #[account(mut,seeds=[b"line",borrower.key().as_ref()],bump=line.bump)] pub line: Account<'info,CreditLine>,
    pub mint: InterfaceAccount<'info,Mint>, #[account(mut,token::mint=mint,token::authority=borrower)] pub from: InterfaceAccount<'info,TokenAccount>,
    #[account(mut,seeds=[b"vault"],bump=config.vault_bump)] pub vault: InterfaceAccount<'info,TokenAccount>,
    #[account(mut,seeds=[b"pool"],bump=pool.bump)] pub pool: Account<'info,PoolStats>, pub token_program: Interface<'info,TokenInterface>,
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    /// Pays rent for the request and escrow accounts (refunded when they close).
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"share-mint"], bump = config.share_mint_bump)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = share_mint, token::authority = lender)]
    pub share_account: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = lender, seeds = [b"escrow", lender.key().as_ref()], bump, token::mint = share_mint, token::authority = escrow, token::token_program = token_program)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = lender, space = 8 + WithdrawRequest::INIT_SPACE, seeds = [b"withdraw", lender.key().as_ref()], bump)]
    pub request: Account<'info, WithdrawRequest>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimWithdraw<'info> {
    /// Only the request's owner (the PDA is derived from this key, and `has_one` double-checks).
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)]
    pub pool: Account<'info, PoolStats>,
    #[account(mut, seeds = [b"share-mint"], bump = config.share_mint_bump)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"escrow", lender.key().as_ref()], bump = request.escrow_bump, token::mint = share_mint)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, close = lender, seeds = [b"withdraw", lender.key().as_ref()], bump = request.bump, has_one = lender)]
    pub request: Account<'info, WithdrawRequest>,
    #[account(mut, token::mint = mint, token::authority = lender)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelWithdraw<'info> {
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"share-mint"], bump = config.share_mint_bump)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = share_mint, token::authority = lender)]
    pub share_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", lender.key().as_ref()], bump = request.escrow_bump, token::mint = share_mint)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, close = lender, seeds = [b"withdraw", lender.key().as_ref()], bump = request.bump, has_one = lender)]
    pub request: Account<'info, WithdrawRequest>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawBorrower<'info> {
    pub borrower: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"line", borrower.key().as_ref()], bump = line.bump)]
    pub line: Account<'info, CreditLine>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = borrower)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"pool"], bump = pool.bump)]
    pub pool: Account<'info, PoolStats>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum NotchError {
    #[msg("Record bytes are malformed")]
    BadRecord,
    #[msg("Ed25519 instruction is malformed")]
    BadSigIx,
    #[msg("Previous instruction must be an Ed25519 verify")]
    MissingSigIx,
    #[msg("Record was not signed by the current underwriter")]
    WrongUnderwriter,
    #[msg("Signed message does not match the record")]
    RecordMismatch,
    #[msg("Record is for a different wallet")]
    WrongWallet,
    #[msg("Record has expired")]
    RecordExpired,
    #[msg("Record is stale: an older nonce than the last one, or posted longer ago than max_age_s")]
    StaleRecord,
    #[msg("Underwriter attestation has expired")]
    UnderwriterExpired,
    #[msg("Amount exceeds credit limit")]
    OverLimit,
    #[msg("Credit line has defaulted")]
    Defaulted,
    #[msg("Line is not past due")]
    NotPastDue,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("There is no outstanding balance to repay")]
    NothingToRepay,
    #[msg("Borrower deposit must cover 20 percent of the draw")]
    InsufficientDeposit,
    #[msg("Repayment must include the 2 percent fee")]
    FeeRequired,
    #[msg("Pool has insufficient idle liquidity")]
    InsufficientLiquidity,
    #[msg("Pool accounting is invalid")]
    InvalidPoolState,
    #[msg("Cannot withdraw the deposit while a balance is outstanding")]
    BalanceOutstanding,
    #[msg("Checked arithmetic overflow")]
    MathOverflow,
    #[msg("Withdrawal cooldown has not elapsed yet")]
    CooldownActive,
    #[msg("This identity is already linked to a different wallet")]
    IdentityBound,
    #[msg("Record carries an identity but the identity account was not provided")]
    IdentityRequired,
    #[msg("No credit line exists for this wallet")]
    NoCreditLine,
    #[msg("Available credit is below the amount asked for")]
    InsufficientCredit,
}

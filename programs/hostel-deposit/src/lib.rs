//! Example consumer of the Notch bureau: a hostel that takes a booking only if Notch says the student
//! is good for at least the rent. It exists to prove that any program can plug into the bureau with one CPI.
use anchor_lang::prelude::*;
use notch::cpi::accounts::CheckCredit;

declare_id!("78e2fCurHQuKe4WfHAWM2kqkqj91zRauPER2TM9w6e13");

/// The hostel only trusts a credit record posted within this window.
pub const MAX_RECORD_AGE_S: i64 = 30 * 86_400;

#[program]
pub mod hostel_deposit {
    use super::*;

    /// Book a room. Asks Notch (CPI) whether the student can cover `rent` right now; if Notch refuses
    /// (no line, defaulted, expired, stale, too little available) this whole instruction fails and no booking is made.
    pub fn book(ctx: Context<Book>, rent: u64) -> Result<()> {
        require!(rent > 0, HostelError::InvalidRent);
        let check = notch::cpi::check_credit(
            CpiContext::new(
                ctx.accounts.notch_program.key(),
                CheckCredit {
                    borrower: ctx.accounts.student.to_account_info(),
                    line: ctx.accounts.line.to_account_info(),
                },
            ),
            rent,
            MAX_RECORD_AGE_S,
        )?
        .get();
        require_keys_eq!(check.wallet, ctx.accounts.student.key(), HostelError::WrongWallet);
        require!(!check.defaulted, HostelError::WrongWallet);

        let b = &mut ctx.accounts.booking;
        b.student = ctx.accounts.student.key();
        b.rent = rent;
        b.bucket = check.available_bucket;
        b.booked_at = Clock::get()?.unix_timestamp;
        b.bump = ctx.bumps.booking;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Booking {
    pub student: Pubkey,
    pub rent: u64,
    /// Notch's coarse bucket at booking time (0 <25, 1 25-100, 2 100-500, 3 500+ USDC). Never the exact limit.
    pub bucket: u8,
    pub booked_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Book<'info> {
    #[account(mut)]
    pub student: Signer<'info>,
    #[account(init, payer = student, space = 8 + Booking::INIT_SPACE, seeds = [b"booking", student.key().as_ref()], bump)]
    pub booking: Account<'info, Booking>,
    /// CHECK: the student's Notch credit line PDA. May not exist; Notch reports that as NoCreditLine.
    #[account(seeds = [b"line", student.key().as_ref()], bump, seeds::program = notch::ID)]
    pub line: UncheckedAccount<'info>,
    #[account(address = notch::ID)]
    pub notch_program: Program<'info, notch::program::Notch>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum HostelError {
    #[msg("Rent must be greater than zero")]
    InvalidRent,
    #[msg("Notch answered for a different wallet")]
    WrongWallet,
}

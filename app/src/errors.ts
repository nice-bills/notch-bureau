// Turn program, token and RPC failures into plain English. The raw logs stay available
// for anyone who wants to see the real error.

/** Anchor error codes start at 6000 and follow the order of `NotchError` in lib.rs. */
const PROGRAM_ERRORS = [
  'BadRecord', 'BadSigIx', 'MissingSigIx', 'WrongUnderwriter', 'RecordMismatch', 'WrongWallet',
  'RecordExpired', 'StaleRecord', 'UnderwriterExpired', 'OverLimit', 'Defaulted', 'NotPastDue',
  'InvalidAmount', 'NothingToRepay', 'InsufficientDeposit', 'FeeRequired', 'InsufficientLiquidity',
  'InvalidPoolState', 'BalanceOutstanding', 'MathOverflow', 'CooldownActive',
  'IdentityBound', 'IdentityRequired', 'NoCreditLine', 'InsufficientCredit',
  'SubordinationBreached', 'BadTrancheMint', 'InvalidTrancheParams', 'InvalidTerm',
  'DeviceBound', 'DeviceRequired', 'ClaimWindowClosed', 'LoanOverdue', 'WalletIdentityPinned',
  'DepositTooSmall', 'DustSupply', 'NotLegacyRequest',
] as const;
export type ProgramErrorName = (typeof PROGRAM_ERRORS)[number];

export const ERROR_MESSAGES: Record<ProgramErrorName, string> = {
  BadRecord: 'The signed credit record is malformed, so the program refused it.',
  BadSigIx: 'The signature check attached to this transaction is malformed.',
  MissingSigIx: 'The signature check is missing. Credit limits only count with the underwriter’s signature attached.',
  WrongUnderwriter: 'This limit was not signed by the Notch underwriter, so the program refused it.',
  RecordMismatch: 'The record you sent is not the record that was signed. Someone changed it after signing, so it was refused.',
  WrongWallet: 'This limit was issued to a different wallet. A limit only works for the wallet it was made for.',
  RecordExpired: 'Your credit limit has expired. Upload a fresh income email to get a new one.',
  StaleRecord: 'A newer limit for this wallet is already on file, so this older one was refused.',
  UnderwriterExpired: 'The underwriter’s trust window has run out. The admin needs to renew it.',
  OverLimit: 'That is more than your credit limit allows.',
  Defaulted: 'This credit line was closed after a missed payment and cannot be used again.',
  NotPastDue: 'This loan is not past its due date yet.',
  InvalidAmount: 'Enter an amount greater than zero.',
  NothingToRepay: 'You have nothing to repay right now.',
  InsufficientDeposit: 'Your security deposit is too small. It must cover 20% of your total balance after this draw.',
  FeeRequired: 'The repayment is too small. You must pay back everything borrowed plus the 2% fee in one go.',
  InsufficientLiquidity: 'The pool does not have enough idle cash for that right now. Try a smaller amount or come back later.',
  InvalidPoolState: 'The pool’s accounts do not add up. Nothing was changed.',
  BalanceOutstanding: 'You still owe money. Repay in full before taking your deposit back.',
  MathOverflow: 'That amount is too large to process.',
  CooldownActive: 'Your withdrawal is still in its waiting period. You can claim it once the countdown ends.',
  IdentityBound: 'That mobile-money account is already linked to a different wallet. One account can back only one wallet.',
  IdentityRequired: 'This limit is tied to a mobile-money account, but the account link was left out of the transaction.',
  DeviceBound: 'That Seeker phone is already linked to a different wallet. One phone can back only one credit line.',
  DeviceRequired: 'This limit is tied to a Seeker phone, but the phone link was left out of the transaction.',
  NoCreditLine: 'This wallet has no credit line yet.',
  InsufficientCredit: 'The available credit is below the amount asked for.',
  SubordinationBreached: 'The junior tranche would fall below its minimum share of the pool, so this deposit or withdrawal was refused. Senior money needs enough junior money underneath it.',
  BadTrancheMint: 'That is not one of the pool’s two share tokens (senior or junior).',
  InvalidTrancheParams: 'The tranche settings are out of range.',
  InvalidTerm: 'The loan term must be between 10 seconds and 30 days.',
  ClaimWindowClosed: 'The 2-day window to claim this withdrawal has closed. Cancel it to get your shares back, then ask again.',
  LoanOverdue: 'Your loan is past its due date. Pay it back before you borrow again.',
  WalletIdentityPinned: 'This wallet is already tied to a different mobile-money account. One wallet can use only one account.',
  DepositTooSmall: 'The first deposit into an empty pool share must be at least 1 USDC.',
  DustSupply: 'That would leave a tiny amount of shares behind. Withdraw all of it, or leave at least 1 share.',
  NotLegacyRequest: 'This withdrawal request is already up to date. Nothing to change.',
};

export interface FriendlyError {
  /** Program error name when we recognised one. */
  code: ProgramErrorName | 'EmailAlreadyUsed' | 'NotEnoughTokens' | 'NotEnoughSol' | 'AccountMissing' | 'Rejected' | 'Network' | 'Unknown';
  message: string;
  /** Raw logs or error text for the "show the real error" view. */
  raw: string;
}

export class TxError extends Error {
  constructor(public readonly raw: string, public readonly logs: readonly string[] = []) {
    super(raw);
    this.name = 'TxError';
  }
}

const HEX_TO_NAME = new Map<number, ProgramErrorName>(PROGRAM_ERRORS.map((n, i) => [6000 + i, n]));

export function programErrorFromText(text: string): ProgramErrorName | null {
  const named = text.match(/Error Code: (\w+)/);
  if (named && (PROGRAM_ERRORS as readonly string[]).includes(named[1])) return named[1] as ProgramErrorName;
  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const hit = HEX_TO_NAME.get(n);
    if (hit) return hit;
  }
  const dec = text.match(/"Custom":\s*(\d+)|Custom\((\d+)\)|custom: (\d+)/);
  if (dec) {
    const n = Number(dec[1] ?? dec[2] ?? dec[3]);
    const hit = HEX_TO_NAME.get(n);
    if (hit) return hit;
  }
  return null;
}

export function explainError(e: unknown): FriendlyError {
  const raw = e instanceof TxError ? [e.raw, ...e.logs].join('\n') : e instanceof Error ? e.message : String(e);
  // Solana's own client errors are stripped to a code in production builds ("Solana error #…"): keep the code visible.
  const lower = raw.toLowerCase();

  if (/user rejected|rejected the request|declined|cancell?ed/.test(lower) && !/custom program/.test(lower)) {
    return { code: 'Rejected', message: 'You cancelled the request in your wallet. Nothing was sent.', raw };
  }
  const named = programErrorFromText(raw);
  if (named) return { code: named, message: ERROR_MESSAGES[named], raw };

  // The dedupe account is created with `init`, so a second use of the same email fails inside the system program.
  if (/already in use/.test(lower) || /allocate: account/.test(lower)) {
    return {
      code: 'EmailAlreadyUsed',
      message: 'This email has already been used to set a limit. Each email only counts once.',
      raw,
    };
  }
  // SPL Token "insufficient funds" is custom error 0x1.
  if (/insufficient funds/.test(lower) && /token/.test(lower)) {
    return { code: 'NotEnoughTokens', message: 'You do not have enough test USDC in this wallet for that.', raw };
  }
  if (/custom program error: 0x1\b/.test(lower)) {
    return { code: 'NotEnoughTokens', message: 'You do not have enough test USDC in this wallet for that.', raw };
  }
  // A fee payer with no SOL: simulation says InvalidAccountForFee (or the debit/rent variants).
  if (/nosolforfees|invalidaccountforfee|attempt to debit an account but found no record of a prior credit|insufficient lamports|insufficientfundsforfee|insufficientfundsforrent/.test(lower)) {
    return { code: 'NotEnoughSol', message: 'Your wallet has no devnet SOL to pay the network fee. Get free test SOL below, then try again.', raw };
  }
  if (/accountnotfound|account not found/.test(lower)) {
    return { code: 'AccountMissing', message: 'A needed account does not exist yet. If this is a new wallet, it needs some devnet SOL first.', raw };
  }
  if (/failed to fetch|networkerror|load failed|econnrefused/.test(lower)) {
    return { code: 'Network', message: 'Could not reach the server. Check your connection and the configured URLs.', raw };
  }
  return { code: 'Unknown', message: 'Something went wrong. Open “Show the real error” to see exactly what the network said.', raw };
}

/** Enclave refusals (DKIM, duplicate email, no income found) in plain English. */
export function explainEnclaveReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('email already used')) return 'The sealed computer has already used this email. Each email counts once.';
  if (r.includes('no passing dkim') || r.includes('dkim')) {
    return 'The email’s digital signature does not check out. It was edited after the sender signed it, or it did not come from a provider we accept.';
  }
  if (r.includes('untrusted signer')) return 'The email was signed by a sender we do not accept as proof of income.';
  if (r.includes('no income found')) return 'The email is genuine, but the sealed computer found no income payment in it.';
  if (r.includes('email too large')) return 'That file is too large. Export the single email as a plain .eml file.';
  if (r.includes('base58')) return 'The wallet address was not valid.';
  return reason;
}

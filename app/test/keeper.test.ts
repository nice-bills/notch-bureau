// Unit test for the keeper's selection step (no network): which credit lines get mark_default.
import { describe, expect, it } from 'vitest';
import { address, getAddressEncoder } from '@solana/kit';
import { selectOverdue } from '../scripts/keeper.mjs';
import { CREDIT_LINE_MIN_LEN } from '../src/notch';

const enc = getAddressEncoder();
const wallet = address('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');

/** CreditLine bytes in lib.rs order: disc, wallet, limit, expiry, drawn, due, on_time, late, nonce, defaulted, bump, deposit. */
function lineBytes({ drawn = 0n, due = 0n, defaulted = false }: { drawn?: bigint; due?: bigint; defaulted?: boolean }) {
  const d = Buffer.alloc(CREDIT_LINE_MIN_LEN);
  Buffer.from(enc.encode(wallet)).copy(d, 8);
  d.writeBigUInt64LE(50_000_000n, 40);
  d.writeBigInt64LE(2_000_000_000n, 48);
  d.writeBigUInt64LE(drawn, 56);
  d.writeBigInt64LE(due, 64);
  d[88] = defaulted ? 1 : 0;
  return new Uint8Array(d);
}

describe('keeper selectOverdue', () => {
  it('picks only lines with a balance, a due date, now > due, and not yet defaulted', () => {
    const now = 1_000_000n;
    const accounts = [
      { pubkey: 'overdue', data: lineBytes({ drawn: 5_000_000n, due: 999_999n }) },
      { pubkey: 'due-exactly-now', data: lineBytes({ drawn: 5_000_000n, due: 1_000_000n }) }, // program needs now > due
      { pubkey: 'not-due-yet', data: lineBytes({ drawn: 5_000_000n, due: 1_000_001n }) },
      { pubkey: 'no-balance', data: lineBytes({ drawn: 0n, due: 10n }) },
      { pubkey: 'no-due-date', data: lineBytes({ drawn: 5_000_000n, due: 0n }) },
      { pubkey: 'already-defaulted', data: lineBytes({ drawn: 5_000_000n, due: 10n, defaulted: true }) },
      { pubkey: 'garbage', data: new Uint8Array(10) },
    ];
    const picked = selectOverdue(accounts, now);
    expect(picked.map((p: { pubkey: string }) => p.pubkey)).toEqual(['overdue']);
    expect(picked[0].line.drawn).toBe(5_000_000n);
  });
});

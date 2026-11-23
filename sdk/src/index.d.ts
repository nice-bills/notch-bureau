import type { Address, Instruction, Rpc, GetAccountInfoApi } from '@solana/kit';

export declare const NOTCH_PROGRAM_ADDRESS: Address;
export declare const BUCKETS: readonly { bucket: number; label: string; min: bigint }[];
export declare function availableBucket(available: bigint | number): number;
export declare function findCreditLineAddress(wallet: string, programAddress?: Address): Promise<Address>;
export declare function decodeCreditLine(bytes: Uint8Array): {
  wallet: Address; limit: bigint; expiry: bigint; drawn: bigint; due: bigint; repaidOnTime: number; repaidLate: number;
  defaulted: boolean; deposit: bigint; postedAt: bigint;
} | null;

export type Credit =
  | { exists: false }
  | {
      exists: true; wallet: Address; availableBucket: number; availableBucketLabel: string; onTimeRepayments: number;
      defaulted: boolean; expiresAt: number; postedAt: number; expired: boolean; active: boolean;
    };

export declare function getCredit(
  rpc: Rpc<GetAccountInfoApi>,
  wallet: string,
  opts?: { programAddress?: Address; nowSeconds?: number },
): Promise<Credit>;

export declare function buildCheckCreditIx(args: {
  wallet: string; minAvailable: bigint | number; maxAgeSeconds: bigint | number; programAddress?: Address;
}): Promise<Instruction>;

export declare function decodeCreditCheck(bytes: ArrayLike<number>): {
  wallet: Address; availableBucket: number; availableBucketLabel: string | undefined; onTimeRepayments: number; defaulted: boolean;
};

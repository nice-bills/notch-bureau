// Pure helpers for the WalletConnect wallet (kept apart from the lazy WalletConnect bundle so they are unit-testable).
import { getBase58Decoder, getBase58Encoder, getTransactionDecoder, getTransactionEncoder, type Address, type SignatureBytes } from '@solana/kit';

/** Solana devnet as WalletConnect names it (CAIP-2: the first 32 characters of the genesis hash). */
export const WC_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const WC_METHODS = ['solana_signTransaction', 'solana_signMessage'];

export const toB64 = (u: Uint8Array) => btoa(Array.from(u, (b) => String.fromCharCode(b)).join(''));
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b58 = (u: Uint8Array) => getBase58Decoder().decode(u);
export const unb58 = (s: string) => new Uint8Array(getBase58Encoder().encode(s));

/**
 * A wallet answers `solana_signTransaction` with the whole signed transaction (`transaction`, base64) or only the
 * signature (`signature`, base58). Either way, return the wire transaction with `signer`'s signature in its slot.
 */
export function applySignature(wire: Uint8Array, signer: Address, result: { transaction?: string; signature?: string }): Uint8Array {
  if (result.transaction) return fromB64(result.transaction);
  if (!result.signature) throw new Error('The wallet answered without a signature.');
  const sig = unb58(result.signature);
  if (sig.length !== 64) throw new Error('The wallet sent back a signature of the wrong length.');
  const tx = getTransactionDecoder().decode(wire);
  if (!(signer in tx.signatures)) throw new Error('The wallet signed for an account that is not in this transaction.');
  return new Uint8Array(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [signer]: sig as SignatureBytes } }));
}

/** The Solana account a WalletConnect session approved (`solana:<chain>:<address>`), or null. */
export function sessionAddress(accounts: string[] | undefined): string | null {
  const a = accounts?.find((x) => x.startsWith(`${WC_DEVNET}:`)) ?? accounts?.find((x) => x.startsWith('solana:'));
  return a ? a.split(':')[2] ?? null : null;
}

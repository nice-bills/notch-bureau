// The two instructions that put a signed limit on Solana (ed25519 check + post_limit), shared by "Post my limit"
// and the one-approval borrow (post + deposit + draw in a single transaction).
import { address, getAddressEncoder, type Address, type Instruction } from '@solana/kit';
import { recordBytes, signatureBytes, type EnclaveOk } from './enclave';
import { decodeRecord, deriveDedupe, deriveIdentity, deriveLine, hasIdentity, postLimitIxs, type CreditLine, type NotchAddresses } from './notch';

export async function postIxsFor(addrs: NotchAddresses, owner: Address, signed: EnclaveOk, underwriter: string): Promise<Instruction[]> {
  const record = recordBytes(signed);
  const { dedupe: dedupeHash, idHash } = decodeRecord(record);
  const dedupe = await deriveDedupe(addrs.program, dedupeHash);
  const identity = hasIdentity(idHash) ? await deriveIdentity(addrs.program, idHash) : undefined;
  const line = await deriveLine(addrs.program, owner);
  const uw = new Uint8Array(getAddressEncoder().encode(address(underwriter)));
  return postLimitIxs(addrs, { payer: owner, borrower: owner, line, dedupe, record, identity }, uw, signatureBytes(signed));
}

/** A signed limit that is not on chain yet (and not expired), or null. */
export function unposted(signed: EnclaveOk | null, line: CreditLine | null): EnclaveOk | null {
  if (!signed || Number(signed.expiry) <= Date.now() / 1000) return null;
  return line && line.lastNonce >= BigInt(signed.nonce) ? null : signed;
}

/** How the line will look once this signed limit is posted: lets Borrow price a loan before the post lands. */
export function lineAfterPost(signed: EnclaveOk, owner: Address, line: CreditLine | null): CreditLine {
  const r = decodeRecord(recordBytes(signed));
  const base: CreditLine = line ?? { wallet: owner, limit: 0n, expiry: 0n, drawn: 0n, due: 0n, repaidOnTime: 0, repaidLate: 0, lastNonce: 0n, defaulted: false, deposit: 0n };
  return { ...base, limit: r.limitMicro, expiry: r.expiry, lastNonce: r.nonce };
}

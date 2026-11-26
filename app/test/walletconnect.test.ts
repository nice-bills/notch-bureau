// WalletConnect wallet: signature placement, session account parsing, and "no project id, no option".
import { describe, expect, it, vi } from 'vitest';
import {
  address, appendTransactionMessageInstructions, blockhash, compileTransaction, createTransactionMessage, getTransactionDecoder,
  getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { WC_DEVNET, applySignature, b58, sessionAddress, toB64 } from '../src/wc-sign';

const ME = address('8vCHa2FTUp2Xf1Yb1pEhUUyRLrEJCGKdj77CB2uLzBE5');
const wire = () => {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(ME, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 1n }, m),
    (m) => appendTransactionMessageInstructions([], m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(msg)));
};

describe('applySignature', () => {
  it('puts a base58 signature in the signer’s slot', () => {
    const sig = new Uint8Array(64).fill(7);
    const out = applySignature(wire(), ME, { signature: b58(sig) });
    expect(Array.from(getTransactionDecoder().decode(out).signatures[ME]!)).toEqual(Array.from(sig));
  });
  it('takes a whole signed transaction as is', () => {
    const signed = wire();
    signed[1] = 9;
    expect(applySignature(wire(), ME, { transaction: toB64(signed), signature: 'ignored' })).toEqual(signed);
  });
  it('refuses a wrong-length signature, or a signer that is not in the transaction', () => {
    expect(() => applySignature(wire(), ME, { signature: b58(new Uint8Array(10)) })).toThrow(/wrong length/);
    expect(() => applySignature(wire(), address('11111111111111111111111111111111'), { signature: b58(new Uint8Array(64)) })).toThrow(/not in this transaction/);
    expect(() => applySignature(wire(), ME, {})).toThrow(/without a signature/);
  });
});

describe('sessionAddress', () => {
  it('reads the devnet account, then any Solana account', () => {
    expect(sessionAddress([`${WC_DEVNET}:${ME}`])).toBe(ME);
    expect(sessionAddress(['eip155:1:0xabc', `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${ME}`])).toBe(ME);
    expect(sessionAddress(['eip155:1:0xabc'])).toBeNull();
    expect(sessionAddress(undefined)).toBeNull();
  });
});

describe('without VITE_WC_PROJECT_ID', () => {
  it('registers nothing', async () => {
    vi.stubEnv('VITE_WC_PROJECT_ID', '');
    vi.resetModules();
    const { getWallets } = await import('@wallet-standard/app');
    const { registerWalletConnect, wcEnabled, WC_NAME } = await import('../src/walletconnect');
    expect(wcEnabled()).toBe(false);
    registerWalletConnect();
    expect(getWallets().get().some((w) => w.name === WC_NAME)).toBe(false);
  });
});

import { address, type Address } from '@solana/kit';

const env = import.meta.env;

export const RPC_URL: string = env.VITE_RPC_URL || 'https://api.devnet.solana.com';
export const PROGRAM_ID: Address = address(env.VITE_PROGRAM_ID || '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz');
/** Devnet test USDC. Run scripts/devnet-setup.mjs to create one and print this value. */
export const USDC_MINT: Address | null = env.VITE_USDC_MINT ? address(env.VITE_USDC_MINT) : null;
export const ENCLAVE_URL: string = (env.VITE_ENCLAVE_URL || 'http://localhost:8787').replace(/\/$/, '');
export const CLUSTER = 'devnet';
export const CHAIN_ID = 'solana:devnet' as const;

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;

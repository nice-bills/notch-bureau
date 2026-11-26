import { address, type Address } from '@solana/kit';

const env = import.meta.env;

export const RPC_URL: string = env.VITE_RPC_URL || 'https://api.devnet.solana.com';
export const PROGRAM_ID: Address = address(env.VITE_PROGRAM_ID || '4ucSsrca8WS9LxJvoQZdhFscYnZ8DGDKMYcBhmBNPLVz');
/** Devnet test USDC. Run scripts/devnet-setup.mjs to create one and print this value. */
export const USDC_MINT: Address | null = env.VITE_USDC_MINT ? address(env.VITE_USDC_MINT) : null;
export const ENCLAVE_URL: string = (env.VITE_ENCLAVE_URL || 'http://localhost:8787').replace(/\/$/, '');
/** Supabase (public URL + anon key) for the live statement status over Realtime. Off when unset: the app polls the underwriter. */
export const SUPABASE_URL: string = env.VITE_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY: string = env.VITE_SUPABASE_ANON_KEY || '';
export const LIVE_STATUS = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
/** Pollar Google sign-in: the publishable key (client-side by design). VITE_POLLAR=off hides it. */
export const POLLAR_KEY: string = env.VITE_POLLAR_KEY || '';
export const POLLAR_ON = !!POLLAR_KEY && env.VITE_POLLAR !== 'off';
export const CLUSTER = 'devnet';
export const CHAIN_ID = 'solana:devnet' as const;

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const explorerAddress = (a: string) => `https://explorer.solana.com/address/${a}?cluster=${CLUSTER}`;

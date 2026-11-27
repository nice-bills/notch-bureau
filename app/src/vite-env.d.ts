/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_PROGRAM_ID?: string;
  readonly VITE_USDC_MINT?: string;
  readonly VITE_ENCLAVE_URL?: string;
  readonly VITE_FAUCET_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_POLLAR_KEY?: string;
  readonly VITE_POLLAR?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

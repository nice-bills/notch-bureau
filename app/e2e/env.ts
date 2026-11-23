// Shared constants for the browser e2e: paths, the devnet deployment (from app/.env.local), URLs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const e2eDir = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(e2eDir, '..');
export const stateDir = path.join(e2eDir, '.state');
export const screensDir = path.join(e2eDir, 'screens');

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = { ...readEnvFile(path.join(appDir, '.env.local')), ...process.env } as Record<string, string | undefined>;

export const RPC_URL = env.VITE_RPC_URL || 'https://api.devnet.solana.com';
export const PROGRAM_ID = env.VITE_PROGRAM_ID as string;
export const USDC_MINT = env.VITE_USDC_MINT as string;
export const ENCLAVE_URL = (env.VITE_ENCLAVE_URL || 'http://localhost:8787').replace(/\/$/, '');
export const APP_URL = env.E2E_APP_URL || 'http://localhost:5173';
export const ADMIN_KEYPAIR = env.E2E_ADMIN_KEYPAIR || path.join(os.homedir(), '.config/solana/id.json');
export const ENCLAVE_KEY_FILE = env.NOTCH_KEY_FILE || path.resolve(appDir, '..', '.underwriter-key.json');
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// The wallet picker name. Phantom registers itself as "Phantom"; the test wallet uses the same name so the
// picker shows exactly what a real user would see.
export const WALLET_NAME = 'Phantom';

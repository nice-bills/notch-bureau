// Small JSON files under e2e/.state/ so flows can hand results to later flows, and so the teardown can sweep
// every throwaway wallet even when a test crashed (a crashed test restarts its worker and loses module state).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './env.ts';

const runFile = path.join(stateDir, 'run.json');
const walletsFile = path.join(stateDir, 'wallets.json');

function read<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function write(file: string, v: unknown) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 1), { mode: 0o600 });
}

export interface RunState {
  adminSolStart?: string;
  /** Pool totals right before flow 1 (decimal strings). */
  baseline?: Record<string, string>;
  /** What flows 1 and 2 did, for the loan-book check. */
  borrow?: { wallet: string; draw: string; fee: string };
  lend?: { wallet: string; deposit: string; shares: string };
}
export const loadState = (): RunState => read<RunState>(runFile, {});
export const saveState = (patch: Partial<RunState>) => write(runFile, { ...loadState(), ...patch });
export const resetState = () => write(runFile, {});

/** Throwaway wallet secrets (devnet, a few cents), kept only so a crash cannot strand leftover SOL. */
export const loadWallets = (): number[][] => read<number[][]>(walletsFile, []);
export const trackWallet = (secretKey: Uint8Array) => write(walletsFile, [...loadWallets(), Array.from(secretKey)]);
export const clearWallets = () => write(walletsFile, []);

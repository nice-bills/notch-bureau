// The hosted demo needs the program to trust the Phala key; this suite needs it to trust the local demo key. So a run borrows
// the program: record the on-chain underwriter, set_underwriter(local key), and ALWAYS put the recorded key back (global
// teardown, a failed global setup, SIGTERM/SIGHUP). A lock file stops two runs interleaving. It also holds the recorded key,
// so a run that was killed outright is repaired by the next one. While a run is going the hosted demo shows "Key mismatch".
//
//   node e2e/rotation.ts restore     # by hand, after a killed run (from app/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { address } from '@solana/kit';
import { setUnderwriterIx } from '../src/notch.ts';
import { call, chainContext, readUnderwriterConfig, rpc, sendTx, waitFor, type UnderwriterConfig } from './chain.ts';
import { IS_LOCAL, stateDir } from './env.ts';

interface Lock {
  pid: number;
  startedAt: string;
  /** The key this run set. */
  local?: string;
  /** What the program trusted before: put back at the end. */
  previous?: { underwriter: string; expiry: string };
}

const TEMP_TTL_S = 86_400;

async function lockFile(): Promise<string> {
  const { program } = await chainContext();
  // Devnet is shared by every checkout on this machine, so its lock lives outside the repo.
  const dir = IS_LOCAL ? stateDir : path.join(os.homedir(), '.config', 'notch');
  fs.mkdirSync(dir, { recursive: true });
  const genesis = await call(rpc.getGenesisHash());
  return path.join(dir, `underwriter-${genesis.slice(0, 8)}-${program.slice(0, 8)}.lock`);
}

const readLock = (file: string): Lock | null => {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Lock; } catch { throw new Error(`unreadable lock file ${file}: check the on-chain underwriter, then delete it`); }
};
const writeLock = (file: string, lock: Lock, flag: 'w' | 'wx' = 'w') => fs.writeFileSync(file, JSON.stringify(lock), { mode: 0o600, flag });
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};
const iso = (expiry: bigint | string) => new Date(Number(expiry) * 1000).toISOString();

async function setUnderwriter(underwriter: string, expiry: bigint): Promise<string> {
  const { admin, A } = await chainContext();
  const sig = await sendTx(admin, [setUnderwriterIx(A, admin.address, address(underwriter), expiry)]);
  await waitFor('underwriter rotated', readUnderwriterConfig, (c) => c.underwriter === underwriter && c.expiry === expiry);
  return sig;
}

/** Take the lock, remember what the program trusts, and make it trust `local`. */
export async function rotateToLocal(local: string): Promise<void> {
  const file = await lockFile();
  const mine: Lock = { pid: process.pid, startedAt: new Date().toISOString() };
  let stale: Lock | null = null;
  try {
    writeLock(file, mine, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    stale = readLock(file);
    if (stale && alive(stale.pid)) throw new Error(`another e2e run (pid ${stale.pid}, since ${stale.startedAt}) has the program's underwriter. Wait for it, or remove ${file} if that process is not an e2e run.`);
    writeLock(file, { ...stale, ...mine });
  }
  const now: UnderwriterConfig = await readUnderwriterConfig();
  // A killed run left its own key on chain: what IT recorded is still the thing to put back.
  const inherit = stale?.previous && now.underwriter === stale.local ? stale.previous : null;
  if (inherit) console.log(`[e2e] a killed run left ${now.underwriter} on chain; it will be replaced by ${inherit.underwriter} at the end`);
  const previous = inherit ?? { underwriter: now.underwriter, expiry: now.expiry.toString() };
  writeLock(file, { ...mine, local, previous });

  const soon = BigInt(Math.floor(Date.now() / 1000) + 7200);
  if (now.underwriter === local && now.expiry > soon) {
    console.log(`[e2e] rotation: program already trusts the local key ${local}`);
    return;
  }
  const expiry = BigInt(Math.floor(Date.now() / 1000) + TEMP_TTL_S);
  const sig = await setUnderwriter(local, expiry);
  console.log(`[e2e] rotation: underwriter ${now.underwriter} -> ${local} (local, until ${iso(expiry)}) tx ${sig}`);
}

/** Put the recorded key back and drop the lock. Does nothing when this process holds no lock (unless `force`). */
export async function restoreUnderwriter({ force = false } = {}): Promise<void> {
  const file = await lockFile();
  const lock = readLock(file);
  if (!lock) return;
  if (lock.pid !== process.pid && !(force && !alive(lock.pid))) return;
  const { previous, local } = lock;
  if (!previous) { fs.rmSync(file, { force: true }); return; }
  let last: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const now = await readUnderwriterConfig();
      if (now.underwriter === previous.underwriter && now.expiry === BigInt(previous.expiry)) {
        console.log(`[e2e] restore: program trusts ${previous.underwriter} (until ${iso(previous.expiry)})`);
      } else if (now.underwriter !== local && now.underwriter !== previous.underwriter) {
        console.warn(`[e2e] restore skipped: someone else set the underwriter to ${now.underwriter} during the run (recorded ${previous.underwriter})`);
      } else {
        const sig = await setUnderwriter(previous.underwriter, BigInt(previous.expiry));
        console.log(`[e2e] restore: underwriter ${now.underwriter} -> ${previous.underwriter} (until ${iso(previous.expiry)}) tx ${sig}`);
      }
      fs.rmSync(file, { force: true });
      return;
    } catch (e) {
      last = e;
      console.error(`[e2e] restore attempt ${attempt} failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`COULD NOT RESTORE the underwriter ${previous.underwriter}. Run "node e2e/rotation.ts restore" in app/. Lock kept at ${file}. Last error: ${(last as Error)?.message}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'restore') {
  await restoreUnderwriter({ force: true });
}

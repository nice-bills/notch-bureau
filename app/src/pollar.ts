// Pollar: "Continue with Google" makes a Pollar-managed Solana wallet, no seed phrase. Loaded on demand (the SDK is big).
//
// What it can and cannot do today (read from @pollar/core 0.12.0 itself): `signSolanaTransaction` signs only with an
// EXTERNAL wallet the user connected; it throws for a Google (Pollar-managed) wallet, which can only make Pollar's own
// transfers (`sendPayment`). So a Google wallet can sign in, hold its address and receive USDC, but Notch's program calls
// (post a limit, deposit, draw, repay) still need a self-custody wallet. The UI says so in plain words.
import { POLLAR_KEY } from './config';

type PollarClient = import('@pollar/core').PollarClient;
export interface PollarState {
  step: string;
  /** The Solana address of the signed-in user's Pollar wallet, once there is one. */
  solana: string | null;
  email: string | null;
  error: string | null;
}

let clientP: Promise<PollarClient> | null = null;
export function pollarClient(): Promise<PollarClient> {
  return (clientP ??= import('@pollar/core').then(({ PollarClient }) =>
    new PollarClient({ apiKey: POLLAR_KEY, oauthRedirectUri: `${window.location.origin}/auth/callback`, logLevel: 'silent' } as never),
  ));
}

export function readState(c: PollarClient): PollarState {
  const auth = c.getAuthState() as { step: string; message?: string; details?: string };
  const wallets = (c.getWallets?.() ?? []) as { chain?: string; address?: string }[];
  const sol = wallets.find((w) => String(w.chain ?? '').toUpperCase() === 'SOLANA')?.address ?? null;
  const profile = c.getUserProfile?.() as { mail?: string } | null;
  return { step: auth.step, solana: sol, email: profile?.mail ?? null, error: auth.step === 'error' ? auth.message ?? auth.details ?? 'Google sign-in failed.' : null };
}

/** Subscribe to sign-in changes. Returns unsubscribe. */
export async function watchPollar(cb: (s: PollarState) => void): Promise<() => void> {
  const c = await pollarClient();
  await c.ready?.();
  const offA = c.onAuthStateChange(() => cb(readState(c)));
  const offW = (c as unknown as { onWalletStateChange?: (f: () => void) => () => void }).onWalletStateChange?.(() => cb(readState(c))) ?? (() => {});
  cb(readState(c));
  return () => { offA(); offW(); };
}

export async function googleLogin(): Promise<void> {
  const c = await pollarClient();
  c.login({ provider: 'google' } as never);
}
export async function pollarLogout(): Promise<void> {
  const c = await pollarClient();
  await c.logout();
}

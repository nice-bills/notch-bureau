// iPhone + Phantom deeplinks: Phantom always opens its answer (redirect_link) in a NEW Safari tab, so every
// approval used to leave one more Notch tab behind. Neither Phantom's docs nor its SDKs offer a way to return to
// the tab that asked (Dynamic's Phantom redirect provider documents the same "clone tab" and works around it).
//
// What this does, safest first:
//  1. The new tab asks the other Notch tabs (BroadcastChannel) "who is there?". If an older tab answers, the
//     answer is handed to it (it reloads itself with Phantom's reply) and this new tab closes itself. Safari lets a
//     page close a tab that has a single history entry, which a tab opened by another app has.
//  2. If no older tab answers in time (iOS freezes background tabs, or there is none), this tab handles the answer
//     itself, as before, and says the older tab can be closed.
//  3. An older tab that comes back into view after a newer one took over says so, with a one-tap close.
import { isNativeApp } from './native';

const PHANTOM_KEYS = ['phantom', 'phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage'];
const LATEST = 'notch.tab.latest';
const TAKEN = 'notch.tab.taken';
const ch: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('notch-tabs') : null;
const me = Math.random().toString(36).slice(2) + Date.now().toString(36);
const bornAt = Date.now();

type Msg = { t: 'ping'; from: string } | { t: 'pong'; to: string; from: string } | { t: 'take'; to: string; href: string };

ch?.addEventListener('message', (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m?.t === 'ping' && m.from !== me) ch.postMessage({ t: 'pong', to: m.from, from: me } satisfies Msg);
  if (m?.t === 'take' && m.to === me) {
    // Phantom's reply, handed over by the tab it landed in: load it here, exactly as if it had come to this tab.
    // The flag stops the reloaded tab from handing it on again.
    try { sessionStorage.setItem(TAKEN, '1'); } catch { /* private mode */ }
    claimLatest();
    location.replace(m.href);
  }
});

const isPhantomReturn = () => new URL(location.href).searchParams.has('phantom');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set when this tab handled a Phantom answer that landed in a new tab (so an older Notch tab is probably still open). */
export let newTabReturn = false;

/**
 * Call before reading Phantom's answer. Resolves 'handed' when an older tab took the answer (this tab should show
 * only "done, close this tab" if it is still open), or 'here' to handle it in this tab.
 */
export async function handOffPhantomReturn(): Promise<'handed' | 'here'> {
  if (!isPhantomReturn() || isNativeApp) return 'here'; // the Android app has one page: nothing to hand over
  try { if (sessionStorage.getItem(TAKEN)) { sessionStorage.removeItem(TAKEN); return 'here'; } } catch { /* private mode */ }
  const fresh = history.length <= 1; // a tab another app opened: one history entry, and closable by script
  if (!ch || !fresh) { newTabReturn = fresh; if (fresh) claimLatest(); return 'here'; }
  const peer = await new Promise<string | null>((resolve) => {
    const done = (v: string | null) => { clearTimeout(timer); ch.removeEventListener('message', on); resolve(v); };
    const on = (e: MessageEvent<Msg>) => { if (e.data?.t === 'pong' && e.data.to === me) done(e.data.from); };
    const timer = setTimeout(() => done(null), 700);
    ch.addEventListener('message', on);
    ch.postMessage({ t: 'ping', from: me } satisfies Msg);
  });
  if (!peer) { newTabReturn = true; claimLatest(); return 'here'; }
  ch.postMessage({ t: 'take', to: peer, href: location.href } satisfies Msg);
  // Drop the reply from this tab's URL either way: it now belongs to the older tab.
  const u = new URL(location.href);
  for (const k of PHANTOM_KEYS) u.searchParams.delete(k);
  history.replaceState(history.state, '', u.toString());
  window.close();
  await sleep(400);
  return 'handed';
}

/** This tab is now the one in use: older tabs will say so when they come back into view. */
export function claimLatest() {
  try { localStorage.setItem(LATEST, JSON.stringify({ id: me, at: Date.now() })); } catch { /* private mode */ }
}

/** True when a newer Notch tab took over after this one loaded. */
export function supersededByNewerTab(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(LATEST) ?? 'null') as { id: string; at: number } | null;
    return !!v && v.id !== me && v.at > bornAt;
  } catch { return false; }
}

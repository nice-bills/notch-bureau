// The Android app (Capacitor). The same web build runs inside it; everything here is a no-op in a normal browser,
// and the plugins are only downloaded inside the app.

export const isNativeApp = !!(globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

/** The app's own link. Phantom's deeplinks send their answer here (the scheme is declared in AndroidManifest.xml). */
export const RETURN_URL = 'app.notchbureau.mobile://return/';
const PHANTOM_ANSWER = ['phantom', 'phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage'];

/**
 * The page to load for a link that opened the app, or null when it is not Phantom's answer. Any app can send such a link,
 * so only Phantom's own parameters and a plain screen name are carried over (the answer itself is checked by decryption).
 */
export function returnPath(link: string): string | null {
  if (!link.startsWith(RETURN_URL)) return null;
  const from = new URL(link);
  if (!from.searchParams.has('phantom')) return null;
  const q = new URLSearchParams();
  for (const k of PHANTOM_ANSWER) { const v = from.searchParams.get(k); if (v !== null) q.set(k, v); }
  return `/?${q}${/^#[a-z-]*$/.test(from.hash) ? from.hash : ''}`;
}

/** Android Back: close an open sheet, else leave a sub-screen, else put the app in the background (the session stays). */
export async function setupNativeShell(awaitingAnswer: () => boolean) {
  if (!isNativeApp) return;
  document.documentElement.classList.add('native');
  const { App } = await import('@capacitor/app');
  // Mobile Wallet Adapter decides "no wallet answered" unless the window blurs within 3 s of opening one. This WebView never
  // sends that blur when another app covers it (seen on Android 15), so send it when Android pauses the app.
  await App.addListener('pause', () => dispatchEvent(new Event('blur')));
  // Phantom's answer arrives as a link into the app: reload with it, as a browser would. Only while a request is waiting,
  // so the link that started the app is not read twice.
  const open = (link: string) => { const to = returnPath(link); if (to && awaitingAnswer()) location.replace(to); };
  await App.addListener('appUrlOpen', ({ url }) => open(url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) open(launch.url);
  await App.addListener('backButton', () => {
    if (document.querySelector('.sheet')) { dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return; }
    // between onboarding questions: one question back
    if (typeof (history.state as { notchOnb?: number } | null)?.notchOnb === 'number' && (history.state as { notchOnb: number }).notchOnb > 0) { history.back(); return; }
    const route = location.hash.slice(1);
    if (!route || route === 'home' || route === 'lend' || route === 'pool') { void App.minimizeApp(); return; }
    // a sub-screen: back to the tab it was opened from, or Home when it was the first thing shown
    if ((history.state as { notchSub?: string } | null)?.notchSub) history.back();
    else location.hash = 'home';
  });
}

/** Ask once, at a moment that explains itself (the inbox address was just made: a limit will arrive). */
export async function askToNotify() {
  if (!isNativeApp) return;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    if ((await LocalNotifications.checkPermissions()).display === 'prompt') await LocalNotifications.requestPermissions();
  } catch { /* notifications are an extra: never break the flow */ }
}

const NOTIFIED = 'notch.notified';

/** "Your limit landed", once per inbox. */
export async function notifyLimit(inbox: string, amount: string) {
  if (!isNativeApp) return;
  try {
    if (localStorage.getItem(NOTIFIED) === inbox) return;
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
    localStorage.setItem(NOTIFIED, inbox);
    await LocalNotifications.schedule({ notifications: [{ id: 1, title: 'Your limit landed', body: `${amount} USDC to borrow. Devnet test money.` }] });
  } catch { /* an extra */ }
}

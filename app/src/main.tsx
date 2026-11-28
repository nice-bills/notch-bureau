import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import './desktop.css';
import { App } from './App';
import { WalletProvider } from './wallet';
import { CHAIN_ID } from './config';
import { isAndroid, isIOS, isIOSOtherBrowser } from './device';
import { isNativeApp, setupNativeShell } from './native';
import { awaitingPhantom, consumePhantomRedirect, linkedAddress, registerPhantomLink } from './phantom-link';
import { registerWalletConnect } from './walletconnect';
import { handOffPhantomReturn } from './tabs';
import { Btn } from './ui';

void boot();

async function boot() {
// Phantom's answer arrives in the URL, in a NEW Safari tab. Hand it to the older Notch tab if one answers (this tab
// then closes itself), otherwise read it here, before React renders.
if ((await handOffPhantomReturn()) === 'handed') { showHanded(); return; }
consumePhantomRedirect();
void setupNativeShell(awaitingPhantom);

if (isAndroid) {
  // Android Chrome: Solana Mobile Wallet Adapter. It registers as a Wallet Standard wallet, so the normal sign-in sheet
  // lists it, and tapping it opens the wallet app on the phone (Phantom, Solflare, Seed Vault on Seeker).
  // The Android app too: its user agent carries "Solana Mobile Web Shell" (capacitor.config.json), which is how the
  // library knows this WebView can open wallet apps.
  const mwa = import('@solana-mobile/wallet-standard-mobile').then(({ registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler }) =>
    registerMwa({
      appIdentity: { name: 'Notch', uri: location.origin, icon: 'notch.svg' },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: [CHAIN_ID],
      chainSelector: createDefaultChainSelector(),
      // The library's own dialog says "browser not supported" in a WebView: the sign-in sheet says what to do instead.
      onWalletNotFound: isNativeApp ? async () => {} : createDefaultWalletNotFoundHandler(),
    }),
  ).catch(() => { /* MWA unavailable: the sheet still offers "open in the wallet's browser" */ });
  // The Android app has no "open in the wallet's browser", so Phantom deeplinks are its fallback. Added after Mobile Wallet
  // Adapter so that one stays first in the list.
  if (isNativeApp) void mwa.then(registerPhantomLink);
}
if (isIOS) {
  // iPhone outside a wallet's browser: Phantom deeplinks. Inside Phantom's browser Phantom injects itself, so wait a moment
  // and only add the deeplink wallet when no built-in Phantom showed up (or when a deeplink session already exists).
  setTimeout(() => {
    const injected = (window as unknown as { phantom?: { solana?: unknown } }).phantom?.solana;
    // Not in Chrome/Firefox on iOS: Phantom would send its answer to Safari, where this tab's session does not exist.
    if ((!injected && !isIOSOtherBrowser) || linkedAddress()) registerPhantomLink();
  }, linkedAddress() ? 0 : 350);
}

// WalletConnect: a list of wallet apps (iPhone Safari, desktop QR). Only with VITE_WC_PROJECT_ID; its code loads on tap.
registerWalletConnect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>,
);
}

/** This tab handed Phantom's answer to the older Notch tab but Safari kept it open: say where to go. */
function showHanded() {
  createRoot(document.getElementById('root')!).render(
    <div className="app no-tabs">
      <div className="card pcard empty" style={{ marginTop: 48 }} role="status" data-testid="handed">
        <b>Done. Notch carries on in your other tab.</b>
        <p>Phantom opened this extra tab. You can close it.</p>
        <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          <Btn onClick={() => window.close()}>Close this tab</Btn>
          <button type="button" className="textlink" onClick={() => location.reload()}>Keep using this tab</button>
        </div>
      </div>
    </div>,
  );
}

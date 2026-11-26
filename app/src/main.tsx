import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import { App } from './App';
import { WalletProvider } from './wallet';
import { CHAIN_ID } from './config';
import { isAndroid, isIOS } from './device';
import { consumePhantomRedirect, linkedAddress, registerPhantomLink } from './phantom-link';

// Phantom's answer to a deeplink request arrives in the URL: read it before React renders.
consumePhantomRedirect();

if (isAndroid) {
  // Android Chrome: Solana Mobile Wallet Adapter. It registers as a Wallet Standard wallet, so the normal sign-in sheet
  // lists it, and tapping it opens the wallet app on the phone (Phantom, Solflare, Seed Vault on Seeker).
  void import('@solana-mobile/wallet-standard-mobile').then(({ registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler }) =>
    registerMwa({
      appIdentity: { name: 'Notch', uri: location.origin, icon: 'notch.svg' },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: [CHAIN_ID],
      chainSelector: createDefaultChainSelector(),
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    }),
  ).catch(() => { /* MWA unavailable: the sheet still offers "open in the wallet's browser" */ });
}
if (isIOS) {
  // iPhone outside a wallet's browser: Phantom deeplinks. Inside Phantom's browser Phantom injects itself, so wait a moment
  // and only add the deeplink wallet when no built-in Phantom showed up (or when a deeplink session already exists).
  setTimeout(() => {
    const injected = (window as unknown as { phantom?: { solana?: unknown } }).phantom?.solana;
    if (!injected || linkedAddress()) registerPhantomLink();
  }, linkedAddress() ? 0 : 350);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </StrictMode>,
);

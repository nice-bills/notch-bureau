// WalletConnect session (lazy chunk: loaded only when "Other wallet apps" is tapped, or to sign with a WC session).
// Reown AppKit core draws the wallet list; the bare UniversalProvider holds the session (no @solana/web3.js).
import UniversalProvider from '@walletconnect/universal-provider';
import { createAppKit } from '@reown/appkit/core';
import { solanaDevnet } from '@reown/appkit/networks';
import { WC_PROJECT_ID } from './config';
import { WC_DEVNET, WC_METHODS, applySignature, b58, sessionAddress, toB64, unb58 } from './wc-sign';
import type { Address } from '@solana/kit';

const metadata = () => ({
  name: 'Notch',
  description: 'Borrow against your income, without showing it.',
  url: location.origin,
  icons: [`${location.origin}/notch.svg`],
  // where the wallet sends the user back after approving
  redirect: { universal: location.origin + location.pathname },
});

let ready: Promise<{ provider: InstanceType<typeof UniversalProvider>; modal: ReturnType<typeof createAppKit> }> | null = null;
function boot() {
  ready ??= (async () => {
    const provider = await UniversalProvider.init({ projectId: WC_PROJECT_ID, metadata: metadata() });
    const modal = createAppKit({
      projectId: WC_PROJECT_ID,
      networks: [solanaDevnet] as never, // viem type versions differ between packages; the value is AppKit's own
      universalProvider: provider as never,
      manualWCControl: true,
      metadata: metadata(),
      themeMode: 'light',
      // Phone wallets with a Solana WalletConnect link, first (WalletConnect directory ids): Trust, Backpack, Exodus, OKX.
      // Phantom and Solflare list no mobile WalletConnect link, so on iPhone Phantom uses its own deeplink button.
      featuredWalletIds: [
        '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
        '2bd8c14e035c2d48f184aaa168559e86b0e3433228d3c4075900a221785019b0',
        'e9ff15be73584489ca4a66f64d32c4537711797e30b6660dbcb71ea72a42b1f4',
        '971e689d0a5be527bac79629b4ee9b925e82208e5168b733496a09c0faed0709',
      ],
      features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false, send: false },
    });
    return { provider, modal };
  })();
  return ready;
}

/** The address of a live session restored from storage, or null. */
export async function restore(): Promise<string | null> {
  const { provider } = await boot();
  return sessionAddress(provider.session?.namespaces.solana?.accounts);
}

/** Show the wallet list; resolves with the approved address, rejects if the user closes the list. */
export async function connect(): Promise<string> {
  const { provider, modal } = await boot();
  const live = sessionAddress(provider.session?.namespaces.solana?.accounts);
  if (live) return live;
  let off = () => {};
  const closed = new Promise<never>((_, reject) => {
    let opened = false;
    off = modal.subscribeState((s) => {
      if (s.open) opened = true;
      else if (opened) reject(new Error('You closed the wallet list. Nothing was connected.'));
    });
  });
  try {
    await modal.open();
    const session = await Promise.race([
      provider.connect({ optionalNamespaces: { solana: { methods: WC_METHODS, chains: [WC_DEVNET], events: [] } } }),
      closed,
    ]);
    const address = sessionAddress(session?.namespaces.solana?.accounts);
    if (!address) throw new Error('The wallet did not share a Solana devnet account.');
    return address;
  } finally {
    off();
    void modal.close();
  }
}

export async function disconnect(): Promise<void> {
  const { provider } = await boot();
  try { await provider.disconnect(); } catch { /* already gone */ }
}

/** On a phone the wallet app must come to the front to show the request: open it by its own link. */
function bringWalletForward(provider: InstanceType<typeof UniversalProvider>) {
  const r = provider.session?.peer.metadata.redirect;
  const link = r?.native || r?.universal;
  if (link && /iphone|ipad|android/i.test(navigator.userAgent)) {
    try { location.href = link; } catch { /* the user can switch apps by hand */ }
  }
}

async function request<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { provider } = await boot();
  if (!provider.session) throw new Error('The WalletConnect session ended. Connect your wallet again.');
  const out = provider.request<T>({ method, params }, WC_DEVNET);
  bringWalletForward(provider);
  return out;
}

export async function signTransaction(wire: Uint8Array, signer: Address): Promise<Uint8Array> {
  const res = await request<{ transaction?: string; signature?: string }>('solana_signTransaction', { transaction: toB64(wire) });
  return applySignature(wire, signer, res);
}

export async function signMessage(message: Uint8Array, signer: string): Promise<Uint8Array> {
  const res = await request<{ signature: string }>('solana_signMessage', { message: b58(message), pubkey: signer });
  return unb58(res.signature);
}

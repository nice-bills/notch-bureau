import { Component, Suspense, createContext, lazy, startTransition, useCallback, useContext, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { ChainProvider, savedPrint, useChain } from './data';
import { useWallet } from './wallet';
import { getAttestation, type Attestation } from './enclave';
import { ENCLAVE_URL, POLLAR_ON, PROGRAM_ID, explorerAddress, explorerTx } from './config';
import { shortAddr } from './amount';
import { FX_DEFS } from './art';
import { startLight, watchLenses } from './glass';
import { Btn, GoogleMark, Icon, Sheet, cx } from './ui';
import { googleLogin, pollarLogout, watchPollar, type PollarState } from './pollar';
import { submitSigned } from './chain';
import { explainError } from './errors';
import { PHANTOM_LINK_NAME, linkedAddress, takeError, takeSignedTransaction } from './phantom-link';
import { WC_NAME } from './walletconnect';
import { browseLinks, isIOSOtherBrowser, isPhone } from './device';
import { FaucetButton } from './Faucet';
import { claimLatest, newTabReturn, supersededByNewerTab } from './tabs';
// The everyday screens are in the main bundle: switching tabs must never wait for a download (on a phone through a
// tunnel that showed as a blank screen). Only the "Try to cheat it" lab (and its crypto library) loads on demand.
import { Home } from './Home';
import { GetLimit } from './GetLimit';
import { Borrow } from './Borrow';
import { Lend } from './Lend';
import { Pool } from './Pool';
const loadAttacks = () => import('./Attacks');
const Attacks = lazy(() => loadAttacks().then((m) => ({ default: m.Attacks })));
function ScreenSkel() {
  return (
    <div className="boot" aria-busy="true" aria-label="Loading">
      <span className="skel" style={{ display: 'block', width: '40%', height: 14 }} />
      <span className="skel" style={{ display: 'block', width: '70%', height: 32, marginTop: 10 }} />
      <span className="skel" style={{ display: 'block', width: '100%', height: 160, marginTop: 24, borderRadius: 28 }} />
    </div>
  );
}

/** A screen that throws shows a plain message with a way out, never a blank page. */
class ScreenGuard extends Component<{ children: ReactNode; onHome: () => void }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: ErrorInfo) { console.error('screen crashed', err, info.componentStack); }
  render() {
    const { err } = this.state;
    if (!err) return this.props.children;
    const chunk = /dynamically imported module|importing a module script|loading chunk|failed to fetch/i.test(err.message);
    return (
      <div className="card pcard crash" role="alert">
        <h2 style={{ margin: 0, fontSize: 20 }}>{chunk ? 'This screen did not download' : 'This screen hit a problem'}</h2>
        <p className="help">{chunk ? 'The connection dropped while loading it. Your wallet and data are fine.' : 'Your wallet and your money are fine. Go back and try again.'}</p>
        <div className="row-btns" style={{ marginTop: 12 }}>
          <Btn variant="secondary" onClick={() => { this.setState({ err: null }); this.props.onHome(); }}>Go home</Btn>
          <Btn onClick={() => location.reload()}>Reload</Btn>
        </div>
        <details className="real-error"><summary>Show the real error</summary><pre>{err.message}</pre></details>
      </div>
    );
  }
}

export type Route = 'home' | 'limit' | 'borrow' | 'lend' | 'pool' | 'cheat';
const ROUTES: Route[] = ['home', 'limit', 'borrow', 'lend', 'pool', 'cheat'];
const TABS: { id: Route; label: string; icon: 'home' | 'lend' | 'pool' }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'lend', label: 'Lend', icon: 'lend' },
  { id: 'pool', label: 'Pool', icon: 'pool' },
];
const fromHash = (): Route => {
  const h = window.location.hash.replace('#', '') as Route;
  return ROUTES.includes(h) ? h : 'home';
};

// ---- app-wide UI state: route, the sign-in sheet, the account sheet, the sealed computer, Pollar ----------------------
interface Ui {
  route: Route;
  go: (r: Route) => void;
  openSignIn: () => void;
  openAccount: () => void;
  att: Attestation | null | 'down';
  pollar: PollarState | null;
}
const UiCtx = createContext<Ui | null>(null);
export const useUi = () => {
  const v = useContext(UiCtx);
  if (!v) throw new Error('useUi outside <App>');
  return v;
};

export function App() {
  if (window.location.pathname.replace(/\/$/, '') === '/auth/callback') return <AuthCallback />;
  return (
    <ChainProvider>
      <Shell />
    </ChainProvider>
  );
}

/** Pollar's Google sign-in returns here in its popup. The opener notices the new session on its own. */
function AuthCallback() {
  useEffect(() => { const t = setTimeout(() => { try { window.close(); } catch { /* not a popup */ } }, 1200); return () => clearTimeout(t); }, []);
  return (
    <main className="callback">
      <h1 style={{ fontWeight: 650, letterSpacing: '-.03em' }}>Signed in</h1>
      <p className="help">You can close this window and go back to Notch.</p>
      <p><a href="/">Back to Notch</a></p>
    </main>
  );
}

function Shell() {
  const [route, setRoute] = useState<Route>(fromHash);
  const [sheet, setSheet] = useState<'signin' | 'account' | null>(null);
  const [att, setAtt] = useState<Attestation | null | 'down'>(null);
  const [pollar, setPollar] = useState<PollarState | null>(null);

  useEffect(() => {
    const on = () => setRoute(fromHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => startLight(), []);
  useEffect(() => watchLenses(), []);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [route]);

  const loadAtt = useCallback(() => {
    const ctl = new AbortController();
    setAtt(null);
    getAttestation(ctl.signal).then(setAtt).catch(() => !ctl.signal.aborted && setAtt('down'));
    return () => ctl.abort();
  }, []);
  useEffect(() => loadAtt(), [loadAtt]);

  // Pollar: restore a Google session if one exists (the SDK is only loaded when there may be one, or on click).
  useEffect(() => {
    if (!POLLAR_ON) return;
    let off: (() => void) | undefined;
    let dead = false;
    const hasSession = (() => { try { return Object.keys(localStorage).some((k) => k.toLowerCase().includes('pollar')); } catch { return false; } })();
    if (hasSession) watchPollar((s) => !dead && setPollar(s)).then((u) => { off = u; if (dead) u(); }, () => {});
    return () => { dead = true; off?.(); };
  }, []);

  const go = useCallback((r: Route) => {
    // Tab to tab replaces the history entry (Back leaves the app instead of walking through every tab); opening a
    // sub-screen (limit, borrow, the lab) pushes one, so Back returns to where you were.
    const isTab = (x: Route) => TABS.some((t) => t.id === x);
    const here = fromHash();
    const st = history.state as { notchSub?: Route } | null;
    if (window.location.hash !== `#${r}`) {
      if (!isTab(here) && st?.notchSub === r) {
        // leaving a sub-screen for the tab it was opened from: step back, so Back never lands on an old form
        history.back();
      } else if (isTab(r)) {
        history.replaceState(null, '', `#${r}`);
      } else if (isTab(here)) {
        // a sub-screen remembers the tab it was opened from
        history.pushState({ notchSub: here }, '', `#${r}`);
      } else {
        // sub-screen to sub-screen (limit -> borrow): same entry, same origin tab
        history.replaceState({ notchSub: st?.notchSub ?? 'home' }, '', `#${r}`);
      }
    }
    // The old screen stays painted until the new one is ready: no blank frame between them.
    startTransition(() => setRoute(r));
  }, []);
  const ui = useMemo<Ui>(() => ({ route, go, openSignIn: () => setSheet('signin'), openAccount: () => setSheet('account'), att, pollar }), [route, go, att, pollar]);
  const { connected, restoring } = useWallet();
  // No tab bar on the welcome screen (it covered "Get started"); everywhere else it floats over a bottom inset.
  const welcome = route === 'home' && !connected && !restoring;
  const tabbed = TABS.some((t) => t.id === route) && !welcome;

  return (
    <UiCtx.Provider value={ui}>
      <svg id="fx" width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true"><defs dangerouslySetInnerHTML={{ __html: FX_DEFS }} /></svg>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      <div className={cx('app', !tabbed && 'no-tabs')}>
        <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
          <PhantomReturn />
          <TabNotes />
          <ScreenGuard key={route} onHome={() => go('home')}>
            <div className="screen-in">
              {route === 'home' && <Home />}
              {route === 'limit' && <GetLimit />}
              {route === 'borrow' && <Borrow />}
              {route === 'lend' && <Lend />}
              {route === 'pool' && <Pool />}
              {route === 'cheat' && <Suspense fallback={<ScreenSkel />}><Attacks /></Suspense>}
            </div>
          </ScreenGuard>
        </main>
        <footer className="help" style={{ textAlign: 'center', padding: '32px 24px 0', fontSize: 12 }}>
          Solana devnet only. Test money, no real funds. Program <a className="mono" translate="no" href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer">{shortAddr(PROGRAM_ID, 5)}</a>
        </footer>
      </div>
      {tabbed && <TabBar route={route} go={go} />}
      {sheet === 'signin' && <SignInSheet onClose={() => setSheet(null)} pollar={pollar} setPollar={setPollar} />}
      {sheet === 'account' && <AccountSheet onClose={() => setSheet(null)} att={att} retryAtt={loadAtt} pollar={pollar} setPollar={setPollar} />}
    </UiCtx.Provider>
  );
}

// Read once per page load (React may run a state initializer twice in development).
let phantomErr: string | null | undefined;
const returnError = () => (phantomErr === undefined ? (phantomErr = takeError()) : phantomErr);

/** Back from the Phantom app with a signed transaction: send it, and say what happened. */
function PhantomReturn() {
  const { settle } = useChain();
  const [state, setState] = useState<{ tone: 'info' | 'good' | 'bad'; text: string; sig?: string } | null>(() => {
    const e = returnError();
    return e ? { tone: 'bad', text: e } : null;
  });
  useEffect(() => {
    const t = takeSignedTransaction();
    if (!t) return;
    const before = savedPrint(linkedAddress());
    setState({ tone: 'info', text: 'Phantom signed it. Sending to Solana…' });
    submitSigned(t.signed, t.lastValidBlockHeight)
      .then(({ signature }) => {
        setState({ tone: 'info', text: 'Done: your transaction is on Solana. Updating your numbers…', sig: signature });
        // re-read until the chain shows it (the RPC node can lag a moment behind the confirmation)
        void settle(before).then(() => setState({ tone: 'good', text: 'Done: your transaction is on Solana.', sig: signature }));
      })
      .catch((e) => setState({ tone: 'bad', text: explainError(e).message }));
  }, [settle]);
  // a success note floats for a few seconds; a problem stays until it is closed
  useEffect(() => {
    if (state?.tone !== 'good') return;
    const t = setTimeout(() => setState(null), 8000);
    return () => clearTimeout(t);
  }, [state]);
  if (!state) return null;
  return (
    <div className={cx('action-status return-banner', state.tone === 'good' && 'good', state.tone === 'bad' && 'bad')} role={state.tone === 'bad' ? 'alert' : 'status'}>
      <p>{state.text}{state.sig && <> <a href={explorerTx(state.sig)} target="_blank" rel="noreferrer">View on Solana Explorer</a></>}</p>
      <button type="button" className="x tap" aria-label="Close" onClick={() => setState(null)}><Icon name="x" /></button>
    </div>
  );
}

/** Phantom opens its answer in a new Safari tab (see tabs.ts): say which tab is current, and offer to close the other. */
function TabNotes() {
  const [hint, setHint] = useState(newTabReturn);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') setStale(supersededByNewerTab()); };
    document.addEventListener('visibilitychange', check);
    addEventListener('focus', check);
    addEventListener('pageshow', check);
    return () => { document.removeEventListener('visibilitychange', check); removeEventListener('focus', check); removeEventListener('pageshow', check); };
  }, []);
  useEffect(() => { if (!hint) return; const t = setTimeout(() => setHint(false), 12_000); return () => clearTimeout(t); }, [hint]);
  if (stale) return (
    <div className="tab-note stale" role="alert" data-testid="stale-tab">
      <p><b>Notch moved to a newer tab.</b> Phantom opened it. This one is out of date.</p>
      <div className="row">
        <Btn small onClick={() => { window.close(); }}>Close this tab</Btn>
        <Btn small variant="secondary" onClick={() => { claimLatest(); location.reload(); }}>Use this tab</Btn>
      </div>
    </div>
  );
  if (hint) return (
    <div className="tab-note" role="status" data-testid="tab-hint">
      <p>Phantom opened this in a new tab. You can close the older Notch tab.</p>
      <button type="button" className="x tap" aria-label="Close" onClick={() => setHint(false)}><Icon name="x" /></button>
    </div>
  );
  return null;
}

function TabBar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const [pressed, setPressed] = useState<number | null>(null);
  useEffect(() => setPressed(null), [route]);
  // The pill moves on press, before the next screen has rendered: the tap answers at once.
  const i = pressed ?? TABS.findIndex((t) => t.id === route);
  const [mini, setMini] = useState(false);
  useEffect(() => {
    let last = scrollY;
    const on = () => { setMini(scrollY > 48 && scrollY > last); last = scrollY; };
    addEventListener('scroll', on, { passive: true });
    return () => removeEventListener('scroll', on);
  }, []);
  return (
    <nav className={cx('tabs glass lens', mini && 'mini')} aria-label="Sections" onPointerDown={() => setMini(false)} onPointerCancel={() => setPressed(null)}>
      <span className="lensel" style={{ transform: `translateX(${Math.max(0, i) * 100}%)` }} aria-hidden="true" />
      {TABS.map((t) => (
        <a key={t.id} href={`#${t.id}`} aria-current={route === t.id ? 'page' : undefined} className="tap"
          onPointerDown={(e) => { if (e.button === 0) setPressed(TABS.indexOf(t)); }}
          onClick={(e) => { e.preventDefault(); go(t.id); }}>
          <Icon name={t.icon} />
          {t.label}
        </a>
      ))}
    </nav>
  );
}

/** Top-of-screen problems, in plain words: sealed computer down, wrong key, Solana unreachable, not set up. */
export function Banners() {
  const { pool, poolLoaded, error, configured, refresh } = useChain();
  const { att } = useUi();
  const mismatch = att && att !== 'down' && pool?.underwriter && pool.underwriter !== att.underwriter;
  return (
    <>
      {!configured && <Banner tone="warn" title="Not pointed at a Notch deployment">Set VITE_USDC_MINT (see .env.example) and restart. <code>pnpm setup:devnet</code> prints it.</Banner>}
      {configured && poolLoaded && !pool && <Banner tone="warn" title="No pool on this network yet">Run <code>pnpm setup:devnet</code> once, then reload.</Banner>}
      {error && <Banner tone="warn" title="Can’t reach Solana right now" action={{ label: 'Retry', on: () => void refresh() }}>Numbers may be out of date. We keep trying every few seconds.</Banner>}
      {att === 'down' && <Banner tone="warn" title="The sealed computer is not answering">Nothing new can be checked until it is back. Expected at {ENCLAVE_URL}.</Banner>}
      {mismatch && <Banner tone="bad" title="Key mismatch">Solana trusts a different sealed computer than the one running, so new limits will be refused. Re-run the setup script with this key.</Banner>}
    </>
  );
}
function Banner({ tone, title, children, action }: { tone: 'warn' | 'bad' | 'info'; title: string; children: ReactNode; action?: { label: string; on: () => void } }) {
  return (
    <div className={cx('banner', tone)} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={tone === 'info' ? 'info' : 'warn'} />
      <div><strong>{title}.</strong> {children}</div>
      {action && <button type="button" onClick={action.on}>{action.label}</button>}
    </div>
  );
}

function SignInSheet({ onClose, pollar, setPollar }: { onClose: () => void; pollar: PollarState | null; setPollar: (s: PollarState) => void }) {
  const { wallets, connect, connecting, cancelConnect } = useWallet();
  // Closing the sheet drops a pending connect, so no spinner is left for next time.
  useEffect(() => () => cancelConnect(), [cancelConnect]);
  const [err, setErr] = useState<string | null>(null);
  const [gBusy, setGBusy] = useState(false);
  const onGoogle = async () => {
    setErr(null);
    setGBusy(true);
    try {
      await watchPollar(setPollar);
      await googleLogin();
    } catch (e) {
      setErr(`Google sign-in could not start: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGBusy(false);
    }
  };
  const gStep = pollar?.step;
  const gWorking = gBusy || (!!gStep && !['idle', 'authenticated', 'error'].includes(gStep));
  return (
    <Sheet title="Sign in to start" onClose={onClose}>
      <p className="sh-p">Your wallet holds your limit. Notch never asks for your seed phrase.</p>
      <div role="menu" aria-label="Wallets">
        {wallets.map((w) => {
          const [title, sub] = walletLabel(w.name);
          return (
            <button key={w.name} type="button" role="menuitem" className="opt tap" aria-busy={connecting === w.name || undefined}
              onClick={() => { setErr(null); connect(w).then(onClose).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }}>
              <span className="badge"><img src={w.icon} alt="" width={28} height={28} /></span>
              <span className="t"><b>{title}</b><small>{sub}</small></span>
              {connecting === w.name ? <span className="spinner chev" aria-hidden="true" /> : <span className="chev"><Icon name="chev" /></span>}
            </button>
          );
        })}
        {wallets.length === 0 && !isPhone && (
          <a className="opt tap" href="https://phantom.com/download" target="_blank" rel="noreferrer">
            <span className="badge"><Icon name="wallet" /></span>
            <span className="t"><b>No wallet in this browser</b><small>Install Phantom, Backpack or Solflare, set it to devnet, then reload.</small></span>
          </a>
        )}
      </div>
      {isIOSOtherBrowser && (
        <p className="note-ios" role="note">On iPhone the Phantom app answers in Safari. Open this page in Safari to use it, or use “Open in Phantom’s browser” below.</p>
      )}
      {/* one obvious choice above; the other ways one tap away (on a small phone the full list needed scrolling) */}
      <details className="more" open={!wallets.length || undefined}>
        <summary>More ways to connect</summary>
      {isPhone && (
          <div className="stack" style={{ marginTop: 4 }} aria-label="Open in a wallet app">
            <p className="help" style={{ margin: '4px 0 0' }}>Open Notch inside a wallet app’s own browser:</p>
            {browseLinks().map((l) => (
              <a key={l.name} className="opt-link tap" href={l.href}>
                <Icon name="out" />
                <span>Open in {l.name}’s browser<small>Notch runs inside the {l.name} app</small></span>
              </a>
            ))}
          </div>
        )}
      {POLLAR_ON ? (
          <button type="button" className="opt tap" onClick={() => void onGoogle()} disabled={gWorking || pollar?.step === 'authenticated'}>
            <span className="badge"><GoogleMark /></span>
            <span className="t">
              <b>{pollar?.step === 'authenticated' ? 'Signed in with Google' : 'Continue with Google'}</b>
              <small>{pollar?.step === 'authenticated' ? `Pollar wallet ${pollar.solana ? shortAddr(pollar.solana) : 'is being made…'}` : 'A wallet made for you by Pollar. No seed phrase.'}</small>
            </span>
            {gWorking ? <span className="spinner chev" aria-hidden="true" /> : <span className="chev"><Icon name="chev" /></span>}
          </button>
        ) : (
          <button type="button" className="opt" disabled aria-describedby="google-off">
            <span className="badge"><GoogleMark /></span>
            <span className="t"><b>Continue with Google</b><small id="google-off">Not switched on for this app yet (needs a Pollar key).</small></span>
          </button>
        )}
      </details>
      {(err || pollar?.error) && <p className="field-hint err" role="alert">{err || pollar?.error}</p>}
      {pollar?.step === 'authenticated' && (
        <p className="help">Google wallets can sign in and hold USDC today. Posting a limit, borrowing and lending still need a self-custody wallet: Pollar does not sign other programs’ transactions yet.</p>
      )}
    </Sheet>
  );
}

/** Plain names for the wallets a phone browser shows. */
function walletLabel(name: string): [string, string] {
  if (name === 'Mobile Wallet Adapter') return ['Wallet app on this phone', 'Phantom, Solflare or Seed Vault opens to approve'];
  if (name === PHANTOM_LINK_NAME) return ['Phantom app', 'Opens Phantom to approve, then comes back here'];
  if (name === WC_NAME) return isPhone ? ['Other wallet apps', 'Pick yours from a list. It opens to approve; then come back here.'] : ['WalletConnect', 'Scan a QR code with a wallet on your phone'];
  return [name, 'Self-custody wallet on devnet'];
}

function AccountSheet({ onClose, att, retryAtt, pollar, setPollar }: { onClose: () => void; att: Attestation | null | 'down'; retryAtt: () => void; pollar: PollarState | null; setPollar: (s: PollarState | null) => void }) {
  const { connected, disconnect } = useWallet();
  const { usdc, sol } = useChain();
  const [copied, setCopied] = useState(false);
  return (
    <Sheet title={connected ? 'Your wallet' : 'Account'} onClose={onClose}>
      {connected && (
        <p className="sh-p">
          {connected.wallet.name} · <span className="mono" translate="no">{shortAddr(connected.address, 6)}</span>{' '}
          <button type="button" className="tap" style={{ color: 'var(--ultra)', fontWeight: 600 }} onClick={() => { void navigator.clipboard?.writeText(connected.address).then(() => setCopied(true), () => {}); }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </p>
      )}
      <div className="facts">
        {connected && (
          <div className="fact"><Icon name="wallet" /><span><b>{(Number(usdc) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} test USDC</b><small>{sol === null ? 'Reading SOL…' : `${(Number(sol) / 1e9).toFixed(4)} devnet SOL for fees`}</small></span></div>
        )}
        <div className="fact">
          <Icon name="lock" />
          <span>
            <b>Sealed computer</b>
            <small>
              {att === null ? 'Checking…' : att === 'down' ? <>Not answering at {ENCLAVE_URL}. <button type="button" onClick={retryAtt} style={{ textDecoration: 'underline' }}>Try again</button></> : (
                <>{att.mode === 'local-dev' ? 'Local prototype, not yet in secure hardware' : att.mode} · key <span className="mono" translate="no">{shortAddr(att.underwriter, 5)}</span></>
              )}
            </small>
          </span>
        </div>
        {pollar?.step === 'authenticated' && (
          <div className="fact"><GoogleMark /><span><b>Google, via Pollar</b><small>{pollar.email ?? 'Signed in'}{pollar.solana ? <> · wallet <span className="mono" translate="no">{shortAddr(pollar.solana)}</span></> : ''}</small></span></div>
        )}
      </div>
      {connected && <div style={{ margin: '4px 0 12px' }}><FaucetButton /></div>}
      {connected && <Btn variant="secondary" onClick={() => { void disconnect(); onClose(); }}><Icon name="out" />Disconnect wallet</Btn>}
      {pollar?.step === 'authenticated' && <Btn variant="ghost" onClick={() => { void pollarLogout().then(() => setPollar(null)); }}>Sign out of Google</Btn>}
    </Sheet>
  );
}

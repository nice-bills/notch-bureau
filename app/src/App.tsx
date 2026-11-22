import { useEffect, useState } from 'react';
import { ChainProvider, useChain } from './data';
import { WalletButton } from './ConnectPrompt';
import { Borrow } from './Borrow';
import { Lend } from './Lend';
import { Book } from './Book';
import { Attacks } from './Attacks';
import { getAttestation, type Attestation } from './enclave';
import { ENCLAVE_URL, PROGRAM_ID, explorerAddress } from './config';
import { shortAddr } from './amount';
import { Notice, cx } from './ui';

const TABS = [
  { id: 'borrow', label: 'Borrow' },
  { id: 'lend', label: 'Lend' },
  { id: 'book', label: 'Loan book' },
  { id: 'attack', label: 'Try to cheat it' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const fromHash = (): TabId => {
  const h = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === h)?.id ?? 'borrow') as TabId;
};

export function App() {
  return (
    <ChainProvider>
      <Shell />
    </ChainProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<TabId>(fromHash);
  useEffect(() => {
    const on = () => setTab(fromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (t: TabId) => {
    window.location.hash = t;
    setTab(t);
  };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="top-row">
          <a className="brand" href="#borrow" onClick={() => go('borrow')} aria-label="Notch Bureau home">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">Notch <em>Bureau</em></span>
          </a>
          <WalletButton />
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className={cx('tab', tab === t.id && 'is-on')} aria-current={tab === t.id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(t.id); }}>
              {t.label}
            </a>
          ))}
        </nav>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        <StatusBar />
        {tab === 'borrow' && <Borrow />}
        {tab === 'lend' && <Lend />}
        {tab === 'book' && <Book />}
        {tab === 'attack' && <Attacks />}
      </main>
      <footer className="foot">
        <p>Solana devnet only. Test money, no real funds. Program <a className="mono" href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noreferrer">{shortAddr(PROGRAM_ID, 5)}</a>.</p>
      </footer>
    </>
  );
}

function StatusBar() {
  const { pool, error } = useChain();
  const [att, setAtt] = useState<Attestation | null | 'down'>(null);
  useEffect(() => {
    const ctl = new AbortController();
    getAttestation(ctl.signal).then(setAtt).catch(() => !ctl.signal.aborted && setAtt('down'));
    return () => ctl.abort();
  }, []);
  const mismatch = att && att !== 'down' && pool?.underwriter && pool.underwriter !== att.underwriter;
  return (
    <div className="status" aria-label="System status">
      {att === 'down' ? (
        <Notice tone="warn" title="The sealed computer is not reachable">Nothing can be underwritten until it is. Expected at {ENCLAVE_URL}.</Notice>
      ) : att ? (
        <p className="status-line">
          <span className={cx('dot', att.mode === 'local-dev' && 'dot-warn')} aria-hidden="true" />
          Sealed computer: <strong>{att.mode === 'local-dev' ? 'local prototype, not yet in secure hardware' : att.mode}</strong>
          <span className="mono" title={att.underwriter}>{shortAddr(att.underwriter, 5)}</span>
        </p>
      ) : null}
      {mismatch && <Notice tone="bad" title="Key mismatch">The program trusts a different underwriter key than the running sealed computer, so new limits will be refused. Re-run the setup script with this key.</Notice>}
      {error && <Notice tone="warn" title="Could not read Solana">{error}</Notice>}
    </div>
  );
}

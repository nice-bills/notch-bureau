import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { address, getAddressEncoder } from '@solana/kit';
import { ENCLAVE_URL, LIVE_STATUS } from './config';
import { MIN_FEE_LAMPORTS, sendTransaction } from './chain';
import { FaucetButton } from './Faucet';
import { PHANTOM_LINK_NAME, takeSignedMessage, returnedWith } from './phantom-link';
import { useChain } from './data';
import { useWallet } from './wallet';
import { demoDeliver, newInbox, pollRecord, recordBytes, reportPosted, signatureBytes, underwrite, type EnclaveOk, type InboxAddress } from './enclave';
import { signInWithSolana, watchJobs, type JobRow } from './live';
import { decodeRecord, deriveDedupe, deriveIdentity, deriveLine, hasIdentity, postLimitIxs } from './notch';
import { formatDate, formatUsdc } from './amount';
import { rosette, stamp } from './art';
import { buzz } from './glass';
import { ActionStatus, Btn, Icon, Notice, cx, useAction } from './ui';
import { Banners, useUi } from './App';
import { Ticket } from './Ticket';

const SAMPLES = [
  { file: '/samples/deel.eml', label: 'Deel payout' },
  { file: '/samples/bank.eml', label: 'Bank statement' },
];

const store = {
  key: (w: string) => `notch.inbox.${w}`,
  get(w: string): InboxAddress | null {
    try { const v = sessionStorage.getItem(this.key(w)); return v ? (JSON.parse(v) as InboxAddress) : null; } catch { return null; }
  },
  set(w: string, v: InboxAddress | null) {
    try { if (v) sessionStorage.setItem(this.key(w), JSON.stringify(v)); else sessionStorage.removeItem(this.key(w)); } catch { /* private mode: keep it in memory only */ }
  },
};

type Live = 'idle' | 'received' | 'checking' | 'done' | 'refused';

export function GetLimit() {
  const { connected, signMessage, signTransaction } = useWallet();
  const { addrs, line, refresh, session, sol } = useChain();
  const { go, openSignIn, att } = useUi();
  const owner = connected?.address ?? null;
  const signed = session.signed;
  const posted = !!(signed && line && line.lastNonce >= BigInt(signed.nonce));
  // back from the Phantom app with the post signed: show the result, not the long form with the next step far below
  const [landed, setLanded] = useState(() => returnedWith === 'tx');
  const fromInbox = useRef(false);

  const postAct = useAction(async () => { await refresh(); });
  const uwKey = att && att !== 'down' ? att.underwriter : null;

  const onPost = () =>
    postAct.run(async () => {
      if (!owner || !addrs || !signed) throw new Error('Missing wallet or limit.');
      if (!uwKey) throw new Error('Could not read the sealed computer’s public key. Is it running?');
      const record = recordBytes(signed);
      const { dedupe: dedupeHash, idHash } = decodeRecord(record);
      const dedupe = await deriveDedupe(addrs.program, dedupeHash);
      const identity = hasIdentity(idHash) ? await deriveIdentity(addrs.program, idHash) : undefined;
      const lineAddr = await deriveLine(addrs.program, owner);
      const ixs = postLimitIxs(addrs, { payer: owner, borrower: owner, line: lineAddr, dedupe, record, identity }, addressBytes(uwKey), signatureBytes(signed));
      const { signature } = await sendTransaction(owner, ixs, signTransaction);
      if (fromInbox.current) void reportPosted(signature);
      setLanded(true);
      buzz(28);
      return { signature, note: 'Your limit is now on Solana.' };
    });

  if (!owner) {
    return (
      <div>
        <Nav title="Get your limit" onBack={() => go('home')} />
        <div className="card pcard empty">
          <div className="ico"><Icon name="wallet" /></div>
          <b>Connect a wallet first</b>
          <p>Your limit is made for one wallet, so we need to know which one.</p>
          <div style={{ marginTop: 16 }}><Btn onClick={openSignIn}>Connect wallet</Btn></div>
        </div>
      </div>
    );
  }

  if (landed && posted && signed) return <Landed signed={signed} onDone={() => go('home')} postAct={postAct} />;

  return (
    <div>
      <Nav title="Get your limit" onBack={() => go('home')} />
      <Banners />
      {signed ? (
        <section aria-labelledby="sig-h">
          <div className="h">
            <h1 id="sig-h">{posted ? 'Your limit is on Solana' : 'Your limit came back'}</h1>
            <p>{posted ? `Good until ${line ? formatDate(line.expiry) : ''}. You can borrow now.` : 'Only this signed limit left the sealed computer. Put it on Solana to start borrowing.'}</p>
          </div>
          <div className="pad">
            <Ticket result={signed} wallet={owner} />
            <details className="raw">
              <summary>Show the raw reply</summary>
              <pre>{JSON.stringify(signed, null, 2)}</pre>
            </details>
          </div>
          <div className="actions">
            {posted ? (
              <Btn onClick={() => go('home')}>Start borrowing</Btn>
            ) : (
              <Btn onClick={onPost} busy={postAct.busy} disabled={!uwKey}>Post my limit</Btn>
            )}
            {!uwKey && !posted && <p className="help warn">Waiting for the sealed computer’s public key…</p>}
            {!posted && sol !== null && sol < MIN_FEE_LAMPORTS && !postAct.error && (
              <div className="notice notice-warn" role="status"><strong>Posting needs a little devnet SOL</strong><span>Your wallet has none yet. It pays the network fee and the small deposit Solana keeps for a new account.</span><div style={{ marginTop: 8 }}><FaucetButton /></div></div>
            )}
            <ActionStatus a={postAct} />
            {!posted && <Btn variant="ghost" onClick={() => { session.setSigned(null); postAct.reset(); }}>Start over with another statement</Btn>}
          </div>
        </section>
      ) : (
        <>
          <Inbox wallet={owner} signMessage={signMessage} onResult={(r) => { fromInbox.current = true; session.setSigned(r); }} localDemo={att !== null && att !== 'down' && att.mode === 'local-dev'} />
          <Upload wallet={owner} signMessage={signMessage} onResult={(r) => { fromInbox.current = false; session.setSigned(r); }} />
        </>
      )}
    </div>
  );
}

function Nav({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="nav">
      <button type="button" className="circ glass lens tap" onClick={onBack} aria-label="Back"><Icon name="back" /></button>
      <span className="ttl">{title}</span>
      <span style={{ width: 48 }} />
    </div>
  );
}
export { Nav };

function Inbox({ wallet, signMessage, onResult, localDemo }: { wallet: string; signMessage: (m: Uint8Array) => Promise<Uint8Array>; onResult: (r: EnclaveOk) => void; localDemo: boolean }) {
  const { connected } = useWallet();
  const [inbox, setInbox] = useState<InboxAddress | null>(() => store.get(wallet));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Live>('idle');
  const [refusal, setRefusal] = useState<{ friendly: string; locked: boolean } | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoErr, setDemoErr] = useState<string | null>(null);

  useEffect(() => { setInbox(store.get(wallet)); }, [wallet]);

  // Back from the Phantom app with the inbox request signed: finish asking for the address.
  useEffect(() => {
    const prefix = `notch-inbox-v1|${wallet}|`;
    const done = takeSignedMessage((m) => m.startsWith(prefix));
    if (!done) return;
    setBusy(true);
    newInbox(wallet, { signed: { ts: Number(done.message.slice(prefix.length)), signature: done.signature } })
      .then((ib) => { store.set(wallet, ib); setInbox(ib); setLive('idle'); setRefusal(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [wallet]);

  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      let proof: Parameters<typeof newInbox>[1] = { signMessage };
      // Sign in with Solana (for live status) needs a second signature; skip it for the Phantom deeplink wallet, where
      // every signature is a trip to the Phantom app and back. The poll below still shows the status.
      if (LIVE_STATUS && connected?.wallet.name !== PHANTOM_LINK_NAME) {
        try { proof = { bearer: await signInWithSolana(wallet, signMessage) }; } catch { /* fall back to the wallet signature */ }
      }
      const ib = await newInbox(wallet, proof);
      store.set(wallet, ib);
      setInbox(ib);
      setLive('idle');
      setRefusal(null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(/reject|declin|cancel/i.test(m) ? 'You cancelled the signature in your wallet. Nothing was sent.' : m);
    } finally {
      setBusy(false);
    }
  };

  // Poll the sealed computer for the result (the source of the signed record).
  const done = useRef(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  useEffect(() => {
    if (!inbox) return;
    done.current = false;
    const ctl = new AbortController();
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await pollRecord(wallet, inbox.pollToken, ctl.signal);
        setPollErr(null);
        if (r.status === 'ready') { done.current = true; setLive('done'); buzz(22); onResultRef.current(r.result); return; }
        if (r.status === 'refused' || r.status === 'locked') { setLive('refused'); setRefusal({ friendly: r.friendly, locked: r.status === 'locked' }); }
      } catch (e) {
        if (ctl.signal.aborted) return;
        const m = e instanceof Error ? e.message : String(e);
        if (/no longer known/.test(m)) { store.set(wallet, null); setInbox(null); setErr(m); return; }
        setPollErr(m);
      }
      t = setTimeout(tick, 2500);
    };
    void tick();
    return () => { ctl.abort(); clearTimeout(t); };
  }, [inbox, wallet]);

  // Live steps over Supabase Realtime, when configured.
  useEffect(() => {
    if (!inbox || !LIVE_STATUS) return;
    const code = inbox.address.split('@')[0];
    return watchJobs(wallet, code, (r: JobRow) => {
      if (done.current) return;
      setLive(r.status === 'received' ? 'received' : r.status === 'checking' ? 'checking' : r.status === 'refused' ? 'refused' : 'done');
    }, setLiveNote);
  }, [inbox, wallet]);

  const sendDemo = async () => {
    if (!inbox) return;
    setDemoBusy(true);
    setDemoErr(null);
    setRefusal(null);
    setLive('received');
    try {
      setLive('checking');
      await demoDeliver(inbox.address);
    } catch (e) {
      setLive('idle');
      setDemoErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDemoBusy(false);
    }
  };

  if (!inbox) {
    return (
      <section aria-labelledby="ib-h">
        <div className="h">
          <h1 id="ib-h">Your own inbox</h1>
          <p>Your mobile money provider emails your statement to an address made for this wallet. MTN MoMo is one example.</p>
        </div>
        <div className="env pcard" aria-hidden="true">
          <div className="row1"><div style={{ minWidth: 0 }}><div className="to">To</div><code>••••••••••@inbox</code></div><div className="slot"><Icon name="lock" /></div></div>
          <div className="foot2"><small>Works once. Only a real signed email gets in.</small></div>
        </div>
        <div className="actions">
          <Btn onClick={() => void ask()} busy={busy}>Get my inbox address</Btn>
          <p className="help">Your wallet signs a short message to prove the address is yours. It costs nothing.</p>
          {err && <Notice tone="bad" title="No address yet">{err}</Notice>}
        </div>
      </section>
    );
  }

  const steps: { k: Live[]; title: string; sub: string }[] = [
    { k: ['received', 'checking', 'done'], title: 'Statement received', sub: 'The sender’s signature is checked' },
    { k: ['done'], title: 'Read in the sealed computer', sub: 'Nobody can look inside, not even us' },
    { k: ['done'], title: 'Limit signed', sub: 'Then the statement is deleted' },
  ];
  const liveIdx = live === 'idle' ? 0 : live === 'received' ? 1 : live === 'checking' ? 1 : 3;
  return (
    <section aria-labelledby="ib-h">
      <div className="h">
        <h1 id="ib-h">{live === 'idle' ? 'Waiting for your statement' : live === 'refused' ? 'The statement was refused' : live === 'done' ? 'Your stamp is ready' : 'Checking your statement'}</h1>
        <p>Have your mobile money provider email your statement to this address.</p>
      </div>
      <div className="env pcard">
        <div className="row1">
          <div style={{ minWidth: 0 }}><div className="to">To</div><code data-testid="inbox-address" translate="no">{inbox.address.split('@')[0]}@<wbr />{inbox.address.split('@').slice(1).join('@')}</code></div>
          <div className="slot" aria-hidden="true"><Icon name="lock" /></div>
        </div>
        <div className="foot2">
          <small>Works once. Expires {formatDate(Date.parse(inbox.expiresAt) / 1000)}.</small>
          <Btn variant="secondary" small onClick={() => { void navigator.clipboard?.writeText(inbox.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {}); }}>
            <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
      </div>
      {!inbox.domainConfigured && (
        <div className="pad"><Notice tone="info" title="Demo address">Real mail can’t reach this address yet (no mail domain is set up). Use “Send a sample statement” below to try the whole path.</Notice></div>
      )}
      <ol className="steps3">
        <li><span className="n">1</span><span>In <b>your money app</b>, open Statements</span></li>
        <li><span className="n">2</span><span>Pick <b>the last 3 months</b></span></li>
        <li><span className="n">3</span><span>Paste the address and <b>send</b></span></li>
      </ol>
      <ul className="log pcard" aria-live="polite" aria-label="Statement status">
        {steps.map((s, i) => {
          const state = live === 'refused' ? (i === 0 ? 'bad' : 'wait') : i < liveIdx ? 'done' : i === liveIdx && live !== 'idle' ? 'live' : i === 0 && live === 'idle' ? 'live' : 'wait';
          return (
            <li key={s.title} className={state}>
              <span className="ck">{state === 'bad' ? <Icon name="x" /> : <Icon name="check" />}</span>
              <span><b>{i === 0 && live === 'idle' ? 'Waiting for the email' : s.title}</b><small>{i === 0 && live === 'idle' ? 'The sender’s signature is checked when it lands' : s.sub}</small></span>
            </li>
          );
        })}
      </ul>
      <div className="pad">
        {refusal && (
          <Notice tone="bad" title="The sealed computer said no">
            {refusal.friendly} {refusal.locked ? '' : 'You can send another statement to the same address.'}
          </Notice>
        )}
        {pollErr && <Notice tone="warn" title="Can’t reach the sealed computer">{pollErr}</Notice>}
        {liveNote && <p className="help">{liveNote}</p>}
      </div>
      <div className="actions">
        {(localDemo || !inbox.domainConfigured) && (
          <Btn variant="secondary" onClick={() => void sendDemo()} busy={demoBusy} disabled={live === 'done'}>
            <Icon name="mail" />Send a sample statement (demo)
          </Btn>
        )}
        {demoErr && <Notice tone="bad" title="The sample was not sent">{demoErr}</Notice>}
        {(refusal?.locked || live === 'refused') && <Btn variant="ghost" onClick={() => { store.set(wallet, null); setInbox(null); setLive('idle'); setRefusal(null); }}>Get a new address</Btn>}
      </div>
    </section>
  );
}

function Upload({ wallet, signMessage, onResult }: { wallet: string; signMessage: (m: Uint8Array) => Promise<Uint8Array>; onResult: (r: EnclaveOk) => void }) {
  const [eml, setEml] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const loadSample = useCallback(async (path: string, label: string) => {
    setErr(null);
    try {
      const r = await fetch(`${ENCLAVE_URL}${path}`);
      const text = await r.text();
      if (r.status === 429) throw new Error(JSON.parse(text).reason);
      if (!r.ok || !/DKIM-Signature/i.test(text)) throw new Error(`The ${label} sample is not available. Start the demo underwriter with "pnpm demo:enclave".`);
      setEml({ name: path.split('/').pop()!, bytes: new TextEncoder().encode(text) });
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : `The ${label} sample is not available.`);
    }
  }, []);

  const send = async () => {
    if (!eml) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await underwrite(eml.bytes, wallet, signMessage);
      if (!res.ok) setErr(res.friendly);
      else onResult(res);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(/reject|declin|cancel/i.test(m) ? 'You cancelled the signature in your wallet. Nothing was sent.' : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="up-h">
      <div className="or" role="separator">or</div>
      <div className="card pcard">
        <h2 id="up-h">Upload a payout email</h2>
        <p className="sub">Paid by Deel, Wise, Payoneer, Superteam Earn or a supported bank? Download that one email as an <code>.eml</code> file and send it. Statements from mobile money only count through your inbox.</p>
        <input ref={file} type="file" accept=".eml,message/rfc822" hidden aria-label="Choose an .eml file"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setErr(null); setEml({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); } }} />
        <div className="chips">
          <button type="button" className="chip tap" onClick={() => file.current?.click()}><Icon name="file" />{eml ? 'Choose another file' : 'Choose a file'}</button>
          {SAMPLES.map((s) => <button key={s.file} type="button" className={cx('chip tap', eml?.name === s.file.split('/').pop() && 'on')} onClick={() => void loadSample(s.file, s.label)}>{s.label} sample</button>)}
        </div>
        {eml && <p className="help">Ready: <span className="file-name">{eml.name}</span></p>}
        <div style={{ marginTop: 16 }}>
          <Btn variant="secondary" onClick={() => void send()} busy={busy} disabled={!eml}>Send to the sealed computer</Btn>
        </div>
        {err && <Notice tone="bad" title="The sealed computer said no">{err}</Notice>}
      </div>
    </section>
  );
}

function Landed({ signed, onDone, postAct }: { signed: EnclaveOk; onDone: () => void; postAct: ReturnType<typeof useAction> }) {
  const rec = useMemo(() => decodeRecord(recordBytes(signed)), [signed]);
  const amt = formatUsdc(rec.limitMicro, { max: 2 }).replace(/\.00$/, '');
  const big = useMemo(() => stamp(256, 304, { foil: true, num: amt, cap: 'USDC', motif: 'bank', numSize: amt.length > 4 ? 16 : amt.length > 3 ? 18 : 24, rosette: true, ms: 0.5 }), [amt]);
  const bg = useMemo(() => rosette(255, 300, 300, 90, '#8E7CC8', 0.1) + rosette(255, 300, 200, 72, '#7FA4E6', 0.1), []);
  const wrap = useRef<HTMLDivElement>(null);
  // Tilt follows the finger 1:1: the box is measured once per gesture, writes are batched per frame, and no
  // transition is left on while tracking (the spring back runs only on release).
  const box = useRef<DOMRect | null>(null);
  const raf = useRef(0);
  const tilt = (e: React.PointerEvent) => {
    const w = wrap.current;
    if (!w || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = (box.current ??= w.getBoundingClientRect());
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      w.style.transition = 'none';
      w.style.transform = `rotateY(${x * 24}deg) rotateX(${-y * 24}deg)`;
      w.style.setProperty('--sx', `${50 + x * 120}%`);
    });
  };
  const reset = () => {
    box.current = null;
    cancelAnimationFrame(raf.current);
    const w = wrap.current;
    if (w) { w.style.transition = 'transform .25s var(--spring)'; w.style.transform = ''; w.style.setProperty('--sx', '50%'); }
  };
  return (
    <section className="landed" aria-labelledby="land-h">
      <div className="rosette" aria-hidden="true"><svg viewBox="0 0 510 700" preserveAspectRatio="xMidYMid slice" dangerouslySetInnerHTML={{ __html: bg }} /></div>
      <div className="cap">Your limit is on Solana</div>
      <h1 id="land-h"><span data-testid="landed-amount">{formatUsdc(rec.limitMicro, { max: 2 })}</span> USDC to borrow</h1>
      <div className="stampwrap" ref={wrap} onPointerMove={tilt} onPointerLeave={reset} onPointerUp={reset} onPointerCancel={reset} aria-hidden="true">
        <div className="stamp drop"><svg viewBox="0 0 256 304" dangerouslySetInnerHTML={{ __html: big }} /><div className="sheen" /></div>
      </div>
      <div className="landchips">
        <span className="pill glass"><Icon name="clock" />Good until {formatDate(rec.expiry)}</span>
        <span className="pill glass"><Icon name="shield" />Signed in a sealed computer</span>
      </div>
      <div className="actions">
        <ActionStatus a={postAct} />
        <Btn onClick={onDone}>Start borrowing</Btn>
      </div>
    </section>
  );
}

const addressEncoder = getAddressEncoder();
function addressBytes(a: string): Uint8Array {
  return new Uint8Array(addressEncoder.encode(address(a)));
}

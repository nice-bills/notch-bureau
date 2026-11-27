import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ENCLAVE_URL, LIVE_STATUS } from './config';
import { MIN_FEE_LAMPORTS, sendTransaction } from './chain';
import { FaucetButton } from './Faucet';
import { PHANTOM_LINK_NAME, takeSignedMessage, returnedWith, clearReturnedWith } from './phantom-link';
import { useChain } from './data';
import { useWallet } from './wallet';
import { demoDeliver, inboxCode, isDemoSealed, newInbox, pollRecord, recordBytes, reportPosted, underwrite, type EnclaveOk, type InboxAddress } from './enclave';
import { signInWithSolana, watchJobs, type JobRow } from './live';
import { decodeRecord } from './notch';
import { postIxsFor } from './post';
import { formatDate, formatUsdc } from './amount';
import { rosette, stamp } from './art';
import { buzz } from './glass';
import { ActionStatus, Btn, Icon, Notice, cx, useAction } from './ui';
import { Banners, useUi } from './App';
import { Ticket } from './Ticket';
import { Restoring } from './Home';
import { copyText, longDay, momoDay, statementRange, waitStage } from './statement-dates';
import { askToNotify, notifyLimit } from './native';
import { STEP, forGoal, onboarding, setOnboard, useOnboard, type Goal } from './onboard';
import { Progress } from './Onboarding';

const SAMPLES = [
  { file: '/samples/deel.eml', label: 'Deel payout' },
  { file: '/samples/bank.eml', label: 'Bank statement' },
];

/** The inbox as kept on this phone: `createdAt` (ms) lets the waiting clock survive a reload. */
type StoredInbox = InboxAddress & { createdAt: number };

const store = {
  key: (w: string) => `notch.inbox.${w}`,
  get(w: string): StoredInbox | null {
    try {
      const v = sessionStorage.getItem(this.key(w));
      if (!v) return null;
      const ib = JSON.parse(v) as InboxAddress & { createdAt?: number };
      if (typeof ib.createdAt === 'number') return ib as StoredInbox;
      const fixed = { ...ib, createdAt: Date.now() }; // saved before createdAt existed: start the clock now
      this.set(w, fixed);
      return fixed;
    } catch { return null; }
  },
  /** Saves the inbox, stamping `createdAt` when it is new. */
  set(w: string, v: (InboxAddress & { createdAt?: number }) | null): StoredInbox | null {
    const ib = v ? { ...v, createdAt: v.createdAt ?? Date.now() } : null;
    this.write(w, ib);
    return ib;
  },
  write(w: string, v: StoredInbox | null) {
    try { if (v) sessionStorage.setItem(this.key(w), JSON.stringify(v)); else sessionStorage.removeItem(this.key(w)); } catch { /* private mode: keep it in memory only */ }
  },
};

type Live = 'idle' | 'received' | 'checking' | 'done' | 'refused';

/** "Send a new statement": forget the last inbox address and limit on this phone, so the form starts clean. */
export function startNewStatement(wallet: string) { store.set(wallet, null); }

export function GetLimit() {
  const { connected, signMessage, signTransaction, restoring } = useWallet();
  const { addrs, line, refresh, session, sol } = useChain();
  const { go, openSignIn, att } = useUi();
  const owner = connected?.address ?? null;
  const signed = session.signed;
  const posted = !!(signed && line && line.lastNonce >= BigInt(signed.nonce));
  // back from the Phantom app with the post signed: show the result, not the long form with the next step far below
  const [landed, setLanded] = useState(() => returnedWith === 'tx');
  useEffect(() => () => clearReturnedWith(), []);
  const fromInbox = useRef(false);
  // First run: the same progress bar as the questions, the person's answers said back, and the path they need first.
  const onb = useOnboard();
  const guided = onboarding(onb);
  const [hasInbox, setHasInbox] = useState(false);
  const progress = guided ? (signed ? STEP.reveal : hasInbox ? STEP.wait : STEP.inbox) : undefined;

  const postAct = useAction(async () => { await refresh(); });
  const uwKey = att && att !== 'down' ? att.underwriter : null;

  const onPost = () =>
    postAct.run(async () => {
      if (!owner || !addrs || !signed) throw new Error('Missing wallet or limit.');
      if (!uwKey) throw new Error('Could not read the sealed computer’s public key. Is it running?');
      const ixs = await postIxsFor(addrs, owner, signed, uwKey);
      const { signature } = await sendTransaction(owner, ixs, signTransaction);
      if (fromInbox.current) void reportPosted(signature);
      setLanded(true);
      buzz(28);
      return { signature, note: 'Your limit is now on Solana.' };
    });

  if (!owner && restoring) return <div><Nav title="Get your limit" onBack={() => go('home')} /><Restoring /></div>;
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
  if (guided && signed && !posted) return (
    <div>
      <Nav title="Your limit" onBack={() => go('home')} progress={progress} />
      <Banners />
      <Reveal signed={signed} goal={onb.goal} onNext={() => { setOnboard({ step: STEP.borrow }); go('borrow'); }} />
    </div>
  );

  const inboxEl = <Inbox wallet={owner} signMessage={signMessage} onResult={(r) => { fromInbox.current = true; session.setSigned(r); }} localDemo={att !== null && att !== 'down' && isDemoSealed(att)} onInbox={setHasInbox} />;
  // First run: one path, the one that works for most people today (the MoMo inbox). The payout-email upload stays for everyone else.
  const uploadEl = guided ? null : <Upload wallet={owner} signMessage={signMessage} onResult={(r) => { fromInbox.current = false; session.setSigned(r); }} />;
  return (
    <div>
      <Nav title="Get your limit" onBack={() => go('home')} progress={progress} />
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
              <>
                {/* One approval: post the limit, put down 20% and borrow, all in one transaction. */}
                <Btn onClick={() => go('borrow')} disabled={!uwKey || postAct.busy}>Choose an amount and borrow</Btn>
                <p className="help" style={{ textAlign: 'center', margin: '4px 0 0' }}>Posting your limit, the deposit and the loan go in one approval.</p>
                {/* The separate path (one more approval later): a small link, not a second big button. */}
                <button type="button" className="textlink" onClick={onPost} disabled={!uwKey || postAct.busy} aria-busy={postAct.busy || undefined}>{postAct.busy ? 'Posting…' : 'Post my limit'}</button>
              </>
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
        <>{inboxEl}{uploadEl}</>
      )}
    </div>
  );
}

function Nav({ title, onBack, progress }: { title: string; onBack: () => void; progress?: number }) {
  return (
    <div className={cx('nav', progress !== undefined && 'with-bar')}>
      <button type="button" className="circ glass lens tap" onClick={onBack} aria-label="Back"><Icon name="back" /></button>
      <span className="ttl">{title}</span>
      <span style={{ width: 48 }} />
      {progress !== undefined && <Progress at={progress} />}
    </div>
  );
}
export { Nav };

function Inbox({ wallet, signMessage, onResult, localDemo, onInbox }: { wallet: string; signMessage: (m: Uint8Array) => Promise<Uint8Array>; onResult: (r: EnclaveOk) => void; localDemo: boolean; onInbox?: (has: boolean) => void }) {
  const { connected } = useWallet();
  const [inbox, setInbox] = useState<StoredInbox | null>(() => store.get(wallet));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Live>('idle');
  const [refusal, setRefusal] = useState<{ friendly: string; locked: boolean } | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedDate, setCopiedDate] = useState<'start' | 'end' | null>(null);
  // When the polls started failing (null while they get answers).
  const [failSince, setFailSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [arrived, setArrived] = useState(false);
  const range = useMemo(() => statementRange(), []);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoErr, setDemoErr] = useState<string | null>(null);

  useEffect(() => { setInbox(store.get(wallet)); }, [wallet]);
  useEffect(() => { onInbox?.(!!inbox); }, [inbox, onInbox]);

  // Back from the Phantom app with the inbox request signed: finish asking for the address.
  useEffect(() => {
    const prefix = `notch-inbox-v1|${wallet}|`;
    const done = takeSignedMessage((m) => m.startsWith(prefix));
    if (!done) return;
    setBusy(true);
    newInbox(wallet, { signed: { ts: Number(done.message.slice(prefix.length)), signature: done.signature } })
      .then((ib) => { setInbox(store.set(wallet, ib)); setLive('idle'); setRefusal(null); })
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
      setInbox(store.set(wallet, ib));
      setLive('idle');
      setRefusal(null);
      void askToNotify();
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
        setFailSince(null);
        if (r.status === 'ready') { done.current = true; setLive('done'); buzz(22); void notifyLimit(inbox.address, formatUsdc(decodeRecord(recordBytes(r.result)).limitMicro, { max: 2 })); onResultRef.current(r.result); return; }
        if (r.status === 'refused' || r.status === 'locked') { setLive('refused'); setRefusal({ friendly: r.friendly, locked: r.status === 'locked' }); }
      } catch (e) {
        if (ctl.signal.aborted) return;
        const m = e instanceof Error ? e.message : String(e);
        if (/no longer known/.test(m)) { store.set(wallet, null); setInbox(null); setErr(m); return; }
        setPollErr(m);
        setFailSince((f) => f ?? Date.now());
      }
      t = setTimeout(tick, 2500);
    };
    void tick();
    return () => { ctl.abort(); clearTimeout(t); };
  }, [inbox, wallet]);

  // A one-second clock (never shown: it picks the waiting message and spots failing polls), only while there is something to wait for.
  const waiting = !!inbox && live === 'idle';
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  // The email landed: mark the moment once (a short buzz on phones that support it).
  const prevLive = useRef<Live>(live);
  useEffect(() => {
    if (prevLive.current === 'idle' && (live === 'received' || live === 'checking')) { setArrived(true); buzz(14); }
    if (live === 'idle' || live === 'refused') setArrived(false);
    prevLive.current = live;
  }, [live]);

  const newAddress = () => { store.set(wallet, null); setInbox(null); setLive('idle'); setRefusal(null); setFailSince(null); };

  // Live steps over Supabase Realtime, when configured.
  useEffect(() => {
    if (!inbox || !LIVE_STATUS) return;
    const code = inboxCode(inbox.address);
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
          <p>Your mobile money provider emails your statement to an address made for this wallet.</p>
          <p className="works-today" data-testid="works-today"><Icon name="check" />Works with MTN MoMo today. Bank statements are next.</p>
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
          <div style={{ minWidth: 0 }}><div className="to">To</div><code data-testid="inbox-address" translate="no">{breakable(inbox.address)}</code></div>
          <div className="slot" aria-hidden="true"><Icon name="lock" /></div>
        </div>
        <div className="foot2">
          <small>Works once. Expires {formatDate(Date.parse(inbox.expiresAt) / 1000)}.</small>
          <Btn variant="secondary" small onClick={() => { void copyText(inbox.address).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600); } }); }}>
            <Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
      </div>
      {!inbox.domainConfigured && (
        <div className="pad"><Notice tone="info" title="Demo address">Real mail can’t reach this address yet (no mail domain is set up). Use “Send a sample statement” below to try the whole path.</Notice></div>
      )}
      <ol className="steps3">
        <li><span className="n">1</span><span>In <b>your money app</b>, open <b>Statements</b> and ask for a statement.<small className="eg">On MTN MoMo, for example: dial <b translate="no">*170#</b> → My Wallet → Statements → Statement Request.</small></span></li>
        <li><span className="n">2</span><span>
          <span className="dates">
            {(['start', 'end'] as const).map((which) => {
              const d = which === 'start' ? range.start : range.end;
              const typed = momoDay(d);
              return (
                <span key={which} className="date-row">
                  <span>{which === 'start' ? 'Start date' : 'End date'}: <b data-testid={`${which}-date`}>{which === 'end' ? `yesterday, ${longDay(d)}` : longDay(d)}</b></span>
                  <button type="button" className="chip tap" data-testid={`copy-${which}`} aria-label={copiedDate === which ? 'Copied' : `Copy ${which} date ${typed}`}
                    onClick={() => { void copyText(typed).then((ok) => { if (ok) { setCopiedDate(which); setTimeout(() => setCopiedDate((c) => (c === which ? null : c)), 1600); } }); }}>
                    <Icon name={copiedDate === which ? 'check' : 'copy'} /><span translate="no">{copiedDate === which ? 'Copied' : typed}</span>
                  </button>
                </span>
              );
            })}
          </span>
          <small className="eg">That’s the last 3 months. Type each date the way MTN asks: day, month, year with spaces.</small>
        </span></li>
        <li><span className="n">3</span><span>Paste the address above and <b>send</b>.</span></li>
      </ol>
      <ul className="log pcard" aria-live="polite" aria-label="Statement status">
        {steps.map((s, i) => {
          const state = live === 'refused' ? (i === 0 ? 'bad' : 'wait') : i < liveIdx ? 'done' : i === liveIdx && live !== 'idle' ? 'live' : i === 0 && live === 'idle' ? 'now' : 'wait'; // waiting: a still ring (the pulse below is the one sign of life)
          return (
            <li key={s.title} className={state}>
              <span className="ck">{state === 'bad' ? <Icon name="x" /> : <Icon name="check" />}</span>
              <span><b>{i === 0 && live === 'idle' ? 'Waiting for the email' : s.title}</b><small>{i === 0 && live === 'idle' ? 'The sender’s signature is checked when it lands' : s.sub}</small></span>
            </li>
          );
        })}
      </ul>
      {waiting && (() => {
        // Elapsed time is tracked but never shown; it only picks the message.
        const stage = waitStage(now - inbox.createdAt);
        const offline = failSince !== null && now - failSince > 20_000;
        return (
          <div className="wait-meta">
            <p className={cx('wait-line', offline && 'off')} data-testid="checking">
              <span className="pulse" aria-hidden="true" />
              <span>{offline ? 'Retrying…' : 'Checking for your email…'}</span>
            </p>
            <div aria-live="polite">
              {stage === 'stuck' ? (
                <div className="notice notice-info still-nothing" role="status">
                  <strong>Still nothing?</strong>
                  <span>Check you typed the address exactly (with the + sign), and that MTN said the request was accepted.</span>
                  <Btn variant="ghost" small onClick={newAddress}>Get a new address</Btn>
                </div>
              ) : (
                <p key={stage} className="wait-stage" data-testid="wait-stage">
                  {stage === 'preparing' ? 'MTN is preparing your statement.' : 'This usually takes a few minutes.'}
                </p>
              )}
            </div>
            {offline && <Notice tone="warn" title="Can’t reach the sealed computer, retrying">Your address still works. Mail that arrives meanwhile is kept.</Notice>}
            <p className="help">You can close this. It picks up where you left off when you come back.</p>
          </div>
        );
      })()}
      {arrived && (live === 'received' || live === 'checking') && (
        <div className="arrived pcard" role="status" data-testid="arrived">
          <span className="arrived-ico" aria-hidden="true"><Icon name="mail" /></span>
          <span><b>Email arrived</b><small>Checking it now. This takes a few seconds.</small></span>
        </div>
      )}
      <div className="pad">
        {refusal && (
          <Notice tone="bad" title="The sealed computer said no">
            {refusal.friendly} {refusal.locked ? '' : 'You can send another statement to the same address.'}
          </Notice>
        )}
        {pollErr && !waiting && <Notice tone="warn" title="Can’t reach the sealed computer">{pollErr}</Notice>}
        {liveNote && <p className="help">{liveNote}</p>}
      </div>
      <div className="actions">
        {(localDemo || !inbox.domainConfigured) && (
          <Btn variant="secondary" onClick={() => void sendDemo()} busy={demoBusy} disabled={live === 'done'}>
            <Icon name="mail" />Send a sample statement (demo)
          </Btn>
        )}
        {demoErr && <Notice tone="bad" title="The sample was not sent">{demoErr}</Notice>}
        {(refusal?.locked || live === 'refused') && <Btn variant="ghost" onClick={newAddress}>Get a new address</Btn>}
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

/** First run: the limit, said in the person's own words, and one button to their first loan. */
function Reveal({ signed, goal, onNext }: { signed: EnclaveOk; goal?: Goal; onNext: () => void }) {
  const rec = useMemo(() => decodeRecord(recordBytes(signed)), [signed]);
  const amt = formatUsdc(rec.limitMicro, { max: 2 });
  const short = amt.replace(/\.00$/, '');
  const big = useMemo(() => stamp(256, 304, { foil: true, num: short, cap: 'USDC', motif: 'bank', numSize: short.length > 4 ? 16 : short.length > 3 ? 18 : 24, rosette: true, ms: 0.5 }), [short]);
  const bg = useMemo(() => rosette(255, 300, 300, 90, '#8E7CC8', 0.1) + rosette(255, 300, 200, 72, '#7FA4E6', 0.1), []);
  // the waiting screen was scrolled down to its buttons: the reveal starts at its headline
  useEffect(() => { window.scrollTo({ top: 0 }); }, []);
  return (
    <section className="landed reveal" aria-labelledby="rv-h">
      <div className="rosette" aria-hidden="true"><svg viewBox="0 0 510 700" preserveAspectRatio="xMidYMid slice" dangerouslySetInnerHTML={{ __html: bg }} /></div>
      <div className="cap">Your limit is ready</div>
      <h1 id="rv-h">For {forGoal(goal)}, you can draw up to <span data-testid="reveal-amount">{amt}</span> USDC</h1>
      <div className="stampwrap" aria-hidden="true">
        <div className="stamp drop"><svg viewBox="0 0 256 304" dangerouslySetInnerHTML={{ __html: big }} /></div>
      </div>
      <div className="landchips">
        <span className="pill glass"><Icon name="clock" />Good until {formatDate(rec.expiry)}</span>
        <span className="pill glass"><Icon name="shield" />Only this number left</span>
      </div>
      <div className="actions">
        <Btn onClick={onNext}>Choose an amount</Btn>
        <p className="help" style={{ textAlign: 'center', margin: '4px 0 0' }}>2% fee and a 20% deposit. You see both before you agree.</p>
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

/** A long inbox address (notch-inbox+code@agentmail.to) may break after "+" and "@", never mid-word on a narrow phone. */
function breakable(address: string) {
  // no regex lookbehind: older iPhone Safari cannot even parse it
  const parts: string[] = [];
  let cur = '';
  for (const ch of address) { cur += ch; if (ch === '+' || ch === '@' || ch === '.') { parts.push(cur); cur = ''; } }
  if (cur) parts.push(cur);
  return parts.map((part, i) => <span key={i}>{i > 0 && <wbr />}{part}</span>);
}

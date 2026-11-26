// Shared chain state: pool, the connected wallet's credit line and balances. Polls gently
// and refreshes right after any transaction.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { USDC_MINT } from './config';
import { fetchLine, fetchPool, fetchSol, fetchTokenBalance, fetchWithdrawRequest, notchAddresses, type PoolView } from './chain';
import { deriveAddresses, type CreditLine, type NotchAddresses, type Tranche, type WithdrawRequest } from './notch';
import { PROGRAM_ID } from './config';
import { useWallet } from './wallet';
import type { EnclaveOk } from './enclave';

export interface Session {
  /** The .eml chosen on the Borrow screen (kept in memory only, never stored). */
  eml: { name: string; bytes: Uint8Array } | null;
  setEml: (e: Session['eml']) => void;
  /** Latest signed limit from the sealed computer, not yet (or already) posted. */
  signed: EnclaveOk | null;
  setSigned: (s: EnclaveOk | null) => void;
}

interface ChainData {
  addrs: NotchAddresses | null;
  configured: boolean;
  pool: PoolView | null;
  poolLoaded: boolean;
  line: CreditLine | null;
  usdc: bigint;
  /** Share tokens held in the wallet, per tranche (senior = Safe, junior = Risky). */
  shares: Record<Tranche, bigint>;
  /** Pending two-step withdrawal per tranche (shares sit in escrow, still counted in the supply), if any. */
  requests: Record<Tranche, WithdrawRequest | null>;
  /** True until the first successful read for the current wallet. */
  loading: boolean;
  sol: bigint | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** After a confirmed transaction: show the known result at once (absolute values from before the action), then re-read. */
  patch: (p: { line?: Partial<CreditLine>; usdc?: bigint }) => void;
  session: Session;
}

const Ctx = createContext<ChainData | null>(null);

// ---- per-wallet memory in localStorage (bigints kept as {"$n": "123"}) ----
const enc = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $n: x.toString() } : x));
const dec = <T,>(t: string): T => JSON.parse(t, (_k, x) => (x && typeof x === 'object' && typeof x.$n === 'string' && Object.keys(x).length === 1 ? BigInt(x.$n) : x)) as T;
const load = <T,>(k: string): T | null => { try { const t = localStorage.getItem(k); return t ? dec<T>(t) : null; } catch { return null; } };
const save = (k: string, v: unknown) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, enc(v)); } catch { /* private mode */ } };
/** The last numbers read for a wallet: shown at once on the next visit (then refreshed), instead of empty boxes. */
interface Snapshot { line: CreditLine | null; usdc: bigint; shares: Record<Tranche, bigint>; requests: Record<Tranche, WithdrawRequest | null>; sol: bigint | null }
const snapKey = (w: string) => `notch.snap.${w}`;
/** A signed limit that is not on chain yet: kept per wallet until it is posted or expires, so Back or a reload never loses it. */
const signedKey = (w: string) => `notch.signed.${w}`;
const liveSigned = (s: EnclaveOk | null) => (s && Number(s.expiry) > Date.now() / 1000 ? s : null);

export function ChainProvider({ children }: { children: ReactNode }) {
  const { connected } = useWallet();
  const owner = connected?.address ?? null;
  const [addrs, setAddrs] = useState<NotchAddresses | null>(null);
  const [pool, setPool] = useState<PoolView | null>(null);
  const [poolLoaded, setPoolLoaded] = useState(false);
  const [line, setLine] = useState<CreditLine | null>(null);
  const [usdc, setUsdc] = useState(0n);
  const [shares, setShares] = useState<Record<Tranche, bigint>>({ senior: 0n, junior: 0n });
  const [requests, setRequests] = useState<Record<Tranche, WithdrawRequest | null>>({ senior: null, junior: null });
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [sol, setSol] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eml, setEml] = useState<Session['eml']>(null);
  const [signed, setSignedState] = useState<EnclaveOk | null>(null);
  const setSigned = useCallback((v: EnclaveOk | null) => {
    setSignedState(v);
    if (ownerRef.current) save(signedKey(ownerRef.current), v);
  }, []);
  const ownerRef = useRef(owner);
  // Bumped by patch(): a read that started before it would bring back the old numbers, so its result is dropped.
  const gen = useRef(0);
  ownerRef.current = owner;

  useEffect(() => {
    if (USDC_MINT) deriveAddresses(PROGRAM_ID, USDC_MINT).then(setAddrs);
    const p = load<PoolView>('notch.pool');
    if (p) { setPool(p); setPoolLoaded(true); }
  }, []);

  const refresh = useCallback(async () => {
    if (!USDC_MINT) return;
    try {
      const g = gen.current;
      const a = await notchAddresses();
      const who = ownerRef.current;
      const [p, l, u, sj, ss, lamports, wrj, wrs] = await Promise.all([
        fetchPool(),
        who ? fetchLine(who) : Promise.resolve(null),
        who ? fetchTokenBalance(who, USDC_MINT) : Promise.resolve(0n),
        who ? fetchTokenBalance(who, a.juniorMint) : Promise.resolve(0n),
        who ? fetchTokenBalance(who, a.seniorMint) : Promise.resolve(0n),
        who ? fetchSol(who) : Promise.resolve(null),
        who ? fetchWithdrawRequest(who, 'junior') : Promise.resolve(null),
        who ? fetchWithdrawRequest(who, 'senior') : Promise.resolve(null),
      ]);
      if (ownerRef.current !== who || gen.current !== g) return; // wallet changed, or an optimistic patch landed, while loading
      setPool(p);
      setLine(l);
      setUsdc(u);
      setShares({ junior: sj, senior: ss });
      setRequests({ junior: wrj, senior: wrs });
      setLoadedFor(who);
      setSol(lamports);
      setError(null);
      setPoolLoaded(true); // only after a successful read: a failed RPC call must not look like "pool not created"
      save('notch.pool', p);
      if (who) save(snapKey(who), { line: l, usdc: u, shares: { junior: sj, senior: ss }, requests: { junior: wrj, senior: wrs }, sol: lamports } satisfies Snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // a new wallet: show its last known numbers at once (or nothing), never the previous wallet's
    const snap = owner ? load<Snapshot>(snapKey(owner)) : null;
    setLine(snap?.line ?? null); setUsdc(snap?.usdc ?? 0n); setShares(snap?.shares ?? { senior: 0n, junior: 0n });
    setRequests(snap?.requests ?? { senior: null, junior: null }); setSol(snap?.sol ?? null);
    setLoadedFor(snap ? owner : undefined);
    setSignedState(owner ? liveSigned(load<EnclaveOk>(signedKey(owner))) : null);
    void refresh();
    const t = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(t);
  }, [refresh, owner]);

  useEffect(() => {
    if (owner && signed && line && line.lastNonce >= BigInt(signed.nonce)) save(signedKey(owner), null);
  }, [owner, signed, line]);

  const patch = useCallback((p: { line?: Partial<CreditLine>; usdc?: bigint }) => {
    gen.current++;
    if (p.line) { const upd = p.line; setLine((l) => (l ? { ...l, ...upd } : l)); }
    if (p.usdc !== undefined) setUsdc(p.usdc < 0n ? 0n : p.usdc);
  }, []);

  const session = useMemo<Session>(() => ({ eml, setEml, signed, setSigned }), [eml, signed, setSigned]);
  const value = useMemo<ChainData>(
    () => ({ addrs, configured: USDC_MINT !== null, pool, poolLoaded, line, usdc, shares, requests, loading: loadedFor !== owner, sol, error, refresh, patch, session }),
    [addrs, pool, poolLoaded, line, usdc, shares, requests, loadedFor, owner, sol, error, refresh, patch, session],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChain(): ChainData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChain must be used inside <ChainProvider>');
  return v;
}

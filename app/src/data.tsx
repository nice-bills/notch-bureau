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
  const [signed, setSigned] = useState<EnclaveOk | null>(null);
  const ownerRef = useRef(owner);
  // Bumped by patch(): a read that started before it would bring back the old numbers, so its result is dropped.
  const gen = useRef(0);
  ownerRef.current = owner;

  useEffect(() => {
    if (USDC_MINT) deriveAddresses(PROGRAM_ID, USDC_MINT).then(setAddrs);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // a new wallet: forget the old one's numbers at once, so nothing stale shows while the first read runs
    setLine(null); setUsdc(0n); setShares({ senior: 0n, junior: 0n }); setRequests({ senior: null, junior: null }); setSol(null);
    void refresh();
    const t = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(t);
  }, [refresh, owner]);

  const patch = useCallback((p: { line?: Partial<CreditLine>; usdc?: bigint }) => {
    gen.current++;
    if (p.line) { const upd = p.line; setLine((l) => (l ? { ...l, ...upd } : l)); }
    if (p.usdc !== undefined) setUsdc(p.usdc < 0n ? 0n : p.usdc);
  }, []);

  const session = useMemo<Session>(() => ({ eml, setEml, signed, setSigned }), [eml, signed]);
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

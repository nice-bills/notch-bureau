// Shared chain state: pool, the connected wallet's credit line and balances. Polls gently
// and refreshes right after any transaction.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { USDC_MINT } from './config';
import { fetchLine, fetchPool, fetchSol, fetchTokenBalance, fetchWithdrawRequest, notchAddresses, type PoolView } from './chain';
import { deriveAddresses, type CreditLine, type NotchAddresses, type WithdrawRequest } from './notch';
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
  shares: bigint;
  /** Pending two-step withdrawal (shares sit in escrow, still counted in the supply), if any. */
  withdrawRequest: WithdrawRequest | null;
  sol: bigint | null;
  error: string | null;
  refresh: () => Promise<void>;
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
  const [shares, setShares] = useState(0n);
  const [withdrawRequest, setWithdrawRequest] = useState<WithdrawRequest | null>(null);
  const [sol, setSol] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eml, setEml] = useState<Session['eml']>(null);
  const [signed, setSigned] = useState<EnclaveOk | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  useEffect(() => {
    if (USDC_MINT) deriveAddresses(PROGRAM_ID, USDC_MINT).then(setAddrs);
  }, []);

  const refresh = useCallback(async () => {
    if (!USDC_MINT) return;
    try {
      const a = await notchAddresses();
      const who = ownerRef.current;
      const [p, l, u, s, lamports, wr] = await Promise.all([
        fetchPool(),
        who ? fetchLine(who) : Promise.resolve(null),
        who ? fetchTokenBalance(who, USDC_MINT) : Promise.resolve(0n),
        who ? fetchTokenBalance(who, a.shareMint) : Promise.resolve(0n),
        who ? fetchSol(who) : Promise.resolve(null),
        who ? fetchWithdrawRequest(who) : Promise.resolve(null),
      ]);
      if (ownerRef.current !== who) return; // wallet changed while loading
      setPool(p);
      setLine(l);
      setUsdc(u);
      setShares(s);
      setWithdrawRequest(wr);
      setSol(lamports);
      setError(null);
      setPoolLoaded(true); // only after a successful read: a failed RPC call must not look like "pool not created"
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(t);
  }, [refresh, owner]);

  const session = useMemo<Session>(() => ({ eml, setEml, signed, setSigned }), [eml, signed]);
  const value = useMemo<ChainData>(
    () => ({ addrs, configured: USDC_MINT !== null, pool, poolLoaded, line, usdc, shares, withdrawRequest, sol, error, refresh, session }),
    [addrs, pool, poolLoaded, line, usdc, shares, withdrawRequest, sol, error, refresh, session],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChain(): ChainData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChain must be used inside <ChainProvider>');
  return v;
}

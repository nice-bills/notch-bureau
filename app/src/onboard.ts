// First-run onboarding: what the person told us, and where they are. Kept on this phone (localStorage) so a reload,
// a trip to the wallet app, or Back never loses their place. Every read and write is guarded: private mode and blocked
// storage fall back to memory, and the app still works.
import { useSyncExternalStore } from 'react';

export type Goal = 'stock' | 'school' | 'emergency' | 'bills';
export type Paid = 'momo' | 'bank' | 'both';

/**
 * The steps, in order. 0-5 are the onboarding screens on Home; 6-9 happen on the real screens (Get your limit, Borrow)
 * with the same progress bar on top.
 */
export const STEP = { promise: 0, goal: 1, paid: 2, private: 3, costs: 4, prime: 5, inbox: 6, wait: 7, reveal: 8, borrow: 9 } as const;
export const STEPS = 10;

export interface Onboard {
  step: number;
  goal?: Goal;
  paid?: Paid;
  /** Finished (drew a first loan), or a returning user who connected without it: never shown again. */
  done?: boolean;
}

const KEY = 'notch.onboard.v1';
let mem: Onboard = read();
const subs = new Set<() => void>();

function read(): Onboard {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Onboard | null;
    if (v && typeof v.step === 'number') return v;
  } catch { /* blocked or broken: start fresh */ }
  return { step: 0 };
}

export function getOnboard(): Onboard { return mem; }

export function setOnboard(patch: Partial<Onboard>) {
  mem = { ...mem, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* memory only */ }
  subs.forEach((f) => f());
}

/** Clears everything (tests and "start again"). */
export function resetOnboard() {
  mem = { step: 0 };
  try { localStorage.removeItem(KEY); } catch { /* memory only */ }
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) { mem = read(); f(); } };
  addEventListener('storage', onStorage);
  return () => { subs.delete(f); removeEventListener('storage', onStorage); };
}

export function useOnboard(): Onboard {
  return useSyncExternalStore(subscribe, getOnboard, getOnboard);
}

/** Onboarding is under way: a goal was picked and the first loan is not drawn yet. */
export const onboarding = (o: Onboard) => !o.done && !!o.goal;

// ---- their words, said back ----------------------------------------------------------------------------------------
export const GOALS: { id: Goal; label: string; icon: 'shop' | 'school' | 'bolt' | 'receipt' }[] = [
  { id: 'stock', label: 'Stock for my shop', icon: 'shop' },
  { id: 'school', label: 'School fees', icon: 'school' },
  { id: 'emergency', label: 'An emergency', icon: 'bolt' },
  { id: 'bills', label: 'Bills or something else', icon: 'receipt' },
];
/** "For your shop stock, …" */
export function forGoal(g: Goal | undefined): string {
  return g === 'stock' ? 'your shop stock' : g === 'school' ? 'school fees' : g === 'emergency' ? 'your emergency' : 'your bills';
}

export const PAID: { id: Paid; label: string; sub: string; icon: 'phone' | 'bank' | 'both' }[] = [
  { id: 'momo', label: 'Mobile money', sub: 'A wallet on your phone', icon: 'phone' },
  { id: 'bank', label: 'A bank account', sub: 'Salary or payments into the bank', icon: 'bank' },
  { id: 'both', label: 'Both', sub: 'Some on the phone, some in the bank', icon: 'both' },
];

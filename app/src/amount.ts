import { USDC_DECIMALS } from './notch';

const SCALE = 10n ** BigInt(USDC_DECIMALS);

/** Parse "12.5" into micro-USDC without floating point. Returns null if it is not a clean amount. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > USDC_DECIMALS) return null;
  return BigInt(whole || '0') * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0');
}

/** 1234567n -> "1.23". Two decimals by default (pass max for more).
 *  Default cuts, so a limit or balance never reads high. round: nearest (what you HOLD: 9.999999 reads 10.00).
 *  up: ceiling, for what you OWE or must add (28.3152 reads 28.32), so following the screen never underpays. */
export function formatUsdc(micro: bigint, opts: { max?: number; round?: boolean; up?: boolean } = {}): string {
  const neg = micro < 0n;
  let v = neg ? -micro : micro;
  const max = opts.max ?? 2;
  if (max < USDC_DECIMALS && (opts.round || opts.up)) {
    const q = 10n ** BigInt(USDC_DECIMALS - max);
    v = opts.up ? ((v + q - 1n) / q) * q : ((v + q / 2n) / q) * q;
  }
  const whole = v / SCALE;
  let frac = (v % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  frac = frac.slice(0, max);
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${frac}`;
}

/** Plain input value (no thousands separators) for putting an amount back into a text field. */
export function toInput(micro: bigint): string {
  const whole = micro / SCALE;
  const frac = (micro % SCALE).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function formatDate(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function formatDateTime(unixSeconds: bigint | number): string {
  const d = new Date(Number(unixSeconds) * 1000);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function shortAddr(a: string, n = 4): string {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function daysLeft(unixSeconds: bigint | number, now = Date.now() / 1000): number {
  return Math.ceil((Number(unixSeconds) - now) / 86400);
}

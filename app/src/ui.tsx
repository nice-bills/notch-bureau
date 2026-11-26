import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { explorerTx } from './config';
import { explainError, type FriendlyError } from './errors';
import { FaucetButton } from './Faucet';
import { buildLenses, buzz } from './glass';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

const PATHS: Record<string, ReactNode> = {
  back: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M5 12h14M13 6l6 6-6 6" />,
  chev: <path d="M9 6l6 6-6 6" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="3" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M16 13.5h.01" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 6 8-6" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  home: <><path d="M4 11l8-6.5 8 6.5" /><path d="M6 10v9.5h12V10" /></>,
  lend: <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />,
  pool: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5V12l6 6" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
  shield: <><path d="M12 3.5l7 2.8v5.2c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6.3z" /><path d="M9 12l2 2 4-4" /></>,
  repay: <><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  up: <path d="M7 17L17 7M9 7h8v8" />,
  file: <><path d="M14 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" /><path d="M14 3.5V8h4.5" /></>,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></>,
  out: <><path d="M14 4h5v16h-5" /><path d="M10 12h10M6 8l-4 4 4 4" /></>,
};
export type IconName = keyof typeof PATHS;
export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {PATHS[name]}
    </svg>
  );
}
export function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
      <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z" />
      <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4 5.6-4z" />
    </svg>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** Primary = dark tinted glass, secondary = clear glass. Busy shows a spinner and blocks double taps. */
export function Btn({ variant = 'primary', busy, children, className, small, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; small?: boolean }) {
  const cls = variant === 'primary' ? 'glass tint lens' : variant === 'secondary' ? 'glass lens' : variant === 'danger' ? 'danger' : 'ghost';
  return (
    <button type="button" {...rest} className={cx('btn tap', cls, small && 'small', className)} disabled={rest.disabled || busy} aria-busy={busy || undefined}
      onPointerDown={(e) => { if (!rest.disabled && !busy) buzz(4); rest.onPointerDown?.(e); }}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, suffix, value, onChange, inputMode = 'decimal', placeholder, disabled, action, error, id }: {
  label: string; hint?: ReactNode; suffix?: string; value: string; onChange: (v: string) => void; inputMode?: 'decimal' | 'text';
  placeholder?: string; disabled?: boolean; action?: { label: string; onClick: () => void }; error?: string | null; id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={cx('field', error && 'has-error')}>
      <label className="field-label" htmlFor={fid}>{label}</label>
      <span className="field-box">
        <input id={fid} name={fid} value={value} onChange={(e) => onChange(e.target.value)} inputMode={inputMode} placeholder={placeholder} disabled={disabled}
          autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby={`${fid}-h`} />
        {suffix && <span className="field-suffix">{suffix}</span>}
        {action && <button type="button" className="field-action tap" onClick={action.onClick} disabled={disabled}>{action.label}</button>}
      </span>
      <span id={`${fid}-h`} className={cx('field-hint', error && 'err')}>{error || hint}</span>
    </div>
  );
}

export function Stat({ label, value, unit, hint, tone }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode; tone?: 'bad' | 'good' }) {
  return (
    <div className={cx('stat', tone && `tone-${tone}`)}>
      <dt>{label}</dt>
      <dd>
        <span className="stat-value">{value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </dd>
      {hint && <p className="stat-hint">{hint}</p>}
    </div>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title?: string; children?: ReactNode }) {
  return (
    <div className={cx('notice', `notice-${tone}`)} role={tone === 'bad' ? 'alert' : 'status'}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

/** Loading placeholder for a number that is still being read from Solana. */
export function Skel({ children, loading }: { children: ReactNode; loading: boolean }) {
  return loading ? <span className="skel" aria-label="Loading">0.00</span> : <>{children}</>;
}

/** A floating glass sheet (modal). Escape or the scrim closes it; focus moves in and comes back. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const tid = useId();
  const close = useRef(onClose);
  close.current = onClose;
  // Once per opening (not on every re-render, which would yank focus back to the first field while typing).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Phones: focus the sheet itself, so no keyboard jumps up before the user taps a field.
    const coarse = matchMedia('(pointer: coarse)').matches;
    (coarse ? el : el?.querySelector<HTMLElement>('input, button:not(.x), a'))?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    addEventListener('keydown', onKey);
    if (el) requestAnimationFrame(() => buildLenses(el));
    return () => { removeEventListener('keydown', onKey); prev?.focus?.({ preventScroll: true }); };
  }, []);
  // Keep the sheet above the on-screen keyboard: the visual viewport shrinks when it opens (iOS does not resize the page).
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;
    const fit = () => {
      const kb = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop));
      el.style.setProperty('--kb', `${kb}px`);
      el.style.maxHeight = `${Math.round(vv.height) - 24}px`;
    };
    fit();
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    return () => { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); };
  }, []);
  return createPortal(
    <>
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="grab" aria-hidden="true" />
        <div className="sh-h">
          <h2 id={tid}>{title}</h2>
          <button type="button" className="x tap" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </>,
    document.body,
  );
}

export interface ActionState {
  busy: boolean;
  error: FriendlyError | null;
  signature: string | null;
  note: string | null;
}

/** Wraps an async chain action: busy flag, plain-English error, explorer link. */
export function useAction(onSuccess?: () => void | Promise<void>) {
  const [state, setState] = useState<ActionState>({ busy: false, error: null, signature: null, note: null });
  const run = useCallback(
    async (fn: () => Promise<{ signature?: string; note?: string } | void>) => {
      setState({ busy: true, error: null, signature: null, note: null });
      try {
        const out = await fn();
        setState({ busy: false, error: null, signature: out?.signature ?? null, note: out?.note ?? null });
        buzz(18);
        await onSuccess?.();
        return true;
      } catch (e) {
        setState({ busy: false, error: explainError(e), signature: null, note: null });
        buzz(30);
        return false;
      }
    },
    [onSuccess],
  );
  const reset = useCallback(() => setState({ busy: false, error: null, signature: null, note: null }), []);
  return { ...state, run, reset };
}

export function RealError({ raw }: { raw: string }) {
  return (
    <details className="real-error">
      <summary>Show the real error</summary>
      <pre>{raw}</pre>
    </details>
  );
}

export function ActionStatus({ a }: { a: ActionState }) {
  if (a.error) {
    return (
      <div className="action-status bad" role="alert">
        <p>{a.error.message}</p>
        {a.error.code === 'NotEnoughSol' && <div style={{ marginTop: 8 }}><FaucetButton /></div>}
        {a.error.code !== 'Rejected' && <RealError raw={a.error.raw} />}
      </div>
    );
  }
  if (a.signature) {
    return (
      <div className="action-status good" role="status">
        <p>
          {a.note ?? 'Done.'}{' '}
          <a href={explorerTx(a.signature)} target="_blank" rel="noreferrer">View on Solana Explorer</a>
        </p>
      </div>
    );
  }
  return null;
}

/** The one success view for every money action: the amount, one line saying what happened, the receipt link, Done. */
export function DoneView({ amount, text, signature, onDone }: { amount: string; text: ReactNode; signature?: string | null; onDone: () => void }) {
  return (
    <div className="done-view" role="status">
      <div className="done-amt">{amount}</div>
      <p className="sh-p">{text}</p>
      {signature && <p className="help"><a href={explorerTx(signature)} target="_blank" rel="noreferrer">View on Solana Explorer</a></p>}
      <Btn onClick={onDone}>Done</Btn>
    </div>
  );
}

/** "1,234.5" -> big number with faint cents. */
export function Money({ v }: { v: string }) {
  const [w, c] = v.split('.');
  return <>{w}{c !== undefined && <span className="cents">.{c}</span>}</>;
}

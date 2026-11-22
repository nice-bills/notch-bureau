import { useCallback, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { explorerTx } from './config';
import { explainError, type FriendlyError } from './errors';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

export function Btn({
  variant = 'primary',
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet'; busy?: boolean }) {
  return (
    <button {...rest} className={cx('btn', `btn-${variant}`, busy && 'is-busy', className)} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="spinner" aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}

export function Field({
  label,
  hint,
  suffix,
  value,
  onChange,
  inputMode = 'decimal',
  placeholder,
  disabled,
  action,
  error,
}: {
  label: string;
  hint?: ReactNode;
  suffix?: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: 'decimal' | 'text';
  placeholder?: string;
  disabled?: boolean;
  action?: { label: string; onClick: () => void };
  error?: string | null;
}) {
  return (
    <label className={cx('field', error && 'has-error')}>
      <span className="field-label">{label}</span>
      <span className="field-box">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={inputMode}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        {suffix && <span className="field-suffix">{suffix}</span>}
        {action && (
          <button type="button" className="field-action" onClick={action.onClick} disabled={disabled}>
            {action.label}
          </button>
        )}
      </span>
      {error ? <span className="field-hint err">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
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

export function Step({
  n,
  title,
  state,
  summary,
  children,
}: {
  n: number;
  title: string;
  state: 'done' | 'active' | 'locked';
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={cx('step', `step-${state}`)} aria-labelledby={`step-${n}`}>
      <div className="step-rail" aria-hidden="true">
        <span className="step-dot">{state === 'done' ? '✓' : n}</span>
      </div>
      <div className="step-body">
        <header className="step-head">
          <h3 id={`step-${n}`}>{title}</h3>
          {summary && <span className="step-summary">{summary}</span>}
        </header>
        <div className="step-content" inert={state === 'locked' ? true : undefined}>
          {children}
        </div>
      </div>
    </section>
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
        await onSuccess?.();
      } catch (e) {
        setState({ busy: false, error: explainError(e), signature: null, note: null });
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
        {a.error.code !== 'Rejected' && <RealError raw={a.error.raw} />}
      </div>
    );
  }
  if (a.signature) {
    return (
      <div className="action-status good" role="status">
        <p>
          {a.note ?? 'Done.'}{' '}
          <a href={explorerTx(a.signature)} target="_blank" rel="noreferrer">
            View on Solana Explorer
          </a>
        </p>
      </div>
    );
  }
  return null;
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="mono" title={title}>
      {children}
    </span>
  );
}

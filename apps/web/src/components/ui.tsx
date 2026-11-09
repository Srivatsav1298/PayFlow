import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect, useId, useRef } from 'react';
import { label } from '../lib/format';

type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'neutral';

/** Status → colour. Colour is never the only signal: every badge also carries its text label. */
const TONES: Record<string, Tone> = {
  SUCCEEDED: 'ok', PAID: 'ok', RESOLVED: 'ok', CONFIRMED: 'ok', COMPLETED: 'ok', PROCESSED: 'ok', EXACT: 'ok',
  FAILED: 'bad', DEAD_LETTER: 'bad', REJECTED: 'bad', VOID: 'neutral',
  PENDING: 'warn', CREATED: 'neutral', PARTIALLY_PAID: 'warn', INVESTIGATING: 'info', SUGGESTED: 'info', RUNNING: 'info', RECEIVED: 'info', PROCESSING: 'info',
  OPEN: 'warn', REFUNDED: 'neutral', DISMISSED: 'neutral', IGNORED: 'neutral', PARTIAL: 'info', MANUAL: 'info',
  FAILED_PAYMENT: 'bad', DUPLICATE_TRANSACTION: 'warn', MISSING_PAYMENT: 'bad', AMOUNT_DISCREPANCY: 'warn', CURRENCY_MISMATCH: 'warn',
  UNMATCHED_INVOICE: 'warn', UNMATCHED_TRANSACTION: 'warn', DELAYED_EVENT: 'neutral',
};
export const Badge = ({ value, tone }: { value: string; tone?: Tone }) => <span className={`badge ${tone ?? TONES[value] ?? 'neutral'}`}>{label(value)}</span>;

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; small?: boolean }>(
  ({ variant, small, className = '', type = 'button', ...p }, ref) => <button ref={ref} type={type} className={`btn ${variant ?? ''} ${small ? 'sm' : ''} ${className}`} {...p} />,
);
Button.displayName = 'Button';

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => <section className={`card ${className}`}>{children}</section>;
export const CardHead = ({ title, children }: { title: ReactNode; children?: ReactNode }) => (
  <div className="card-head"><h2>{title}</h2><div className="row">{children}</div></div>
);
export const PageHead = ({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) => (
  <div className="page-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row">{children}</div></div>
);

export function Field({ label: text, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`field ${wide ? 'wide' : ''}`}>
      <label htmlFor={id}>{text}</label>
      {children(id)}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input className="input" {...p} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select className="select" {...p} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className="textarea" {...p} />;

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;
export const Loading = () => <div className="empty"><Spinner /></div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const ErrorBox = ({ error }: { error: unknown }) => <div className="banner bad" role="alert">{error instanceof Error ? error.message : 'Something went wrong'}</div>;

export const Kpi = ({ label: l, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) => (
  <div className="card kpi">
    <div className="kpi-label">{l}</div>
    <div className="kpi-value num" style={tone ? { color: `var(--${tone === 'neutral' ? 'ink' : tone})` } : undefined}>{value}</div>
    {sub && <div className="kpi-sub">{sub}</div>}
  </div>
);

export function Pager({ meta, onPage }: { meta: { page: number; totalPages: number; total: number }; onPage: (p: number) => void }) {
  return (
    <nav className="pager" aria-label="Pagination">
      <span>{meta.total.toLocaleString()} result{meta.total === 1 ? '' : 's'}</span>
      <span className="row">
        <Button small disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</Button>
        <span aria-live="polite">Page {meta.page} of {Math.max(meta.totalPages, 1)}</span>
        <Button small disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>Next</Button>
      </span>
    </nav>
  );
}

/** Native <dialog>: focus trap, Escape to close and aria-modal semantics come from the platform. */
export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      {open && (
        <>
          <div className="card-head"><h2 id={titleId}>{title}</h2><Button variant="ghost" small aria-label="Close dialog" onClick={onClose}>✕</Button></div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} className="tab" onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

export const Reasons = ({ reasons }: { reasons: { criterion: string; matched: boolean; detail: string }[] }) => (
  <div className="reasons">{reasons.map((r) => <span key={r.criterion} className={`reason ${r.matched ? 'yes' : 'no'}`} title={r.detail}>{r.matched ? '✓' : '✕'} {r.criterion}</span>)}</div>
);

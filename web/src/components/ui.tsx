import { Marked } from 'marked';
import { Link } from 'react-router-dom';
import { useRef, useState, type ReactNode, type InputHTMLAttributes } from 'react';

// A prominent "back to the list" link shared by every detail page. Larger and
// more noticeable than a plain text link — a pill with an oversized arrow.
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="back-link">
      <span className="back-link-arrow" aria-hidden>←</span>
      <span>{label}</span>
    </Link>
  );
}

// Shared loading placeholder so every page shows the same indicator. `card` wraps it
// in the standard card+empty box used by list pages; `backTo`/`backLabel` prepend the
// detail-page back link (so a detail page loads with its back link already in place).
export function Loading({ card, backTo, backLabel }: { card?: boolean; backTo?: string; backLabel?: string }) {
  const body = card
    ? <div className="card" style={backTo ? { marginTop: 12 } : undefined}><div className="empty">Loading…</div></div>
    : <div className="muted" style={{ padding: 24 }}>Loading…</div>;
  if (backTo && backLabel) return <>{<BackLink to={backTo} label={backLabel} />}{body}</>;
  return body;
}

// Money at rest: "$1,234.50" (negative "−$1,234.50"), matching money() in api.ts.
// Blank stays blank; anything unparseable is shown as typed.
const fmtAmount = (value: string): string => {
  const t = String(value ?? '').trim().replace(/[$,\s]/g, '');
  if (t === '') return value ?? '';
  const n = Number(t);
  if (!Number.isFinite(n)) return value;
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? '−$' : '$') + v;
};

// A money input that shows the full money format at rest ("127000" displays as
// "$127,000.00"), and the plain number while editing so typing isn't disrupted.
// Blank stays blank so optional amounts aren't forced to $0.00. The value it reports
// is always the plain number ("127000.00"). Value-based onChange; passes through
// style/placeholder/disabled/etc.
export function AmountInput({ value, onChange, className, onFocus, onBlur, ...rest }: {
  value: string;
  onChange: (v: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...rest}
      className={className ?? 'num-input'}
      inputMode="decimal"
      value={focused ? value : fmtAmount(value)}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => {
        setFocused(false);
        const raw = e.target.value.trim().replace(/[$,\s]/g, '');
        if (raw !== '' && Number.isFinite(Number(raw))) onChange(Number(raw).toFixed(2));
        onBlur?.(e);
      }}
    />
  );
}

export function Modal({ title, subtitle, onClose, children, wide, persistent }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; persistent?: boolean }) {
  return (
    <div className="scrim" onClick={persistent ? undefined : onClose}>
      <div className="modal" style={wide ? { maxWidth: 920 } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 className="section" style={{ margin: 0 }}>{title}</h2>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

// Markdown renderer hardened against XSS: raw HTML in the source is escaped
// (not passed through), and link/image URLs are restricted to safe protocols —
// so untrusted text echoed by the AI (e.g. a transaction note authored by another
// book member) can't inject script. marked's own output for markdown syntax
// (headings, lists, emphasis, code) is safe by construction.
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHref = (href: unknown): string => {
  const h = String(href ?? '').trim();
  return /^(https?:|mailto:|tel:|#|\/)/i.test(h) ? h : '';
};
const safeMarked = new Marked({
  renderer: {
    html(token: any): string { return escapeHtml(typeof token === 'string' ? token : token?.text ?? ''); },
    link(token: any): string {
      const href = safeHref(token.href);
      const text = (this as any).parser.parseInline(token.tokens);
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>` : text;
    },
    image(token: any): string {
      const href = safeHref(token.href);
      return href ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text ?? '')}">` : escapeHtml(token.text ?? '');
    },
  },
});

export function AiOutput({ markdown }: { markdown: string }) {
  const html = safeMarked.parse(markdown, { async: false }) as string;
  return <div className="ai-output" dangerouslySetInnerHTML={{ __html: html }} />;
}

// Move an array element from one index to another (returns a new array).
export const arrayMove = <T,>(arr: T[], from: number, to: number): T[] => {
  const a = [...arr];
  const [m] = a.splice(from, 1);
  a.splice(to, 0, m);
  return a;
};

// Reorder a displayed subset within the full id list, keeping non-displayed ids
// in their existing slots. Returns the new full order to persist.
export const slotReorder = (full: number[], displayed: number[], newDisplayed: number[]): number[] => {
  const set = new Set(displayed);
  let k = 0;
  return full.map((id) => (set.has(id) ? newDisplayed[k++] : id));
};

// A six-dot grip that starts an HTML5 drag and reports its index.
export function DragHandle({ index, onStart, onEnd }: { index: number; onStart: (i: number) => void; onEnd: () => void }) {
  return (
    <span
      draggable
      onDragStart={(e) => { e.stopPropagation(); onStart(index); }}
      onDragEnd={onEnd}
      onClick={(e) => e.stopPropagation()}
      title="Drag to reorder"
      style={{ cursor: 'grab', display: 'inline-flex', color: 'var(--muted)' }}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" style={{ display: 'block' }}>
        <circle cx="2.5" cy="3" r="1.3" /><circle cx="7.5" cy="3" r="1.3" />
        <circle cx="2.5" cy="8" r="1.3" /><circle cx="7.5" cy="8" r="1.3" />
        <circle cx="2.5" cy="13" r="1.3" /><circle cx="7.5" cy="13" r="1.3" />
      </svg>
    </span>
  );
}

// Standard pencil "edit" icon.
export function EditIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

// Shared chart styling — Doric palette. Navy = primary/current, bronze = highlight,
// sage/olive = growth & stable, slate blue = secondary, stone/sand = inactive/prior.
export const CHART_COLORS = ['#0F1B2D', '#B78A4A', '#6B7F6E', '#5A6F87', '#D4AF6A', '#8A946E', '#DCCFB5', '#A9B2BF'];
export const chartTooltip = { fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12, borderRadius: 8 } as const;
// Small pill/chip button sizing.
export const CHIP = { padding: '5px 12px', fontSize: 13 } as const;
// Capitalize the first letter.
export const cap = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s ?? '');
// Amount comparison operators for filter UIs.
export const AMOUNT_OPS: [string, string][] = [['', 'Any'], ['gt', 'Greater Than'], ['lt', 'Less Than'], ['between', 'Between'], ['eq', 'Exact']];

// Read a File as base64, returning the payload, mime, and name.
export function fileToBase64(file: File): Promise<{ data: string; mime: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const res = reader.result as string;
      resolve({ data: res.slice(res.indexOf(',') + 1), mime: file.type || 'application/octet-stream', name: file.name });
    };
    reader.readAsDataURL(file);
  });
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// A sliding on/off switch. Accessible (a visually-hidden checkbox drives the state;
// clicking anywhere on the label toggles it) with the pill rendered on top. Pass
// children to show a label beside it.
export function Toggle({ checked, onChange, disabled, children }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <label className="row" style={{ gap: 10, alignItems: 'center', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      <span aria-hidden="true" style={{ position: 'relative', width: 40, height: 22, borderRadius: 11, flexShrink: 0, transition: 'background .15s', opacity: disabled ? 0.4 : 1, background: checked ? 'var(--credit)' : 'var(--brass)' }}>
        <span style={{ position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
      </span>
      {children != null && <span>{children}</span>}
    </label>
  );
}

// A small section divider used inside editors to group related fields.
export function EditorSection({ title }: { title: string }) {
  return <div className="label" style={{ marginTop: 14, marginBottom: 6 }}>{title}</div>;
}

// A titled section/card for grouping related fields inside an editor. The optional
// description sits under the title. Standardizes spacing and hierarchy so long
// forms read as a few discrete groups instead of one flat list.
export function FormSection({ title, description, children, subtle }: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  subtle?: boolean; // de-emphasized treatment for secondary groups
}) {
  return (
    <section className={`form-section${subtle ? ' subtle' : ''}`}>
      <div className="form-section-head">
        <h3 className="form-section-title">{title}</h3>
        {description && <div className="form-section-desc">{description}</div>}
      </div>
      {children}
    </section>
  );
}

// The canonical editor footer used by every entity editor modal: Delete on the
// left (only when editing an existing row), a spacer, then a ghost Close and the
// primary Save (disabled until the form is dirty / while saving). Keeping this in
// one place is what makes every editor window look and behave the same.
export function EditorFooter({ onClose, onSave, onDelete, saveLabel, saving, disabled, extra, closeLabel = 'Close', statusHint }: {
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  saveLabel: string;
  saving?: boolean;
  disabled?: boolean;
  extra?: ReactNode; // optional secondary action(s), shown on the left
  closeLabel?: string; // label for the secondary (cancel) button; defaults to "Close"
  statusHint?: ReactNode; // optional dirty/save status shown just before the buttons
}) {
  return (
    <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
      {onDelete && <button className="danger" onClick={onDelete}>Delete</button>}
      {extra}
      <div className="spacer" />
      {statusHint}
      <button className="ghost" onClick={onClose}>{closeLabel}</button>
      <button onClick={onSave} disabled={saving || disabled}>{saving ? 'Saving…' : saveLabel}</button>
    </div>
  );
}

// Returns true once `value` (typically the editor's form state) differs from what
// it was on first render — used to enable Save only after a real change.
export function useDirty(value: unknown): boolean {
  const baseline = useRef<string | null>(null);
  const snap = JSON.stringify(value);
  if (baseline.current === null) baseline.current = snap;
  return snap !== baseline.current;
}

export type Kind = 'income' | 'expense';

/** CSS custom-property accent for a money kind. Income = green, expense = slate-blue. */
export const kindAccent = (kind: Kind) => (kind === 'income' ? 'var(--income)' : 'var(--expense)');

/**
 * A standardized section heading: an accent dot + title on the left and an
 * optional action (usually an "Add" button) on the right, for an identical look
 * & feel wherever a titled section is needed (e.g. the Book and budget screens).
 */
export function SectionHeader({ kind, title, action }: { kind: Kind; title: string; action?: ReactNode }) {
  return (
    <div className={`section-head ${kind}`}>
      <h2 className="section"><span className="dot" />{title}</h2>
      {action}
    </div>
  );
}

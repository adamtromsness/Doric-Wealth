import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { Modal, cap, Toggle } from './ui';

export interface SuggestionTxn { id: number; date: string; amount: number; merchant: string }
export interface SubscriptionSuggestion {
  merchant: string;
  key: string;
  amount: number;
  billing_cycle: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  count: number;
  last_date: string;
  next_due_date: string;
  interval_days: number;
  transactions: SuggestionTxn[];
}

// Shared confirm/ignore actions for a single candidate. Pass subscriptionId to apply
// the detected charges to an EXISTING subscription instead of creating a new one.
async function confirmSuggestion(s: SubscriptionSuggestion, subscriptionId?: number | null) {
  await api.post('/subscriptions/suggestions/confirm', {
    merchant: s.merchant, key: s.key, amount: s.amount,
    billing_cycle: s.billing_cycle, next_due_date: s.next_due_date,
    subscription_id: subscriptionId ?? null,
  });
}
async function ignoreSuggestion(s: SubscriptionSuggestion) {
  await api.post('/subscriptions/suggestions/ignore', { merchant: s.merchant });
}

// Plain-English reason a candidate was flagged, from its cadence + amount.
export function justification(s: SubscriptionSuggestion): string {
  const everyWord = s.interval_days >= 360 ? 'year' : s.interval_days >= 85 ? 'quarter'
    : s.interval_days >= 25 ? 'month' : s.interval_days >= 6 ? 'week' : `${s.interval_days} days`;
  const cadence = ['year', 'quarter', 'month', 'week'].includes(everyWord) ? `about once a ${everyWord}` : `about every ${everyWord}`;
  return `Charged ${s.count} times, ${cadence} (~every ${s.interval_days} days), each time around ${money(s.amount)}. `
    + `That regular cadence and consistent amount is what flags it as a likely ${cap(s.billing_cycle)} subscription.`;
}

// Shared review popup for likely-subscription candidates detected from
// transactions. Each row can be Confirmed (creates the subscription) or
// Ignored (never suggested again). onChanged fires after every action so the
// parent can refresh its own data.
export function SubscriptionSuggestions({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [list, setList] = useState<SubscriptionSuggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<SubscriptionSuggestion | null>(null);
  const [err, setErr] = useState('');

  const load = () => api.get<SubscriptionSuggestion[]>('/subscriptions/suggestions').then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Drop a row after it's acted on; once the list is empty, close the window.
  const removeRow = (s: SubscriptionSuggestion) => {
    const remaining = (list ?? []).filter((x) => x.key !== s.key);
    setList(remaining);
    onChanged?.();
    if (remaining.length === 0) onClose();
  };

  const confirm = async (s: SubscriptionSuggestion) => {
    setBusy(s.merchant); setErr('');
    try { await confirmSuggestion(s); removeRow(s); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  const ignore = async (s: SubscriptionSuggestion) => {
    setBusy(s.merchant); setErr('');
    try { await ignoreSuggestion(s); removeRow(s); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };

  return (
    <Modal title="Possible Subscriptions" onClose={onClose} wide>
      <p className="subtitle" style={{ marginTop: 0 }}>
        These merchants charge the same amount on a regular cadence in your transactions, so they look like subscriptions.
        Click a row to see the charges and reasoning, or use the quick Confirm / Ignore buttons.
      </p>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {list === null ? (
        <div className="empty">Scanning your transactions…</div>
      ) : list.length === 0 ? (
        <div className="empty">No likely subscriptions found in your transactions.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="ledger">
            <thead>
              <tr><th>Merchant</th><th>Cycle</th><th className="r">Amount</th><th className="r">Seen</th><th className="r">Last Charge</th><th></th></tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.merchant} className="clickable" onClick={() => setSelected(s)} title="View charges & details">
                  <td>{s.merchant}</td>
                  <td className="muted">{cap(s.billing_cycle)}</td>
                  <td className="r money num">{money(s.amount)}</td>
                  <td className="r num muted">{s.count}×</td>
                  <td className="r num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(s.last_date)}</td>
                  <td className="r" onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy === s.merchant} onClick={() => confirm(s)}>Confirm</button>
                      <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy === s.merchant} onClick={() => ignore(s)}>Ignore</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <SubscriptionSuggestionDetail
          suggestion={selected}
          onClose={() => setSelected(null)}
          onChanged={() => removeRow(selected)}
        />
      )}

      <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

// Focused review for a SINGLE candidate: shows only the transactions that
// triggered it plus the justification, with confirm/ignore. Opened from the
// "↻ subscription?" chip on a transaction row.
export function SubscriptionSuggestionDetail({ suggestion, onClose, onChanged }: {
  suggestion: SubscriptionSuggestion;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const s = suggestion;
  const [busy, setBusy] = useState<'confirm' | 'ignore' | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [subs, setSubs] = useState<{ id: number; name: string }[]>([]);
  const [targetSub, setTargetSub] = useState('');

  useEffect(() => {
    api.get<{ id: number; name: string }[]>('/subscriptions').then((rows) => setSubs(rows)).catch(() => {});
  }, []);

  const doConfirm = async () => {
    if (mode === 'existing' && !targetSub) { setErr('Pick a subscription to add these charges to.'); return; }
    setBusy('confirm'); setErr('');
    try {
      await confirmSuggestion(s, mode === 'existing' ? Number(targetSub) : null);
      onChanged?.(); onClose();
    } catch (e: any) { setErr(e.message); setBusy(null); }
  };
  const doIgnore = async () => {
    setBusy('ignore'); setErr('');
    try { await ignoreSuggestion(s); onChanged?.(); onClose(); }
    catch (e: any) { setErr(e.message); setBusy(null); }
  };

  return (
    <Modal title="Possible Subscription" onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{s.merchant}</h3>
        <span className="num">{money(s.amount)} · {cap(s.billing_cycle)}</span>
      </div>
      <p className="subtitle" style={{ margin: '0 0 8px', lineHeight: 1.5 }}>{justification(s)}</p>
      <p className="muted" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
        Next charge expected around <strong>{shortDate(s.next_due_date)}</strong>. Create a new subscription, or add these charges to one you already track.
      </p>

      <div className="muted" style={{ fontSize: 12, margin: '12px 0 6px' }}>Charges behind this suggestion ({s.transactions.length})</div>
      <div className="card" style={{ padding: 0 }}>
        <table className="ledger">
          <thead><tr><th>Date</th><th>Merchant (as imported)</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {s.transactions.map((t) => (
              <tr key={t.id}>
                <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(t.date)}</td>
                <td style={{ fontSize: 12 }}>{t.merchant}</td>
                <td className="r money num">{money(t.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
        <Toggle checked={mode === 'existing'} disabled={subs.length === 0} onChange={(v) => setMode(v ? 'existing' : 'new')}>
          Add these charges to an existing subscription{subs.length === 0 ? ' (you have none yet)' : ''}
        </Toggle>
        {mode === 'existing' && (
          <div style={{ marginTop: 10 }}>
            <select value={targetSub} onChange={(e) => setTargetSub(e.target.value)} style={{ width: '100%', maxWidth: 360 }}>
              <option value="">Choose a subscription…</option>
              {subs.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
            </select>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              These charges will be tagged to it, and future charges from this merchant will link automatically.
            </p>
          </div>
        )}
      </div>

      <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
        <button className="ghost" onClick={onClose} disabled={!!busy}>Close</button>
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={doIgnore} disabled={!!busy}
          title="Stop suggesting this merchant — it won't appear again"
          style={{ color: 'var(--debit)', borderColor: 'var(--debit)' }}>
          {busy === 'ignore' ? 'Ignoring…' : "Ignore — it's not a subscription"}
        </button>
        <button onClick={doConfirm} disabled={!!busy}>
          {busy === 'confirm' ? 'Saving…' : mode === 'existing' ? 'Add to subscription' : 'Confirm subscription'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 11, textAlign: 'right', marginTop: 6, marginBottom: 0 }}>
        Closing (or clicking outside) leaves it as a potential subscription.
      </p>
    </Modal>
  );
}

// App-wide notification bar: whenever the book has likely-subscription
// candidates, surface a message on every screen. Clicking it opens the review
// modal. Hidden on the Subscriptions page (which has its own banner) and
// dismissible for the session.
export function SubscriptionAlert() {
  const loc = useLocation();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const refresh = () => api.get<SubscriptionSuggestion[]>('/subscriptions/suggestions')
    .then((s) => setCount(s.length)).catch(() => {});
  // Re-check on each navigation so newly-detected candidates surface promptly.
  useEffect(() => { refresh(); }, [loc.pathname]);

  const showBanner = count > 0 && !dismissed && loc.pathname !== '/subscriptions';

  return (
    <>
      {showBanner && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen(true); }}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
            padding: '10px 14px', marginBottom: 16, borderRadius: 8, cursor: 'pointer',
            background: 'var(--surface-alt, #f4f2ec)', border: '1px solid var(--brass-deep, #8a6d3b)',
          }}
        >
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span aria-hidden>🔔</span>
            <span><strong>{count} potential subscription{count === 1 ? '' : 's'}</strong> found in your transactions — click to review.</span>
          </span>
          <span className="row" style={{ gap: 6, alignItems: 'center' }}>
            <button style={{ padding: '4px 12px', fontSize: 13 }} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>Review</button>
            <button className="ghost" title="Dismiss" aria-label="Dismiss"
              style={{ padding: '4px 8px', fontSize: 13 }}
              onClick={(e) => { e.stopPropagation(); setDismissed(true); }}>✕</button>
          </span>
        </div>
      )}
      {open && <SubscriptionSuggestions onClose={() => setOpen(false)} onChanged={refresh} />}
    </>
  );
}

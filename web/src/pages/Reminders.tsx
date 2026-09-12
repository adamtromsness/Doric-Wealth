import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, shortDate } from '../api';

interface Reminder {
  source: string; kind: string; title: string; subtitle: string | null;
  date: string; amount: number | null; link: string;
}
interface SetupItem { key: string; title: string; description: string; link: string; dismissible: boolean; done: boolean; dismissed: boolean }
interface AttentionItem { kind: string; title: string; count: number; link: string; severity: 'warn' | 'info' | 'debit' }
interface Todos { setup: SetupItem[]; attention: AttentionItem[]; setupOpen: number }

const KIND_LABEL: Record<string, string> = {
  renewal: 'Renewal', bill_due: 'Bill Due', payment_due: 'Payment Due',
  insurance_renewal: 'Insurance', maintenance: 'Maintenance', lease_end: 'Lease',
  cancels: 'Cancels', closes: 'Closes',
};
const sevColor = (s: string) => (s === 'debit' ? 'var(--debit)' : s === 'warn' ? 'var(--warn, #b8860b)' : 'var(--brass-deep)');

const daysUntil = (iso: string) => Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
const dueLabel = (d: number) => (d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d}d`);

export default function Reminders() {
  const [items, setItems] = useState<Reminder[]>([]);
  const [todos, setTodos] = useState<Todos | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const loadTodos = () => api.get<Todos>('/todos').then(setTodos).catch(() => {});
  useEffect(() => {
    api.get<Reminder[]>('/reminders').then(setItems).catch((e) => setErr(e.message));
    loadTodos();
  }, []);

  const dismiss = async (key: string) => { try { await api.post('/todos/dismiss', { key }); loadTodos(); } catch (e: any) { setErr(e.message); } };
  const undismiss = async (key: string) => { try { await api.post('/todos/undismiss', { key }); loadTodos(); } catch (e: any) { setErr(e.message); } };

  const overdue = items.filter((r) => daysUntil(r.date) < 0);
  const soon = items.filter((r) => { const d = daysUntil(r.date); return d >= 0 && d <= 30; });
  const later = items.filter((r) => daysUntil(r.date) > 30);

  const Group = ({ title, rows, tone }: { title: string; rows: Reminder[]; tone?: 'debit' | 'warn' }) => {
    if (rows.length === 0) return null;
    return (
      <div style={{ marginBottom: 22 }}>
        <div className="label" style={{ marginBottom: 8 }}>{title} · {rows.length}</div>
        <div className="card" style={{ padding: 0 }}>
          <table className="ledger"><tbody>
            {rows.map((r, i) => {
              const d = daysUntil(r.date);
              return (
                <tr key={`${r.link}-${r.kind}-${i}`} className="clickable txn-row" onClick={() => navigate(r.link)}>
                  <td style={{ width: 110 }}><span className="tag" style={{ textTransform: 'none', fontSize: 11 }}>{KIND_LABEL[r.kind] ?? r.kind}</span></td>
                  <td><div>{r.title}</div>{r.subtitle && <div className="muted" style={{ fontSize: 12 }}>{r.subtitle}</div>}</td>
                  <td className="r num" style={{ whiteSpace: 'nowrap' }}>{r.amount != null ? money(r.amount) : ''}</td>
                  <td className="r num" style={{ whiteSpace: 'nowrap', width: 150 }}>
                    {shortDate(r.date)}
                    <div style={{ fontSize: 11, color: tone === 'warn' ? 'var(--warn, #b8860b)' : tone === 'debit' ? 'var(--debit)' : 'var(--muted)' }}>{dueLabel(d)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody></table>
        </div>
      </div>
    );
  };

  const setup = todos?.setup ?? [];
  const visibleSetup = setup.filter((s) => !s.dismissed);
  const skipped = setup.filter((s) => s.dismissed);
  const attention = todos?.attention ?? [];
  const setupOpen = todos?.setupOpen ?? 0;
  const nothingUpcoming = items.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Overview</div>
          <h1 className="title">To-Do</h1>
          <p className="subtitle">Finish setting up, clear what needs attention, and see what's coming due — all in one place.</p>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {/* Needs attention — live data-hygiene items */}
      {attention.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <div className="label" style={{ marginBottom: 8 }}>Needs attention · {attention.length}</div>
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger"><tbody>
              {attention.map((a) => (
                <tr key={a.kind} className="clickable txn-row" onClick={() => navigate(a.link)}>
                  <td style={{ width: 60 }}><span className="tag num" style={{ color: sevColor(a.severity), borderColor: sevColor(a.severity), fontSize: 12 }}>{a.count}</span></td>
                  <td>{a.title}</td>
                  <td className="r muted" style={{ width: 40 }}>→</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        </div>
      )}

      {/* Set up — onboarding checklist */}
      {(setupOpen > 0 || skipped.length > 0) && (
        <div style={{ marginBottom: 22 }}>
          <div className="label" style={{ marginBottom: 8 }}>Get set up {setupOpen > 0 ? `· ${setupOpen} left` : '· complete ✓'}</div>
          <div className="card">
            {visibleSetup.map((s) => (
              <div key={s.key} className="row" style={{ alignItems: 'flex-start', gap: 10, padding: '8px 2px', borderTop: '1px solid var(--hairline)' }}>
                <span style={{ fontSize: 16, lineHeight: '20px', color: s.done ? 'var(--credit)' : 'var(--muted)' }}>{s.done ? '✓' : '○'}</span>
                <div style={{ flex: 1, minWidth: 0, cursor: s.done ? 'default' : 'pointer' }} onClick={() => !s.done && navigate(s.link)}>
                  <div style={{ fontWeight: 500, textDecoration: s.done ? 'line-through' : 'none', opacity: s.done ? 0.55 : 1 }}>{s.title}</div>
                  {!s.done && <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>}
                </div>
                {!s.done && s.dismissible && <button className="ghost" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={() => dismiss(s.key)}>Skip</button>}
              </div>
            ))}
            {skipped.length > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                {skipped.length} skipped · <a style={{ cursor: 'pointer' }} onClick={() => setShowSkipped((v) => !v)}>{showSkipped ? 'hide' : 'show'}</a>
                {showSkipped && skipped.map((s) => (
                  <div key={s.key} className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <span>{s.title}</span>
                    <button className="ghost" style={{ fontSize: 12 }} onClick={() => undismiss(s.key)}>Restore</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upcoming — time-based reminders */}
      <div className="label" style={{ marginBottom: 8 }}>Upcoming</div>
      {nothingUpcoming && !err ? (
        <div className="card"><div className="empty">Nothing due in the next 60 days. 🎉</div></div>
      ) : (
        <>
          <Group title="Overdue" rows={overdue} tone="debit" />
          <Group title="Next 30 Days" rows={soon} tone="warn" />
          <Group title="Later" rows={later} />
        </>
      )}
    </>
  );
}

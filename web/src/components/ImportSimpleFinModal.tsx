import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiStream } from '../api';
import { Modal, Field, Toggle } from './ui';

interface LinkedAccount {
  id: number;
  account_id: number | null;
  account_name: string | null;
  external_account_id: string;
  org_name: string | null;
}
interface Connection { id: number; provider: string; accounts: LinkedAccount[] }

const isoDaysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const todayIso = () => new Date().toISOString().slice(0, 10);

// On-demand SimpleFIN import: pick which mapped accounts and a date range, then pull
// those transactions into the review queue. A single streamed session reports what it's
// doing (connecting, fetched N, staged …) as it goes. (A scheduled version comes later.)
export function ImportSimpleFinModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [connTotal, setConnTotal] = useState(0);
  const [connDone, setConnDone] = useState(0);
  const [totals, setTotals] = useState<{ added: number; skipped: number }>({ added: 0, skipped: 0 });
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get<Connection[]>('/connections').then((rows) => {
      setConns(rows);
      const all = new Set<number>();
      rows.forEach((c) => c.accounts.forEach((a) => { if (a.account_id != null) all.add(a.account_id); }));
      setSelected(all);
    }).catch((e) => setErr(e.message));
  }, []);

  const mappedAccounts = useMemo(
    () => (conns ?? []).flatMap((c) => c.accounts.filter((a) => a.account_id != null)),
    [conns]
  );
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = async () => {
    if (selected.size === 0) { setErr('Select at least one account.'); return; }
    setErr(''); setLog([]); setConnDone(0); setTotals({ added: 0, skipped: 0 });
    setStarted(true); setRunning(true); setDone(false);
    const append = (msg: string) => setLog((l) => [...l, msg]);
    try {
      await apiStream('/connections/import/stream',
        { account_ids: [...selected], start_date: from || null, end_date: to || null },
        (ev) => {
          if (ev.type === 'start') { setConnTotal(ev.connections); append(`Starting import from ${ev.connections} connection${ev.connections === 1 ? '' : 's'}…`); }
          else if (ev.type === 'status') append(ev.message);
          else if (ev.type === 'progress') { setConnDone(ev.connDone); setTotals({ added: ev.added, skipped: ev.skipped }); if (ev.message) append(ev.message); }
          else if (ev.type === 'done') { setTotals({ added: ev.added, skipped: ev.skipped }); }
          else if (ev.type === 'error') setErr(ev.message);
        });
      append('Done.');
      setDone(true);
      onImported();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  };

  const pct = done ? 100 : connTotal ? Math.min(96, (connDone / connTotal) * 100 + (running ? 8 : 0)) : (running ? 8 : 0);

  return (
    <Modal title="Import from SimpleFIN" onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {conns == null ? <p className="muted">Loading…</p> : mappedAccounts.length === 0 ? (
        <div className="empty">No linked &amp; mapped accounts yet. Set one up under Integrations → SimpleFIN first.</div>
      ) : started ? (
        // ---- Session progress view ----
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div className="muted" style={{ fontSize: 12 }}>{running ? 'Importing from SimpleFIN…' : done ? 'Import complete' : 'Import stopped'}</div>
            {connTotal > 1 && <div className="muted num" style={{ fontSize: 12 }}>{connDone} of {connTotal} connections</div>}
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--hairline)', overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: done ? 'var(--credit)' : 'var(--brass-deep, var(--brass))', transition: 'width .3s' }} />
          </div>

          <div className="card" style={{ padding: 10, marginBottom: 12, maxHeight: 220, overflowY: 'auto', fontSize: 13, fontFamily: 'Inter, system-ui, sans-serif' }}>
            {log.map((line, i) => (
              <div key={i} className="row" style={{ gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                <span aria-hidden="true" style={{ width: 12, color: i === log.length - 1 && running ? 'var(--brass-deep)' : 'var(--muted)' }}>{i === log.length - 1 && running ? '⟳' : '·'}</span>
                <span>{line}</span>
              </div>
            ))}
            {log.length === 0 && <span className="muted">Starting…</span>}
          </div>

          {done && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--credit)' }}>
              {totals.added > 0
                ? <>Imported <strong>{totals.added}</strong> transaction{totals.added === 1 ? '' : 's'} to your review queue ({totals.skipped} already imported).</>
                : <>Nothing new in that range ({totals.skipped} already imported).</>}
            </div>
          )}

          <div className="btn-row" style={{ alignItems: 'center' }}>
            <button className="ghost" onClick={onClose} disabled={running}>{done ? 'Close' : 'Cancel'}</button>
            <div style={{ flex: 1 }} />
            {done && totals.added > 0 && <button onClick={() => { onClose(); navigate('/transactions'); }}>Review {totals.added} →</button>}
          </div>
        </>
      ) : (
        // ---- Setup view ----
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Accounts to import</div>
          <div className="card" style={{ padding: 8, marginBottom: 14, display: 'grid', gap: 6 }}>
            {mappedAccounts.map((a) => (
              <Toggle key={a.id} checked={selected.has(a.account_id!)} onChange={() => toggle(a.account_id!)}>
                {a.account_name ?? a.external_account_id}
                {a.org_name && <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>· {a.org_name}</span>}
              </Toggle>
            ))}
          </div>

          <div className="grid grid-2">
            <Field label="From"><input type="date" value={from} max={to || todayIso()} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" value={to} max={todayIso()} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Imported transactions land in your review queue. Re-importing a range is safe — duplicates are skipped.
          </div>

          <div className="btn-row" style={{ marginTop: 16, alignItems: 'center' }}>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <div style={{ flex: 1 }} />
            <button onClick={run} disabled={selected.size === 0}>Import {selected.size} Account{selected.size === 1 ? '' : 's'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

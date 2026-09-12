import { useEffect, useState } from 'react';
import { api, shortDate } from '../api';
import { AiOutput, Modal } from '../components/ui';

interface Status { configured: boolean; model: string }
interface Saved { id: number; kind: string; subject_id: number | null; title: string; result: string; model: string; created_at: string }

const KIND_LABEL: Record<string, string> = {
  vehicle_tco: 'Vehicle cost of ownership',
  receipt_products: 'Product spending',
  spending_overview: 'Spending overview',
  custom: 'Custom question',
};

export default function Analysis() {
  const [status, setStatus] = useState<Status | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [result, setResult] = useState<{ title: string; markdown: string } | null>(null);
  const [running, setRunning] = useState<string>('');
  const [question, setQuestion] = useState('');
  const [viewing, setViewing] = useState<Saved | null>(null);
  const [err, setErr] = useState('');

  const loadSaved = () => api.get<Saved[]>('/analysis').then(setSaved).catch(() => {});
  useEffect(() => {
    api.get<Status>('/analysis/status').then(setStatus).catch(() => {});
    loadSaved();
  }, []);

  const run = async (kind: string, fn: () => Promise<{ result: string }>, title: string) => {
    setRunning(kind); setErr(''); setResult(null);
    try {
      const res = await fn();
      setResult({ title, markdown: res.result });
      loadSaved();
    } catch (e: any) { setErr(e.message); }
    finally { setRunning(''); }
  };

  const runCustom = () => {
    const q = question.trim().slice(0, 1000); // bound the free-form prompt
    if (!q) { setErr('Type a question first.'); return; }
    run('custom', () => api.post<{ result: string }>('/analysis/custom', { question: q }), `Q: ${q}`);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Insight</div>
          <h1 className="title">AI Analysis</h1>
          <p className="subtitle">Claude reads your ledger, receipts, utilities and accounts to surface patterns and recommendations.</p>
        </div>
      </div>

      {status && !status.configured && (
        <div className="banner">
          AI is not configured. Add <code>ANTHROPIC_API_KEY</code> to your <code>.env</code> and restart the server to enable analysis. Saved analyses below remain viewable.
        </div>
      )}
      {status?.configured && <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>Model: <span className="num">{status.model}</span></div>}
      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      <div className="grid grid-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <div className="section" style={{ marginTop: 0 }}>Spending Overview</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Net worth, income vs. expense by category, and utilities over the last ~3 months.</p>
          <button className="brass" disabled={!!running} onClick={() => run('spending_overview', () => api.post<{ result: string }>('/analysis/overview'), 'Spending overview')}>
            {running === 'spending_overview' ? 'Analyzing…' : 'Run Overview'}
          </button>
        </div>
        <div className="card">
          <div className="section" style={{ marginTop: 0 }}>Product Spending</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Aggregates itemized receipt products to find spend drivers and price variation.</p>
          <button className="brass" disabled={!!running} onClick={() => run('receipt_products', () => api.post<{ result: string }>('/analysis/products'), 'Product spending analysis')}>
            {running === 'receipt_products' ? 'Analyzing…' : 'Analyze Products'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="section" style={{ marginTop: 0 }}>Ask a question</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Free-form question answered against a snapshot of your finances.</p>
        <div className="row" style={{ gap: 10 }}>
          <input
            value={question}
            maxLength={1000}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runCustom()}
            placeholder="e.g. Which category grew the most in the last 3 months?"
            style={{ flex: 1 }}
          />
          <button className="brass" disabled={!!running} onClick={runCustom}>{running === 'custom' ? 'Thinking…' : 'Ask'}</button>
        </div>
      </div>

      {result && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="section" style={{ marginTop: 0 }}>{result.title}</div>
          <AiOutput markdown={result.markdown} />
        </div>
      )}

      <div className="section">Saved Analyses</div>
      <div className="card" style={{ padding: 0 }}>
        <table className="ledger">
          <thead><tr><th>Title</th><th>Type</th><th>Model</th><th className="r">When</th></tr></thead>
          <tbody>
            {saved.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setViewing(s)}>
                <td>{s.title}</td>
                <td className="muted">{KIND_LABEL[s.kind] ?? s.kind}</td>
                <td className="muted num" style={{ fontSize: 12 }}>{s.model}</td>
                <td className="r num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(s.created_at)}</td>
              </tr>
            ))}
            {saved.length === 0 && <tr><td colSpan={4}><div className="empty">No saved analyses yet. Run one above.</div></td></tr>}
          </tbody>
        </table>
      </div>

      {viewing && (
        <Modal title={viewing.title} onClose={() => setViewing(null)} wide>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{KIND_LABEL[viewing.kind] ?? viewing.kind} · {viewing.model} · {shortDate(viewing.created_at)}</div>
          <AiOutput markdown={viewing.result} />
          <div className="btn-row" style={{ marginTop: 16 }}>
            <div className="spacer" />
            <button className="ghost" onClick={() => setViewing(null)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

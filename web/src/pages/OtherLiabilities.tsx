import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money } from '../api';

interface Liability {
  id: number;
  name: string;
  liability_type: string;
  balance: number | null;
  original_amount: number | null;
  interest_rate: number | null;
  notes: string | null;
}

const LIABILITY_TYPES: [string, string][] = [
  ['mortgage', 'Mortgage'], ['auto_loan', 'Auto Loan'], ['student_loan', 'Student Loan'],
  ['personal_loan', 'Personal Loan'], ['credit_card', 'Credit Card'], ['medical', 'Medical Debt'], ['other', 'Other'],
];
const typeLabel = (t: string) => LIABILITY_TYPES.find(([v]) => v === t)?.[1] ?? t;

export default function OtherLiabilities() {
  const [items, setItems] = useState<Liability[]>([]);
  const [err, setErr] = useState('');
  const navigate = useNavigate();

  const load = () => api.get<Liability[]>('/liabilities').then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Liabilities</div>
          <h1 className="title">Other Liabilities</h1>
          <p className="subtitle">Standalone debts not tracked as an account — personal loans, medical debt, and the like. Credit cards and loans with balance history belong on Liability Accounts.</p>
        </div>
        <button className="head-add" onClick={() => navigate('/other-liabilities/new')}>Add Liability</button>
      </div>

      {err && <div className="error">{err}</div>}

      {items.length === 0 ? (
        <div className="card"><div className="empty">No standalone liabilities yet. Add one to start tracking.</div></div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {items.map((l) => (
            <div key={l.id} className="card kindcard expense clickable" style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/other-liabilities/${l.id}`)} title="View liability details">
              <div className="kindcard-head">
                <div style={{ minWidth: 0 }}>
                  <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {l.name}
                    <span className="tag">{typeLabel(l.liability_type)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{l.notes || 'Standalone debt'}</div>
                </div>
                <button className="ghost" style={{ whiteSpace: 'nowrap' }} onClick={(e) => { e.stopPropagation(); navigate(`/other-liabilities/${l.id}`); }}>View Details →</button>
              </div>
              <div style={{ padding: '12px 14px' }}>
                <div className="grid grid-3">
                  <div className="stat"><div className="label">Balance Owed</div><div className="value small debit">{money(l.balance)}</div></div>
                  <div className="stat"><div className="label">Interest Rate</div><div className="value small">{l.interest_rate != null ? `${l.interest_rate}%` : '—'}</div></div>
                  <div className="stat"><div className="label">Original</div><div className="value small">{l.original_amount != null ? money(l.original_amount) : '—'}</div></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

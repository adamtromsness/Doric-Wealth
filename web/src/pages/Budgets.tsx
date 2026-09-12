import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { Budget } from './budgets/types';
import { BudgetDetail } from './budgets/BudgetDetail';
import { NewBudget } from './budgets/BudgetEditor';

export default function Budgets() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selected, setSelected] = useState<Budget | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');

  // Remember the chosen budget across navigation.
  const STORAGE_KEY = 'budgets.selectedId';
  const choose = (b: Budget | null) => {
    setSelected(b);
    try { b ? localStorage.setItem(STORAGE_KEY, String(b.id)) : localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  };

  const load = () =>
    api.get<Budget[]>('/budgets').then((b) => {
      setBudgets(b);
      setSelected((cur) => {
        if (cur) return b.find((x) => x.id === cur.id) ?? b[0] ?? null;
        const storedId = Number(localStorage.getItem(STORAGE_KEY));
        return (storedId ? b.find((x) => x.id === storedId) : null) ?? b[0] ?? null;
      });
    }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Track</div>
          <h1 className="title">Budgets</h1>
          <p className="subtitle">Plan income and spending by category and item, then track actuals for the period.</p>
        </div>
        <button className="head-add" onClick={() => setAdding(true)}>New Budget</button>
      </div>

      <div className="card" style={{ marginBottom: 16, padding: '11px 14px' }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Budgets organize the categories you set up on the <Link to="/categories">Categories</Link> screen into groups and items, then track them against the activity you record on the <Link to="/transactions">Transactions</Link> screen. To budget a new category, first create it on the Categories screen, then add it here.
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      {budgets.length === 0 ? (
        <div className="card"><div className="empty">No budgets yet. Create one to start planning income and expenses.</div></div>
      ) : (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {budgets.map((b) => (
              <button key={b.id} className={selected?.id === b.id ? '' : 'ghost'} onClick={() => choose(b)}>
                {b.name} <span className="muted" style={{ fontSize: 11 }}>· {b.period}</span>
              </button>
            ))}
          </div>
          {selected && <BudgetDetail budget={selected} onDeleted={() => { choose(null); load(); }} />}
        </>
      )}

      {adding && <NewBudget onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </>
  );
}

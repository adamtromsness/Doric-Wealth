import { useEffect, useState } from 'react';
import { api, money, shortDate } from '../../api';
import { Modal } from '../../components/ui';
import { Pager } from '../transactions/common';
import type { Category } from '../../types';
import type { Txn } from './types';

const TXN_PAGE = 50;

// Lists the transactions behind a section's actual, or its uncategorized bucket,
// for the period/accounts. Non-split rows can be (re)categorized inline.
export function TxnModal({
  budgetId, refStr, kind, scope, cats, title, categories, budgetedCatIds, onClose, onChanged,
}: {
  budgetId: number; refStr: string | null; kind: 'income' | 'expense'; scope: 'section' | 'uncategorized' | 'category';
  cats?: number[]; title?: string; categories: Category[]; budgetedCatIds: Set<number>;
  onClose: () => void; onChanged: () => void;
}) {
  const [rows, setRows] = useState<Txn[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState('');
  const load = () => {
    const qs = new URLSearchParams({ kind, scope, limit: String(TXN_PAGE), offset: String(page * TXN_PAGE) });
    if (refStr) qs.set('ref', refStr);
    if (cats && cats.length) qs.set('cats', cats.join(','));
    api.get<{ transactions: Txn[]; total: number }>(`/budgets/${budgetId}/transactions?${qs.toString()}`)
      .then((r) => { setRows(r.transactions); setTotal(r.total); }).catch((e) => setErr(e.message));
  };
  useEffect(() => { setPage(0); }, [kind, scope, refStr]); // a different drill-down starts at page 1
  useEffect(load, [kind, scope, refStr, page]);
  const opts = categories.filter((c) => c.kind === kind && c.parent_id !== null)
    .sort((a, b) => (a.parent_name ?? '').localeCompare(b.parent_name ?? '') || a.name.localeCompare(b.name));
  const setCat = async (txnId: number, categoryId: string) => {
    try { await api.post(`/transactions/${txnId}/category`, { category_id: categoryId ? Number(categoryId) : null }); load(); onChanged(); }
    catch (e: any) { setErr(e.message); }
  };
  const addToBudget = async (categoryId: number) => {
    try { await api.post(`/budgets/${budgetId}/lines`, { category_id: categoryId, amount: 0 }); onChanged(); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const pageSum = (rows ?? []).reduce((s, r) => s + Number(r.amount), 0);
  const heading = title ?? (scope === 'uncategorized'
    ? `Uncategorized ${kind === 'income' ? 'income' : 'spending'}`
    : `${kind === 'income' ? 'Received' : 'Spent'} — budgeted`);
  return (
    <Modal title={heading} onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {rows === null ? <div className="empty">Loading…</div>
        : rows.length === 0 ? <div className="empty">No transactions.</div>
          : (
            <div className="card" style={{ padding: 0, maxHeight: '60vh', overflow: 'auto' }}>
              <table className="ledger">
                <thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th className="r">Amount</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.txn_id}-${r.split_id ?? 'x'}`}>
                      <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(r.txn_date)}</td>
                      <td>{r.merchant || r.description || '—'}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.account_name || '—'}</td>
                      <td>
                        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                          {r.split_id != null
                            ? <span className="muted" style={{ fontSize: 12 }}>{r.category_name || '—'} (split)</span>
                            : (
                              <select value={r.category_id ?? ''} onChange={(e) => setCat(r.txn_id, e.target.value)} style={{ fontSize: 12 }}>
                                <option value="">— none —</option>
                                {opts.map((c) => <option key={c.id} value={c.id}>{c.parent_name ? `${c.parent_name} › ${c.name}` : c.name}</option>)}
                              </select>
                            )}
                          {r.category_id != null && !budgetedCatIds.has(r.category_id) && (
                            <button className="ghost" style={{ padding: '2px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
                              title="Add this category to the budget" onClick={() => addToBudget(r.category_id!)}>+ budget</button>
                          )}
                        </div>
                      </td>
                      <td className="r money num">{money(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      {rows && rows.length > 0 && (
        <>
          <Pager
            page={page}
            pageCount={Math.max(1, Math.ceil(total / TXN_PAGE))}
            total={total}
            start={page * TXN_PAGE}
            count={rows.length}
            onPage={setPage}
          />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12 }}>{total} transaction{total === 1 ? '' : 's'}</span>
            <span className="money num" style={{ fontWeight: 600 }}>{money(pageSum)}</span>
          </div>
        </>
      )}
      <div className="btn-row" style={{ marginTop: 12 }}><div className="spacer" /><button className="ghost" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

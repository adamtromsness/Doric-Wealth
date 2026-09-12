import { money, shortDate } from '../../api';
import type { Txn } from './helpers';

// Shared transaction-list table used by the entity detail pages (accounts,
// vehicles, properties, …). One row per transaction; amount sign/colour follow
// the Transactions page convention (income +, expense −, transfer neutral).
// Pass `onEdit` to make rows clickable (opens the transaction editor); pass
// `emptyText` to tailor the empty state to the host entity.
export function TxnTable({ items, onEdit, emptyText = 'No transactions yet.' }: {
  items: Txn[];
  onEdit?: (t: Txn) => void;
  emptyText?: string;
}) {
  if (items.length === 0) return <div className="empty">{emptyText}</div>;
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="ledger">
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className="r">Amount</th><th className="r">Status</th><th className="r" title="Automatically imported from a linked bank (SimpleFIN)">Auto</th></tr></thead>
        <tbody>
          {items.map((t) => {
            const amtClass = t.direction === 'income' ? 'credit' : t.direction === 'transfer' ? 'muted' : 'debit';
            const amtText = t.direction === 'transfer'
              ? money(t.amount)
              : money(t.direction === 'income' ? t.amount : -t.amount, { sign: t.direction === 'income' });
            const autoImported = t.source === 'simplefin';
            return (
              <tr key={t.id} className={onEdit ? 'clickable txn-row' : undefined} onClick={onEdit ? () => onEdit(t) : undefined}>
                <td className="num">{shortDate(t.txn_date)}</td>
                <td>{t.merchant || t.description || '—'}</td>
                <td className="muted">{t.category_name || '—'}</td>
                <td className={`r money num ${amtClass}`}>{amtText}</td>
                <td className="r"><span className="tag" style={{ textTransform: 'none' }}>{t.posted_date ? 'Posted' : 'Pending'}</span></td>
                <td className="r">
                  <input type="checkbox" checked={autoImported} readOnly tabIndex={-1}
                    title={autoImported ? 'Auto-imported from a linked bank' : 'Not auto-imported'}
                    style={{ cursor: 'default', pointerEvents: 'none' }} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

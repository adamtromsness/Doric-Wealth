import { money, shortDate } from '../../api';
import { type Invoice, isOverdue, dueLabel, isPartial, lineLabel, amountOwed } from './invoiceHelpers';

// ── Shared invoice tables (used by the list page and the account detail page) ──
export function UnpaidInvoiceTable({ items, onEdit, emptyText }: { items: Invoice[]; onEdit: (inv: Invoice) => void; emptyText?: string }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="ledger">
        <thead>
          <tr><th>Due</th><th>Due in</th><th>Provider</th><th>Utilities</th><th className="r">Total</th><th className="r">Remaining</th></tr>
        </thead>
        <tbody>
          {items.map((inv) => {
            const over = isOverdue(inv);
            return (
              <tr key={inv.id} className="clickable" onClick={() => onEdit(inv)} title="Edit invoice">
                <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{inv.due_date ? shortDate(inv.due_date) : '—'}</td>
                <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap', ...(over ? { color: 'var(--debit)', fontWeight: 600 } : {}) }}>{dueLabel(inv.due_date)}</td>
                <td>
                  {inv.provider || inv.lines[0]?.account_name || '—'}
                  {inv.has_file && <span title="Invoice file attached" style={{ marginLeft: 6 }}>📎</span>}
                  {isPartial(inv) && <span className="tag" style={{ marginLeft: 6, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>Partial</span>}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {inv.lines.map((l, i) => (<span key={i}>{i > 0 ? ' · ' : ''}{lineLabel(l)} {money(l.amount)}</span>))}
                </td>
                <td className="r money num muted">{money(inv.total)}</td>
                <td className="r money num" style={over ? { color: 'var(--debit)' } : {}}>
                  {money(amountOwed(inv))}
                  {isPartial(inv)
                    ? <div className="muted" style={{ fontSize: 11 }}>paid {money(inv.amount_paid)}</div>
                    : over && inv.late_total != null && inv.late_total !== inv.total && <div className="muted" style={{ fontSize: 11 }}>incl. late fee</div>}
                </td>
              </tr>
            );
          })}
          {items.length === 0 && <tr><td colSpan={6}><div className="empty">{emptyText ?? 'No unpaid invoices. 🎉'}</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function PaidInvoiceTable({ items, onEdit, emptyText }: { items: Invoice[]; onEdit: (inv: Invoice) => void; emptyText?: string }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <table className="ledger">
        <thead>
          <tr><th>Paid</th><th>Provider</th><th>Utilities</th><th className="r">Total</th><th className="r">Remaining</th></tr>
        </thead>
        <tbody>
          {items.map((inv) => (
            <tr key={inv.id} className="clickable" onClick={() => onEdit(inv)} title="Edit invoice">
              <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{inv.paid_date ? shortDate(inv.paid_date) : '—'}</td>
              <td>
                {inv.provider || inv.lines[0]?.account_name || '—'}
                {inv.has_file && <span title="Invoice file attached" style={{ marginLeft: 6 }}>📎</span>}
                {inv.transaction_id && <span className="tag" style={{ marginLeft: 6 }} title={`Recorded as a transaction${inv.category_name ? ` in ${inv.category_name}` : ''}`}>Recorded</span>}
              </td>
              <td className="muted" style={{ fontSize: 12 }}>
                {inv.lines.map((l, i) => (<span key={i}>{i > 0 ? ' · ' : ''}{lineLabel(l)} {money(l.amount)}</span>))}
              </td>
              <td className="r money num">{money(inv.total)}</td>
              <td className="r money num muted">{money(amountOwed(inv))}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={5}><div className="empty">{emptyText ?? 'No paid invoices yet.'}</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

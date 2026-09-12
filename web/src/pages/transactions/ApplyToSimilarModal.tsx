import { useState } from 'react';
import { money, shortDate } from '../../api';
import { Modal } from '../../components/ui';
import type { SimilarTxn } from './helpers';

// Confirm applying a merchant rename and/or category to lookalike transactions.
export function ApplyToSimilarModal({
  oldMerchant, newMerchant, merchantChanged, categoryChanged, newCategoryName, matches, onClose, onApply,
}: {
  oldMerchant: string;
  newMerchant: string;
  merchantChanged: boolean;
  categoryChanged: boolean;
  newCategoryName: string | null;
  matches: SimilarTxn[];
  onClose: () => void;
  onApply: (opts: { ids: number[] }) => void | Promise<void>;
}) {
  // Which transactions to apply to — all selected by default; the user can pick a subset.
  const [selected, setSelected] = useState<Set<number>>(() => new Set(matches.map((m) => m.id)));
  const [busy, setBusy] = useState(false);

  const toggle = (id: number) => setSelected((cur) => {
    const next = new Set(cur);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // When anything is selected, clear it (apply to just the one already edited);
  // when nothing is selected, select all.
  const toggleAll = () => setSelected(selected.size > 0 ? new Set() : new Set(matches.map((m) => m.id)));

  return (
    <Modal title="Apply to similar transactions?" onClose={onClose} wide>
      <p className="subtitle" style={{ marginTop: 0 }}>
        Found <strong>{matches.length}</strong> other transaction{matches.length === 1 ? '' : 's'} that look like the same merchant
        (imported as “{oldMerchant}”). This will{' '}
        {merchantChanged && <>rename the merchant to <strong>{newMerchant}</strong></>}
        {merchantChanged && categoryChanged ? ' and ' : ''}
        {categoryChanged && <>set the category to <strong>{newCategoryName ?? '— (none)'}</strong></>}
        {' '}on the highlighted rows. Click a row to exclude it.
      </p>

      <div className="card" style={{ padding: 0, maxHeight: 260, overflow: 'auto' }}>
        <table className="ledger">
          <thead><tr><th>Date</th><th>Merchant (as imported)</th><th>Category</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {matches.map((m) => (
              <tr key={m.id} className={`clickable ${selected.has(m.id) ? 'sub-selected' : ''}`}
                onClick={() => toggle(m.id)} title={selected.has(m.id) ? 'Click to exclude' : 'Click to include'}>
                <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{m.txn_date ? shortDate(m.txn_date) : '—'}</td>
                <td style={{ fontSize: 12 }}>{m.merchant}</td>
                <td className="muted" style={{ fontSize: 12 }}>{m.category_name ?? '—'}</td>
                <td className="r money num">{money(m.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
        <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="ghost" style={{ fontSize: 12 }} onClick={toggleAll} disabled={busy}>{selected.size > 0 ? 'No, just this one' : 'Select all'}</button>
        <div style={{ flex: 1 }} />
        <span className="muted" style={{ fontSize: 12 }}>{selected.size} selected</span>
        <button disabled={busy}
          onClick={async () => { setBusy(true); await onApply({ ids: [...selected] }); }}>
          {busy ? 'Saving…' : selected.size === 0 ? 'Save' : `Apply to ${selected.size}`}
        </button>
      </div>
    </Modal>
  );
}

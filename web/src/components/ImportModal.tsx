import { useState } from 'react';
import { api, money, shortDate } from '../api';
import { Modal, Field, AmountInput } from './ui';
import type { Category, StagedTxn, ImportMapping, ImportPreview } from '../types';

interface Account { id: number; name: string }

// Compact category <optgroup> options (mirror of the Transactions page helper).
function categoryOptions(categories: Category[], kind?: 'expense' | 'income') {
  const groups = categories
    .filter((c) => c.parent_id === null && c.has_children && (!kind || c.kind === kind))
    .sort((a, b) => (a.kind === b.kind ? a.sort_order - b.sort_order : a.kind === 'income' ? -1 : 1));
  const itemsOf = (g: number) => categories.filter((c) => c.parent_id === g).sort((a, b) => a.sort_order - b.sort_order);
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.id} label={g.name}>
          {itemsOf(g.id).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
        </optgroup>
      ))}
    </>
  );
}

const idx = (v: string) => (v === '' ? undefined : Number(v));

// ---------------------------------------------------------------------------
// Upload + column-mapping modal. Reads the CSV text, asks the server to detect
// columns, lets the user adjust the mapping, then commits to the staging table.
// ---------------------------------------------------------------------------
interface ImportSummary { total: number; duplicates: number; imported: number; invalid?: number; truncated?: number }

export function ImportModal({ accounts, onClose, onImported }: {
  accounts: Account[];
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [accountId, setAccountId] = useState<string>(accounts[0] ? String(accounts[0].id) : '');
  const [map, setMap] = useState<ImportMapping>({ date: 0 });
  const [splitAmount, setSplitAmount] = useState(false);
  const [negExpense, setNegExpense] = useState(true);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setErr('');
    try {
      const content = await file.text();
      setText(content);
      setFilename(file.name);
      const p = await api.post<ImportPreview>('/imports/preview', { text: content });
      setPreview(p);
      setMap(p.suggestedMapping);
      setSplitAmount(p.suggestedMapping.amount == null && (p.suggestedMapping.debit != null || p.suggestedMapping.credit != null));
    } catch (e: any) { setErr(e.message); }
  };

  const doImport = async () => {
    if (!accountId) { setErr('Choose the account these transactions belong to.'); return; }
    setErr(''); setBusy(true);
    try {
      const mapping: ImportMapping = splitAmount
        ? { date: map.date, debit: map.debit, credit: map.credit, merchant: map.merchant, description: map.description }
        : { date: map.date, amount: map.amount, merchant: map.merchant, description: map.description };
      const summary = await api.post<ImportSummary>('/imports', {
        text, filename, account_id: Number(accountId), mapping, amountsNegativeAreExpense: negExpense,
      });
      // Show a result summary rather than closing silently — if nothing was
      // staged (e.g. the date/amount columns were mapped wrong, so every row was
      // unreadable) the user gets a clear explanation and can fix the mapping.
      setResult(summary);
      setBusy(false);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const headerSelect = (value: number | undefined, onChange: (v: number | undefined) => void, allowNone = false) => (
    <select value={value ?? ''} onChange={(e) => onChange(idx(e.target.value))}>
      {allowNone && <option value="">— none —</option>}
      {preview!.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
    </select>
  );

  return (
    <Modal title="Import transactions from CSV" onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {result ? (
        <div>
          {result.imported > 0 ? (
            <>
              <p style={{ marginTop: 0 }}>
                Added <strong>{result.imported}</strong> transaction{result.imported === 1 ? '' : 's'} to the review queue below.
                {result.duplicates ? ` ${result.duplicates} looked like possible duplicate${result.duplicates === 1 ? '' : 's'} and ${result.duplicates === 1 ? 'was' : 'were'} set to skip.` : ''}
                {result.invalid ? ` ${result.invalid} row${result.invalid === 1 ? '' : 's'} couldn't be read and ${result.invalid === 1 ? 'was' : 'were'} ignored.` : ''}
              </p>
              <p className="muted" style={{ fontSize: 13 }}>Nothing posts to your ledger until you confirm it in the review queue.</p>
              {result.truncated ? <p className="muted" style={{ fontSize: 13 }}>Only the first rows were processed; {result.truncated} more were skipped.</p> : null}
              <div className="btn-row">
                <div style={{ flex: 1 }} />
                <button onClick={() => onImported(result)}>View {result.imported} in review queue</button>
              </div>
            </>
          ) : (
            <>
              <div className="error" style={{ marginBottom: 12 }}>
                No transactions could be imported.
                {result.invalid ? ` ${result.invalid} row${result.invalid === 1 ? '' : 's'} couldn't be parsed` : ''}
                {result.duplicates ? `${result.invalid ? ', and' : ''} ${result.duplicates} looked like duplicates of existing transactions` : ''}.
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                If rows were unreadable, the <strong>Date</strong> and <strong>Amount</strong> columns are probably mapped to the wrong columns. Go back and check the mapping preview shows real dates and amounts.
              </p>
              <div className="btn-row">
                <button className="ghost" onClick={() => setResult(null)}>Back to Mapping</button>
                <div style={{ flex: 1 }} />
                <button onClick={onClose}>Close</button>
              </div>
            </>
          )}
        </div>
      ) : !preview ? (
        <div>
          <p className="subtitle" style={{ marginTop: 0 }}>
            Upload a CSV exported from your bank. You'll map the columns and review every row before anything is posted.
          </p>
          <label className="ghost" style={{ cursor: 'pointer', padding: '8px 14px', border: '1px solid var(--hairline-strong)', borderRadius: 6, display: 'inline-block' }}>
            Choose CSV file…
            <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => onPick(e.target.files?.[0])} />
          </label>
        </div>
      ) : (
        <div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            <strong>{filename}</strong> — {preview.rowCount} rows. Map the columns below.
          </div>

          <div className="grid grid-2">
            <Field label="Account">
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">— choose —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Date Column">{headerSelect(map.date, (v) => setMap({ ...map, date: v ?? 0 }))}</Field>
          </div>

          <div className="grid grid-2">
            <Field label="Merchant / Payee Column">{headerSelect(map.merchant, (v) => setMap({ ...map, merchant: v }), true)}</Field>
            <Field label="Description / Memo Column">{headerSelect(map.description, (v) => setMap({ ...map, description: v }), true)}</Field>
          </div>

          <label className="row" style={{ alignItems: 'center', margin: '4px 0 10px' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={splitAmount} onChange={(e) => setSplitAmount(e.target.checked)} />
            <span>This CSV has separate debit &amp; credit columns</span>
          </label>

          {splitAmount ? (
            <div className="grid grid-2">
              <Field label="Debit (Money Out) Column">{headerSelect(map.debit, (v) => setMap({ ...map, debit: v }), true)}</Field>
              <Field label="Credit (Money In) Column">{headerSelect(map.credit, (v) => setMap({ ...map, credit: v }), true)}</Field>
            </div>
          ) : (
            <div className="grid grid-2">
              <Field label="Amount Column">{headerSelect(map.amount, (v) => setMap({ ...map, amount: v }), true)}</Field>
              <label className="row" style={{ alignItems: 'center', alignSelf: 'end', marginBottom: 12 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={negExpense} onChange={(e) => setNegExpense(e.target.checked)} />
                <span>Negative amounts are expenses</span>
              </label>
            </div>
          )}

          {/* Mapping preview: shows the chosen columns on the first few rows. */}
          <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>Preview</div>
          <div className="card" style={{ padding: 0, marginBottom: 14 }}>
            <table className="ledger">
              <thead><tr><th>Date</th><th>Merchant / Description</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {preview.sampleRows.map((r, i) => (
                  <tr key={i}>
                    <td className="num">{r[map.date] ?? ''}</td>
                    <td>{(map.merchant != null ? r[map.merchant] : '') || (map.description != null ? r[map.description] : '')}</td>
                    <td className="r num">{splitAmount ? `${r[map.debit ?? -1] ?? ''}${r[map.credit ?? -1] ? ' / ' + r[map.credit ?? -1] : ''}` : (r[map.amount ?? -1] ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="btn-row">
            <button className="ghost" onClick={() => setPreview(null)}>Back</button>
            <div style={{ flex: 1 }} />
            <button onClick={doImport} disabled={busy || !accountId}>{busy ? 'Importing…' : `Import ${preview.rowCount} rows`}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Edit a single staged row before confirming it.
// ---------------------------------------------------------------------------
export function StagedEditor({ staged, accounts, categories, merchants, onClose, onSaved }: {
  staged: StagedTxn;
  accounts: Account[];
  categories: Category[];
  merchants: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    account_id: staged.account_id ? String(staged.account_id) : '',
    category_id: staged.category_id ? String(staged.category_id) : '',
    txn_date: staged.txn_date ?? '',
    amount: String(staged.amount ?? ''),
    direction: staged.direction,
    merchant: staged.merchant ?? '',
    description: staged.description ?? '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Emit a finite number or null — never NaN/Infinity (which JSON would coerce to
  // null silently); the server validates too, this just keeps the payload honest.
  const finiteOrNull = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
  const body = () => ({
    account_id: f.account_id ? Number(f.account_id) : null,
    category_id: f.category_id ? Number(f.category_id) : null,
    txn_date: f.txn_date || null,
    amount: f.amount === '' ? null : finiteOrNull(f.amount),
    direction: f.direction,
    merchant: f.merchant || null,
    description: f.description || null,
  });

  const save = async () => {
    setErr(''); setBusy(true);
    try { await api.put(`/imports/staged/${staged.id}`, { ...body(), decision: staged.decision }); onSaved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const saveAndConfirm = async () => {
    setErr(''); setBusy(true);
    try {
      await api.put(`/imports/staged/${staged.id}`, { ...body(), decision: 'import' });
      await api.post(`/imports/staged/${staged.id}/confirm`);
      onSaved();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <Modal title="Review imported transaction" onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {staged.decision === 'skip' && (() => {
        const reason = staged.skip_reason ?? (staged.duplicate_of != null ? 'matches_existing' : 'duplicate_in_file');
        return (
          <div className="muted" style={{ fontSize: 12, marginBottom: 12, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--hairline)', background: 'var(--surface-alt)' }}>
            <strong>Skipped on import.</strong>{' '}
            {reason === 'matches_existing'
              ? <>Looks like {staged.dup_merchant ?? 'a transaction'} {money(staged.dup_amount)}{staged.dup_date ? ' on ' + shortDate(staged.dup_date) : ''} that&apos;s already in your ledger.</>
              : <>The same date, amount &amp; merchant appear more than once in the imported file, so only the first copy was kept.</>}
            {' '}Edit if needed, then use <strong>Add anyway</strong> to post it.
          </div>
        );
      })()}
      {staged.raw_merchant && staged.raw_merchant !== f.merchant && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>From file: <code>{staged.raw_merchant}</code></div>
      )}
      <div className="grid grid-2">
        <Field label="Date"><input type="date" value={f.txn_date} onChange={(e) => setF({ ...f, txn_date: e.target.value })} /></Field>
        <Field label="Amount"><AmountInput value={f.amount} style={{ textAlign: 'right' }} onChange={(v) => setF({ ...f, amount: v })} /></Field>
      </div>
      <div className="grid grid-2">
        <Field label="Direction">
          <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as StagedTxn['direction'] })}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </Field>
        <Field label="Account">
          <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
            <option value="">—</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Merchant">
        <input list="staged-merchants" value={f.merchant} onChange={(e) => setF({ ...f, merchant: e.target.value })} />
        <datalist id="staged-merchants">{merchants.map((m) => <option key={m} value={m} />)}</datalist>
      </Field>
      <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Category">
        <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
          <option value="">—</option>
          {categoryOptions(categories, f.direction === 'income' ? 'income' : 'expense')}
        </select>
      </Field>

      <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
        <button className="ghost" onClick={onClose}>Cancel</button>
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={save} disabled={busy}>Save</button>
        <button onClick={saveAndConfirm} disabled={busy}>{busy ? 'Posting…' : (staged.decision === 'skip' ? 'Add Anyway' : 'Confirm & Post')}</button>
      </div>
    </Modal>
  );
}

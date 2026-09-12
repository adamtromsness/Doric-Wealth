import { useEffect, useState } from 'react';
import { api, money, shortDate, todayStr } from '../../api';
import { Field, Modal, fileToBase64, EditorFooter, AmountInput } from '../../components/ui';
import { type Invoice, type UtilAccount, type BankAccount, PAY_CHANNELS, isPayableFrom } from './invoiceHelpers';

interface PayCandidate { id: number; txn_date: string; amount: number; merchant: string | null; description: string | null; account_name: string | null }

interface LineForm { utility_account_id: string; description: string; amount: string; usage_quantity: string; usage_unit: string }
const blankLine = (): LineForm => ({ utility_account_id: '', description: '', amount: '', usage_quantity: '', usage_unit: '' });

export function InvoiceEditor({ invoice, accounts, bankAccounts, onClose, onSaved }: {
  invoice: Invoice | null; accounts: UtilAccount[]; bankAccounts: BankAccount[];
  onClose: () => void; onSaved: () => void;
}) {
  const [head, setHead] = useState({
    provider: invoice?.provider ?? '',
    invoice_date: invoice?.invoice_date?.slice(0, 10) ?? todayStr(),
    period_start: invoice?.period_start?.slice(0, 10) ?? '',
    period_end: invoice?.period_end?.slice(0, 10) ?? '',
    due_date: invoice?.due_date?.slice(0, 10) ?? '',
    paid: invoice?.paid ?? false,
    paid_date: invoice?.paid_date?.slice(0, 10) ?? '',
    account_id: invoice?.account_id?.toString() ?? '',
    channel: invoice?.channel ?? '',
    notes: invoice?.notes ?? '',
    total: invoice?.total != null ? String(Math.round(invoice.total * 100) / 100) : '',
    late_total: invoice?.late_total != null ? String(invoice.late_total) : '',
    file: null as string | null,           // newly-uploaded base64; null = keep existing
    file_mime: invoice?.file_mime ?? '',
    file_name: invoice?.file_name ?? '',
    has_file: !!invoice?.has_file,
  });
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState('');
  const [lines, setLines] = useState<LineForm[]>(
    invoice?.lines.length
      ? invoice.lines.map((l) => ({
          utility_account_id: l.utility_account_id?.toString() ?? '',
          description: l.description ?? '',
          amount: l.amount?.toString() ?? '', usage_quantity: l.usage_quantity?.toString() ?? '',
          usage_unit: l.usage_unit ?? '',
        }))
      : [blankLine()]
  );
  const [err, setErr] = useState('');
  // Mark-paid mode: record a brand-new transaction, or link an existing one.
  const [payMode, setPayMode] = useState<'new' | 'link'>('new');
  const [linkTxnId, setLinkTxnId] = useState('');
  const [candidates, setCandidates] = useState<PayCandidate[]>([]);
  const num = (s: string) => (s === '' ? null : Number(s));

  const setLine = (i: number, patch: Partial<LineForm>) => setLines((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const pickAccount = (i: number, id: string) => {
    const acct = accounts.find((a) => String(a.id) === id);
    setLine(i, { utility_account_id: id, usage_unit: lines[i].usage_unit || acct?.usage_unit || '' });
  };
  // Typing the invoice total mirrors into a single default "Invoice total" line,
  // until the user builds a real breakdown (adds a line or names a charge).
  const onTotalChange = (v: string) => {
    setHead((h) => ({ ...h, total: v }));
    setLines((rows) => {
      const desc = rows[0]?.description ?? '';
      const isDefault = rows.length <= 1 && (desc === '' || desc === 'Invoice total');
      if (!isDefault) return rows;
      const base = rows[0] ?? blankLine();
      return [{ ...base, description: base.utility_account_id ? base.description : 'Invoice total', amount: v }];
    });
  };
  const linesTotal = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const statedTotal = head.total === '' ? null : Number(head.total);
  const totalMismatch = statedTotal != null && Math.abs(linesTotal - statedTotal) > 0.005;

  // Potential transactions to link as the payment (near this invoice's amount/date),
  // fetched lazily once "Link an existing transaction" is chosen.
  useEffect(() => {
    if (!head.paid || payMode !== 'link') return;
    const amount = statedTotal ?? linesTotal;
    const params = new URLSearchParams();
    if (amount) params.set('amount', String(amount));
    const d = head.paid_date || head.invoice_date;
    if (d) params.set('date', d);
    if (head.account_id) params.set('account_id', head.account_id);
    api.get<PayCandidate[]>(`/utilities/payment-candidates?${params.toString()}`).then(setCandidates).catch(() => setCandidates([]));
  }, [head.paid, payMode, head.total, head.paid_date, head.invoice_date, head.account_id, linesTotal]);
  const candidateLabel = (c: PayCandidate) => `${shortDate(c.txn_date)} · ${money(c.amount)} · ${c.merchant || c.description || c.account_name || 'transaction'}`;
  // Accounts a bill can be paid from (keep the current selection visible regardless).
  const payableAccounts = bankAccounts.filter((a) => isPayableFrom(a) || String(a.id) === head.account_id);

  const save = async () => {
    const validLines = lines.filter((l) => l.amount !== '' && Number(l.amount) >= 0);
    if (validLines.length === 0) { setErr('Add at least one line with an amount.'); return; }
    const sum = validLines.reduce((s, l) => s + Number(l.amount), 0);
    if (statedTotal != null && Math.abs(sum - statedTotal) > 0.005) {
      setErr(`The line breakdown (${money(sum)}) must match the invoice total (${money(statedTotal)}). Adjust the lines or the total.`);
      return;
    }
    if (head.paid && !invoice?.paid) {
      if (payMode === 'link') {
        if (!linkTxnId) { setErr('Select a transaction to link, or switch to “A new transaction”.'); return; }
      } else {
        if (!head.paid_date) { setErr('Enter the payment date to mark it paid.'); return; }
        if (!head.channel) { setErr('Choose how it was paid to mark it paid.'); return; }
      }
    }
    const body = {
      provider: head.provider || null,
      invoice_date: head.invoice_date || null,
      period_start: head.period_start || null,
      period_end: head.period_end || null,
      due_date: head.due_date || null,
      paid: head.paid,
      paid_date: head.paid ? (head.paid_date || todayStr()) : null,
      account_id: head.account_id ? Number(head.account_id) : null,
      channel: head.paid ? (head.channel || null) : null,
      payment_transaction_id: head.paid && payMode === 'link' && linkTxnId ? Number(linkTxnId) : null,
      notes: head.notes || null,
      late_total: head.late_total === '' ? null : Number(head.late_total),
      file: head.file, file_mime: head.file_mime || null, file_name: head.file_name || null,
      lines: validLines.map((l) => ({
        utility_account_id: l.utility_account_id ? Number(l.utility_account_id) : null,
        description: l.description || null,
        amount: Number(l.amount), usage_quantity: num(l.usage_quantity),
        usage_unit: l.usage_unit || null,
      })),
    };
    try {
      if (invoice) await api.put(`/utilities/invoices/${invoice.id}`, body);
      else await api.post('/utilities/invoices', body);
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  const remove = async () => {
    if (!invoice || !confirm('Delete this invoice and its lines?')) return;
    try { await api.del(`/utilities/invoices/${invoice.id}`); onSaved(); } catch (e: any) { setErr(e.message); }
  };

  // Reverse the "mark paid" convenience payment (real, categorized transactions are kept).
  const unpay = async () => {
    if (!invoice) return;
    try { await api.post(`/utilities/invoices/${invoice.id}/pay`, { paid: false }); onSaved(); } catch (e: any) { setErr(e.message); }
  };

  // Pre-fill the form from parsed invoice data (basic or AI), matching the bill
  // to a known utility account so the line is pre-selected.
  const applyParsed = (p: any) => {
    setHead((h) => ({
      ...h,
      provider: h.provider || p.provider || '',
      invoice_date: p.invoice_date || h.invoice_date,
      due_date: p.due_date || h.due_date,
      period_start: p.period_start || h.period_start,
      period_end: p.period_end || h.period_end,
      total: p.total != null ? String(p.total) : h.total,
      late_total: p.late_total != null ? String(p.late_total) : h.late_total,
    }));
    const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let acctId: number | null = p.account_id ?? null;
    if (!acctId && p.provider) {
      const key = norm(p.provider);
      const a = accounts.find((x) => {
        const n = norm(x.name), pr = norm(x.provider);
        return !!key && (n === key || (!!pr && pr === key) || (n.length >= 3 && (key.includes(n) || n.includes(key))));
      });
      acctId = a?.id ?? null;
    }
    const acctStr = acctId ? String(acctId) : '';
    if (Array.isArray(p.lines) && p.lines.length) {
      setLines(p.lines.map((l: any) => ({ utility_account_id: acctStr, description: l.description ?? '', amount: l.amount != null ? String(l.amount) : '', usage_quantity: '', usage_unit: '' })));
    } else if (p.total != null) {
      setLines([{ utility_account_id: acctStr, description: 'Invoice total', amount: String(p.total), usage_quantity: '', usage_unit: '' }]);
    }
  };

  // Upload a bill: store it and run the no-AI heuristic scan to pre-fill.
  const onPickFile = async (file?: File) => {
    if (!file) return;
    setParseMsg('');
    const { data, mime, name } = await fileToBase64(file);
    setHead((h) => ({ ...h, file: data, file_mime: mime, file_name: name, has_file: true }));
    setParsing(true);
    try {
      applyParsed(await api.post<any>('/utilities/invoices/parse-basic', { file: data, mime }));
      setParseMsg('Scanned — review the fields and assign each line to a utility account.');
    } catch (e: any) {
      setParseMsg(`File attached. ${e.message}`);
    } finally {
      setParsing(false);
    }
  };

  // Optional, higher-accuracy re-scan using the AI vision model.
  const scanWithAi = async () => {
    if (!head.file) return;
    setParseMsg('');
    setParsing(true);
    try {
      applyParsed(await api.post<any>('/utilities/invoices/parse', { file: head.file, mime: head.file_mime }));
      setParseMsg('Scanned with AI — review the fields.');
    } catch (e: any) {
      setParseMsg(`AI scan failed: ${e.message} The current values remain.`);
    } finally {
      setParsing(false);
    }
  };

  return (
    <Modal title={invoice ? 'Edit Invoice' : 'Add Invoice'} onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="card" style={{ padding: 12, marginBottom: 14, background: 'var(--surface-alt)' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="label" style={{ margin: 0 }}>Bill File</div>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            {head.file && <button className="ghost" style={{ padding: '4px 10px', fontSize: 13 }} disabled={parsing} onClick={scanWithAi}>Scan with AI</button>}
            <label className="ghost" style={{ cursor: 'pointer', padding: '4px 10px', border: '1px solid var(--hairline-strong)', borderRadius: 6, fontSize: 13 }}>
              {parsing ? 'Reading…' : (head.has_file ? 'Replace file' : 'Upload file')}
              <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={(e) => onPickFile(e.target.files?.[0])} />
            </label>
          </div>
        </div>
        {head.has_file && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {head.file_name || 'attached file'}
            {invoice && !head.file && <> · <a href={`/api/utilities/invoices/${invoice.id}/file`} target="_blank" rel="noreferrer">View original</a></>}
          </div>
        )}
        {parseMsg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{parseMsg}</div>}
        {!head.has_file && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Upload a PDF or image — it’s stored for review. PDFs are scanned automatically to pre-fill the fields (no AI needed); use “Scan with AI” for images or a cleaner read.</div>}
      </div>

      <div className="grid grid-3">
        <Field label="Provider / Biller"><input value={head.provider} onChange={(e) => setHead({ ...head, provider: e.target.value })} placeholder="e.g. City of Austin" /></Field>
        <Field label="Invoice Date"><input type="date" value={head.invoice_date} onChange={(e) => setHead({ ...head, invoice_date: e.target.value })} /></Field>
        <Field label="Due Date"><input type="date" value={head.due_date} onChange={(e) => setHead({ ...head, due_date: e.target.value })} /></Field>
      </div>
      <div className="grid grid-2">
        <Field label="Service Period Start"><input type="date" value={head.period_start} onChange={(e) => setHead({ ...head, period_start: e.target.value })} /></Field>
        <Field label="Service Period End"><input type="date" value={head.period_end} onChange={(e) => setHead({ ...head, period_end: e.target.value })} /></Field>
      </div>

      <div className="grid grid-2" style={{ marginTop: 4 }}>
        <Field label="Invoice Total (Due on Time)">
          <AmountInput value={head.total} onChange={(v) => onTotalChange(v)} placeholder="0.00" style={{ textAlign: 'right' }} />
        </Field>
        <Field label="Total if Paid Late">
          <AmountInput value={head.late_total} onChange={(v) => setHead({ ...head, late_total: v })} placeholder="(optional)" style={{ textAlign: 'right' }} />
        </Field>
      </div>
      <div style={{ fontSize: 12, marginTop: -2, marginBottom: 8 }}>
        {totalMismatch
          ? <span className="debit">The breakdown adds up to {money(linesTotal)}, which doesn’t match the invoice total of {money(statedTotal!)} (off by {money(Math.abs(linesTotal - statedTotal!))}). Adjust the lines so they match.</span>
          : statedTotal != null && linesTotal > 0
            ? <span style={{ color: 'var(--credit)' }}>✓ The breakdown matches the invoice total.</span>
            : <span className="muted">Enter the invoice total above; the breakdown below must add up to it. If unpaid after the due date, the outstanding amount switches to the late total.</span>}
      </div>

      <div className="label" style={{ marginTop: 8, marginBottom: 6 }}>Utilities on This Invoice</div>
      <div className="card" style={{ padding: 0 }}>
        <table className="ledger">
          <thead>
            <tr><th>Utility Account</th><th>Description / Charge</th><th className="r">Usage</th><th>Unit</th><th className="r">Amount</th><th></th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select value={l.utility_account_id} onChange={(e) => pickAccount(i, e.target.value)}>
                    <option value="">— none —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.utility_type})</option>)}
                  </select>
                </td>
                <td><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder={l.utility_account_id ? '(usage charge)' : 'e.g. Sewer, Base fee, Tax'} /></td>
                <td><input className="num-input" inputMode="decimal" value={l.usage_quantity} onChange={(e) => setLine(i, { usage_quantity: e.target.value })} style={{ width: 80, textAlign: 'right' }} /></td>
                <td><input value={l.usage_unit} onChange={(e) => setLine(i, { usage_unit: e.target.value })} style={{ width: 64 }} /></td>
                <td><AmountInput value={l.amount} onChange={(v) => setLine(i, { amount: v })} placeholder="0.00" style={{ width: 88, textAlign: 'right' }} /></td>
                <td className="r"><button className="ghost" onClick={() => setLines((rows) => rows.filter((_, idx) => idx !== i))}>✕</button></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={4} className="r muted">Breakdown total</td><td className={`r money num ${totalMismatch ? 'debit' : ''}`}>{money(linesTotal)}</td><td></td></tr>
          </tfoot>
        </table>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="ghost" onClick={() => setLines((rows) => [...rows, blankLine()])}>Add Line</button>
      </div>

      <Field label="Notes"><input value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></Field>

      <div className="label" style={{ marginTop: 14, marginBottom: 6 }}>Payment</div>
      {invoice && Number(invoice.amount_paid) > 0.005 && !head.paid && (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <span style={{ color: 'var(--credit)' }}>{money(invoice.amount_paid)} paid so far</span>
          <span className="muted"> · {money(Math.max(0, linesTotal - Number(invoice.amount_paid)))} outstanding</span>
        </div>
      )}
      <label className="row" style={{ gap: 6, alignItems: 'center', marginBottom: head.paid ? 10 : 0 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={head.paid} onChange={(e) => setHead({ ...head, paid: e.target.checked, paid_date: e.target.checked ? (head.paid_date || todayStr()) : head.paid_date })} />
        <span>{invoice && Number(invoice.amount_paid) > 0.005 && !head.paid ? 'Mark fully paid (record the remaining balance)' : 'Mark as paid'}</span>
      </label>
      {head.paid && (
        <>
          <Field label="Record As">
            <select value={payMode} onChange={(e) => setPayMode(e.target.value as 'new' | 'link')}>
              <option value="new">A new transaction</option>
              <option value="link">Link an existing transaction</option>
            </select>
          </Field>
          {payMode === 'new' ? (
            <div className="grid grid-3">
              <Field label="Paid Date"><input type="date" value={head.paid_date} onChange={(e) => setHead({ ...head, paid_date: e.target.value })} /></Field>
              <Field label="From Account">
                <select value={head.account_id} onChange={(e) => setHead({ ...head, account_id: e.target.value })}>
                  <option value="">—</option>
                  {payableAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="How Paid">
                <select value={head.channel} onChange={(e) => setHead({ ...head, channel: e.target.value })}>
                  <option value="">—</option>
                  {PAY_CHANNELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </Field>
            </div>
          ) : (
            <Field label="Linked Transaction">
              <select value={linkTxnId} onChange={(e) => setLinkTxnId(e.target.value)}>
                <option value="">Select a transaction…</option>
                {candidates.map((c) => <option key={c.id} value={c.id}>{candidateLabel(c)}</option>)}
              </select>
              {candidates.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No matching transactions found near that amount and date.</div>}
            </Field>
          )}
        </>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: head.paid ? 4 : 8 }}>
        {head.paid && payMode === 'link'
          ? 'Links the chosen transaction as this invoice’s payment — no new transaction is created.'
          : 'Marking it paid records an expense transaction for the remaining balance (auto-filed under the utility’s category). Partial payments also accumulate on their own from any transaction you categorize to this utility.'}
      </div>

      <EditorFooter onClose={onClose} onSave={save} onDelete={invoice ? remove : undefined}
        saveLabel={invoice ? 'Save Invoice' : 'Add Invoice'}
        extra={invoice?.paid ? <button className="ghost" onClick={unpay}>Unpay</button> : undefined} />
    </Modal>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api, money, todayStr } from '../../api';
import { Field, Modal, fileToBase64, EditorFooter, AmountInput } from '../../components/ui';
import { CHANNEL_OPTIONS } from '../../components/txnFilters';
import {
  type Txn, type SimilarTxn, type Tag, type Lookups,
  type LineForm, type Item, type ReceiptState,
  businessDay, merchantKey, standardizeMerchant, lineFromSplit, blankItem, emptyReceipt, ITEM_CATEGORIES,
} from './helpers';
import { categoryOptions } from './common';
import { TagPicker } from './TagPicker';
import { ApplyToSimilarModal } from './ApplyToSimilarModal';

export function TxnEditor({
  txn, lookups, purchasers, merchants, initialTags, initialAccountId, seed, confirmStaged, convertPair, onClose, onSaved,
}: {
  txn: Txn | null;
  lookups: Lookups;
  purchasers: string[];
  merchants: string[];
  // Tags to pre-apply on a NEW transaction (e.g. opened from a vehicle's tab).
  initialTags?: Tag[];
  // Account to pre-select on a NEW transaction (e.g. opened from an account's tab).
  initialAccountId?: number;
  // Pre-fill the form for a NEW transaction from this source (e.g. a staged import
  // row), without treating it as an existing transaction (so save creates, not edits).
  seed?: Partial<Txn> | null;
  // When confirming a staged review row in the full editor: carries the staged id to
  // remove on save, plus its provider provenance so the created transaction keeps the
  // source/external_id needed for SimpleFIN dedup.
  confirmStaged?: { id: number; source: string | null; external_id: string | null } | null;
  // Confirming a "possible transfer": the two detected transactions are merged into one
  // transfer (atomic, preserves provider dedup) on save, then the form's edits are applied.
  convertPair?: { out_id: number; in_id: number } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Form pre-fills from an existing txn, else a seed (e.g. a staged row); `txn`
  // still drives whether save updates (PUT) or creates (POST).
  const src: Partial<Txn> | null = txn ?? seed ?? null;
  const [f, setF] = useState({
    txn_date: src?.txn_date?.slice(0, 10) ?? todayStr(),
    pending: txn ? !txn.posted_date : false,
    posted_date: src?.posted_date?.slice(0, 10) ?? src?.txn_date?.slice(0, 10) ?? todayStr(),
    direction: src?.direction ?? 'expense',
    amount: src?.amount?.toString() ?? '',
    merchant: src?.merchant ?? '',
    description: src?.description ?? '',
    purchaser: src?.purchaser ?? '',
    channel: src?.channel ?? '',
    account_id: src?.account_id?.toString() ?? (initialAccountId != null ? String(initialAccountId) : ''),
    transfer_account_id: src?.transfer_account_id?.toString() ?? '',
  });
  const isTransfer = f.direction === 'transfer';
  // A transfer into a liability (e.g. a loan/mortgage payment) uses the same
  // split-by-category lines as a normal transaction, with a per-line "Principal"
  // flag marking which lines pay down the loan; the rest (interest/escrow/fees)
  // are expenses.
  const fromAccount = lookups.accounts.find((a) => String(a.id) === f.account_id);
  const fromName = fromAccount?.name;
  const toAccount = lookups.accounts.find((a) => String(a.id) === f.transfer_account_id);
  const showPrincipal = isTransfer && !!toAccount?.is_liability;
  const toName = toAccount?.name || 'the account';
  // Loan-type accounts bundle interest into the payment, so breaking the payment
  // into lines is recommended; a credit card's interest is already its own charge,
  // so its payment is normally just the full balance reduction.
  const toIsLoan = toAccount?.type === 'loan' || toAccount?.type === 'mortgage';

  // Merchant standardization: on blur, snap a variant spelling to its canonical
  // form, show a note, and let the user undo it.
  const [merchantNote, setMerchantNote] = useState<{ from: string } | null>(null);
  const [ignoring, setIgnoring] = useState(false);
  const noStdRef = useRef('');
  const setMerchant = (v: string) => {
    setF((p) => ({ ...p, merchant: v }));
    if (merchantNote) setMerchantNote(null);
    if (noStdRef.current && merchantKey(v) !== noStdRef.current) noStdRef.current = '';
  };
  const standardizeOnBlur = () => {
    const original = f.merchant.trim();
    if (!original || (noStdRef.current && merchantKey(original) === noStdRef.current)) return;
    const { value, changed } = standardizeMerchant(f.merchant, merchants);
    if (value !== f.merchant) setF((p) => ({ ...p, merchant: value }));
    if (changed) setMerchantNote({ from: original });
  };
  const undoMerchant = () => {
    if (!merchantNote) return;
    noStdRef.current = merchantKey(merchantNote.from); // don't re-standardize what they undid
    setF((p) => ({ ...p, merchant: merchantNote.from }));
    setMerchantNote(null);
  };

  // The line table is the default view: one line for a simple transaction, more
  // for a split. A single line maps to transaction-level category + tags on save.
  const [lines, setLines] = useState<LineForm[]>(() => {
    if (txn?.has_splits) return txn.splits.map(lineFromSplit);
    // Legacy single-field loan payment → reconstruct principal + interest lines so
    // it opens in the unified breakdown UI.
    if (txn?.direction === 'transfer' && txn.principal_amount != null) {
      const interest = Number(txn.amount) - Number(txn.principal_amount);
      const ls: LineForm[] = [{ category_id: '', tags: [], amount: String(txn.principal_amount), is_principal: true }];
      if (interest > 0.005) ls.push({ category_id: txn.interest_category_id?.toString() ?? '', tags: [], amount: interest.toFixed(2), is_principal: false });
      return ls;
    }
    return [{ category_id: src?.category_id?.toString() ?? '', tags: src?.tags ?? initialTags ?? [], amount: src?.amount?.toString() ?? '', is_principal: true }];
  });
  const setLine = (i: number, patch: Partial<LineForm>) => setLines((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const isSplit = lines.length > 1;
  const lineTotal = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const remaining = (Number(f.amount) || 0) - lineTotal;
  const principalTotal = isSplit
    ? lines.reduce((s, l) => s + (l.is_principal && l.amount !== '' ? (Number(l.amount) || 0) : 0), 0)
    : (lines[0]?.is_principal ? (Number(f.amount) || 0) : 0);

  const addLine = () => setLines((rows) => {
    // Going single -> split: seed the existing line's amount with the full total.
    const seeded = rows.length === 1 && rows[0].amount === '' ? [{ ...rows[0], amount: f.amount }] : rows;
    // Added lines default to non-principal (interest/escrow/fees).
    return [...seeded, { category_id: '', tags: [], amount: '', is_principal: false }];
  });

  // Receipt captured inline. Loaded for existing transactions; empty for new.
  const [receipt, setReceipt] = useState<ReceiptState>(emptyReceipt());
  const [showReceipt, setShowReceipt] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [receiptMsg, setReceiptMsg] = useState('');
  // Baseline snapshot for change detection (set on first render / after load).
  const baseline = useRef<string | null>(null);

  useEffect(() => {
    if (!txn) return;
    api.get<any>(`/transactions/${txn.id}/receipt`).then((r) => {
      if (!r) return;
      const loaded: ReceiptState = {
        merchant: r.merchant ?? '', purchased_at: r.purchased_at?.slice(0, 10) ?? '',
        subtotal: r.subtotal?.toString() ?? '', tax: r.tax?.toString() ?? '', total: r.total?.toString() ?? '',
        notes: r.notes ?? '', image: null, image_mime: r.image_mime ?? null, original_name: r.original_name ?? null, has_image: !!r.has_image,
        items: r.items?.length ? r.items.map((it: any) => ({
          name: it.name ?? '', brand: it.brand ?? '', category: it.category ?? '',
          size: it.size?.toString() ?? '', unit: it.unit ?? '', product_category: it.product_category ?? '',
          quantity: it.quantity?.toString() ?? '1', unit_price: it.unit_price?.toString() ?? '', total_price: it.total_price?.toString() ?? '',
        })) : [blankItem()],
      };
      setReceipt(loaded);
      setShowReceipt(true);
      // Fold the loaded receipt into the change baseline so just opening an
      // existing transaction doesn't count as a change.
      baseline.current = JSON.stringify({ f, lines, receipt: loaded });
    }).catch(() => {});
  }, [txn]);

  const [err, setErr] = useState('');
  // After saving an edit, optionally offer to apply a merchant/category change
  // to other transactions that look like the same merchant.
  const [propagate, setPropagate] = useState<{
    oldMerchant: string; newMerchant: string; merchantChanged: boolean; categoryChanged: boolean;
    newCategoryId: number | null; newCategoryName: string | null; matches: SimilarTxn[];
  } | null>(null);

  // Enable Save/Add only when something actually changed from the loaded state.
  const snapshot = JSON.stringify({ f, lines, receipt });
  if (baseline.current === null) baseline.current = snapshot;
  const dirty = snapshot !== baseline.current;

  const setItem = (i: number, patch: Partial<Item>) => setReceipt((r) => ({ ...r, items: r.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));
  const numOrNull = (s: string) => (s === '' ? null : Number(s));

  // Ask the AI to derive brand / category / size / unit from the item names (no image
  // needed). Only fills fields that are still blank, so manual entries aren't overwritten.
  const enrichItems = async () => {
    const named = receipt.items.map((it, i) => ({ i, name: it.name.trim() })).filter((x) => x.name);
    if (!named.length) return;
    setEnriching(true); setReceiptMsg('');
    try {
      const res = await api.post<{ items: any[] }>('/transactions/enrich-items', { items: named.map((x) => ({ name: x.name })) });
      setReceipt((r) => {
        const items = r.items.map((it) => ({ ...it }));
        named.forEach((x, k) => {
          const e = res.items?.[k]; if (!e) return;
          const it = items[x.i];
          if (e.brand != null && !it.brand) it.brand = String(e.brand);
          if (e.category && !it.category) it.category = String(e.category);
          if (e.size != null && !it.size) it.size = String(e.size);
          if (e.unit != null && !it.unit) it.unit = String(e.unit);
        });
        return { ...r, items };
      });
      setReceiptMsg('Filled in brand, category and size where they were blank. Review before saving.');
    } catch (e: any) { setReceiptMsg(e.message); } finally { setEnriching(false); }
  };

  const onPickImage = async (file: File | undefined) => {
    if (!file) return;
    setReceiptMsg('');
    try {
      const { data, mime, name } = await fileToBase64(file);
      setReceipt((r) => ({ ...r, image: data, image_mime: mime, original_name: name, has_image: true }));
      setParsing(true);
      try {
        const parsed = await api.post<any>('/transactions/parse-receipt', { image: data, mime });
        setReceipt((r) => ({
          ...r,
          merchant: parsed.merchant ?? r.merchant,
          purchased_at: parsed.purchased_at ?? r.purchased_at,
          subtotal: parsed.subtotal?.toString() ?? r.subtotal,
          tax: parsed.tax?.toString() ?? r.tax,
          total: parsed.total?.toString() ?? r.total,
          items: Array.isArray(parsed.items) && parsed.items.length
            ? parsed.items.map((it: any) => ({
                name: it.name ?? '', brand: it.brand ?? '', category: it.category ?? '',
                size: it.size?.toString() ?? '', unit: it.unit ?? '', product_category: it.product_category ?? '',
                quantity: it.quantity?.toString() ?? '1', unit_price: it.unit_price?.toString() ?? '', total_price: it.total_price?.toString() ?? '',
              }))
            : r.items,
        }));
        // Auto-fill the transaction fields from the receipt (date, merchant, amount).
        setF((prev) => {
          const date = parsed.purchased_at ? String(parsed.purchased_at).slice(0, 10) : prev.txn_date;
          return {
            ...prev,
            amount: parsed.total != null ? String(parsed.total) : prev.amount,
            merchant: parsed.merchant || prev.merchant,
            txn_date: date,
            // Keep the posted date in step for a new, non-pending transaction.
            posted_date: (!txn && !prev.pending && parsed.purchased_at) ? businessDay(date) : prev.posted_date,
          };
        });
        setReceiptMsg('Receipt read — filled in the date, merchant and amount above. Review the items below.');
      } catch (e: any) {
        setReceiptMsg(`File attached, but couldn't auto-read it: ${e.message} You can enter items manually.`);
      } finally {
        setParsing(false);
      }
    } catch (e: any) {
      setReceiptMsg(e.message);
    }
  };

  const receiptHasContent = () =>
    receipt.has_image || receipt.image || receipt.merchant || receipt.total || receipt.items.some((it) => it.name.trim());

  const save = async () => {
    const amt = Number(f.amount);
    if (!amt || amt <= 0) { setErr('Amount must be greater than 0.'); return; }
    if (isTransfer) {
      if (!f.account_id || !f.transfer_account_id) { setErr('Pick both a From and a To account.'); return; }
      if (f.account_id === f.transfer_account_id) { setErr('From and To accounts must differ.'); return; }
    }

    // Transfers into a liability use the same line breakdown as a normal
    // transaction; the principal-flagged lines are what reduce the loan balance.
    const usesLines = !isTransfer || showPrincipal;
    let splitPayload: any[] = [];
    let txnCategory: number | null = null;
    let txnTags: Tag[] = [];
    if (usesLines) {
      if (isSplit) {
        const valid = lines.filter((l) => l.amount !== '' && Number(l.amount) > 0);
        if (valid.length < 2) { setErr('A split needs at least two lines with amounts.'); return; }
        if (Math.abs(amt - valid.reduce((s, l) => s + Number(l.amount), 0)) > 0.005) { setErr(`Lines must add up to ${money(amt)}.`); return; }
        splitPayload = valid.map((l) => ({
          amount: Number(l.amount),
          category_id: l.category_id ? Number(l.category_id) : null,
          is_principal: showPrincipal ? !!l.is_principal : false,
          tags: l.tags.map((t) => ({ kind: t.kind, ref_id: t.ref_id })),
        }));
      } else if (showPrincipal) {
        // Single-line loan payment: persist one split so its principal flag is kept.
        splitPayload = [{
          amount: amt,
          category_id: lines[0].category_id ? Number(lines[0].category_id) : null,
          is_principal: !!lines[0].is_principal,
          tags: [],
        }];
      } else {
        txnCategory = lines[0].category_id ? Number(lines[0].category_id) : null;
        txnTags = lines[0].tags;
      }
    }

    const body = {
      txn_date: f.txn_date,
      posted_date: f.pending ? null : (f.posted_date || f.txn_date || todayStr()),
      direction: f.direction,
      amount: amt,
      merchant: f.merchant || null,
      description: f.description || null,
      purchaser: f.purchaser.trim() || null,
      channel: isTransfer ? null : (f.channel || null),
      account_id: f.account_id ? Number(f.account_id) : null,
      transfer_account_id: isTransfer && f.transfer_account_id ? Number(f.transfer_account_id) : null,
      // Principal now lives on the split lines (is_principal); clear the legacy fields.
      principal_amount: null,
      interest_category_id: null,
      category_id: txnCategory,
      tags: txnTags.map((t) => ({ kind: t.kind, ref_id: t.ref_id })),
      splits: splitPayload,
      // Preserve provider provenance when confirming a staged import via the full
      // editor, so SimpleFIN dedup keeps working on future syncs.
      ...(confirmStaged ? { source: confirmStaged.source, external_id: confirmStaged.external_id } : {}),
    };
    try {
      // Converting a possible transfer: merge the two detected transactions into one
      // transfer first (handles deletes + provider dedup), then PUT the form so any edits
      // the user made in this window are applied to the resulting transfer.
      let editId: number | null = txn?.id ?? null;
      if (convertPair && !txn) {
        const created = await api.post<any>('/transactions/transfer-suggestions/confirm', { out_id: convertPair.out_id, in_id: convertPair.in_id });
        editId = created?.id ?? null;
      }
      const saved = editId ? await api.put<any>(`/transactions/${editId}`, body) : await api.post<any>('/transactions', body);
      const id = saved.id ?? editId;
      if (id && !isTransfer && receiptHasContent()) {
        await api.put(`/transactions/${id}/receipt`, {
          merchant: receipt.merchant || null,
          purchased_at: receipt.purchased_at || null,
          subtotal: numOrNull(receipt.subtotal), tax: numOrNull(receipt.tax), total: numOrNull(receipt.total),
          notes: receipt.notes || null,
          image: receipt.image, image_mime: receipt.image_mime, original_name: receipt.original_name,
          items: receipt.items.filter((it) => it.name.trim()).map((it) => ({
            name: it.name.trim(), brand: it.brand.trim() || null, category: it.category || null,
            size: numOrNull(it.size), unit: it.unit.trim() || null, product_category: it.product_category || null,
            quantity: numOrNull(it.quantity) ?? 1, unit_price: numOrNull(it.unit_price),
            total_price: numOrNull(it.total_price) ?? (numOrNull(it.unit_price) != null ? Number(it.unit_price) * (numOrNull(it.quantity) ?? 1) : null),
          })),
        });
      }

      // Offer to apply a merchant rename and/or category change to other
      // transactions that look like the same merchant (existing edits only).
      const oldMerchant = (txn?.merchant ?? '').trim();
      const newMerchant = f.merchant.trim();
      const merchantChanged = !!txn && !!newMerchant && newMerchant.toLowerCase() !== oldMerchant.toLowerCase();
      const newCatId = !isTransfer && !isSplit && lines[0].category_id ? Number(lines[0].category_id) : null;
      const categoryChanged = !!txn && !isTransfer && !isSplit && String(newCatId ?? '') !== String(txn.category_id ?? '');
      if (txn && oldMerchant && (merchantChanged || categoryChanged)) {
        try {
          const { transactions: matches } = await api.post<{ transactions: SimilarTxn[] }>('/transactions/similar', {
            merchant: oldMerchant, exclude_id: txn.id, new_merchant: merchantChanged ? newMerchant : null,
          });
          if (matches.length) {
            setPropagate({
              oldMerchant, newMerchant, merchantChanged, categoryChanged,
              newCategoryId: newCatId,
              newCategoryName: newCatId != null ? (lookups.categories.find((c) => c.id === newCatId)?.name ?? null) : null,
              matches,
            });
            return; // keep the editor open until the user decides
          }
        } catch { /* non-fatal — just close */ }
      }
      // Confirming a staged review row: the real transaction now exists, so remove the
      // staged row from the review queue.
      if (confirmStaged) { try { await api.del(`/imports/staged/${confirmStaged.id}`); } catch { /* leave for manual cleanup */ } }
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  const remove = async () => {
    if (!txn || !confirm('Delete this transaction?')) return;
    try { await api.del(`/transactions/${txn.id}`); onSaved(); } catch (e: any) { setErr(e.message); }
  };
  // Convert-mode only: dismiss the transfer suggestion (it's not actually a transfer).
  const ignoreTransfer = async () => {
    if (!convertPair) return;
    setIgnoring(true); setErr('');
    try { await api.post('/transactions/transfer-suggestions/ignore', { out_id: convertPair.out_id, in_id: convertPair.in_id }); onSaved(); }
    catch (e: any) { setErr(e.message); setIgnoring(false); }
  };

  const itemsTotal = receipt.items.reduce((s, it) => s + (Number(it.total_price) || (Number(it.unit_price) || 0) * (Number(it.quantity) || 0)), 0);

  return (
    <Modal title={txn ? 'Edit Transaction' : confirmStaged ? 'Review & Add Transaction' : 'Add Transaction'} onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      {/* Receipt at the top: uploading one auto-fills the form below. */}
      {!isTransfer && (
        <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          {!showReceipt && (
            <span className="muted" style={{ fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setShowReceipt(true)}>
              enter receipt manually
            </span>
          )}
          <label className="ghost" style={{ cursor: 'pointer', padding: '6px 12px', border: '1px solid var(--hairline-strong)', borderRadius: 6, fontSize: 13, fontWeight: 600 }}>
            {parsing ? 'Reading receipt…' : (receiptHasContent() ? '🧾 Replace receipt' : '🧾 Add receipt — auto-fills the form')}
            <input type="file" accept="image/*,application/pdf,.pdf" style={{ display: 'none' }}
              onChange={(e) => { setShowReceipt(true); onPickImage(e.target.files?.[0]); }} />
          </label>
        </div>
      )}

      {/* Primary: date, direction, amount */}
      <div className="grid grid-3">
        <Field label="Date"><input type="date" value={f.txn_date} onChange={(e) => setF((cur) => ({ ...cur, txn_date: e.target.value, ...(txn ? {} : { posted_date: businessDay(e.target.value) }) }))} /></Field>
        <Field label="Direction">
          <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as any })}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </select>
        </Field>
        <Field label="Amount"><AmountInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} placeholder="0.00" /></Field>
      </div>

      {/* Account + status near the top */}
      <div className="grid grid-3">
        <Field label={isTransfer ? 'From account' : 'Account'}>
          <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
            <option value="">—</option>
            {lookups.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        {isTransfer ? (
          <Field label="To Account">
            <select value={f.transfer_account_id} onChange={(e) => setF({ ...f, transfer_account_id: e.target.value })}>
              <option value="">—</option>
              {lookups.accounts.filter((a) => String(a.id) !== f.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Status">
            <select value={f.pending ? 'pending' : 'posted'} onChange={(e) => setF({ ...f, pending: e.target.value === 'pending' })}>
              <option value="posted">Posted</option>
              <option value="pending">Pending</option>
            </select>
          </Field>
        )}
        {!f.pending && !isTransfer ? (
          <Field label="Posted Date"><input type="date" value={f.posted_date} onChange={(e) => setF({ ...f, posted_date: e.target.value })} /></Field>
        ) : isTransfer ? (
          <Field label="Status">
            <select value={f.pending ? 'pending' : 'posted'} onChange={(e) => setF({ ...f, pending: e.target.value === 'pending' })}>
              <option value="posted">Posted</option>
              <option value="pending">Pending</option>
            </select>
          </Field>
        ) : <div />}
      </div>

      {/* Secondary: merchant, purchaser, channel */}
      <div className={isTransfer ? 'grid grid-2' : 'grid grid-3'}>
        <Field label="Merchant">
          <input list="txn-merchants" value={f.merchant} onChange={(e) => setMerchant(e.target.value)} onBlur={standardizeOnBlur} placeholder="Where the money went" />
          <datalist id="txn-merchants">{merchants.map((m) => <option key={m} value={m} />)}</datalist>
          {merchantNote && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              ✓ Standardized from “{merchantNote.from}”.{' '}
              <span style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={undoMerchant}>Undo</span>
            </div>
          )}
        </Field>
        <Field label="Purchaser">
          <input list="txn-purchasers" value={f.purchaser} onChange={(e) => setF({ ...f, purchaser: e.target.value })} placeholder="Who made the purchase" />
          <datalist id="txn-purchasers">{purchasers.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        {!isTransfer && (
          <Field label="Channel">
            <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value as any })}>
              <option value="">—</option>
              {CHANNEL_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
        )}
      </div>

      {/* Plain-language summary of what a transfer does, shown for every transfer
          once a destination is chosen. Liabilities also get the split breakdown. */}
      {isTransfer && toAccount && (
        <div className="banner" style={{ marginBottom: 12 }}>
          {!toAccount.is_liability
            ? <>This transfer increases the balance of <strong>{toName}</strong> by the full amount{fromName ? <>, moved from <strong>{fromName}</strong></> : ''}.</>
            : toIsLoan
              ? <>Paying down <strong>{toName}</strong>? Adding lines is recommended — break out interest, escrow, or fees and tick <strong>Reduces balance</strong> only on the amount that pays down what you owe. The rest is recorded as an expense.</>
              : <>This payment reduces the balance of <strong>{toName}</strong>{fromName ? <>, paid from <strong>{fromName}</strong></> : ''}. Leave it as one line for a full payment; if part of it isn’t paying down the balance, add lines and untick <strong>Reduces balance</strong> on those.</>}
        </div>
      )}

      {/* Lines table — split by category. A transfer into a liability also gets a
          "Reduces balance" checkbox marking the lines that pay down the account. */}
      {(!isTransfer || showPrincipal) && (
        <div style={{ marginTop: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div className="label">
              {showPrincipal
                ? (isSplit ? `Payment breakdown — tick the lines that reduce ${toName}’s balance (must add up to the amount)` : `Payment breakdown — tick if this reduces ${toName}’s balance, or add lines`)
                : (isSplit ? 'Lines — each with its own category & tags (must add up to the amount)' : 'Category & tags')}
            </div>
            {isSplit && <span className="muted num" style={{ fontSize: 12 }}>{money(lineTotal)}{Math.abs(remaining) > 0.005 && <span className="debit"> · {remaining > 0 ? `${money(remaining)} left` : `${money(-remaining)} over`}</span>}</span>}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <thead><tr><th>Category</th>{showPrincipal ? <th style={{ width: 120, textAlign: 'center' }}>Reduces Balance</th> : <th>Tags</th>}<th className="r" style={{ width: 120 }}>Amount</th><th></th></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <select value={l.category_id} onChange={(e) => setLine(i, { category_id: e.target.value })}>
                        <option value="">{showPrincipal ? '— (e.g. interest, escrow)' : '—'}</option>
                        {categoryOptions(lookups.categories, isTransfer ? 'expense' : (f.direction as 'expense' | 'income'))}
                      </select>
                    </td>
                    {showPrincipal ? (
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={!!l.is_principal}
                          title={`This line reduces ${toName}’s balance`}
                          onChange={(e) => setLine(i, { is_principal: e.target.checked })} />
                      </td>
                    ) : (
                      <td><TagPicker tags={l.tags} onChange={(tags) => setLine(i, { tags })} lookups={lookups} compact /></td>
                    )}
                    <td>
                      <AmountInput value={isSplit ? l.amount : f.amount}
                        disabled={!isSplit}
                        onChange={(v) => setLine(i, { amount: v })}
                        placeholder="0.00" style={{ width: 100, textAlign: 'right' }} />
                    </td>
                    <td className="r">{isSplit && <button className="ghost" onClick={() => setLines((rows) => rows.filter((_, idx) => idx !== i))}>✕</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 8, justifyContent: 'space-between', alignItems: 'baseline' }}>
            <button className="ghost" onClick={addLine}>+ Add {showPrincipal ? 'Line' : 'Split'}</button>
            {showPrincipal && (
              <span className="muted num" style={{ fontSize: 12 }}>
                Reduces balance {money(principalTotal)} · expenses {money(Math.max(0, (Number(f.amount) || 0) - principalTotal))}
              </span>
            )}
          </div>
          {showPrincipal && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Only lines marked <strong>Reduces balance</strong> pay down <strong>{toName}</strong>; the rest are recorded as expenses under their category.
            </div>
          )}
        </div>
      )}

      <Field label="Description / Note"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>

      {/* Receipt — upload an image to auto-itemize, or enter by hand */}
      {!isTransfer && showReceipt && (
        <div style={{ marginTop: 6 }}>
            <div className="card" style={{ padding: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div className="label" style={{ margin: 0 }}>Receipt</div>
                <label className="ghost" style={{ cursor: 'pointer', padding: '4px 10px', border: '1px solid var(--hairline-strong)', borderRadius: 6, fontSize: 13 }}>
                  {parsing ? 'Reading…' : (receipt.has_image ? 'Replace' : 'Upload image or PDF')}
                  <input type="file" accept="image/*,application/pdf,.pdf" style={{ display: 'none' }} onChange={(e) => onPickImage(e.target.files?.[0])} />
                </label>
              </div>
              {receiptMsg && <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{receiptMsg}</div>}
              {receipt.has_image && (() => {
                const isPdf = receipt.image_mime === 'application/pdf' || (receipt.original_name?.toLowerCase().endsWith('.pdf') ?? false);
                const src = receipt.image
                  ? `data:${receipt.image_mime || 'application/octet-stream'};base64,${receipt.image}`
                  : (txn ? `/api/transactions/${txn.id}/receipt/image` : null);
                return (
                <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 10 }}>
                  {isPdf
                    ? (src && <a className="tag receipt" href={src} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', padding: '4px 10px' }}>📄 View PDF</a>)
                    : (src && <img src={src} alt="receipt" style={{ maxHeight: 90, borderRadius: 6, border: '1px solid var(--hairline)' }} />)}
                  <span className="muted" style={{ fontSize: 12 }}>{receipt.original_name || (isPdf ? 'stored PDF' : 'stored file')}</span>
                </div>
                );
              })()}
              <div className="grid grid-3">
                <Field label="Merchant"><input value={receipt.merchant} onChange={(e) => setReceipt({ ...receipt, merchant: e.target.value })} /></Field>
                <Field label="Purchased"><input type="date" value={receipt.purchased_at} onChange={(e) => setReceipt({ ...receipt, purchased_at: e.target.value })} /></Field>
                <Field label="Total"><AmountInput value={receipt.total} onChange={(v) => setReceipt({ ...receipt, total: v })} /></Field>
                <Field label="Subtotal"><AmountInput value={receipt.subtotal} onChange={(v) => setReceipt({ ...receipt, subtotal: v })} /></Field>
                <Field label="Tax"><AmountInput value={receipt.tax} onChange={(v) => setReceipt({ ...receipt, tax: v })} /></Field>
                <Field label="Notes"><input value={receipt.notes} onChange={(e) => setReceipt({ ...receipt, notes: e.target.value })} /></Field>
              </div>
              <div className="label" style={{ marginTop: 8, marginBottom: 6 }}>Itemized products</div>
              <div className="card" style={{ padding: 0 }}>
                <table className="ledger">
                  <thead><tr><th>Product</th><th>Brand</th><th>Category</th><th>Size</th><th className="r">Qty</th><th className="r">Unit $</th><th className="r">Total</th><th></th></tr></thead>
                  <tbody>
                    {receipt.items.map((it, i) => (
                      <tr key={i}>
                        <td><input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder="Item name" /></td>
                        <td><input value={it.brand} onChange={(e) => setItem(i, { brand: e.target.value })} placeholder="brand" style={{ width: 110 }} /></td>
                        <td>
                          <select value={it.category} onChange={(e) => setItem(i, { category: e.target.value })}>
                            <option value="">—</option>
                            {ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <input className="num-input" inputMode="decimal" value={it.size} onChange={(e) => setItem(i, { size: e.target.value })} placeholder="size" style={{ width: 52, textAlign: 'right' }} />
                            <input value={it.unit} onChange={(e) => setItem(i, { unit: e.target.value })} placeholder="oz" style={{ width: 48 }} />
                          </div>
                        </td>
                        <td><input className="num-input" inputMode="decimal" value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} style={{ width: 48, textAlign: 'right' }} /></td>
                        <td><AmountInput value={it.unit_price} onChange={(v) => setItem(i, { unit_price: v })} style={{ width: 80, textAlign: 'right' }} /></td>
                        <td><AmountInput value={it.total_price} onChange={(v) => setItem(i, { total_price: v })} placeholder="auto" style={{ width: 80, textAlign: 'right' }} /></td>
                        <td className="r"><button className="ghost" onClick={() => setReceipt((r) => ({ ...r, items: r.items.filter((_, idx) => idx !== i) }))}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={6} className="r muted">Items total</td><td className="r money num">{money(itemsTotal)}</td><td></td></tr>
                  </tfoot>
                </table>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="ghost" onClick={() => setReceipt((r) => ({ ...r, items: [...r.items, blankItem()] }))}>Add Line Item</button>
                <button className="ghost" onClick={enrichItems} disabled={enriching || !receipt.items.some((it) => it.name.trim())}>{enriching ? 'Filling…' : 'Fill Details with AI'}</button>
              </div>
            </div>
        </div>
      )}

      {convertPair ? (
        <>
          <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
            <button className="ghost" onClick={onClose} disabled={ignoring}>Close</button>
            <div className="spacer" />
            <button className="ghost" onClick={ignoreTransfer} disabled={ignoring}
              title="Stop suggesting this — it's not a transfer"
              style={{ color: 'var(--debit)', borderColor: 'var(--debit)' }}>
              {ignoring ? 'Ignoring…' : "Ignore — it's not a transfer"}
            </button>
            <button onClick={save} disabled={ignoring}>Confirm Transfer</button>
          </div>
          <p className="muted" style={{ fontSize: 11, textAlign: 'right', marginTop: 6, marginBottom: 0 }}>
            Closing (or clicking outside) leaves it as a potential transfer.
          </p>
        </>
      ) : (
        <EditorFooter
          onClose={onClose}
          onSave={save}
          onDelete={txn ? remove : undefined}
          saveLabel={txn ? 'Save Changes' : 'Add'}
          disabled={!dirty}
        />
      )}

      {propagate && (
        <ApplyToSimilarModal
          {...propagate}
          onClose={() => setPropagate(null)}
          onApply={async ({ ids }) => {
            try {
              const payload: any = { ids };
              if (propagate.merchantChanged) payload.merchant = propagate.newMerchant;
              if (propagate.categoryChanged) payload.category_id = propagate.newCategoryId;
              await api.post('/transactions/bulk-update', payload);
            } catch (e: any) { setErr(e.message); }
            setPropagate(null);
            onSaved();
          }}
        />
      )}
    </Modal>
  );
}

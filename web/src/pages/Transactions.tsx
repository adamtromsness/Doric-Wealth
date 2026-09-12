import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { type Filters, DEFAULT_FILTERS, chip, buildTxnParams, TxnFilterBar } from '../components/txnFilters';
import { ImportModal } from '../components/ImportModal';
import { ImportSimpleFinModal } from '../components/ImportSimpleFinModal';
import { SubscriptionSuggestionDetail, justification, type SubscriptionSuggestion } from '../components/SubscriptionSuggestions';
import { cap } from '../components/ui';
import type { Category, StagedTxn } from '../types';
import {
  type Txn, type Tag, type Account, type Vehicle, type Property, type Subscription, type UserTag,
  type TxnPage,
  CHANNEL_LABEL, recurringKey, stagedSkipReason, tagKey,
  FILTER_KEY, loadStored, deepLinkFilters, PAGE_SIZE,
} from './transactions/helpers';
import { Pager } from './transactions/common';
import { TxnEditor } from './transactions/TxnEditor';

interface TransferRow { id: number; account_id: number; account_name: string; txn_date: string; amount: number; direction: string; merchant: string | null; description: string | null }
interface TransferPair { out: TransferRow; in: TransferRow }
interface TransferRule { id: number; source_account_id: number; source_name: string; dest_account_id: number; dest_name: string }
interface PostedSide { id: number; account_id: number; account_name: string; date: string; merchant: string | null }
interface PostedTransferPair { key: string; amount: number; out: PostedSide; in: PostedSide }

// A collapsible group inside the Review section. Collapsing tucks a group away without
// dismissing its items; the open/closed state persists per-browser (localStorage) so it
// stays that way for next time. Optional header `actions` (e.g. Confirm All) sit on the
// right and don't toggle the group.
function ReviewGroup({ id, title, count, actions, children }: {
  id: string; title: string; count?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  const storageKey = `review.collapsed.${id}`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(storageKey) !== '1'; } catch { return true; }
  });
  const toggle = () => setOpen((o) => {
    try { localStorage.setItem(storageKey, o ? '1' : '0'); } catch { /* ignore */ }
    return !o;
  });
  return (
    <div className="card" style={{ marginBottom: 12, padding: 0, borderLeft: '3px solid var(--brass-deep)', overflow: 'hidden' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, background: 'var(--surface-alt)', padding: '9px 14px', cursor: 'pointer' }}
        onClick={toggle}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: 12 }}>{open ? '▾' : '▸'}</span>
          <span style={{ fontWeight: 600 }}>{title}</span>
          {count != null && <span className="tag">{count}</span>}
        </div>
        {actions && <div className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>{actions}</div>}
      </div>
      {open && <div style={{ padding: '12px 14px' }}>{children}</div>}
    </div>
  );
}

export default function Transactions() {
  const [pending, setPending] = useState<Txn[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [posted, setPosted] = useState<Txn[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [tags, setTags] = useState<UserTag[]>([]);
  const [suggestions, setSuggestions] = useState<SubscriptionSuggestion[]>([]);
  const [detailSug, setDetailSug] = useState<SubscriptionSuggestion | null>(null);
  const [merchants, setMerchants] = useState<string[]>([]);
  const location = useLocation();
  const navigate = useNavigate();
  // Filters come from a ?uncategorized=1 deep-link (e.g. from the To-Do/Dashboard
  // action items), else navigation state, else the last-used saved filters.
  const [filters, setFilters] = useState<Filters>(() => {
    if (new URLSearchParams(location.search).get('uncategorized') === '1') {
      return { ...DEFAULT_FILTERS, range: 'all', uncategorized: '1' };
    }
    return deepLinkFilters(location.state) ?? loadStored()?.filters ?? DEFAULT_FILTERS;
  });
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(() => {
    const deep = deepLinkFilters(location.state);
    if (deep && (deep.property_id || deep.vehicle_id)) return true;
    return loadStored()?.advancedOpen ?? false;
  });
  const [editing, setEditing] = useState<Txn | null>(null);
  const [adding, setAdding] = useState(false);
  const [convertPair, setConvertPair] = useState<PostedTransferPair | null>(null);
  const [pendingPage, setPendingPage] = useState(0);
  const [postedPage, setPostedPage] = useState(0);
  const [staged, setStaged] = useState<StagedTxn[]>([]);
  const [transferPairs, setTransferPairs] = useState<TransferPair[]>([]);
  const [transferRules, setTransferRules] = useState<TransferRule[]>([]);
  const [ignoredPairs, setIgnoredPairs] = useState<Set<string>>(new Set());
  const [rememberPairs, setRememberPairs] = useState<Set<string>>(new Set());
  const [linkingPair, setLinkingPair] = useState<string | null>(null);
  const [postedPairs, setPostedPairs] = useState<PostedTransferPair[]>([]);
  const [ignoredPosted, setIgnoredPosted] = useState<Set<string>>(new Set());
  const [expandedPair, setExpandedPair] = useState<string | null>(null);
  const [expandedSug, setExpandedSug] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [sfImporting, setSfImporting] = useState(false);
  const [editingStaged, setEditingStaged] = useState<StagedTxn | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember the filter selection so returning to this page restores it.
  useEffect(() => {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify({ filters, advancedOpen })); } catch { /* ignore */ }
  }, [filters, advancedOpen]);

  const qs = useMemo(() => {
    const s = buildTxnParams(filters).toString();
    return s ? `?${s}` : '';
  }, [filters]);

  const load = () => {
    const url = `/transactions${qs}${qs ? '&' : '?'}limit=${PAGE_SIZE}`
      + `&pendingOffset=${pendingPage * PAGE_SIZE}&postedOffset=${postedPage * PAGE_SIZE}`;
    api.get<TxnPage>(url)
      .then((d) => { setPending(d.pending); setPendingTotal(d.pendingTotal); setPosted(d.posted); setTotal(d.total); })
      .catch((e) => setErr(e.message));
  };
  // Reload when the filter or either page changes.
  useEffect(() => { load(); }, [qs, pendingPage, postedPage]);
  // Jump both lists back to the first page whenever the filter changes.
  useEffect(() => { setPendingPage(0); setPostedPage(0); }, [qs]);
  // If a total shrank below the current page (e.g. after a delete), clamp it.
  useEffect(() => {
    const pc = Math.max(1, Math.ceil(pendingTotal / PAGE_SIZE));
    if (pendingPage > pc - 1) setPendingPage(pc - 1);
  }, [pendingTotal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const pc = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (postedPage > pc - 1) setPostedPage(pc - 1);
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMerchants = () => api.get<string[]>('/transactions/merchants').then(setMerchants).catch(() => {});
  const loadTransferPairs = () => api.get<TransferPair[]>('/imports/staged/transfer-candidates').then(setTransferPairs).catch(() => setTransferPairs([]));
  const loadTransferRules = () => api.get<TransferRule[]>('/imports/transfer-rules').then(setTransferRules).catch(() => {});
  // Transfer pairs among already-POSTED transactions (catches manually entered ones).
  const loadPostedTransferPairs = () => api.get<PostedTransferPair[]>('/transactions/transfer-suggestions').then(setPostedPairs).catch(() => {});
  // Apply remembered rules first (so known pairs are already merged), then load the queue.
  const loadStaged = async () => {
    await api.post('/imports/staged/auto-link').catch(() => {});
    loadTransferPairs();
    return api.get<StagedTxn[]>('/imports/staged').then(setStaged).catch(() => {});
  };
  const loadSuggestions = () => api.get<SubscriptionSuggestion[]>('/subscriptions/suggestions').then(setSuggestions).catch(() => {});
  const loadSubscriptions = () => api.get<Subscription[]>('/subscriptions').then(setSubscriptions).catch(() => {});
  const loadTags = () => api.get<UserTag[]>('/tags').then((t) => setTags(t.filter((x) => !x.archived))).catch(() => {});
  useEffect(() => {
    api.get<Category[]>('/categories').then(setCategories).catch(() => {});
    api.get<Account[]>('/accounts').then(setAccounts).catch(() => {});
    api.get<Vehicle[]>('/vehicles').then(setVehicles).catch(() => {});
    api.get<Property[]>('/properties').then(setProperties).catch(() => {});
    loadSubscriptions();
    loadTags();
    loadSuggestions();
    loadMerchants();
    loadStaged();
    loadTransferRules();
    loadPostedTransferPairs();
  }, []);

  // Merchants that look like recurring subscriptions, keyed by lowercase name
  // so a transaction row can flag itself as a candidate.
  const candidateKeys = useMemo(
    () => new Set(suggestions.map((s) => s.key)),
    [suggestions]
  );

  const lookups = { categories, accounts, vehicles, properties, subscriptions, tags };
  const purchasers = useMemo(
    () => [...new Set([...pending, ...posted].map((t) => t.purchaser).filter((p): p is string => !!p))].sort(),
    [pending, posted]
  );

  const markPosted = async (t: Txn) => {
    try { await api.post(`/transactions/${t.id}/post`); load(); } catch (e: any) { setErr(e.message); }
  };

  // --- Import review actions ---
  const afterStagedChange = () => { loadStaged(); load(); loadMerchants(); };
  const pairKey = (p: TransferPair) => `${p.out.id}-${p.in.id}`;
  const visiblePairs = transferPairs.filter((p) => !ignoredPairs.has(pairKey(p)));
  const linkTransfer = async (p: TransferPair) => {
    const key = pairKey(p); setLinkingPair(key); setErr('');
    try {
      await api.post('/imports/staged/transfer', { out_id: p.out.id, in_id: p.in.id, remember: rememberPairs.has(key) });
      afterStagedChange(); loadTransferRules();
    } catch (e: any) { setErr(e.message); } finally { setLinkingPair(null); }
  };
  const ignorePair = (p: TransferPair) => setIgnoredPairs((s) => new Set(s).add(pairKey(p)));
  const toggleRemember = (p: TransferPair) => setRememberPairs((s) => {
    const n = new Set(s); const k = pairKey(p); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const removeTransferRule = async (id: number) => {
    try { await api.del(`/imports/transfer-rules/${id}`); loadTransferRules(); } catch (e: any) { setErr(e.message); }
  };
  const visiblePostedPairs = postedPairs.filter((p) => !ignoredPosted.has(p.key));
  const ignorePostedPair = async (p: PostedTransferPair) => {
    setIgnoredPosted((s) => new Set(s).add(p.key));
    try { await api.post('/transactions/transfer-suggestions/ignore', { out_id: p.out.id, in_id: p.in.id }); } catch (e: any) { setErr(e.message); }
  };
  const ignoreSuggestionRow = async (s: SubscriptionSuggestion) => {
    try { await api.post('/subscriptions/suggestions/ignore', { merchant: s.merchant }); loadSuggestions(); }
    catch (e: any) { setErr(e.message); }
  };
  const ignoreAllSuggestions = async () => {
    if (!suggestions.length) return;
    try { for (const s of suggestions) await api.post('/subscriptions/suggestions/ignore', { merchant: s.merchant }); loadSuggestions(); }
    catch (e: any) { setErr(e.message); }
  };
  const ignoreAllPostedPairs = async () => {
    const pairs = visiblePostedPairs;
    if (!pairs.length) return;
    setIgnoredPosted((s) => { const n = new Set(s); pairs.forEach((p) => n.add(p.key)); return n; });
    try { for (const p of pairs) await api.post('/transactions/transfer-suggestions/ignore', { out_id: p.out.id, in_id: p.in.id }); }
    catch (e: any) { setErr(e.message); }
  };
  const confirmStaged = async (s: StagedTxn) => {
    try { await api.post(`/imports/staged/${s.id}/confirm`); afterStagedChange(); } catch (e: any) { setErr(e.message); }
  };
  const discardStaged = async (s: StagedTxn) => {
    try { await api.del(`/imports/staged/${s.id}`); loadStaged(); } catch (e: any) { setErr(e.message); }
  };
  const confirmAllStaged = async () => {
    const n = staged.filter((s) => s.decision === 'import').length;
    if (!n || !confirm(`Confirm and post ${n} transaction${n === 1 ? '' : 's'}? Rows marked skip are left in the queue.`)) return;
    try { await api.post('/imports/staged/confirm'); afterStagedChange(); } catch (e: any) { setErr(e.message); }
  };
  const discardAllStaged = async () => {
    if (!confirm(`Ignore all ${staged.length} rows in the review queue? They'll be removed from the import. This cannot be undone.`)) return;
    try { await api.del('/imports/staged'); loadStaged(); } catch (e: any) { setErr(e.message); }
  };
  const importCount = staged.filter((s) => s.decision === 'import').length;
  const skipCount = staged.filter((s) => s.decision === 'skip').length;

  // All tags across a transaction (its own + every split), de-duplicated.
  const allTags = (t: Txn): Tag[] => {
    const src = t.has_splits ? t.splits.flatMap((s) => s.tags ?? []) : (t.tags ?? []);
    const seen = new Set<string>();
    const out: Tag[] = [];
    for (const tag of src) { const k = tagKey(tag); if (!seen.has(k)) { seen.add(k); out.push(tag); } }
    return out;
  };
  const tagChips = (tags: Tag[]) =>
    tags.length
      ? <>{tags.map((tag) => <span key={tagKey(tag)} className="tag" style={{ marginRight: 6 }}>{tag.name}</span>)}</>
      : '—';

  const renderRow = (t: Txn) => (
    <tr key={t.id} className="clickable txn-row" onClick={() => setEditing(t)}>
      <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(t.txn_date)}</td>
      <td>
        {t.merchant || <span className="muted">—</span>}
        {t.direction === 'expense' && t.merchant && candidateKeys.has(recurringKey(t.merchant)) && (
          <button className="tag" title="This merchant looks like a recurring subscription — review it"
            style={{ marginLeft: 8, fontSize: 11, cursor: 'pointer', borderColor: 'var(--accent, #5A6F87)', color: 'var(--accent, #5A6F87)' }}
            onClick={(e) => {
              e.stopPropagation();
              const sug = suggestions.find((su) => su.key === recurringKey(t.merchant ?? ''));
              if (sug) setDetailSug(sug);
            }}>↻ subscription?</button>
        )}
        {t.channel && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{CHANNEL_LABEL[t.channel]}</span>}
        {/* Always render the detail line (placeholder when empty) so all rows match height. */}
        <div className="muted" style={{ fontSize: 12 }}>{t.description || ' '}</div>
      </td>
      <td className="muted">
        {t.account_name || '—'}
        {t.direction === 'transfer' && <span> → {t.transfer_account_name || '—'}</span>}
      </td>
      <td className="muted">{t.purchaser || '—'}</td>
      <td className="muted">
        {t.direction === 'transfer'
          ? <span className="tag">Transfer</span>
          : t.has_splits ? <span className="tag">Split · {t.splits.length}</span> : (t.category_name || '—')}
        {t.direction === 'transfer' && (() => {
          const principal = t.has_splits
            ? t.splits.filter((s) => s.is_principal).reduce((sum, s) => sum + Number(s.amount), 0)
            : (t.principal_amount != null ? Number(t.principal_amount) : null);
          if (principal == null) return null;
          const costs = Number(t.amount) - principal;
          if (costs <= 0.005) return null;
          return <span className="muted" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>principal {money(principal)} · costs {money(costs)}</span>;
        })()}
      </td>
      <td className="muted" style={{ fontSize: 12 }}>{t.direction === 'transfer' ? '—' : tagChips(allTags(t))}</td>
      <td className={`r money ${t.direction === 'income' ? 'credit' : t.direction === 'transfer' ? 'muted' : 'debit'}`}>
        {t.direction === 'transfer'
          ? money(t.amount)
          : money(t.direction === 'income' ? t.amount : -t.amount, { sign: t.direction === 'income' })}
      </td>
      <td>{t.has_receipt ? <span className="tag receipt">🧾</span> : <span className="muted">—</span>}</td>
      <td className="r">
        <input type="checkbox" checked={t.source === 'simplefin'} readOnly tabIndex={-1}
          title={t.source === 'simplefin' ? 'Auto-imported from a linked bank' : 'Not auto-imported'}
          style={{ cursor: 'default', pointerEvents: 'none' }} />
      </td>
      <td className="r" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
        {!t.posted_date && <button className="ghost" onClick={() => markPosted(t)}>Mark Posted</button>}
      </td>
    </tr>
  );

  // `pending`/`posted` are each the current server-side page of their list.
  const pendingPageCount = Math.max(1, Math.ceil(pendingTotal / PAGE_SIZE));
  const pendingSafePage = Math.min(pendingPage, pendingPageCount - 1);
  const pendingStart = pendingSafePage * PAGE_SIZE;
  const postedPageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const postedSafePage = Math.min(postedPage, postedPageCount - 1);
  const postedStart = postedSafePage * PAGE_SIZE;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Track</div>
          <h1 className="title">Transactions</h1>
          <p className="subtitle">Every expense, deposit and transfer. Split a transaction into lines, tag each, and upload a receipt for AI itemization.</p>
        </div>
        <div className="row head-actions">
          <button className="ghost" onClick={() => setImporting(true)}>Import CSV</button>
          <button className="ghost" onClick={() => setSfImporting(true)}>Import SimpleFIN</button>
          <button className="head-add" onClick={() => setAdding(true)}>Add Transaction</button>
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      <TxnFilterBar
        filters={filters}
        setFilters={setFilters}
        advancedOpen={advancedOpen}
        setAdvancedOpen={setAdvancedOpen}
        lookups={{ accounts, categories, vehicles, properties, tags }}
      />

      {(visiblePostedPairs.length > 0 || suggestions.length > 0 || staged.length > 0) && (
        <div style={{ marginBottom: 18 }}>
          <h2 className="section" style={{ margin: '0 0 10px', color: 'var(--brass-deep)' }}>Review</h2>

      {visiblePostedPairs.length > 0 && (
        <ReviewGroup id="transfers" title="Possible Transfers" count={`${visiblePostedPairs.length} to review`}
          actions={<button className="ghost" style={{ ...chip, minWidth: 100 }} onClick={ignoreAllPostedPairs}>Ignore All</button>}>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            These posted transactions look like one transfer split across two accounts. Converting replaces both with a single transfer, which is excluded from spending and income.
          </p>
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <thead><tr><th>Out</th><th>In</th><th className="r">Amount</th><th>Date</th><th></th></tr></thead>
              <tbody>
                {visiblePostedPairs.map((p) => {
                  const open = expandedPair === p.key;
                  const days = Math.round(Math.abs(Date.parse(p.out.date) - Date.parse(p.in.date)) / 86_400_000);
                  const hi = 'color-mix(in srgb, var(--brass) 16%, var(--surface))';
                  return (
                    <Fragment key={p.key}>
                      <tr className="clickable" style={open ? { background: hi } : undefined} onClick={() => setExpandedPair(open ? null : p.key)}>
                        <td style={open ? { boxShadow: 'inset 3px 0 0 var(--brass-deep)' } : undefined}>{p.out.account_name}</td>
                        <td>{p.in.account_name}</td>
                        <td className="r money num">{money(p.amount)}</td>
                        <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{shortDate(p.out.date)}</td>
                        <td className="r" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          <button className="ghost" style={{ ...chip, minWidth: 72 }} onClick={() => ignorePostedPair(p)}>Ignore</button>
                          <button style={{ ...chip, minWidth: 88, marginLeft: 4 }} onClick={() => setConvertPair(p)}>Review</button>
                        </td>
                      </tr>
                      {open && (
                        <tr><td colSpan={5} style={{ background: hi }}>
                          <div className="grid grid-2" style={{ gap: 10, marginBottom: 8 }}>
                            <div className="card" style={{ background: 'var(--surface)', padding: '8px 10px' }}>
                              <div className="muted" style={{ fontSize: 11 }}>Money out · {p.out.account_name}</div>
                              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}><span>{p.out.merchant || '—'}</span><span className="num debit">−{money(p.amount)}</span></div>
                              <div className="muted" style={{ fontSize: 12 }}>{shortDate(p.out.date)}</div>
                            </div>
                            <div className="card" style={{ background: 'var(--surface)', padding: '8px 10px' }}>
                              <div className="muted" style={{ fontSize: 11 }}>Money in · {p.in.account_name}</div>
                              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}><span>{p.in.merchant || '—'}</span><span className="num credit">+{money(p.amount)}</span></div>
                              <div className="muted" style={{ fontSize: 12 }}>{shortDate(p.in.date)}</div>
                            </div>
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            <strong>Why this looks like a transfer:</strong>
                            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                              <li>Same amount on both sides ({money(p.amount)}).</li>
                              <li>Opposite directions — money left <strong>{p.out.account_name}</strong> and arrived in <strong>{p.in.account_name}</strong>.</li>
                              <li>{days === 0 ? 'Posted the same day' : `${days} day${days === 1 ? '' : 's'} apart`} ({shortDate(p.out.date)} → {shortDate(p.in.date)}).</li>
                              <li>Two different accounts.</li>
                            </ul>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ReviewGroup>
      )}

      {suggestions.length > 0 && (
        <ReviewGroup id="subscriptions" title="Possible Subscriptions" count={`${suggestions.length} to review`}
          actions={<button className="ghost" style={{ ...chip, minWidth: 100 }} onClick={ignoreAllSuggestions}>Ignore All</button>}>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            These merchants charge the same amount on a regular cadence, so they look like subscriptions. Click a row to see why it was flagged, then confirm or ignore it.
          </p>
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <thead><tr><th>Merchant</th><th className="r">Amount</th><th>Every</th><th className="r">Times</th><th></th></tr></thead>
              <tbody>
                {suggestions.map((s) => {
                  const open = expandedSug === s.key;
                  const hi = 'color-mix(in srgb, var(--brass) 16%, var(--surface))';
                  return (
                    <Fragment key={s.key}>
                      <tr className="clickable" style={open ? { background: hi } : undefined} onClick={() => setExpandedSug(open ? null : s.key)}>
                        <td style={open ? { boxShadow: 'inset 3px 0 0 var(--brass-deep)' } : undefined}>{s.merchant}</td>
                        <td className="r money num">{money(s.amount)}</td>
                        <td className="muted">{cap(s.billing_cycle)}</td>
                        <td className="r num muted">{s.count}×</td>
                        <td className="r" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          <button className="ghost" style={{ ...chip, minWidth: 72 }} onClick={() => ignoreSuggestionRow(s)}>Ignore</button>
                          <button style={{ ...chip, minWidth: 88, marginLeft: 4 }} onClick={() => setDetailSug(s)}>Review</button>
                        </td>
                      </tr>
                      {open && (
                        <tr><td colSpan={5} style={{ background: hi }}>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                            <strong>Why this looks like a subscription:</strong> {justification(s)}
                          </div>
                          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Recent charges</div>
                          <div className="grid grid-3" style={{ gap: 8 }}>
                            {s.transactions.slice(0, 6).map((t) => (
                              <div key={t.id} className="card" style={{ background: 'var(--surface)', padding: '6px 10px' }}>
                                <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                                  <span className="muted" style={{ fontSize: 12 }}>{shortDate(t.date)}</span>
                                  <span className="num debit">−{money(t.amount)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ReviewGroup>
      )}

      {staged.length > 0 && (
        <ReviewGroup id="autoimport" title="Auto Imported" count={`${importCount} to post${skipCount ? ` · ${skipCount} skipped` : ''}`}
          actions={<>
            <button className="ghost" style={{ ...chip, minWidth: 100 }} onClick={discardAllStaged}>Ignore All</button>
            <button style={{ ...chip, minWidth: 138 }} disabled={!importCount} onClick={confirmAllStaged}>Confirm All ({importCount})</button>
          </>}>
          {visiblePairs.length > 0 && (
            <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--brass-deep)' }}>
              <div className="label" style={{ marginBottom: 4 }}>Possible Transfers in this import</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
                These look like one transfer split across two accounts. Linking creates a single transfer (excluded from spending and income) and removes both lines from the review queue.
              </p>
              {visiblePairs.map((p) => {
                const key = pairKey(p);
                return (
                  <div key={key} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--hairline)' }}>
                    <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="num debit">−{money(p.out.amount)}</span>
                      <span className="muted">{p.out.account_name}</span>
                      <span className="muted">⇄</span>
                      <span className="num credit">+{money(p.in.amount)}</span>
                      <span className="muted">{p.in.account_name}</span>
                      <span className="muted" style={{ fontSize: 12 }}>· {shortDate(p.out.txn_date)}{p.out.merchant ? ` · ${p.out.merchant}` : ''}</span>
                    </div>
                    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                      <label className="row" style={{ gap: 4, alignItems: 'center', fontSize: 12 }} title={`Always auto-link ${p.out.account_name} → ${p.in.account_name} on future imports`}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={rememberPairs.has(key)} onChange={() => toggleRemember(p)} />
                        <span className="muted">Always</span>
                      </label>
                      <button className="ghost" style={chip} onClick={() => ignorePair(p)}>Ignore</button>
                      <button style={chip} disabled={linkingPair === key} onClick={() => linkTransfer(p)}>{linkingPair === key ? 'Linking…' : 'Link as Transfer'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th>Category</th><th className="r">Amount</th><th>Why Skipped</th><th></th></tr></thead>
              <tbody>
                {staged.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => setEditingStaged(s)}
                    style={s.decision === 'skip'
                      ? { background: 'rgba(184, 134, 11, 0.08)', boxShadow: 'inset 3px 0 0 var(--warn, #b8860b)' }
                      : undefined}>
                    <td className="num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{s.txn_date ? shortDate(s.txn_date) : <span className="debit">no date</span>}</td>
                    <td>
                      {s.merchant || <span className="muted">—</span>}
                      {s.raw_merchant && s.raw_merchant !== s.merchant && <div className="muted" style={{ fontSize: 12 }}>{s.raw_merchant}</div>}
                    </td>
                    <td className="muted">{s.account_name || '—'}</td>
                    <td className="muted">{s.category_name || '—'}</td>
                    <td className={`r money ${s.direction === 'income' ? 'credit' : 'debit'}`}>{money(s.direction === 'income' ? s.amount : -s.amount, { sign: s.direction === 'income' })}</td>
                    <td>
                      {(() => {
                        const reason = stagedSkipReason(s);
                        if (!reason) return <span className="muted">—</span>;
                        if (reason === 'matches_existing')
                          return <span className="tag" style={{ borderColor: 'var(--debit)', color: 'var(--debit)' }}
                            title={`Looks like ${s.dup_merchant ?? 'a transaction'} ${money(s.dup_amount)}${s.dup_date ? ' on ' + shortDate(s.dup_date) : ''} that's already in your ledger.`}>⚠ already in ledger</span>;
                        return <span className="tag" style={{ borderColor: 'var(--warn, #b8860b)', color: 'var(--warn, #b8860b)' }}
                          title="The same date, amount and merchant appear more than once in this file, so only the first copy was kept. Add this one if it's a separate, real charge.">⚠ repeated in file</span>;
                      })()}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <button className="ghost" style={{ ...chip, minWidth: 72 }} onClick={() => discardStaged(s)}>Ignore</button>
                      <button style={{ ...chip, minWidth: 88, marginLeft: 4 }}
                        title={s.decision === 'skip' ? 'Post this row anyway — it was flagged as a possible duplicate' : undefined}
                        onClick={() => confirmStaged(s)}>Confirm</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Imported rows post to your ledger only after you confirm them. Rows that look like duplicates are set to skip and show <em>why</em> in the “Why skipped” column — “already in ledger” matched an existing transaction, “repeated in file” appeared more than once in the upload. If a skipped row is a real, separate charge, click <strong>Add anyway</strong> to post it (or open it to edit first); use ✕ to discard.
          </div>
        </ReviewGroup>
      )}
        </div>
      )}

      {transferRules.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 4 }}>Auto-Linked Transfers</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Imports matching these account pairs are merged into a transfer automatically.</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {transferRules.map((r) => (
              <span key={r.id} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {r.source_name} → {r.dest_name}
                <button className="ghost" style={{ padding: '0 4px', lineHeight: 1 }} title="Remove this auto-link rule" onClick={() => removeTransferRule(r.id)}>✕</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {pendingTotal > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <h2 className="section" style={{ margin: 0, color: 'var(--brass-deep)' }}>Pending</h2>
            <span className="muted num" style={{ fontSize: 13 }}>{pendingTotal} awaiting posting</span>
          </div>
          <Pager top page={pendingSafePage} pageCount={pendingPageCount} total={pendingTotal} start={pendingStart} count={pending.length} onPage={setPendingPage} />
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <thead><tr><th>Date</th><th>Merchant</th><th>Account</th><th>Person</th><th>Category</th><th>Tags</th><th className="r">Amount</th><th>Receipt</th><th className="r">Auto</th><th></th></tr></thead>
              <tbody>{pending.map(renderRow)}</tbody>
            </table>
          </div>
          <Pager page={pendingSafePage} pageCount={pendingPageCount} total={pendingTotal} start={pendingStart} count={pending.length} onPage={setPendingPage} />
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h2 className="section" style={{ margin: 0 }}>Posted</h2>
        {total > 0 && <span className="muted num" style={{ fontSize: 13 }}>{total} total</span>}
      </div>
      <Pager top page={postedSafePage} pageCount={postedPageCount} total={total} start={postedStart} count={posted.length} onPage={setPostedPage} />
      <div className="card" style={{ padding: 0 }}>
        <table className="ledger">
          <thead>
            <tr><th>Date</th><th>Merchant</th><th>Account</th><th>Person</th><th>Category</th><th>Tags</th><th className="r">Amount</th><th>Receipt</th><th className="r">Auto</th><th></th></tr>
          </thead>
          <tbody>
            {posted.map(renderRow)}
            {posted.length === 0 && <tr><td colSpan={10}><div className="empty">{pendingTotal ? 'No posted transactions match.' : 'No transactions match. Add one or clear filters.'}</div></td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={postedSafePage} pageCount={postedPageCount} total={total} start={postedStart} count={posted.length} onPage={setPostedPage} />

      {(adding || editing) && (
        <TxnEditor
          txn={editing}
          lookups={lookups}
          purchasers={purchasers}
          merchants={merchants}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); load(); loadMerchants(); }}
        />
      )}

      {convertPair && (
        <TxnEditor
          txn={null}
          seed={{
            direction: 'transfer',
            account_id: convertPair.out.account_id,
            transfer_account_id: convertPair.in.account_id,
            amount: convertPair.amount,
            txn_date: convertPair.out.date,
            posted_date: convertPair.out.date,
            merchant: convertPair.out.merchant ?? convertPair.in.merchant ?? '',
          }}
          convertPair={{ out_id: convertPair.out.id, in_id: convertPair.in.id }}
          lookups={lookups}
          purchasers={purchasers}
          merchants={merchants}
          onClose={() => setConvertPair(null)}
          onSaved={() => { setConvertPair(null); load(); loadPostedTransferPairs(); loadMerchants(); }}
        />
      )}

      {importing && (
        <ImportModal
          accounts={accounts}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); loadStaged(); }}
        />
      )}

      {sfImporting && (
        <ImportSimpleFinModal
          onClose={() => setSfImporting(false)}
          onImported={() => { loadStaged(); }}
        />
      )}

      {editingStaged && (
        <TxnEditor
          txn={null}
          seed={{
            txn_date: editingStaged.txn_date ?? undefined,
            posted_date: editingStaged.txn_date ?? undefined,
            direction: editingStaged.direction,
            amount: editingStaged.amount,
            merchant: editingStaged.merchant,
            description: editingStaged.description,
            account_id: editingStaged.account_id,
            category_id: editingStaged.category_id,
          }}
          confirmStaged={{ id: editingStaged.id, source: editingStaged.source, external_id: editingStaged.external_id }}
          lookups={lookups}
          purchasers={purchasers}
          merchants={merchants}
          onClose={() => setEditingStaged(null)}
          onSaved={() => { setEditingStaged(null); afterStagedChange(); }}
        />
      )}

      {detailSug && (
        <SubscriptionSuggestionDetail
          suggestion={detailSug}
          onClose={() => setDetailSug(null)}
          onChanged={() => { loadSuggestions(); loadSubscriptions(); load(); }}
        />
      )}
    </>
  );
}

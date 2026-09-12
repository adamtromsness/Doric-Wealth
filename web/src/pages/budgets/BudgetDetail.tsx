import { useEffect, useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import { api, money, todayStr, shortDate } from '../../api';
import { arrayMove, slotReorder, chartTooltip, CHIP, Loading } from '../../components/ui';
import type { Category } from '../../types';
import type { Account, Budget, Line, Progress, RolloverMode } from './types';
import { fmtRange, mondayOf } from './calc';
import { SummaryBlock, BudgetSection } from './BudgetProgress';
import { LineConfigModal } from './BudgetEditor';
import { TxnModal } from './TxnModal';

export function BudgetDetail({ budget, onDeleted }: { budget: Budget; onDeleted: () => void }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [adding, setAdding] = useState<'income' | 'expense' | null>(null);
  const [configLine, setConfigLine] = useState<Line | null>(null);
  const [addGroupId, setAddGroupId] = useState<number | null>(null);
  // Parent groups added to the budget that don't yet have any item lines. They're
  // shown as empty containers so the user can add lines, without a phantom line on
  // the group category itself.
  const [emptyGroups, setEmptyGroups] = useState<number[]>([]);
  const [txnModal, setTxnModal] = useState<{ scope: 'section' | 'uncategorized' | 'category'; kind: 'income' | 'expense'; cats?: number[]; title?: string } | null>(null);
  const showCatTxns = (kind: 'income' | 'expense', cats: number[], title: string) => setTxnModal({ scope: 'category', kind, cats, title });
  const [ref, setRef] = useState<string | null>(null); // null = current period
  const [accounts, setAccounts] = useState<Account[]>([]);
  // The account filter + anchor date rarely change, so they live in a collapsed
  // "Budget details" disclosure instead of taking up space at the top every period.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [err, setErr] = useState('');

  const loadProgress = () => {
    // Always send a ref: for the current period use the browser-LOCAL date, so a user
    // west of UTC near a month/week boundary sees their own current period rather than
    // the server's UTC "today" (which may already be the next period).
    const qs = `?ref=${ref ?? todayStr()}`;
    api.get<Progress>(`/budgets/${budget.id}/progress${qs}`).then(setProgress).catch((e) => setErr(e.message));
  };
  // Reset to the current period when switching budgets.
  useEffect(() => { setRef(null); setProgress(null); }, [budget.id]);
  useEffect(() => { loadProgress(); }, [budget.id, ref]);
  useEffect(() => { api.get<Category[]>('/categories').then(setCategories).catch(() => {}); }, []);
  useEffect(() => { api.get<Account[]>('/accounts').then(setAccounts).catch(() => {}); }, []);

  // Toggle an account in the budget's scope (no rows = all accounts).
  const toggleAccount = async (accountId: number | null) => {
    const cur = progress?.account_ids ?? [];
    let next: number[];
    if (accountId === null) next = []; // "All accounts"
    else next = cur.includes(accountId) ? cur.filter((a) => a !== accountId) : [...cur, accountId];
    try { await api.put(`/budgets/${budget.id}/accounts`, { account_ids: next }); loadProgress(); } catch (e: any) { setErr(e.message); }
  };

  const remove = async () => {
    if (!confirm(`Delete budget "${budget.name}"?`)) return;
    try { await api.del(`/budgets/${budget.id}`); onDeleted(); } catch (e: any) { setErr(e.message); }
  };

  // Add (or update) an allocation — the lines endpoint upserts by category. Edit
  // and remove operate directly on the screen, no separate modal.
  const setLine = async (category_id: number, amount: number, closeAdd = false, rollover_mode: RolloverMode = 'reset', opening_balance?: number) => {
    try {
      await api.post(`/budgets/${budget.id}/lines`, { category_id, amount, rollover_mode, ...(opening_balance === undefined ? {} : { opening_balance }) });
      if (closeAdd) setAdding(null);
      loadProgress();
    } catch (e: any) { setErr(e.message); }
  };
  const removeLine = async (line_id: number) => {
    try { await api.del(`/budgets/${budget.id}/lines/${line_id}`); loadProgress(); } catch (e: any) { setErr(e.message); }
  };

  // Reordering reuses the category sort order (shared with the Categories page).
  const refreshAll = () => { loadProgress(); api.get<Category[]>('/categories').then(setCategories).catch(() => {}); };
  const moveGroup = async (kind: 'income' | 'expense', from: number, to: number) => {
    const sec = progress?.sections.find((s) => s.kind === kind);
    if (!sec || from === to || from < 0 || to < 0 || to >= sec.groups.length) return;
    const displayed = sec.groups.map((g) => g.group_id);
    const next = arrayMove(displayed, from, to);
    const full = categories.filter((c) => c.parent_id === null && c.kind === kind).sort((a, b) => a.sort_order - b.sort_order).map((c) => c.id);
    try { await api.post('/categories/reorder', { ids: slotReorder(full, displayed, next) }); refreshAll(); } catch (e: any) { setErr(e.message); }
  };
  const moveItem = async (groupId: number, lines: Line[], from: number, to: number) => {
    if (lines.length < 2 || from === to || from < 0 || to < 0 || to >= lines.length) return;
    const displayed = lines.map((l) => l.category_id);
    const next = arrayMove(displayed, from, to);
    const full = categories.filter((c) => c.parent_id === groupId).sort((a, b) => a.sort_order - b.sort_order).map((c) => c.id);
    try { await api.post('/categories/reorder', { ids: slotReorder(full, displayed, next), parent_id: groupId }); refreshAll(); } catch (e: any) { setErr(e.message); }
  };

  // Advance to the adjacent period using the window the server returned: the day
  // before this window's start (or after its end) lands in the neighbouring period.
  const shift = (dir: -1 | 1) => {
    if (!progress) return;
    const base = dir < 0 ? progress.window.start : progress.window.end;
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + dir);
    setRef(d.toISOString().slice(0, 10));
  };

  if (err) return <div className="error">{err}</div>;
  if (!progress) return <Loading card />;

  const expense = progress.sections.find((s) => s.kind === 'expense')!;
  const income = progress.sections.find((s) => s.kind === 'income')!;
  // For weekly buckets, "today" maps to its week's Monday so the marker lines up.
  const todayKey = progress.bucket === 'week' ? mondayOf(todayStr()) : todayStr();
  const todayInWindow = progress.daily.some((d) => d.date === todayKey);
  const fmtBucket = (d: string) => progress.bucket === 'week'
    ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : String(Number(d.slice(8, 10)));
  const fmtBucketLong = (d: string) => {
    const s = new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return progress.bucket === 'week' ? `Week of ${s}` : s;
  };

  // Days remaining in the period (relative to actual today).
  const DAY = 86400000;
  const winStart = new Date(progress.window.start + 'T00:00:00Z').getTime();
  const winEnd = new Date(progress.window.end + 'T00:00:00Z').getTime();
  const nowUTC = new Date(todayStr() + 'T00:00:00Z').getTime();
  const totalDays = Math.round((winEnd - winStart) / DAY) + 1;
  let daysLeft = 0, daysNote = '';
  if (nowUTC > winEnd) { daysLeft = 0; daysNote = 'period ended'; }
  else if (nowUTC < winStart) { daysLeft = totalDays; daysNote = 'not started yet'; }
  else { daysLeft = Math.round((winEnd - nowUTC) / DAY) + 1; daysNote = `of ${totalDays} days`; }

  // Category items already allocated anywhere in this budget — excluded from "Add".
  const assigned = new Set<number>();
  for (const sec of progress.sections) for (const g of sec.groups) for (const l of g.lines) assigned.add(l.category_id);
  // Top-level groups (categories) not yet shown in this section.
  const availableGroups = (kind: 'income' | 'expense') => {
    const shown = new Set([
      ...(progress.sections.find((s) => s.kind === kind)?.groups ?? []).map((g) => g.group_id),
      ...emptyGroups,
    ]);
    return categories
      .filter((c) => c.parent_id === null && c.kind === kind && !shown.has(c.id))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({ id: c.id, name: c.name }));
  };
  // Empty group containers to render for a section (parent groups the user added
  // but that have no lines yet, and aren't already real groups in the budget).
  const emptyGroupCards = (kind: 'income' | 'expense') => {
    const real = new Set((progress!.sections.find((s) => s.kind === kind)?.groups ?? []).map((g) => g.group_id));
    return emptyGroups
      .map((id) => categories.find((c) => c.id === id))
      .filter((c): c is Category => !!c && c.kind === kind && !real.has(c.id))
      .map((c) => ({ group_id: c.id, group_name: c.name, allocated: 0, actual: 0, lines: [] as Line[] }));
  };
  // Unassigned child items within a specific group.
  const availableItems = (groupId: number) =>
    categories
      .filter((c) => c.parent_id === groupId && !assigned.has(c.id))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({ id: c.id, name: c.name }));
  const addLine = (cid: number, amt: number, mode: RolloverMode) => {
    // Adding a parent group (a category with children) shouldn't create a line on
    // the group itself — show it as an empty container and open its item-add row.
    const cat = categories.find((c) => c.id === cid);
    if (cat && cat.parent_id === null && cat.has_children) {
      setEmptyGroups((g) => (g.includes(cid) ? g : [...g, cid]));
      setAdding(null);
      setAddGroupId(cid);
      return;
    }
    setLine(cid, amt, false, mode);
    setAdding(null);
    setAddGroupId(null);
  };
  // Add every unassigned item in a group at once (planned 0, reset rollover); tune amounts after.
  const addAllItems = async (catIds: number[]) => {
    try {
      for (const cid of catIds) await api.post(`/budgets/${budget.id}/lines`, { category_id: cid, amount: 0, rollover_mode: 'reset' });
      setAddGroupId(null);
      loadProgress();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      {/* Date on top, account filter beneath it. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8 }}>
          <div />
          {progress.period === 'custom' ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{progress.window.label}</div>
              <div className="muted" style={{ fontSize: 11 }}>Custom range · {fmtRange(progress.window.start, progress.window.end)}</div>
            </div>
          ) : (
            <div className="row" style={{ gap: 6, alignItems: 'center', justifyContent: 'center' }}>
              <button className="ghost" onClick={() => shift(-1)} title="Previous period" style={{ minWidth: 36 }}>◀</button>
              <div style={{ minWidth: 190, textAlign: 'center' }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{progress.window.label}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {progress.period.charAt(0).toUpperCase() + progress.period.slice(1)} · {fmtRange(progress.window.start, progress.window.end)}
                </div>
              </div>
              <button className="ghost" onClick={() => shift(1)} title="Next period" style={{ minWidth: 36 }}>▶</button>
            </div>
          )}
          <div className="row" style={{ justifySelf: 'end', gap: 8, alignItems: 'center' }}>
            {ref && <button className="ghost" onClick={() => setRef(null)}>Current</button>}
            <button className="danger" onClick={remove}>Delete</button>
          </div>
        </div>

        <div style={{ marginTop: 12, borderTop: '1px solid var(--hairline)', paddingTop: 10 }}>
          <button
            onClick={() => setDetailsOpen((o) => !o)}
            style={{ border: 'none', background: 'none', padding: '2px 0', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span>{detailsOpen ? '▾' : '▸'}</span> Budget Details
            {!detailsOpen && (
              <span style={{ fontWeight: 400 }}>
                · counting {(progress.account_ids?.length ?? 0) === 0 ? 'all accounts' : `${progress.account_ids.length} account${progress.account_ids.length === 1 ? '' : 's'}`}
              </span>
            )}
          </button>
          {detailsOpen && (
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: accounts.length > 0 ? 12 : 0 }}>
                Anchor date · <strong style={{ color: 'var(--ink-soft)' }}>{shortDate(budget.start_date)}</strong>
                <span style={{ marginLeft: 6 }}>— {progress.period === 'custom' ? 'fixed custom range' : `${progress.period} periods are measured from here`}</span>
              </div>
              {accounts.length > 0 && (
                <>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Accounts counted</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    <button className={(progress.account_ids?.length ?? 0) === 0 ? '' : 'ghost'} style={CHIP} onClick={() => toggleAccount(null)}>All accounts</button>
                    {accounts.map((a) => (
                      <button key={a.id} className={progress.account_ids?.includes(a.id) ? '' : 'ghost'} style={CHIP} onClick={() => toggleAccount(a.id)}>{a.name}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Income · Expenses · Days remaining. */}
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card"><SummaryBlock section={income} onShowTxns={() => setTxnModal({ scope: 'section', kind: 'income' })} /></div>
        <div className="card"><SummaryBlock section={expense} onShowTxns={() => setTxnModal({ scope: 'section', kind: 'expense' })} /></div>
        <div className="card">
          <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Days remaining</div>
          <div className="num" style={{ fontSize: 28, marginTop: 8 }}>{daysLeft}</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{daysNote}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 22 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <span className="label">{progress.bucket === 'week' ? 'Weekly cash flow' : 'Daily cash flow'}</span>
          <span className="muted" style={{ fontSize: 11 }}>net per {progress.bucket} · green in, red out</span>
        </div>
        <div style={{ height: 170 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={progress.daily} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false}
                tickFormatter={fmtBucket} minTickGap={14} />
              <YAxis tick={{ fontSize: 10, fill: '#767C85' }} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => '$' + v} />
              <Tooltip contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                formatter={(v: number) => [money(Number(v)), 'Net']}
                labelFormatter={fmtBucketLong} />
              <ReferenceLine y={0} stroke="var(--hairline-strong)" />
              {todayInWindow && <ReferenceLine x={todayKey} stroke="#5A6F87" strokeDasharray="3 3" label={{ value: progress.bucket === 'week' ? 'This week' : 'Today', fontSize: 10, fill: '#5A6F87', position: 'insideTopRight' }} />}
              <Bar dataKey="net" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                {progress.daily.map((d, i) => (
                  <Cell key={i} fill={d.date === todayKey ? '#5A6F87' : d.net >= 0 ? '#6B7F6E' : '#A15648'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <BudgetSection
        section={income}
        addingSection={adding === 'income'} groupOptions={availableGroups('income')}
        onToggleAddSection={() => setAdding((a) => (a === 'income' ? null : 'income'))}
        onAddLine={addLine} onCancelAdd={() => { setAdding(null); setAddGroupId(null); }}
        onEdit={(cid, amt, mode) => setLine(cid, amt, false, mode)} onRemove={removeLine}
        onConfigure={setConfigLine}
        onMoveGroup={(from, to) => moveGroup('income', from, to)} onMoveItem={moveItem}
        onShowUncategorized={() => setTxnModal({ scope: 'uncategorized', kind: 'income' })}
        onShowCatTxns={(cats, title) => showCatTxns('income', cats, title)}
        addGroupId={addGroupId} onToggleAddItem={(gid) => setAddGroupId((g) => (g === gid ? null : gid))} itemOptions={availableItems}
        onAddAllItems={addAllItems} extraGroups={emptyGroupCards('income')}
      />
      <BudgetSection
        section={expense}
        addingSection={adding === 'expense'} groupOptions={availableGroups('expense')}
        onToggleAddSection={() => setAdding((a) => (a === 'expense' ? null : 'expense'))}
        onAddLine={addLine} onCancelAdd={() => { setAdding(null); setAddGroupId(null); }}
        onEdit={(cid, amt, mode) => setLine(cid, amt, false, mode)} onRemove={removeLine}
        onConfigure={setConfigLine}
        onMoveGroup={(from, to) => moveGroup('expense', from, to)} onMoveItem={moveItem}
        onShowUncategorized={() => setTxnModal({ scope: 'uncategorized', kind: 'expense' })}
        onShowCatTxns={(cats, title) => showCatTxns('expense', cats, title)}
        addGroupId={addGroupId} onToggleAddItem={(gid) => setAddGroupId((g) => (g === gid ? null : gid))} itemOptions={availableItems}
        onAddAllItems={addAllItems} extraGroups={emptyGroupCards('expense')}
      />

      {txnModal && (
        <TxnModal
          budgetId={budget.id} refStr={ref ?? todayStr()} kind={txnModal.kind} scope={txnModal.scope} cats={txnModal.cats} title={txnModal.title}
          categories={categories} budgetedCatIds={assigned}
          onClose={() => setTxnModal(null)} onChanged={loadProgress}
        />
      )}

      {configLine && (
        <LineConfigModal
          line={configLine}
          onSave={(mode, opening) => { setLine(configLine.category_id, configLine.base_amount ?? configLine.allocated, false, mode, opening); setConfigLine(null); }}
          onClose={() => setConfigLine(null)}
        />
      )}
    </>
  );
}

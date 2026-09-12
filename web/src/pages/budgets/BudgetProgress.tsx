import { useEffect, useState, type ReactNode } from 'react';
import { money } from '../../api';
import { SectionHeader, kindAccent, EditIcon, DragHandle, AmountInput } from '../../components/ui';
import type { Group, Line, RolloverMode, Section } from './types';
import { ROLLOVER_MODES } from './types';
import { behaviorText, isIncome, titleFor, actualLabel } from './calc';

export function SummaryBlock({ section, onShowTxns }: { section: Section; onShowTxns: () => void }) {
  const remaining = section.allocated - section.actual;
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{titleFor(section)}</div>
      <div className="row" style={{ gap: 20, marginTop: 6, flexWrap: 'wrap' }}>
        <div><div className="muted" style={{ fontSize: 11 }}>Planned</div><div className="num" style={{ fontSize: 20 }}>{money(section.allocated)}</div></div>
        <div onClick={onShowTxns} style={{ cursor: 'pointer' }} title={`View ${actualLabel(section).toLowerCase()} transactions`}>
          <div className="muted" style={{ fontSize: 11 }}>{actualLabel(section)} ›</div>
          <div className="num" style={{ fontSize: 20, textDecoration: 'underline', textDecorationStyle: 'dotted', textDecorationColor: 'var(--hairline-strong)' }}>{money(section.actual)}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>{isIncome(section) ? 'Left to receive' : 'Remaining'}</div>
          <div className={`num ${remaining < 0 ? (isIncome(section) ? 'credit' : 'debit') : ''}`} style={{ fontSize: 20 }}>{money(remaining)}</div>
        </div>
      </div>
      {section.uncategorized > 0 && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          + {money(section.uncategorized)} {isIncome(section) ? 'unbudgeted income' : 'unbudgeted spending'} (uncategorized)
        </div>
      )}
    </div>
  );
}

export function BudgetSection({
  section, addingSection, groupOptions, onToggleAddSection, onAddLine, onCancelAdd, onEdit, onRemove, onConfigure,
  onMoveGroup, onMoveItem, onShowUncategorized, onShowCatTxns, addGroupId, onToggleAddItem, itemOptions, onAddAllItems,
  extraGroups,
}: {
  section: Section;
  addingSection: boolean; groupOptions: { id: number; name: string }[];
  onToggleAddSection: () => void;
  onAddLine: (categoryId: number, amount: number, mode: RolloverMode) => void;
  onCancelAdd: () => void;
  onEdit: (categoryId: number, amount: number, mode: RolloverMode) => void;
  onRemove: (lineId: number) => void;
  onConfigure: (line: Line) => void;
  onMoveGroup: (from: number, to: number) => void;
  onMoveItem: (groupId: number, lines: Line[], from: number, to: number) => void;
  onShowUncategorized: () => void;
  onShowCatTxns: (cats: number[], title: string) => void;
  addGroupId: number | null;
  onToggleAddItem: (groupId: number) => void;
  itemOptions: (groupId: number) => { id: number; name: string }[];
  onAddAllItems: (catIds: number[]) => void;
  extraGroups: Group[];
}) {
  const kind = section.kind;
  const income = kind === 'income';
  const hasRows = section.groups.length > 0 || section.uncategorized > 0 || extraGroups.length > 0;
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  return (
    <div style={{ marginBottom: 28 }}>
      <SectionHeader
        kind={kind}
        title={titleFor(section)}
        action={<button className={addingSection ? 'ghost' : ''} onClick={onToggleAddSection}>{addingSection ? 'Close' : `Add ${income ? 'Income' : 'Expense'} Group`}</button>}
      />

      <div style={{ display: 'grid', gap: 16 }}>
        {addingSection && <AddRow kind={kind} options={groupOptions} emptyMsg="Every group of this type is already in the budget. Create more on the Categories page." onAdd={onAddLine} onCancel={onCancelAdd} />}
        {section.groups.map((g, i) => (
          <div key={g.group_id}
            onDragOver={(e) => { if (dragIdx !== null) e.preventDefault(); }}
            onDrop={() => { if (dragIdx !== null && dragIdx !== i) onMoveGroup(dragIdx, i); setDragIdx(null); }}
            style={dragIdx === i ? { opacity: 0.5 } : undefined}>
            <GroupCard group={g} kind={kind} onEdit={onEdit} onRemove={onRemove} onConfigure={onConfigure}
              dragHandle={<DragHandle index={i} onStart={setDragIdx} onEnd={() => setDragIdx(null)} />}
              onMoveItem={onMoveItem} onShowCatTxns={onShowCatTxns}
              itemOptions={itemOptions(g.group_id)} addingItem={addGroupId === g.group_id}
              onToggleAddItem={() => onToggleAddItem(g.group_id)} onAddItem={onAddLine} onCancelAddItem={onCancelAdd}
              onAddAll={() => onAddAllItems(itemOptions(g.group_id).map((o) => o.id))} />
          </div>
        ))}
        {/* Newly-added parent groups that have no lines yet — add items to them. */}
        {extraGroups.map((g) => (
          <GroupCard key={`empty-${g.group_id}`} group={g} kind={kind} onEdit={onEdit} onRemove={onRemove} onConfigure={onConfigure}
            dragHandle={<span />}
            onMoveItem={onMoveItem} onShowCatTxns={onShowCatTxns}
            itemOptions={itemOptions(g.group_id)} addingItem={addGroupId === g.group_id}
            onToggleAddItem={() => onToggleAddItem(g.group_id)} onAddItem={onAddLine} onCancelAddItem={onCancelAdd}
            onAddAll={() => onAddAllItems(itemOptions(g.group_id).map((o) => o.id))} />
        ))}
        {section.uncategorized > 0 && <UncategorizedCard amount={section.uncategorized} income={income} onClick={onShowUncategorized} />}
        {!hasRows && !addingSection && (
          <div className="card"><div className="empty">No {income ? 'income' : 'expense'} allocations yet. Click “Add {income ? 'Income' : 'Expense'} Group”.</div></div>
        )}
      </div>
    </div>
  );
}

// Add-a-line form: pick a category (flat list), amount, and rollover mode. Used
// for adding a group (section header) or an item within a group (group header).
function AddRow({
  kind, options, emptyMsg, onAdd, onCancel, inline,
}: {
  kind: 'income' | 'expense'; options: { id: number; name: string }[]; emptyMsg: string;
  onAdd: (categoryId: number, amount: number, mode: RolloverMode) => void; onCancel: () => void; inline?: boolean;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<RolloverMode>('reset');
  const accent = kindAccent(kind);
  const wrap = (children: ReactNode) => inline
    ? <div style={{ padding: '10px 14px', borderTop: '1px solid var(--hairline)', background: 'var(--surface-alt)' }}>{children}</div>
    : <div className="card" style={{ padding: 14, borderLeft: `3px solid ${accent}` }}>{children}</div>;
  if (options.length === 0) {
    return wrap(
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 13 }}>{emptyMsg}</span>
        <button className="ghost" onClick={onCancel}>Close</button>
      </div>
    );
  }
  return wrap(
    <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <label className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
        <span>Category</span>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Select…</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="field" style={{ margin: 0, width: 120 }}>
        <span>Amount</span>
        <AmountInput value={amount} onChange={(v) => setAmount(v)} placeholder="0.00" />
      </label>
      <label className="field" style={{ margin: 0, width: 140 }}>
        <span>Rollover</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as RolloverMode)}>
          {ROLLOVER_MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      <button disabled={!categoryId || (amount !== '' && (Number.isNaN(Number(amount)) || Number(amount) < 0))} onClick={() => onAdd(Number(categoryId), amount === '' ? 0 : Number(amount), mode)}>Add</button>
      <button className="ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

// Shows the amount as currency ($1,234.00) when idle; switches to a plain
// editable number on focus, and saves (formatted again) on blur/Enter.
function EditableAmount({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [focused, setFocused] = useState(false);
  const [v, setV] = useState(String(value));
  useEffect(() => { if (!focused) setV(String(value)); }, [value, focused]);
  const commit = () => {
    const n = Number(v);
    if (!Number.isNaN(n) && n >= 0 && n !== value) onSave(n);
    else setV(String(value));
    setFocused(false);
  };
  return (
    <input
      className="num-input money"
      inputMode="decimal"
      value={focused ? v : money(value)}
      onFocus={(e) => { setFocused(true); setV(String(value)); requestAnimationFrame(() => e.target.select()); }}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setV(String(value)); setFocused(false); (e.target as HTMLInputElement).blur(); }
      }}
      style={{ width: '100%', textAlign: 'right' }}
    />
  );
}

function GroupCard({
  group, kind, onEdit, onRemove, onConfigure, dragHandle, onMoveItem, onShowCatTxns,
  itemOptions, addingItem, onToggleAddItem, onAddItem, onCancelAddItem, onAddAll,
}: {
  group: Group; kind: 'income' | 'expense';
  onEdit: (categoryId: number, amount: number, mode: RolloverMode) => void;
  onRemove: (lineId: number) => void;
  onConfigure: (line: Line) => void;
  dragHandle: ReactNode;
  onMoveItem: (groupId: number, lines: Line[], from: number, to: number) => void;
  onShowCatTxns: (cats: number[], title: string) => void;
  itemOptions: { id: number; name: string }[];
  addingItem: boolean;
  onToggleAddItem: () => void;
  onAddItem: (categoryId: number, amount: number, mode: RolloverMode) => void;
  onCancelAddItem: () => void;
  onAddAll: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const income = kind === 'income';
  const actualWord = income ? 'received' : 'spent';
  const remaining = group.allocated - group.actual;
  const pct = group.allocated > 0 ? (group.actual / group.allocated) * 100 : 0;
  const over = !income && group.actual > group.allocated;
  const remLabel = remaining < 0 ? 'over' : income ? 'to receive' : 'left';

  return (
    <div className={`card kindcard ${kind}`}>
      <div className="kindcard-head">
        <span className="title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {dragHandle}
          {group.group_name}
        </span>
        <span className="row" style={{ gap: 12, alignItems: 'center' }}>
          <span className="num" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            <span className={`clickable ${over ? 'debit' : ''}`} style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textDecorationColor: 'var(--hairline-strong)' }}
              title={`View ${actualWord} transactions`}
              onClick={() => onShowCatTxns(group.lines.map((l) => l.category_id), `${group.group_name} — ${actualWord}`)}>{income ? 'Received' : 'Spent'} {money(group.actual)}</span>
            <span className="muted"> · {money(group.allocated)} planned</span>
          </span>
          {itemOptions.length > 1 && !addingItem && (
            <button className="ghost" title={`Add all ${itemOptions.length} remaining items in this group`} onClick={onAddAll}>Add All</button>
          )}
          {(itemOptions.length > 0 || addingItem) && (
            <button className={addingItem ? 'ghost' : ''} onClick={onToggleAddItem}>{addingItem ? 'Close' : 'Add'}</button>
          )}
        </span>
      </div>

      <div style={{ padding: '11px 14px 6px' }}>
        <div className={`progress ${over ? 'over' : ''}`}><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <span className="muted num" style={{ fontSize: 11 }}>{pct.toFixed(0)}% {income ? 'received' : 'spent'}</span>
          <span className={`num ${remaining < 0 ? (income ? 'credit' : 'debit') : 'muted'}`} style={{ fontSize: 11 }}>
            {money(Math.abs(remaining))} {remLabel}
          </span>
        </div>
      </div>

      <table className="ledger" style={{ tableLayout: 'fixed', width: '100%' }}>
        <colgroup>
          <col />
          <col style={{ width: 120 }} />
          <col style={{ width: 150 }} />
          <col style={{ width: 120 }} />
          <col style={{ width: 120 }} />
          <col style={{ width: 44 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Item</th>
            <th className="r">Beginning Balance</th>
            <th className="r">Planned This Period</th>
            <th className="r">{income ? 'Received' : 'Spent'}</th>
            <th className="r">Remaining</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {group.lines.map((l, li) => {
            const lr = l.allocated - l.actual;
            const lover = !income && l.actual > l.allocated;
            const base = l.base_amount ?? l.allocated;
            const mode = l.rollover_mode ?? 'reset';
            return (
              <tr key={l.category_id}
                onDragOver={(e) => { if (dragIdx !== null) e.preventDefault(); }}
                onDrop={() => { if (dragIdx !== null && dragIdx !== li) onMoveItem(group.group_id, group.lines, dragIdx, li); setDragIdx(null); }}
                style={dragIdx === li ? { opacity: 0.5 } : undefined}>
                <td style={{ paddingLeft: 14, overflow: 'hidden' }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    {group.lines.length > 1 && (
                      <DragHandle index={li} onStart={setDragIdx} onEnd={() => setDragIdx(null)} />
                    )}
                    <button className="ghost" style={{ padding: 4, display: 'inline-flex', lineHeight: 0 }} title="Configure behavior"
                      onClick={() => onConfigure(l)}><EditIcon /></button>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.category_name}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginLeft: 29 }}>{behaviorText(mode)}</div>
                </td>
                <td className="r money num muted">{mode === 'reset' ? '—' : money(l.carry_in ?? 0)}</td>
                <td className="r"><EditableAmount value={base} onSave={(n) => onEdit(l.category_id, n, mode)} /></td>
                <td className={`r money num ${lover ? 'debit' : ''}`} style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textDecorationColor: 'var(--hairline-strong)' }}
                  title={`View ${actualWord} transactions`}
                  onClick={() => onShowCatTxns([l.category_id], l.category_name)}>{money(l.actual)}</td>
                <td className={`r money num ${lr < 0 ? (income ? 'credit' : 'debit') : ''}`}>{money(lr)}</td>
                <td className="r" style={{ paddingLeft: 4, paddingRight: 8 }}><button className="ghost" title="Remove allocation" style={{ padding: '2px 8px' }} onClick={() => onRemove(l.line_id)}>✕</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {addingItem && <AddRow inline kind={kind} options={itemOptions} emptyMsg="No more items to add in this group. Create more on the Categories page." onAdd={onAddItem} onCancel={onCancelAddItem} />}
    </div>
  );
}

function UncategorizedCard({ amount, income, onClick }: { amount: number; income: boolean; onClick: () => void }) {
  return (
    <div className="card clickable" onClick={onClick} title="View and categorize these transactions"
      style={{ padding: 0, overflow: 'hidden', borderLeft: '3px solid var(--hairline-strong)', cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', background: 'var(--surface-alt)', borderBottom: '1px solid var(--hairline)' }}>
        <span className="muted" style={{ fontWeight: 700, fontSize: 15 }}>Uncategorized</span>
        <span className="num" style={{ fontSize: 13 }}>{money(amount)}</span>
      </div>
      <div className="muted" style={{ fontSize: 12, padding: '10px 14px' }}>
        {income ? 'Income' : 'Spending'} this period not assigned to a budget item — <span style={{ textDecoration: 'underline' }}>click to review &amp; categorize</span>.
      </div>
    </div>
  );
}

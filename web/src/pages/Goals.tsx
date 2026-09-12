import { useEffect, useState } from 'react';
import { api, money, shortDate, todayStr } from '../api';
import { AmountInput, Field, Modal, EditorFooter, useDirty } from '../components/ui';

type GoalType = 'savings' | 'reduce_spending' | 'debt_payoff';

interface Progress {
  current: number;
  target: number;
  pct: number;
  remaining: number;
  state: 'achieved' | 'on_track' | 'over';
  baseline?: number;
  paid?: number;
  period?: string;
  windowLabel?: string;
}
interface Goal {
  id: number;
  name: string;
  goal_type: GoalType;
  target_amount: number | null;
  current_amount: number | null;
  baseline_amount: number | null;
  period: string | null;
  account_id: number | null;
  category_id: number | null;
  liability_id: number | null;
  asset_id: number | null;
  target_date: string | null;
  status: 'active' | 'archived';
  notes: string | null;
  account_name: string | null;
  category_name: string | null;
  liability_name: string | null;
  asset_name: string | null;
  progress: Progress;
}

interface Account { id: number; name: string; is_liability: boolean; latest_balance: number | null }
interface Asset { id: number; name: string; value: number | null }
interface Liability { id: number; name: string; balance: number | null }
interface Category { id: number; name: string; kind: 'expense' | 'income'; parent_id: number | null; has_children: boolean; sort_order: number }

const TYPE_LABEL: Record<GoalType, string> = {
  savings: 'Savings', reduce_spending: 'Reduce spending', debt_payoff: 'Debt payoff',
};

export default function Goals() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [lookups, setLookups] = useState<{ accounts: Account[]; assets: Asset[]; liabilities: Liability[]; categories: Category[] }>(
    { accounts: [], assets: [], liabilities: [], categories: [] }
  );
  const [editing, setEditing] = useState<Goal | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');

  // Send the browser-local date so reduce-spending goals resolve the current period
  // in the user's timezone (not the server's UTC day).
  const load = () => api.get<Goal[]>(`/goals?ref=${todayStr()}`).then(setGoals).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    Promise.all([
      api.get<Account[]>('/accounts').catch(() => []),
      api.get<Asset[]>('/assets').catch(() => []),
      api.get<Liability[]>('/liabilities').catch(() => []),
      api.get<Category[]>('/categories').catch(() => []),
    ]).then(([accounts, assets, liabilities, categories]) => setLookups({ accounts, assets, liabilities, categories }));
  }, []);

  const remove = async (g: Goal) => {
    if (!confirm(`Delete goal "${g.name}"?`)) return;
    try { await api.del(`/goals/${g.id}`); load(); } catch (e: any) { setErr(e.message); }
  };
  const archiveToggle = async (g: Goal) => {
    try { await api.put(`/goals/${g.id}`, { status: g.status === 'active' ? 'archived' : 'active' }); load(); } catch (e: any) { setErr(e.message); }
  };

  const active = goals.filter((g) => g.status === 'active');
  const archived = goals.filter((g) => g.status === 'archived');
  const achievedCount = active.filter((g) => g.progress.state === 'achieved').length;
  const offTrackCount = active.filter((g) => g.progress.state === 'over').length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Plan</div>
          <h1 className="title">Goals</h1>
          <p className="subtitle">Save toward a target, rein in a spending category, or pay down debt — tracked against your live data.</p>
        </div>
        <button className="head-add" onClick={() => setAdding(true)}>Add Goal</button>
      </div>

      {err && <div className="error">{err}</div>}

      {goals.length === 0 ? (
        <div className="card"><div className="empty">No goals yet. Add a savings, spending, or debt-payoff goal to start.</div></div>
      ) : (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Active goals</div><div className="value">{active.length}</div></div>
            <div className="card stat"><div className="label">Achieved</div><div className="value credit">{achievedCount}</div></div>
            <div className="card stat"><div className="label">Off track</div><div className={`value ${offTrackCount > 0 ? 'debit' : ''}`}>{offTrackCount}</div></div>
          </div>

          <h2 className="section" style={{ margin: '0 0 12px' }}>Active Goals</h2>
          {active.length === 0 ? (
            <div className="card"><div className="empty">No active goals. Reactivate one below, or add a new goal.</div></div>
          ) : (
            <div style={{ display: 'grid', gap: 16 }}>
              {active.map((g) => <GoalCard key={g.id} goal={g} onEdit={() => setEditing(g)} onDelete={() => remove(g)} onArchive={() => archiveToggle(g)} />)}
            </div>
          )}
        </>
      )}

      {archived.length > 0 && (
        <>
          <h2 className="section">Archived</h2>
          <div style={{ display: 'grid', gap: 16 }}>
            {archived.map((g) => <GoalCard key={g.id} goal={g} onEdit={() => setEditing(g)} onDelete={() => remove(g)} onArchive={() => archiveToggle(g)} />)}
          </div>
        </>
      )}

      {(adding || editing) && (
        <GoalEditor goal={editing} lookups={lookups} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { setAdding(false); setEditing(null); load(); }} />
      )}
    </>
  );
}

function GoalCard({ goal, onEdit, onDelete, onArchive }: { goal: Goal; onEdit: () => void; onDelete: () => void; onArchive: () => void }) {
  const p = goal.progress;
  const over = p.state === 'over';
  const achieved = p.state === 'achieved';
  const barPct = Math.min(100, Math.max(0, p.pct));

  let line1 = '';
  let line2 = '';
  if (goal.goal_type === 'savings') {
    line1 = `${money(p.current)} of ${money(p.target)}`;
    line2 = achieved ? 'Goal reached 🎉' : `${money(p.remaining)} to go`;
  } else if (goal.goal_type === 'debt_payoff') {
    line1 = `${money(p.remaining)} left to pay`;
    line2 = achieved ? 'Paid off 🎉' : `Paid ${money(p.paid ?? 0)}${p.baseline != null ? ` of ${money(p.baseline - p.target)}` : ''}`;
  } else {
    line1 = `${money(p.current)} of ${money(p.target)} ${p.period ?? ''} cap`;
    line2 = over ? `Over by ${money(-p.remaining)}` : `${money(p.remaining)} left${p.windowLabel ? ` · ${p.windowLabel}` : ''}`;
  }

  const linked =
    goal.account_name ? `Account: ${goal.account_name}`
      : goal.asset_name ? `Asset: ${goal.asset_name}`
        : goal.liability_name ? `Debt: ${goal.liability_name}`
          : goal.category_name ? `Category: ${goal.category_name}` : null;

  // Left-border accent mirrors the kindcards on the other pages: green when the
  // goal is met, red when a spending cap is blown, neutral otherwise.
  const accent = achieved ? 'income' : over ? 'expense' : '';

  return (
    <div className={`card kindcard ${accent}`}>
      <div className="kindcard-head">
        <div style={{ minWidth: 0 }}>
          <div className="title">{goal.name}</div>
          {linked && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{linked}</div>}
        </div>
        <span className="tag">{TYPE_LABEL[goal.goal_type]}</span>
      </div>

      <div style={{ padding: '12px 14px' }}>
        <div className={`progress ${over ? 'over' : ''}`}>
          <span style={{ width: `${barPct}%`, background: achieved ? 'var(--credit)' : undefined }} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <div className="num" style={{ fontSize: 15 }}>{line1}</div>
          <div className={`num ${over ? 'debit' : achieved ? 'credit' : 'muted'}`} style={{ fontSize: 13 }}>{line2}</div>
        </div>

        {goal.target_date && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Target date: {shortDate(goal.target_date)}</div>}
        {goal.notes && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{goal.notes}</div>}

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={onEdit}>Edit</button>
          <button className="ghost" onClick={onArchive}>{goal.status === 'active' ? 'Archive' : 'Reactivate'}</button>
          <div className="spacer" />
          <button className="danger" onClick={onDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function expenseCategoryOptions(categories: Category[]) {
  const groups = categories.filter((c) => c.parent_id === null && c.kind === 'expense').sort((a, b) => a.sort_order - b.sort_order);
  return groups.map((g) => {
    const items = categories.filter((c) => c.parent_id === g.id).sort((a, b) => a.sort_order - b.sort_order);
    return (
      <optgroup key={g.id} label={g.name}>
        <option value={g.id}>{g.name} (whole group)</option>
        {items.map((it) => <option key={it.id} value={it.id}>{`  ${it.name}`}</option>)}
      </optgroup>
    );
  });
}

function GoalEditor({
  goal, lookups, onClose, onSaved,
}: {
  goal: Goal | null;
  lookups: { accounts: Account[]; assets: Asset[]; liabilities: Liability[]; categories: Category[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<GoalType>(goal?.goal_type ?? 'savings');
  // savings source: how the current value is tracked
  const initialSource = goal?.account_id ? 'account' : goal?.asset_id ? 'asset' : 'manual';
  const [source, setSource] = useState<'manual' | 'account' | 'asset'>(initialSource);
  const [f, setF] = useState({
    name: goal?.name ?? '',
    target_amount: goal?.target_amount?.toString() ?? '',
    current_amount: goal?.current_amount?.toString() ?? '',
    baseline_amount: goal?.baseline_amount?.toString() ?? '',
    period: goal?.period ?? 'monthly',
    account_id: goal?.account_id?.toString() ?? '',
    category_id: goal?.category_id?.toString() ?? '',
    liability_id: goal?.liability_id?.toString() ?? '',
    asset_id: goal?.asset_id?.toString() ?? '',
    target_date: goal?.target_date?.slice(0, 10) ?? '',
    notes: goal?.notes ?? '',
  });
  const [err, setErr] = useState('');
  const dirty = useDirty({ f, type, source });
  const set = (patch: Partial<typeof f>) => setF((cur) => ({ ...cur, ...patch }));

  // Debt to pay off can be either a liability account (credit card, loan,
  // mortgage — lives in `accounts` with is_liability) or a standalone liability.
  // The dropdown value is prefixed (`acct:` / `liab:`) so we know which id to set.
  const debtLink = f.account_id ? `acct:${f.account_id}` : f.liability_id ? `liab:${f.liability_id}` : '';
  const onPickDebt = (val: string) => {
    if (!val) { set({ account_id: '', liability_id: '' }); return; }
    const [kind, id] = val.split(':');
    if (kind === 'acct') {
      const acct = lookups.accounts.find((a) => String(a.id) === id);
      set({
        account_id: id, liability_id: '',
        baseline_amount: f.baseline_amount || (acct?.latest_balance != null ? String(acct.latest_balance) : ''),
        target_amount: f.target_amount || '0',
      });
    } else {
      const lia = lookups.liabilities.find((l) => String(l.id) === id);
      set({
        liability_id: id, account_id: '',
        baseline_amount: f.baseline_amount || (lia?.balance != null ? String(lia.balance) : ''),
        target_amount: f.target_amount || '0',
      });
    }
  };

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    const body: any = {
      name: f.name, goal_type: type, target_date: f.target_date || null, notes: f.notes || null,
      target_amount: null, current_amount: null, baseline_amount: null, period: null,
      account_id: null, category_id: null, liability_id: null, asset_id: null,
    };
    if (type === 'savings') {
      if (!f.target_amount) { setErr('Set a target amount.'); return; }
      body.target_amount = Number(f.target_amount);
      if (source === 'account') body.account_id = f.account_id ? Number(f.account_id) : null;
      else if (source === 'asset') body.asset_id = f.asset_id ? Number(f.asset_id) : null;
      else body.current_amount = f.current_amount ? Number(f.current_amount) : 0;
    } else if (type === 'reduce_spending') {
      if (!f.category_id) { setErr('Pick a category to cap.'); return; }
      if (!f.target_amount) { setErr('Set a spending cap.'); return; }
      body.category_id = Number(f.category_id);
      body.target_amount = Number(f.target_amount);
      body.period = f.period;
    } else {
      if (!f.liability_id && !f.account_id && !f.current_amount) { setErr('Link a debt account or liability, or enter a current balance.'); return; }
      body.target_amount = f.target_amount ? Number(f.target_amount) : 0;
      body.baseline_amount = f.baseline_amount ? Number(f.baseline_amount) : null;
      if (f.account_id) body.account_id = Number(f.account_id);
      else if (f.liability_id) body.liability_id = Number(f.liability_id);
      else body.current_amount = Number(f.current_amount);
    }
    try {
      if (goal) await api.put(`/goals/${goal.id}`, body);
      else await api.post('/goals', body);
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <Modal title={goal ? 'Edit Goal' : 'Add Goal'} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="grid grid-2">
        <Field label="Name"><input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Emergency fund" /></Field>
        <Field label="Goal Type">
          <select value={type} onChange={(e) => setType(e.target.value as GoalType)} disabled={!!goal}>
            <option value="savings">Savings</option>
            <option value="reduce_spending">Reduce Spending</option>
            <option value="debt_payoff">Debt Payoff</option>
          </select>
        </Field>
      </div>

      {type === 'savings' && (
        <>
          <div className="grid grid-2">
            <Field label="Target Amount"><AmountInput value={f.target_amount} onChange={(v) => set({ target_amount: v })} placeholder="10000" /></Field>
            <Field label="Track Current Value via">
              <select value={source} onChange={(e) => setSource(e.target.value as any)}>
                <option value="manual">Enter Manually</option>
                <option value="account">An Account Balance</option>
                <option value="asset">An Asset Value</option>
              </select>
            </Field>
          </div>
          {source === 'manual' && (
            <Field label="Current Amount Saved"><AmountInput value={f.current_amount} onChange={(v) => set({ current_amount: v })} placeholder="0" /></Field>
          )}
          {source === 'account' && (
            <Field label="Account">
              <select value={f.account_id} onChange={(e) => set({ account_id: e.target.value })}>
                <option value="">Select…</option>
                {lookups.accounts.filter((a) => !a.is_liability).map((a) => <option key={a.id} value={a.id}>{a.name}{a.latest_balance != null ? ` · ${money(a.latest_balance)}` : ''}</option>)}
              </select>
            </Field>
          )}
          {source === 'asset' && (
            <Field label="Asset">
              <select value={f.asset_id} onChange={(e) => set({ asset_id: e.target.value })}>
                <option value="">Select…</option>
                {lookups.assets.map((a) => <option key={a.id} value={a.id}>{a.name}{a.value != null ? ` · ${money(a.value)}` : ''}</option>)}
              </select>
            </Field>
          )}
        </>
      )}

      {type === 'reduce_spending' && (
        <div className="grid grid-3">
          <Field label="Category">
            <select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}>
              <option value="">Select…</option>
              {expenseCategoryOptions(lookups.categories)}
            </select>
          </Field>
          <Field label="Spending Cap"><AmountInput value={f.target_amount} onChange={(v) => set({ target_amount: v })} placeholder="500" /></Field>
          <Field label="Per">
            <select value={f.period} onChange={(e) => set({ period: e.target.value })}>
              <option value="weekly">Week</option>
              <option value="monthly">Month</option>
              <option value="yearly">Year</option>
            </select>
          </Field>
        </div>
      )}

      {type === 'debt_payoff' && (
        <>
          <Field label="Debt to Pay Off">
            <select value={debtLink} onChange={(e) => onPickDebt(e.target.value)}>
              <option value="">Not linked — enter manually</option>
              {lookups.accounts.some((a) => a.is_liability) && (
                <optgroup label="Accounts">
                  {lookups.accounts.filter((a) => a.is_liability).map((a) => (
                    <option key={`acct-${a.id}`} value={`acct:${a.id}`}>{a.name}{a.latest_balance != null ? ` · ${money(a.latest_balance)}` : ''}</option>
                  ))}
                </optgroup>
              )}
              {lookups.liabilities.length > 0 && (
                <optgroup label="Other Liabilities">
                  {lookups.liabilities.map((l) => (
                    <option key={`liab-${l.id}`} value={`liab:${l.id}`}>{l.name}{l.balance != null ? ` · ${money(l.balance)}` : ''}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          <div className="grid grid-3">
            <Field label="Starting Balance"><AmountInput value={f.baseline_amount} onChange={(v) => set({ baseline_amount: v })} placeholder="e.g. 20000" /></Field>
            {!f.liability_id && !f.account_id && (
              <Field label="Current Balance"><AmountInput value={f.current_amount} onChange={(v) => set({ current_amount: v })} placeholder="e.g. 8500" /></Field>
            )}
            <Field label="Target Balance"><AmountInput value={f.target_amount} onChange={(v) => set({ target_amount: v })} placeholder="0" /></Field>
          </div>
        </>
      )}

      <div className="grid grid-2">
        <Field label="Target Date (Optional)"><input type="date" value={f.target_date} onChange={(e) => set({ target_date: e.target.value })} /></Field>
        <Field label="Notes"><input value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>

      <EditorFooter onClose={onClose} onSave={save} saveLabel={goal ? 'Save Changes' : 'Add Goal'} disabled={!dirty} />
    </Modal>
  );
}

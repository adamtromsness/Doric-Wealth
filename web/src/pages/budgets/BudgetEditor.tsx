import { useState } from 'react';
import { api, todayStr } from '../../api';
import { Field, Modal, EditorFooter, useDirty, AmountInput } from '../../components/ui';
import type { Line, RolloverMode } from './types';
import { ROLLOVER_MODES, ROLLOVER_DESC } from './types';

export function LineConfigModal({ line, onSave, onClose }: { line: Line; onSave: (mode: RolloverMode, opening: number) => void; onClose: () => void }) {
  const [mode, setMode] = useState<RolloverMode>(line.rollover_mode ?? 'reset');
  const [opening, setOpening] = useState(String(line.opening_balance ?? 0));
  return (
    <Modal title={`Configure: ${line.category_name}`} onClose={onClose}>
      <Field label="Period Behavior">
        <select value={mode} onChange={(e) => setMode(e.target.value as RolloverMode)}>
          {ROLLOVER_MODES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </Field>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{ROLLOVER_DESC[mode]}</div>
      {mode !== 'reset' && (
        <>
          <Field label="Starting Balance">
            <AmountInput value={opening} onChange={(v) => setOpening(v)} placeholder="0.00" style={{ textAlign: 'right' }} />
          </Field>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>The balance this category began with at the budget's start; the carry/accrual builds from here.</div>
        </>
      )}
      <EditorFooter onClose={onClose} onSave={() => onSave(mode, mode === 'reset' ? 0 : (Number(opening) || 0))} saveLabel="Save" />
    </Modal>
  );
}

export function NewBudget({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', period: 'monthly', start_date: todayStr(), end_date: '' });
  const [err, setErr] = useState('');
  const dirty = useDirty(f);
  const isCustom = f.period === 'custom';
  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return; }
    if (isCustom) {
      if (!f.start_date || !f.end_date) { setErr('A custom range needs a start and end date.'); return; }
      if (f.end_date < f.start_date) { setErr('End date must be on or after the start date.'); return; }
    }
    try {
      await api.post('/budgets', {
        name: f.name, period: f.period, start_date: f.start_date,
        end_date: isCustom ? f.end_date : null,
      });
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <Modal title="New Budget" onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Family 2026" /></Field>
      <Field label="Period">
        <select value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
          <option value="monthly">Monthly (recurring)</option>
          <option value="weekly">Weekly (recurring)</option>
          <option value="yearly">Yearly (recurring)</option>
          <option value="custom">Custom Date Range</option>
        </select>
      </Field>
      <div className="grid grid-2">
        <Field label={isCustom ? 'Start date' : 'Start date (anchor)'}>
          <input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} />
        </Field>
        {isCustom && (
          <Field label="End Date"><input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        {isCustom
          ? 'A custom budget tracks one fixed window between these dates.'
          : 'Recurring budgets roll forward each period; use ◀ ▶ to move between periods.'}
      </div>
      <EditorFooter onClose={onClose} onSave={save} saveLabel="Create Budget" disabled={!dirty} />
    </Modal>
  );
}

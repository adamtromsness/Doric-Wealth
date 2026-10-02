import { useEffect, useState } from 'react';
import { api, shortDate, todayStr, ageOn, dobProblem, earliestDob } from '../api';
import { useAuth } from '../auth';
import { Field } from '../components/ui';

// My Profile: tabbed personal record (same shape as the account/vehicle/property
// detail pages). The 1:1 sections share one form + a single top "Save Changes"
// button; Dependants is a sub-collection with its own inline add/edit/delete.
type Tab = 'profile' | 'occupation' | 'retirement' | 'dependants' | 'emergency' | 'security';
const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'occupation', label: 'Occupation' },
  { key: 'retirement', label: 'Retirement' },
  { key: 'dependants', label: 'Dependants' },
  { key: 'emergency', label: 'Emergency' },
  { key: 'security', label: 'Security' },
];

const EMPLOYMENT: readonly (readonly [string, string])[] = [
  ['', '—'], ['employed', 'Employed'], ['self_employed', 'Self-employed'], ['retired', 'Retired'],
  ['unemployed', 'Unemployed'], ['student', 'Student'], ['other', 'Other'],
];

// Every editable 1:1 field (kept as strings for the form; the server coerces).
const FIELDS = [
  'first_name', 'middle_name', 'last_name', 'preferred_name', 'dob',
  'phone', 'address_line1', 'address_line2', 'city', 'state_region', 'postal_code', 'country',
  'employer', 'job_title', 'employment_status', 'industry', 'annual_income', 'employment_start',
  'target_retirement_age', 'target_retirement_date', 'desired_monthly_income', 'monthly_contribution', 'retirement_notes',
  'emergency_name', 'emergency_relationship', 'emergency_phone', 'emergency_email',
] as const;
type FieldKey = typeof FIELDS[number];
type Form = Record<FieldKey, string>;
const seed = (p: any): Form => {
  const o = {} as Form;
  for (const k of FIELDS) o[k] = p?.[k] == null ? '' : String(p[k]);
  return o;
};

interface Dependant { id: number; first_name: string | null; middle_name: string | null; last_name: string | null; name: string; relationship: string | null; dob: string | null; notes: string | null }

export default function Account() {
  const { refresh } = useAuth();
  const [tab, setTab] = useState<Tab>('profile');
  const [email, setEmail] = useState('');
  const [f, setF] = useState<Form>(() => seed(null));
  const [base, setBase] = useState<Form>(() => seed(null));
  const [deps, setDeps] = useState<Dependant[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<any>('/auth/profile').then((p) => {
      setEmail(p.email ?? ''); const s = seed(p); setF(s); setBase(s); setDeps(p.dependants ?? []);
    }).catch((e) => setErr(e.message));
  }, []);

  const dirty = JSON.stringify(f) !== JSON.stringify(base);
  const set = (k: FieldKey, v: string) => { setF((p) => ({ ...p, [k]: v })); };

  const save = async () => {
    setSaving(true); setErr('');
    const payload: Record<string, string | null> = {};
    for (const k of FIELDS) payload[k] = f[k].trim() === '' ? null : f[k].trim();
    try {
      await api.put('/auth/profile', payload);
      setBase(f); await refresh();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };

  // Dependants sub-collection (saved immediately, separate from "Save Changes"). The
  // add/edit state lives here so the Add button can sit alongside the Save Changes row.
  const blankDep = { first_name: '', middle_name: '', last_name: '', relationship: '', dob: '', notes: '' };
  const [depEditId, setDepEditId] = useState<number | 'new' | null>(null);
  const [depForm, setDepForm] = useState(blankDep);
  const [depBusy, setDepBusy] = useState(false);
  const depStartNew = () => { setDepForm(blankDep); setDepEditId('new'); };
  const depStartEdit = (d: Dependant) => { setDepForm({ first_name: d.first_name ?? '', middle_name: d.middle_name ?? '', last_name: d.last_name ?? '', relationship: d.relationship ?? '', dob: d.dob ?? '', notes: d.notes ?? '' }); setDepEditId(d.id); };
  const depSave = async () => {
    if (!depForm.first_name.trim() && !depForm.last_name.trim()) { setErr('A dependant needs a first or last name.'); return; }
    const dobErr = dobProblem(depForm.dob);
    if (dobErr) { setErr(dobErr); return; }
    setDepBusy(true); setErr('');
    const payload = {
      first_name: depForm.first_name.trim() || null, middle_name: depForm.middle_name.trim() || null, last_name: depForm.last_name.trim() || null,
      relationship: depForm.relationship.trim() || null, dob: depForm.dob || null, notes: depForm.notes.trim() || null,
    };
    try {
      if (depEditId === 'new') { const row = await api.post<Dependant>('/auth/dependants', payload); setDeps((d) => [...d, row]); }
      else { const row = await api.put<Dependant>(`/auth/dependants/${depEditId}`, payload); setDeps((d) => d.map((x) => (x.id === depEditId ? row : x))); }
      setDepEditId(null);
    } catch (e: any) { setErr(e.message); } finally { setDepBusy(false); }
  };
  const depRemove = async (id: number) => {
    setDepBusy(true); setErr('');
    try { await api.del(`/auth/dependants/${id}`); setDeps((d) => d.filter((x) => x.id !== id)); }
    catch (e: any) { setErr(e.message); } finally { setDepBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1 className="title">My Profile</h1>
          <p className="subtitle">Your personal record — keep your details, work, retirement plans, and family on file.</p>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', marginBottom: 8 }}>
        <div className="btn-row">
          {tab === 'dependants' ? (
            depEditId === null ? (
              <button onClick={depStartNew}>Add Dependant</button>
            ) : (
              <>
                <button className="ghost" onClick={() => setDepEditId(null)} disabled={depBusy}>Cancel</button>
                <button onClick={depSave} disabled={depBusy}>{depBusy ? 'Saving…' : 'Save Changes'}</button>
              </>
            )
          ) : tab === 'security' ? null : (
            <>
              <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
            </>
          )}
        </div>
      </div>

      {tab === 'profile' && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Personal</div>
          <div className="grid grid-3">
            <Field label="First Name"><input value={f.first_name} onChange={(e) => set('first_name', e.target.value)} placeholder="e.g. Adam" /></Field>
            <Field label="Middle Name"><input value={f.middle_name} onChange={(e) => set('middle_name', e.target.value)} placeholder="(optional)" /></Field>
            <Field label="Last Name"><input value={f.last_name} onChange={(e) => set('last_name', e.target.value)} placeholder="e.g. Smith" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Preferred Name"><input value={f.preferred_name} onChange={(e) => set('preferred_name', e.target.value)} placeholder="what you'd like to be called" /></Field>
            <Field label="Date of Birth"><input type="date" value={f.dob} onChange={(e) => set('dob', e.target.value)} /></Field>
          </div>
          <div className="label" style={{ margin: '16px 0 10px' }}>Contact</div>
          <div className="grid grid-2">
            <Field label="Email"><input value={email} disabled readOnly /></Field>
            <Field label="Phone"><input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="(optional)" /></Field>
          </div>
          <Field label="Address Line 1"><input value={f.address_line1} onChange={(e) => set('address_line1', e.target.value)} /></Field>
          <Field label="Address Line 2"><input value={f.address_line2} onChange={(e) => set('address_line2', e.target.value)} placeholder="(optional)" /></Field>
          <div className="grid grid-4">
            <Field label="City"><input value={f.city} onChange={(e) => set('city', e.target.value)} /></Field>
            <Field label="State / Region"><input value={f.state_region} onChange={(e) => set('state_region', e.target.value)} /></Field>
            <Field label="Postal Code"><input value={f.postal_code} onChange={(e) => set('postal_code', e.target.value)} /></Field>
            <Field label="Country"><input value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Changing your email or password isn't available here yet.</div>
        </div>
      )}

      {tab === 'occupation' && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Occupation</div>
          <div className="grid grid-2">
            <Field label="Employer"><input value={f.employer} onChange={(e) => set('employer', e.target.value)} /></Field>
            <Field label="Job Title"><input value={f.job_title} onChange={(e) => set('job_title', e.target.value)} /></Field>
          </div>
          <div className="grid grid-3">
            <Field label="Employment Status">
              <select value={f.employment_status} onChange={(e) => set('employment_status', e.target.value)}>
                {EMPLOYMENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Industry"><input value={f.industry} onChange={(e) => set('industry', e.target.value)} /></Field>
            <Field label="Employed Since"><input type="date" value={f.employment_start} onChange={(e) => set('employment_start', e.target.value)} /></Field>
          </div>
          <Field label="Annual Income"><input type="number" inputMode="decimal" value={f.annual_income} onChange={(e) => set('annual_income', e.target.value)} placeholder="e.g. 85000" /></Field>
        </div>
      )}

      {tab === 'retirement' && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Retirement Planning</div>
          <div className="grid grid-2">
            <Field label="Target Retirement Age"><input type="number" value={f.target_retirement_age} onChange={(e) => set('target_retirement_age', e.target.value)} placeholder="e.g. 65" /></Field>
            <Field label="Target Retirement Date"><input type="date" value={f.target_retirement_date} onChange={(e) => set('target_retirement_date', e.target.value)} /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Desired Monthly Income"><input type="number" inputMode="decimal" value={f.desired_monthly_income} onChange={(e) => set('desired_monthly_income', e.target.value)} placeholder="in retirement" /></Field>
            <Field label="Monthly Contribution"><input type="number" inputMode="decimal" value={f.monthly_contribution} onChange={(e) => set('monthly_contribution', e.target.value)} placeholder="saved toward retirement" /></Field>
          </div>
          <Field label="Notes"><textarea value={f.retirement_notes} onChange={(e) => set('retirement_notes', e.target.value)} rows={3} placeholder="Goals, accounts, strategy…" /></Field>
        </div>
      )}

      {tab === 'dependants' && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Dependants</div>
          {depEditId !== null && (
            <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 14 }}>
              <div className="grid grid-3">
                <Field label="First Name"><input value={depForm.first_name} onChange={(e) => setDepForm({ ...depForm, first_name: e.target.value })} /></Field>
                <Field label="Middle Name"><input value={depForm.middle_name} onChange={(e) => setDepForm({ ...depForm, middle_name: e.target.value })} placeholder="(optional)" /></Field>
                <Field label="Last Name"><input value={depForm.last_name} onChange={(e) => setDepForm({ ...depForm, last_name: e.target.value })} /></Field>
              </div>
              <div className="grid grid-2">
                <Field label="Relationship"><input value={depForm.relationship} onChange={(e) => setDepForm({ ...depForm, relationship: e.target.value })} placeholder="e.g. Child" /></Field>
                <Field label="Date of Birth"><input type="date" value={depForm.dob} min={earliestDob()} max={todayStr()} onChange={(e) => setDepForm({ ...depForm, dob: e.target.value })} /></Field>
              </div>
              <Field label="Notes"><input value={depForm.notes} onChange={(e) => setDepForm({ ...depForm, notes: e.target.value })} placeholder="(optional)" /></Field>
            </div>
          )}
          {deps.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>No dependants added yet.</p>
          ) : (
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr><th style={{ textAlign: 'left' }}>Name</th><th style={{ textAlign: 'left' }}>Relationship</th><th style={{ textAlign: 'left' }}>Date of Birth</th><th style={{ textAlign: 'left' }}>Age</th><th></th></tr>
              </thead>
              <tbody>
                {deps.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="muted">{d.relationship || '—'}</td>
                    <td className="muted">{shortDate(d.dob)}</td>
                    <td className="muted">{ageOn(d.dob) ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                        <button className="ghost danger" style={{ padding: '4px 10px', fontSize: 12 }} disabled={depBusy} onClick={() => depRemove(d.id)}>Delete</button>
                        <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => depStartEdit(d)}>Edit</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'security' && <SecuritySection />}

      {tab === 'emergency' && (
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>Emergency Contact</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Who to reach in an emergency.</p>
          <div className="grid grid-2">
            <Field label="Name"><input value={f.emergency_name} onChange={(e) => set('emergency_name', e.target.value)} /></Field>
            <Field label="Relationship"><input value={f.emergency_relationship} onChange={(e) => set('emergency_relationship', e.target.value)} placeholder="e.g. Spouse" /></Field>
          </div>
          <div className="grid grid-2">
            <Field label="Phone"><input value={f.emergency_phone} onChange={(e) => set('emergency_phone', e.target.value)} /></Field>
            <Field label="Email"><input value={f.emergency_email} onChange={(e) => set('emergency_email', e.target.value)} /></Field>
          </div>
        </div>
      )}
    </>
  );
}

// Security tab: change the password, and end sessions on other devices. Both live
// here rather than in the shared profile form because each has its own action and
// neither should ride the page's single "Save Changes" button.
function SecuritySection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmNext, setConfirmNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const [outBusy, setOutBusy] = useState(false);
  const [outErr, setOutErr] = useState('');
  const [outNote, setOutNote] = useState('');

  const sessionsEnded = (n: number) =>
    n === 0 ? 'No other sessions were signed in.' : `Signed out ${n} other session${n === 1 ? '' : 's'}.`;

  const submit = async () => {
    setErr(''); setNote('');
    if (!current || !next) { setErr('Enter your current and new password.'); return; }
    if (next !== confirmNext) { setErr('The new passwords do not match.'); return; }
    if (next.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      const r = await api.put<{ ended: number }>('/auth/password', { current_password: current, new_password: next });
      setCurrent(''); setNext(''); setConfirmNext('');
      setNote(`Password changed. ${sessionsEnded(r.ended)}`);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const signOutEverywhere = async () => {
    if (!window.confirm('Sign out of every other device? You will stay signed in here.')) return;
    setOutErr(''); setOutNote(''); setOutBusy(true);
    try {
      const r = await api.post<{ ended: number }>('/auth/logout-all', {});
      setOutNote(sessionsEnded(r.ended));
    } catch (e: any) { setOutErr(e.message); }
    finally { setOutBusy(false); }
  };

  return (
    <>
      <div className="card">
        <div className="label" style={{ marginBottom: 10 }}>Change Password</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Changing your password signs out every other device, so anyone using your account elsewhere is locked out.
        </p>
        {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
        {note && <div className="banner" style={{ marginBottom: 12 }}>{note}</div>}
        <Field label="Current Password">
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <div className="grid grid-2">
          <Field label="New Password">
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="at least 8 characters" />
          </Field>
          <Field label="Confirm New Password">
            <input type="password" autoComplete="new-password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={submit} disabled={busy}>{busy ? 'Changing…' : 'Change Password'}</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="label" style={{ marginBottom: 10 }}>Signed-In Devices</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          End every other session without changing your password. Useful after using a shared or lost device.
        </p>
        {outErr && <div className="error" style={{ marginBottom: 12 }}>{outErr}</div>}
        {outNote && <div className="banner" style={{ marginBottom: 12 }}>{outNote}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={signOutEverywhere} disabled={outBusy}>
            {outBusy ? 'Signing Out…' : 'Sign Out Everywhere'}
          </button>
        </div>
      </div>
    </>
  );
}

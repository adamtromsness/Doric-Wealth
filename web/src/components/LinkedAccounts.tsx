import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiStream, money } from '../api';
import { Toggle, Modal, Field } from './ui';

interface LinkedAccount {
  id: number;
  link_id: number;
  external_account_id: string;
  sf_name: string | null;
  org_name: string | null;
  currency: string | null;
  last_balance: number | null;
  account_id: number | null;
  account_name: string | null;
  auto_import: boolean;
  missing_since: string | null;
  dismissed_fields: Record<string, string | null>;
}

const ACCOUNT_TYPE_OPTIONS: [string, string][] = [
  ['checking', 'Checking'], ['savings', 'Savings'], ['credit_card', 'Credit Card'], ['investment', 'Investment'],
  ['loan', 'Loan'], ['cash', 'Cash'], ['asset', 'Asset'], ['other', 'Other'],
];
interface Connection {
  id: number;
  provider: string;
  status: string;
  last_error: string | null;
  account_errors: string[];
  last_synced_at: string | null;
  connected_at: string | null;
  include_pending: boolean;
  auto_import_enabled: boolean;
  auto_import_frequency: 'daily' | 'weekly';
  auto_import_start_at: string | null;
  accounts: LinkedAccount[];
}
interface Account { id: number; name: string; institution: string | null; currency: string | null }
// A single proposed field update to a mapped account (SimpleFIN value vs. local value).
interface Suggestion {
  linkId: number; ext: string; accountName: string;
  fieldKey: 'name' | 'institution' | 'currency'; fieldLabel: string; cur: string | null; prop: string;
}

// Editable settings are staged in a draft and committed with the top Save button
// (dirty when the draft differs from what's loaded), like the rest of the app's forms.
interface LinkSettings { include_pending: boolean; auto_import_enabled: boolean; auto_import_frequency: 'daily' | 'weekly'; auto_import_start_at: string | null }
interface AccountSettings { account_id: string; auto_import: boolean }
interface Draft { links: Record<number, LinkSettings>; accounts: Record<number, AccountSettings> }

const draftFrom = (rows: Connection[]): Draft => {
  const links: Record<number, LinkSettings> = {};
  const accounts: Record<number, AccountSettings> = {};
  for (const c of rows) {
    links[c.id] = { include_pending: c.include_pending, auto_import_enabled: c.auto_import_enabled, auto_import_frequency: c.auto_import_frequency, auto_import_start_at: c.auto_import_start_at };
    for (const a of c.accounts) accounts[a.id] = { account_id: a.account_id != null ? String(a.account_id) : '', auto_import: a.auto_import };
  }
  return { links, accounts };
};
// Keep already-edited values for keys that still exist after a structural reload
// (connect/refresh add accounts without touching existing settings).
const mergeDraft = (fresh: Draft, prev: Draft): Draft => ({
  links: Object.fromEntries(Object.entries(fresh.links).map(([k, v]) => [k, prev.links[+k] ?? v])),
  accounts: Object.fromEntries(Object.entries(fresh.accounts).map(([k, v]) => [k, prev.accounts[+k] ?? v])),
});

// SimpleFIN connection management: connect, map accounts, re-discover, and configure
// import settings (pending + scheduled auto-import). Settings stage as a dirty draft
// and commit with Save. Running imports lives on the Transactions page.
export default function LinkedAccounts() {
  const [tab, setTab] = useState<'overview' | 'token' | 'accounts' | 'imports'>('overview');
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [draft, setDraft] = useState<Draft>({ links: {}, accounts: {} });
  const [baseline, setBaseline] = useState<Draft>({ links: {}, accounts: {} });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [refreshProg, setRefreshProg] = useState<{ done: number; total: number; status: string } | null>(null);
  const [busyAcct, setBusyAcct] = useState<string | null>(null);
  const [createTarget, setCreateTarget] = useState<{ linkId: number; ext: string; name: string; type: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const navigate = useNavigate();

  const load = (preserveEdits = false) =>
    Promise.all([api.get<Connection[]>('/connections'), api.get<Account[]>('/accounts')])
      .then(([rows, accs]) => {
        setConns(rows); setAccounts(accs);
        const fresh = draftFrom(rows);
        setBaseline(fresh);
        setDraft((prev) => (preserveEdits ? mergeDraft(fresh, prev) : fresh));
      })
      .catch((e) => setErr(e.message));
  useEffect(() => { load(false); }, []);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const setLink = (id: number, patch: Partial<LinkSettings>) => { setSavedMsg(''); setDraft((d) => ({ ...d, links: { ...d.links, [id]: { ...d.links[id], ...patch } } })); };
  const setAcct = (id: number, patch: Partial<AccountSettings>) => { setSavedMsg(''); setDraft((d) => ({ ...d, accounts: { ...d.accounts, [id]: { ...d.accounts[id], ...patch } } })); };

  const save = async () => {
    if (!conns || !dirty) return;
    setSaving(true); setErr(''); setSavedMsg(''); setMsg('');
    const meta: Record<number, { linkId: number; ext: string }> = {};
    for (const c of conns) for (const a of c.accounts) meta[a.id] = { linkId: c.id, ext: a.external_account_id };
    try {
      for (const c of conns) {
        const d = draft.links[c.id], b = baseline.links[c.id];
        if (!d || !b) continue;
        const patch: Record<string, unknown> = {};
        if (d.include_pending !== b.include_pending) patch.include_pending = d.include_pending;
        if (d.auto_import_enabled !== b.auto_import_enabled) patch.auto_import_enabled = d.auto_import_enabled;
        if (d.auto_import_frequency !== b.auto_import_frequency) patch.auto_import_frequency = d.auto_import_frequency;
        if (d.auto_import_start_at !== b.auto_import_start_at) patch.auto_import_start_at = d.auto_import_start_at;
        if (Object.keys(patch).length) await api.post(`/connections/${c.id}/settings`, patch);
      }
      for (const [idStr, d] of Object.entries(draft.accounts)) {
        const id = +idStr; const b = baseline.accounts[id]; const m = meta[id];
        if (!b || !m) continue;
        if (d.account_id !== b.account_id) await api.post(`/connections/${m.linkId}/map`, { mappings: [{ external_account_id: m.ext, account_id: d.account_id ? Number(d.account_id) : null }] });
        if (d.auto_import !== b.auto_import) await api.post(`/connections/${m.linkId}/account-auto`, { external_account_id: m.ext, auto_import: d.auto_import });
      }
      load(false);
      setSavedMsg('Saved.');
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const connect = async () => {
    if (!token.trim()) { setErr('Paste your SimpleFIN setup token first.'); return; }
    setErr(''); setMsg(''); setBusy(true);
    try {
      const r = await api.post<{ accounts: unknown[] }>('/connections/simplefin/claim', { setupToken: token.trim() });
      setToken('');
      setMsg(`Connected — found ${r.accounts.length} account${r.accounts.length === 1 ? '' : 's'}. Map each to one of your accounts below.`);
      load(true);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const refresh = async (id: number) => {
    setErr(''); setMsg(''); setBusyId(id); setRefreshProg({ done: 0, total: 0, status: 'Starting…' });
    try {
      await apiStream(`/connections/${id}/refresh/stream`, {}, (ev: any) => {
        if (ev.type === 'start') setRefreshProg({ done: 0, total: 0, status: 'Contacting SimpleFIN…' });
        else if (ev.type === 'status') setRefreshProg((p) => ({ done: p?.done ?? 0, total: ev.total ?? p?.total ?? 0, status: ev.message }));
        else if (ev.type === 'progress') setRefreshProg({ done: ev.done, total: ev.total, status: ev.message ?? `Updated ${ev.done}/${ev.total}` });
        else if (ev.type === 'done') {
          setRefreshProg(null);
          setMsg(ev.added > 0
            ? `Found ${ev.added} new account${ev.added === 1 ? '' : 's'} — map ${ev.added === 1 ? 'it' : 'them'} below.`
            : `No new accounts (${ev.total} found, all already listed).`);
        } else if (ev.type === 'error') { setErr(ev.message); setRefreshProg(null); }
      });
      load(true);
    } catch (e: any) { setErr(e.message); setRefreshProg(null); }
    finally { setBusyId(null); }
  };

  // Per-external-account actions: create a local account pre-filled from SimpleFIN, or
  // push SimpleFIN's details onto the already-mapped account.
  const acctKey = (linkId: number, ext: string) => `${linkId}:${ext}`;
  const doCreate = async () => {
    if (!createTarget) return;
    const { linkId, ext } = createTarget;
    const key = acctKey(linkId, ext);
    // account_link row id (draft.accounts is keyed by it) so we can reflect the new mapping.
    const rowId = conns?.find((c) => c.id === linkId)?.accounts.find((a) => a.external_account_id === ext)?.id ?? null;
    setBusyAcct(key); setErr(''); setMsg('');
    try {
      const acct = await api.post<Account>(`/connections/${linkId}/create-account`,
        { external_account_id: ext, type: createTarget.type, name: createTarget.name });
      setMsg(`Created “${acct.name}” and linked it to this bank account.`);
      setCreateTarget(null);
      await load(true);
      // mergeDraft keeps the prior (unmapped) draft value, so explicitly select the new account.
      if (rowId != null) setAcct(rowId, { account_id: String(acct.id) });
    } catch (e: any) { setErr(e.message); } finally { setBusyAcct(null); }
  };
  const sugKey = (s: Suggestion) => `${s.linkId}:${s.ext}:${s.fieldKey}`;
  // Apply a single field's SimpleFIN value to the mapped account.
  const applySuggestion = async (s: Suggestion) => {
    const key = sugKey(s);
    setBusyAcct(key); setErr(''); setMsg('');
    try {
      await api.post(`/connections/${s.linkId}/apply-settings`, { external_account_id: s.ext, field: s.fieldKey });
      setMsg(`Updated ${s.fieldLabel.toLowerCase()} for “${s.accountName}”.`);
      load(true);
    } catch (e: any) { setErr(e.message); } finally { setBusyAcct(null); }
  };
  const ignoreSuggestion = async (s: Suggestion) => {
    setErr('');
    try {
      await api.post(`/connections/${s.linkId}/dismiss-suggestion`, { external_account_id: s.ext, field: s.fieldKey, value: s.prop });
      load(true);
    } catch (e: any) { setErr(e.message); }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this connection? Its stored access credential is removed; imported transactions are kept.')) return;
    setErr(''); setMsg('');
    try { await api.del(`/connections/${id}`); load(true); } catch (e: any) { setErr(e.message); }
  };

  // Proposed updates, one per differing field on a mapped account, excluding fields the
  // user dismissed (until SimpleFIN reports a different value for that field).
  const suggestions: Suggestion[] = [];
  for (const c of conns ?? []) {
    for (const a of c.accounts) {
      if (a.account_id == null) continue;
      const acc = accounts.find((x) => x.id === a.account_id);
      if (!acc) continue;
      const fields: Suggestion['fieldKey'][] = ['name', 'institution', 'currency'];
      const propOf = { name: a.sf_name, institution: a.org_name, currency: a.currency };
      const curOf = { name: acc.name, institution: acc.institution, currency: acc.currency };
      const labelOf = { name: 'Name', institution: 'Institution', currency: 'Currency' };
      for (const fk of fields) {
        const prop = propOf[fk];
        if (!prop || prop === (curOf[fk] ?? '')) continue;
        if ((a.dismissed_fields ?? {})[fk] === prop) continue; // dismissed at this value
        suggestions.push({ linkId: c.id, ext: a.external_account_id, accountName: acc.name, fieldKey: fk, fieldLabel: labelOf[fk], cur: curOf[fk], prop });
      }
    }
  }

  return (
    <div style={{ marginBottom: 24 }}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--credit)', padding: 10 }}>{msg}</div>}

      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>Overview</button>
        <button className={`tab ${tab === 'token' ? 'active' : ''}`} onClick={() => setTab('token')}>Token</button>
        <button className={`tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>Accounts</button>
        <button className={`tab ${tab === 'imports' ? 'active' : ''}`} onClick={() => setTab('imports')}>Imports</button>
      </div>

      {(tab === 'accounts' || tab === 'imports') && (
        <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', marginBottom: 8 }}>
          <div className="btn-row">
            <button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </div>
      )}

      {tab === 'overview' && (
        <>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
            SimpleFIN connects your banks so transactions import into your review queue. Add a connection in the <strong>Token</strong> tab,
            map each bank account to one of yours in <strong>Accounts</strong>, and set up scheduled pulls in <strong>Imports</strong>.
          </p>
          {conns == null ? <p className="muted">Loading…</p> : conns.length === 0 ? (
            <div className="card"><div className="empty">No connections yet. Add one in the Token tab.</div></div>
          ) : (
            <div style={{ display: 'grid', gap: 16 }}>
              {conns.map((c) => {
                // Group the connection's external accounts by their institution (org).
                const byInst = new Map<string, LinkedAccount[]>();
                for (const a of c.accounts) {
                  const k = a.org_name || 'Unknown';
                  const arr = byInst.get(k);
                  if (arr) arr.push(a); else byInst.set(k, [a]);
                }
                const institutions = [...byInst.entries()].sort((x, y) => x[0].localeCompare(y[0]));
                const missing = c.accounts.filter((a) => a.missing_since);
                const attention = [
                  c.last_error,
                  ...(c.account_errors ?? []),
                  ...(missing.length ? [`${missing.length} account${missing.length === 1 ? '' : 's'} stopped appearing (${[...new Set(missing.map((a) => a.org_name || 'Unknown'))].join(', ')}) — re-authenticate at bridge.simplefin.org.`] : []),
                ].filter(Boolean) as string[];
                return (
                  <div key={c.id} className="card">
                    <div className="row" style={{ gap: 10, alignItems: 'baseline', marginBottom: 8 }}>
                      <strong style={{ textTransform: 'capitalize' }}>{c.provider}</strong>
                      <span className="tag" style={{ fontSize: 11, color: c.status === 'active' ? 'var(--credit)' : 'var(--debit)' }}>{c.status}</span>
                      {c.last_synced_at && <span className="muted" style={{ fontSize: 12 }}>last synced {c.last_synced_at.replace('T', ' ')}</span>}
                      {c.auto_import_enabled && <span className="muted" style={{ fontSize: 12 }}>· auto-import on</span>}
                    </div>
                    {attention.length > 0 && (
                      <div className="card" style={{ background: 'var(--surface-alt)', borderLeft: '3px solid var(--debit)', padding: '8px 10px', marginBottom: 10 }}>
                        <div style={{ fontSize: 12, color: 'var(--debit)', marginBottom: 2 }}>Needs attention</div>
                        {attention.map((e, i) => <div key={i} style={{ fontSize: 13 }}>{e}</div>)}
                      </div>
                    )}
                    <table className="ledger">
                      <thead><tr><th>Institution</th><th className="r">Accounts</th><th className="r">Mapped</th><th className="r">Balance</th><th>Status</th></tr></thead>
                      <tbody>
                        {institutions.map(([inst, accts]) => {
                          const mapped = accts.filter((a) => a.account_id != null).length;
                          const bal = accts.reduce((s, a) => s + (a.last_balance ?? 0), 0);
                          const gone = accts.filter((a) => a.missing_since);
                          return (
                            <tr key={inst}>
                              <td>{inst}</td>
                              <td className="r num">{accts.length}</td>
                              <td className="r num">{mapped}/{accts.length}</td>
                              <td className="r num">{money(bal)}</td>
                              <td>{gone.length
                                ? <span style={{ color: 'var(--debit)' }} title={`Stopped appearing ${gone[0].missing_since}. Re-authenticate at bridge.simplefin.org.`}>⚠ Check bridge</span>
                                : <span style={{ color: 'var(--credit)' }}>OK</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
              <div className="muted" style={{ fontSize: 12 }}>
                Institutions, status and balances come from the SimpleFIN API. The <strong>Apps</strong> list and <strong>access log</strong> on bridge.simplefin.org aren't exposed by the API, so they can't be shown here.
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'token' && (
        <>
          {conns && conns.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3 className="section" style={{ marginTop: 0 }}>Active Token{conns.length === 1 ? '' : 's'}</h3>
              <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
                Each connection holds a read-only SimpleFIN access credential, stored encrypted. The one-time setup token can't be shown again — if a connection stops working, generate a fresh setup token at <a href="https://bridge.simplefin.org" target="_blank" rel="noopener noreferrer">bridge.simplefin.org</a> and connect it below.
              </p>
              <table className="ledger">
                <thead><tr><th>Provider</th><th>Status</th><th>Connected</th><th>Last Synced</th><th className="r">Accounts</th></tr></thead>
                <tbody>
                  {conns.map((c) => {
                    const mapped = c.accounts.filter((a) => a.account_id != null).length;
                    return (
                      <tr key={c.id}>
                        <td style={{ textTransform: 'capitalize' }}>{c.provider} <span className="muted" style={{ textTransform: 'none' }}>· bridge.simplefin.org</span></td>
                        <td><span style={{ color: c.status === 'active' ? 'var(--credit)' : 'var(--debit)' }}>{c.status === 'active' ? 'Active' : c.status === 'error' ? 'Error' : c.status === 'revoked' ? 'Revoked' : c.status}</span></td>
                        <td>{c.connected_at ? c.connected_at.replace('T', ' ') : '—'}</td>
                        <td>{c.last_synced_at ? c.last_synced_at.replace('T', ' ') : 'Never'}</td>
                        <td className="r num">{mapped}/{c.accounts.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {conns.some((c) => c.last_error) && (
                <div className="card" style={{ background: 'var(--surface-alt)', borderLeft: '3px solid var(--debit)', padding: '8px 10px', marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--debit)', marginBottom: 2 }}>Needs attention</div>
                  {conns.filter((c) => c.last_error).map((c) => <div key={c.id} style={{ fontSize: 13 }}>{c.last_error}</div>)}
                </div>
              )}
            </div>
          )}

          <h3 className="section" style={{ marginTop: 0 }}>{conns && conns.length > 0 ? 'Add a Connection' : 'Connect a Bank'}</h3>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
            Create a connection at <a href="https://bridge.simplefin.org" target="_blank" rel="noopener noreferrer">bridge.simplefin.org</a>, link your banks there, then generate a <strong>setup token</strong> and paste it below — it's one-time, exchanged for a read-only credential we store encrypted. After connecting, map the accounts in the <strong>Accounts</strong> tab.
          </p>
          <div className="card">
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your SimpleFIN setup token…"
              rows={3}
              style={{ width: '100%', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12, resize: 'vertical' }}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="brass" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect Institution'}</button>
            </div>
          </div>
        </>
      )}

      {tab === 'accounts' && (
        conns == null ? <p className="muted">Loading…</p> : conns.length === 0 ? (
          <div className="card"><div className="empty">No linked institutions yet. Add a connection in the Token tab.</div></div>
        ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {conns.map((c) => (
            <div key={c.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
                  <strong style={{ textTransform: 'capitalize' }}>{c.provider}</strong>
                  <span className="tag" style={{ fontSize: 11, color: c.status === 'active' ? 'var(--credit)' : 'var(--debit)' }}>{c.status}</span>
                  {c.last_synced_at && <span className="muted" style={{ fontSize: 12 }}>last synced {c.last_synced_at.replace('T', ' ')}</span>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="danger" onClick={() => remove(c.id)} style={{ whiteSpace: 'nowrap' }}>Delete</button>
                  <button className="ghost" disabled={busyId === c.id} onClick={() => refresh(c.id)} title="Re-check this connection for newly added bank accounts" style={{ whiteSpace: 'nowrap' }}>{busyId === c.id ? 'Refreshing…' : 'Refresh Accounts'}</button>
                </div>
              </div>
              {c.last_error && <div className="muted" style={{ fontSize: 12, color: 'var(--debit)', marginBottom: 8 }}>{c.last_error}</div>}
              {busyId === c.id && refreshProg && (
                <div style={{ marginBottom: 10 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                    {refreshProg.status}{refreshProg.total > 0 ? ` (${refreshProg.done}/${refreshProg.total})` : ''}
                  </div>
                  <div style={{ height: 6, background: 'var(--hairline)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${refreshProg.total > 0 ? Math.round((refreshProg.done / refreshProg.total) * 100) : 12}%`, background: 'var(--brass-deep, var(--brass))', transition: 'width .3s' }} />
                  </div>
                </div>
              )}
              <table className="ledger">
                <thead>
                  <tr><th>Bank Account</th><th>Balance</th><th></th><th>Maps to</th></tr>
                </thead>
                <tbody>
                  {c.accounts.map((a) => {
                    const key = acctKey(c.id, a.external_account_id);
                    return (
                      <tr key={a.id}>
                        <td>
                          <div>
                            {a.sf_name || a.external_account_id}
                            {a.missing_since && <span className="tag" style={{ marginLeft: 6, fontSize: 10, borderColor: 'var(--debit)', color: 'var(--debit)' }} title={`Stopped appearing ${a.missing_since}. Re-authenticate at bridge.simplefin.org.`}>⚠ check bridge</span>}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>{a.org_name ? `${a.org_name} · ` : ''}{a.external_account_id}</div>
                        </td>
                        <td className="num">{a.last_balance != null ? money(Number(a.last_balance)) : '—'}</td>
                        <td>
                          {a.account_id == null && (
                            <button className="ghost" style={{ padding: '2px 10px', fontSize: 12 }} disabled={busyAcct === key}
                              title="Create a new account pre-filled from this SimpleFIN account"
                              onClick={() => setCreateTarget({ linkId: c.id, ext: a.external_account_id, name: a.sf_name || a.org_name || a.external_account_id, type: 'checking' })}>Create</button>
                          )}
                        </td>
                        <td>
                          <select value={draft.accounts[a.id]?.account_id ?? ''} onChange={(e) => setAcct(a.id, { account_id: e.target.value })}>
                            <option value="">— not mapped —</option>
                            {accounts.map((acc) => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

          {suggestions.length > 0 && (
            <div className="card" style={{ borderLeft: '3px solid var(--brass-deep)' }}>
              <div className="label" style={{ marginBottom: 4 }}>Suggested Updates from SimpleFIN</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>SimpleFIN reports different details for these mapped accounts. Apply to update the account (and record its current balance), or ignore to keep your values.</p>
              {suggestions.map((s) => {
                const key = sugKey(s);
                return (
                  <div key={key} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--hairline)' }}>
                    <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 500 }}>{s.accountName}</span>
                      <span className="muted" style={{ fontSize: 12 }}>{s.fieldLabel}: {s.cur || '—'} → <strong style={{ color: 'var(--credit)' }}>{s.prop}</strong></span>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => ignoreSuggestion(s)}>Ignore</button>
                      <button style={{ padding: '2px 10px', fontSize: 12 }} disabled={busyAcct === key} onClick={() => applySuggestion(s)}>{busyAcct === key ? 'Applying…' : 'Apply'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="muted" style={{ fontSize: 13 }}>
            To import transactions for these accounts, use <strong>Import SimpleFIN</strong> on the{' '}
            <a style={{ cursor: 'pointer' }} onClick={() => navigate('/transactions')}>Transactions page →</a>
          </div>
        </div>
        ))}

      {tab === 'imports' && (
        conns == null ? <p className="muted">Loading…</p> : conns.length === 0 ? (
          <div className="card"><div className="empty">Connect a bank in the Token tab first, then map its accounts.</div></div>
        ) : (
        <>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>Choose whether each connection imports on a schedule. Changes save with the button above. Transactions are imported once they post; pending ones wait until then.</p>
          <div className="card" style={{ display: 'grid', gap: 18 }}>
            {conns.map((c) => {
              const ls = draft.links[c.id];
              if (!ls) return null;
              const mapped = c.accounts.filter((a) => (draft.accounts[a.id]?.account_id ?? '') !== '');
              return (
                <div key={c.id}>
                  {conns.length > 1 && <div className="muted" style={{ fontSize: 12, marginBottom: 8, textTransform: 'capitalize' }}>{c.provider}</div>}

                  <Toggle checked={ls.auto_import_enabled} onChange={(v) => setLink(c.id, { auto_import_enabled: v })}>
                    Automatically import on a schedule
                  </Toggle>
                  {ls.auto_import_enabled ? (
                    <div style={{ margin: '10px 0 0 50px', display: 'grid', gap: 12 }}>
                      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="muted" style={{ fontSize: 13, width: 72 }}>Starts</span>
                        <input type="datetime-local" value={ls.auto_import_start_at ?? ''} onChange={(e) => setLink(c.id, { auto_import_start_at: e.target.value || null })} />
                        {!ls.auto_import_start_at && <span className="muted" style={{ fontSize: 12 }}>blank = start now</span>}
                      </div>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="muted" style={{ fontSize: 13, width: 72 }}>Frequency</span>
                        <select value={ls.auto_import_frequency} onChange={(e) => setLink(c.id, { auto_import_frequency: e.target.value as 'daily' | 'weekly' })} style={{ width: 'auto' }}>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                        </select>
                      </div>
                      <div>
                        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>Accounts to auto-import</div>
                        {mapped.length === 0
                          ? <div className="muted" style={{ fontSize: 12 }}>Map accounts above first.</div>
                          : mapped.map((a) => (
                            <Toggle key={a.id} checked={draft.accounts[a.id]?.auto_import ?? true} onChange={(v) => setAcct(a.id, { auto_import: v })}>
                              {a.account_name ?? a.external_account_id}
                            </Toggle>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 12, margin: '2px 0 0 50px' }}>Off — import manually from the Transactions page.</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Scheduled imports run automatically in the background and land in your review queue — nothing posts until you confirm it.</div>
        </>
        )
      )}


      {createTarget && (
        <Modal title="Create Account from SimpleFIN" persistent onClose={() => setCreateTarget(null)}>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            The name, institution, currency and current balance come from SimpleFIN. It doesn't report an account <strong>type</strong>, so pick one.
          </p>
          <Field label="Name"><input value={createTarget.name} onChange={(e) => setCreateTarget({ ...createTarget, name: e.target.value })} /></Field>
          <Field label="Type">
            <select value={createTarget.type} onChange={(e) => setCreateTarget({ ...createTarget, type: e.target.value })}>
              {ACCOUNT_TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <div className="btn-row" style={{ marginTop: 12, alignItems: 'center' }}>
            <button className="ghost" onClick={() => setCreateTarget(null)}>Cancel</button>
            <div style={{ flex: 1 }} />
            <button onClick={doCreate} disabled={busyAcct === acctKey(createTarget.linkId, createTarget.ext) || !createTarget.name.trim()}>Create &amp; Link</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

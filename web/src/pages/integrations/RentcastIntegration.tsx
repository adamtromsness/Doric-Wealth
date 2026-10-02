import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Field } from '../../components/ui';

export interface RentcastStatus { configured: boolean; book_key_set: boolean; key_hint: string | null; server_fallback: boolean; can_manage: boolean }

// Integration: the active book's RentCast API key, used for property value estimates
// and automatic value updates.
export default function RentcastIntegration() {
  const [s, setS] = useState<RentcastStatus | null>(null);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get<RentcastStatus>('/integrations/rentcast').then(setS).catch((e) => setErr(e.message));
  }, []);

  const save = async (apiKey: string) => {
    setErr(''); setMsg('');
    try {
      const next = await api.put<RentcastStatus>('/integrations/rentcast', { api_key: apiKey });
      setS(next); setKey('');
      setMsg(next.book_key_set ? 'API key saved. Property value estimates now use RentCast.' : 'API key removed.');
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Integrations</div>
          <h1 className="title">RentCast</h1>
          <p className="subtitle">Connect a RentCast API key to estimate your properties' market value from comparable sales, and to update them automatically each week or month.</p>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <ol className="muted" style={{ fontSize: 13, margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Create an account at <a href="https://app.rentcast.io/app/api" target="_blank" rel="noreferrer">rentcast.io</a>.</li>
          <li>On the API dashboard, choose a plan. The free developer plan works; a key does nothing until a plan is selected.</li>
          <li>Create an API key and paste it below.</li>
        </ol>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
          The key belongs to this set of books, so everyone sharing it uses it. It's stored encrypted and never shown again.
          Each estimate or automatic update uses one request from your RentCast plan.
        </p>
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Status:{' '}
          {s == null
            ? '…'
            : s.configured
              ? <span style={{ color: 'var(--credit)' }}>Connected{s.book_key_set ? ` · using this book's key ${s.key_hint}` : ' · using the server key'}</span>
              : <span style={{ color: 'var(--debit)' }}>Not connected</span>}
        </div>
        {s?.can_manage ? (
          <Field label="RentCast API Key">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={s.book_key_set ? `Saved (${s.key_hint}). Enter a new key to replace it` : 'Paste your RentCast API key'}
                style={{ flex: 1, minWidth: 240 }} />
              <button className="ghost" disabled={!key.trim()} onClick={() => save(key)}>Save Key</button>
              {s.book_key_set && <button className="ghost" onClick={() => save('')}>Delete</button>}
            </div>
          </Field>
        ) : s && (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Only an owner or admin of these books can change the key.</p>
        )}
        {msg && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{msg}</div>}
      </div>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Field } from '../components/ui';
import { AuthShell } from '../components/AuthShell';

// Choose a new password from a reset link (/reset-password?token=…).
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [account, setAccount] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setLinkErr('This reset link is missing its code. Use the full link you were sent.'); return; }
    api.get<{ email: string }>(`/auth/password-reset/${encodeURIComponent(token)}`)
      .then((r) => setAccount(r.email))
      .catch((e) => setLinkErr(e.message));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (pw !== pw2) { setErr("The passwords don't match."); return; }
    setBusy(true);
    try { await api.post('/auth/password-reset/complete', { token, password: pw }); setDone(true); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <AuthShell title="Choose a new password" subtitle={account ? `For ${account}.` : undefined}>
      {linkErr && (
        <>
          <div className="error" style={{ marginBottom: 12 }}>{linkErr}</div>
          <p className="muted" style={{ fontSize: 13 }}><Link to="/forgot-password">Ask for a new link</Link></p>
        </>
      )}
      {done && (
        <p style={{ marginTop: 0 }}>Your password has been changed, and you've been signed out on every device. <Link to="/login">Sign in</Link> with your new password.</p>
      )}
      {account && !done && (
        <>
          {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
          <form onSubmit={submit}>
            <Field label="New Password"><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="at least 8 characters" /></Field>
            <Field label="Confirm New Password"><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Set New Password'}</button>
            </div>
          </form>
        </>
      )}
    </AuthShell>
  );
}

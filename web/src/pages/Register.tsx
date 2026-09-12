import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { Field } from '../components/ui';
import { AuthShell } from '../components/AuthShell';

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const code = params.get('code');
  const [f, setF] = useState({ name: '', email: '', password: '', book_name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (f.password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      await register({
        email: f.email,
        password: f.password,
        name: f.name || undefined,
        book_name: f.book_name || undefined,
      });
      nav(code ? `/accept?code=${encodeURIComponent(code)}` : '/');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <AuthShell title="Create your account" subtitle={code ? 'Create an account, then open the books you were invited to.' : 'Start tracking your finances.'}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <form onSubmit={submit}>
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="optional" /></Field>
        <Field label="Email"><input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="at least 8 characters" /></Field>
        {!code && (
          <Field label="Books Name"><input value={f.book_name} onChange={(e) => setF({ ...f, book_name: e.target.value })} placeholder="e.g. The Smiths (optional)" /></Field>
        )}
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        </div>
      </form>
      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
        Already have an account? <Link to={code ? `/login?code=${encodeURIComponent(code)}` : '/login'}>Sign in</Link>
      </p>
    </AuthShell>
  );
}

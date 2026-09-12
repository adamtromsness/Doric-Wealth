import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { Field } from '../components/ui';
import { AuthShell } from '../components/AuthShell';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const code = params.get('code');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await login(email, password);
      nav(code ? `/accept?code=${encodeURIComponent(code)}` : '/');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <AuthShell title="Sign in" subtitle="Welcome back to Doric.">
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <form onSubmit={submit}>
        <Field label="Email"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
        No account? <Link to={code ? `/register?code=${encodeURIComponent(code)}` : '/register'}>Create one</Link>
      </p>
    </AuthShell>
  );
}

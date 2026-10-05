import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Field } from '../components/ui';
import { AuthShell } from '../components/AuthShell';

export interface SignupConfig { invite_only: boolean; first_account: boolean }

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const urlCode = params.get('code') || '';
  const [cfg, setCfg] = useState<SignupConfig | null>(null);
  // Set when the link's code is a book invite: the new account joins that book
  // instead of getting its own, so the Books Name field doesn't apply.
  const [joiningBook, setJoiningBook] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '', book_name: '', code: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<SignupConfig>('/auth/signup-config').then(setCfg).catch(() => {});
  }, []);
  useEffect(() => {
    if (!urlCode) return;
    // A book invite previews its book; a signup invite (own books) doesn't, which is fine.
    api.get<{ book_name: string }>(`/invites/${encodeURIComponent(urlCode)}`)
      .then((p) => setJoiningBook(p.book_name))
      .catch(() => {});
  }, [urlCode]);

  // Invite-only and no code in the link: ask for one (not needed for the very first account).
  const askForCode = !urlCode && !!cfg?.invite_only && !cfg.first_account;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (f.password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    const code = urlCode || f.code.trim();
    if (askForCode && !code) { setErr('Enter the invite code from your invitation.'); return; }
    setBusy(true);
    try {
      await register({
        email: f.email,
        password: f.password,
        name: f.name || undefined,
        book_name: joiningBook ? undefined : (f.book_name || undefined),
        invite_code: code || undefined,
      });
      nav('/');
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const subtitle = joiningBook
    ? `You're joining ${joiningBook}. Create an account to get started.`
    : askForCode ? 'Sign-up is by invitation. Enter the code from your invite.'
    : 'Start tracking your finances.';

  return (
    <AuthShell title="Create your account" subtitle={subtitle}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <form onSubmit={submit}>
        {askForCode && (
          <Field label="Invite Code"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} autoComplete="off" placeholder="from your invite link" /></Field>
        )}
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="optional" /></Field>
        <Field label="Email"><input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="at least 8 characters" /></Field>
        {!joiningBook && (
          <Field label="Books Name"><input value={f.book_name} onChange={(e) => setF({ ...f, book_name: e.target.value })} placeholder="e.g. The Smiths (optional)" /></Field>
        )}
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create Account'}</button>
        </div>
      </form>
      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        By creating an account, you agree to how Doric handles your data: see <Link to="/privacy">Privacy</Link>.
      </p>
      <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
        Already have an account? <Link to={urlCode ? `/login?code=${encodeURIComponent(urlCode)}` : '/login'}>Sign in</Link>
      </p>
    </AuthShell>
  );
}

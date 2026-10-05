import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Field } from '../components/ui';
import { AuthShell } from '../components/AuthShell';

// Ask for a password reset link. The reply is the same whether or not the account
// exists; without email set up on the server, the user is told who to ask.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ email_enabled: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { setResult(await api.post<{ ok: boolean; email_enabled: boolean }>('/auth/password-reset/request', { email })); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell title="Reset your password" subtitle="Enter the email you sign in with.">
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {result ? (
        <p style={{ marginTop: 0 }}>
          {result.email_enabled
            ? `If ${email} has a Doric account, we've sent it a link to reset the password. It works for 60 minutes. Check your spam folder if it doesn't arrive.`
            : "Doric can't send email yet. Ask the person who runs Doric (or who invited you) for a password reset link."}
        </p>
      ) : (
        <form onSubmit={submit}>
          <Field label="Email"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send Reset Link'}</button>
          </div>
        </form>
      )}
      <p className="muted" style={{ fontSize: 13, marginTop: 16 }}><Link to="/login">Back to sign in</Link></p>
    </AuthShell>
  );
}

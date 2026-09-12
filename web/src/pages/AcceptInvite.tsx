import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { AuthShell } from '../components/AuthShell';

export default function AcceptInvite() {
  const { user, acceptInvite } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const code = params.get('code') || '';
  const [preview, setPreview] = useState<{ book_name: string; role: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) { setErr('No invite code provided.'); return; }
    api.get<{ book_name: string; role: string }>(`/invites/${encodeURIComponent(code)}`)
      .then(setPreview)
      .catch((e) => setErr(e.message));
  }, [code]);

  const join = async () => {
    setErr(''); setBusy(true);
    try { await acceptInvite(code); nav('/'); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const inner = (
    <>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {preview && (
        <p style={{ marginTop: 0 }}>
          You've been invited to join <strong>{preview.book_name}</strong> as <strong>{preview.role}</strong>.
        </p>
      )}
      {preview && (user ? (
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button onClick={join} disabled={busy}>{busy ? 'Joining…' : `Join ${preview.book_name}`}</button>
          <Link className="nav-link" style={{ color: 'inherit' }} to="/">Not now</Link>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          <Link to={`/login?code=${encodeURIComponent(code)}`}>Sign in</Link> or{' '}
          <Link to={`/register?code=${encodeURIComponent(code)}`}>create an account</Link> to join.
        </p>
      ))}
    </>
  );

  // Logged-in users see this inside the app shell; logged-out users get the auth card.
  if (user) {
    return (
      <>
        <div className="page-head"><div><div className="eyebrow">Invite</div><h1 className="title">Join Shared Books</h1></div></div>
        <div className="card" style={{ padding: '20px 22px', maxWidth: 460 }}>{inner}</div>
      </>
    );
  }
  return <AuthShell title="You're invited">{inner}</AuthShell>;
}

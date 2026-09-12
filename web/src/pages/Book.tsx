import { useEffect, useState, type ReactNode } from 'react';
import { api, shortDate } from '../api';
import { useAuth } from '../auth';
import { SectionHeader } from '../components/ui';

interface Member { id: number; email: string; name: string | null; role: string; created_at: string; last_login_at: string | null }
interface Invite { id: number; code: string; role: string; url: string; expires_at: string | null; max_uses: number | null; uses: number }

// Label styled like a form field's label, for the inline input+button rows below.
function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="muted" style={{ fontSize: 12, marginBottom: 6, fontWeight: 500 }}>{children}</div>;
}

export default function Book() {
  const { activeBook, refresh } = useAuth();
  const id = activeBook?.id;
  const canManage = activeBook?.role === 'owner' || activeBook?.role === 'admin';
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState<number | null>(null);
  const [bookName, setBookName] = useState(activeBook?.name ?? '');
  const [newName, setNewName] = useState('');

  // Keep the rename field in sync when the active books change.
  useEffect(() => { setBookName(activeBook?.name ?? ''); }, [activeBook?.name]);

  const load = () => {
    if (!id) return;
    api.get<Member[]>(`/books/${id}/members`).then(setMembers).catch((e) => setErr(e.message));
    if (canManage) api.get<Invite[]>(`/books/${id}/invites`).then(setInvites).catch(() => {});
    else setInvites([]);
  };
  useEffect(load, [id, canManage]);

  const absolute = (url: string) => (url.startsWith('http') ? url : `${location.origin}${url}`);

  const renameBooks = async () => {
    if (!id || !bookName.trim()) return;
    setErr('');
    try { await api.put(`/books/${id}`, { name: bookName.trim() }); await refresh(); }
    catch (e: any) { setErr(e.message); }
  };
  const createInvite = async () => {
    setErr('');
    try { await api.post(`/books/${id}/invites`, {}); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const revoke = async (inviteId: number) => {
    try { await api.del(`/books/${id}/invites/${inviteId}`); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const copy = async (inv: Invite) => {
    try { await navigator.clipboard.writeText(absolute(inv.url)); setCopied(inv.id); setTimeout(() => setCopied(null), 1500); }
    catch { /* clipboard unavailable */ }
  };
  const createBook = async () => {
    if (!newName.trim()) return;
    try { await api.post('/books', { name: newName.trim() }); setNewName(''); await refresh(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1 className="title">{activeBook?.name ?? 'Books'}</h1>
          <p className="subtitle">Manage who can see and edit these books' finances. You're {activeBook?.role}.</p>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      {canManage && (
        <div style={{ marginBottom: 28 }}>
          <SectionHeader kind="income" title="Books name" />
          <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
            Rename this set of books. Everyone with access sees the new name.
          </p>
          <FieldLabel>Name</FieldLabel>
          <div className="row" style={{ gap: 8 }}>
            <input value={bookName} onChange={(e) => setBookName(e.target.value)} placeholder="e.g. Home Books" style={{ flex: 1, maxWidth: 360 }} />
            <button className="ghost" disabled={!bookName.trim() || bookName.trim() === activeBook?.name} onClick={renameBooks}>Save</button>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 28 }}>
        <SectionHeader kind="income" title="Members" />
        <div className="card" style={{ padding: 0 }}>
          <table className="ledger">
            <thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Joined</th><th>Last Login</th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.name || '—'}</td>
                  <td className="muted">{m.email}</td>
                  <td>{m.role}</td>
                  <td className="num">{shortDate(m.created_at)}</td>
                  <td className="num muted">{m.last_login_at ? shortDate(m.last_login_at) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {canManage && (
        <div style={{ marginBottom: 28 }}>
          <SectionHeader kind="expense" title="Invite user" action={<button onClick={createInvite}>New Invite Link</button>} />
          <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
            Share a link to invite someone to these books. Anyone who opens it can create an account (or sign in) and get access.
          </p>
          {invites.length === 0 ? (
            <div className="card"><div className="empty">No active invites. Create a link to share.</div></div>
          ) : (
            <div className="card" style={{ padding: 0 }}>
              <table className="ledger">
                <thead><tr><th>Invite Link</th><th>Role</th><th>Uses</th><th></th></tr></thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id}>
                      <td><code style={{ fontSize: 12 }}>{absolute(inv.url)}</code></td>
                      <td>{inv.role}</td>
                      <td className="num">{inv.uses}{inv.max_uses != null ? ` / ${inv.max_uses}` : ''}</td>
                      <td className="r" style={{ whiteSpace: 'nowrap' }}>
                        <button className="ghost" style={{ padding: '2px 8px' }} onClick={() => copy(inv)}>{copied === inv.id ? 'Copied!' : 'Copy'}</button>
                        <button className="ghost" style={{ padding: '2px 8px', marginLeft: 6 }} onClick={() => revoke(inv.id)}>Revoke</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div>
        <SectionHeader kind="income" title="Start another set of books" />
        <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
          Create a separate set of books with its own accounts and transactions. Switch between books from the menu in the top-right.
        </p>
        <FieldLabel>New Books Name</FieldLabel>
        <div className="row" style={{ gap: 8 }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Mom & Dad's books" style={{ flex: 1, maxWidth: 360 }} />
          <button className="ghost" disabled={!newName.trim()} onClick={createBook}>Create</button>
        </div>
      </div>
    </>
  );
}

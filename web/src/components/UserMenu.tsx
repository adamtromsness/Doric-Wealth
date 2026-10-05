import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

// Up-to-two-letter monogram from a name (or email as a fallback).
function initials(name: string | null, email: string): string {
  const base = (name || email || '').trim();
  if (!base) return '?';
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

// Top-right account/settings menu: who you're signed in as, book switching,
// links to the account and book pages, and sign out.
export function UserMenu() {
  const { user, books, activeBook, switchBook, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Close on outside click or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!user) return null;
  const go = (to: string) => { setOpen(false); navigate(to); };
  const mono = initials(user.name, user.email);

  return (
    <div className="usermenu" ref={ref}>
      <button className="usermenu-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Account & settings">
        <span className="usermenu-avatar">{mono}</span>
        <span className="usermenu-name">{user.name || user.email}</span>
        <span className="usermenu-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="usermenu-pop" role="menu">
          <div className="usermenu-head">
            <span className="usermenu-avatar lg">{mono}</span>
            <div style={{ minWidth: 0 }}>
              <div className="usermenu-headname">{user.name || 'Account'}</div>
              <div className="usermenu-headmail" title={user.email}>{user.email}</div>
            </div>
          </div>

          {books.length > 1 && (
            <>
              <div className="usermenu-section">Switch books</div>
              {books.map((h) => (
                <button key={h.id} className={`usermenu-item ${activeBook?.id === h.id ? 'is-active' : ''}`} role="menuitem"
                  onClick={async () => {
                    setOpen(false);
                    if (activeBook?.id === h.id) return;
                    // Reload onto the dashboard so every page's data refetches under
                    // the newly-active book (and we never linger on a detail
                    // page that belongs to the previous one).
                    await switchBook(h.id);
                    window.location.assign('/');
                  }}>
                  <span className="usermenu-check" aria-hidden>{activeBook?.id === h.id ? '✓' : ''}</span>
                  <span className="usermenu-itemlabel">{h.name}</span>
                  <span className="usermenu-role">{h.role}</span>
                </button>
              ))}
              <div className="usermenu-divider" />
            </>
          )}

          <button className="usermenu-item" role="menuitem" onClick={() => go('/account')}>My Profile</button>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/book')}>My Books</button>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/my-data')}>My Data</button>
          <div className="usermenu-divider" />
          <div className="usermenu-section">Integrations</div>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/integrations/simplefin')}>SimpleFIN</button>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/integrations/ai')}>AI</button>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/integrations/rentcast')}>RentCast</button>
          <div className="usermenu-divider" />
          <button className="usermenu-item" role="menuitem" onClick={() => go('/privacy')}>Privacy</button>
          <div className="usermenu-divider" />
          <button className="usermenu-item danger" role="menuitem" onClick={() => { setOpen(false); logout(); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

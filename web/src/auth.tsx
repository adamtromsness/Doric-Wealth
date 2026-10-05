import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, setExpectedBook, setBookChangedHandler, setBookSwitching, reloadAt } from './api';

export interface User {
  id: number;
  email: string;
  name: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  dob?: string | null;
  timezone?: string | null;
}

// Capture the browser's IANA timezone once, so server-side date logic that can't take
// a client "today" (SimpleFIN sync, scheduled jobs, period defaults) resolves in the
// user's zone. Persisted only if the user has none set yet; attempted once per session.
let tzSynced = false;
function captureTimezone(m: Me) {
  if (tzSynced || !m.user || m.user.timezone) return;
  tzSynced = true;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz) api.put('/auth/profile', { timezone: tz }).catch(() => {});
}

// The name to greet/address the user by: preferred name, else first name, else
// the legacy display name, else the email's local part.
export function displayName(u: Partial<User> | null | undefined): string {
  if (!u) return '';
  return (u.preferred_name || u.first_name || u.name || (u.email ? u.email.split('@')[0] : '') || '').trim();
}
export interface Book { id: number; name: string; role: string }
export interface Me { user: User; books: Book[]; activeBook: Book | null }

interface AuthValue {
  ready: boolean;
  user: User | null;
  books: Book[];
  activeBook: Book | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; name?: string; book_name?: string; invite_code?: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchBook: (id: number) => Promise<void>;
  acceptInvite: (code: string) => Promise<void>;
  refresh: () => Promise<void>;
  // Set when another tab switched books and this one followed; shown until dismissed.
  bookNotice: string | null;
  dismissBookNotice: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);
const NOTICE_KEY = 'doric.bookNotice';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  // A note carried over the reload that follows another tab's book switch (below).
  const [bookNotice, setBookNotice] = useState<string | null>(() => {
    try { const n = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); return n; } catch { return null; }
  });
  const shownBook = useRef<number | null>(null);

  const apply = (m: Me, notice: string | null = null) => {
    const next = m.activeBook?.id ?? null;
    // Changing books, from here or another tab: reload onto the new book's dashboard.
    // Rebuilding the interface isn't enough, since an action already under way for the
    // old book (e.g. waiting on a download before deleting) would carry on afterwards
    // and send its request as the new book. A reload ends all of them, and requests
    // are held until it happens (see api.ts).
    if (shownBook.current != null && next !== shownBook.current) {
      setBookSwitching(true);
      setExpectedBook(next);
      if (notice) { try { sessionStorage.setItem(NOTICE_KEY, notice); } catch { /* the note is optional */ } }
      reloadAt('/');
      return;
    }
    shownBook.current = next;
    setExpectedBook(next); setMe(m); captureTimezone(m);
  };
  const signedOut = () => { shownBook.current = null; setExpectedBook(null); setMe(null); setBookNotice(null); };

  useEffect(() => {
    // A 401 from any request drops us to the logged-out state.
    setUnauthorizedHandler(signedOut);
    // Another tab switched books: follow it, clearing anything unsaved here, and say so.
    setBookChangedHandler(() => {
      api.get<Me>('/auth/me')
        .then((m) => apply(m, `Another tab switched to ${m.activeBook?.name ?? 'another book'}, so this tab did too. Anything you hadn't saved here was cleared.`))
        .catch(() => {});
    });
    api.get<Me>('/auth/me').then(apply).catch(() => setMe(null)).finally(() => setReady(true));
    return () => { setUnauthorizedHandler(null); setBookChangedHandler(null); };
  }, []);

  const value: AuthValue = {
    ready,
    user: me?.user ?? null,
    books: me?.books ?? [],
    activeBook: me?.activeBook ?? null,
    login: async (email, password) => apply(await api.post<Me>('/auth/login', { email, password })),
    register: async (input) => apply(await api.post<Me>('/auth/register', input)),
    logout: async () => { await api.post('/auth/logout'); signedOut(); },
    switchBook: async (id) => apply(await api.post<Me>('/books/switch', { book_id: id })),
    acceptInvite: async (code) => apply(await api.post<Me>(`/invites/${encodeURIComponent(code)}/accept`)),
    refresh: async () => apply(await api.get<Me>('/auth/me')),
    bookNotice,
    dismissBookNotice: () => setBookNotice(null),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

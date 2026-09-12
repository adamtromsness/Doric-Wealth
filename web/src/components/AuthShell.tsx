import type { ReactNode } from 'react';
import { DoricBadge } from './DoricMark';

// Centered card used by the logged-out screens (login / register / accept invite).
export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px' }}>
      <div className="card" style={{ width: '100%', maxWidth: 420, padding: '26px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <DoricBadge size={34} />
          <span style={{ fontFamily: 'var(--display)', fontSize: 24, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase' }}>Doric</span>
        </div>
        <h2 className="section" style={{ margin: '4px 0 2px' }}>{title}</h2>
        {subtitle && <p className="subtitle" style={{ marginBottom: 18 }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

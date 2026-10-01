import { useMemo } from 'react';
import { shortDate } from '../api';
import { parseChangelog, parseInline, type Release } from '../changelog';

const ISSUES_URL = 'https://github.com/adamtromsness/Doric-Wealth/issues/';

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((p, i) => {
        if (p.kind === 'bold') return <strong key={i}>{p.text}</strong>;
        if (p.kind === 'code') return <code key={i}>{p.text}</code>;
        if (p.kind === 'issue') return <a key={i} href={`${ISSUES_URL}${p.number}`} target="_blank" rel="noreferrer">#{p.number}</a>;
        return <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

// What's New: the running version and the release notes from CHANGELOG.md.
// Reached by clicking the version in the top bar.
export default function Changelog({ markdown = __APP_CHANGELOG__, version = __APP_VERSION__ }: { markdown?: string; version?: string }) {
  const releases = useMemo<Release[]>(() => parseChangelog(markdown), [markdown]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Doric</div>
          <h1 className="title">What's New</h1>
          <p className="subtitle">You're on version <strong>v{version}</strong>. Here's what changed in each release.</p>
        </div>
      </div>

      {releases.length === 0 ? (
        <div className="card"><div className="empty">No release notes yet.</div></div>
      ) : (
        <div className="changelog" style={{ display: 'grid', gap: 16 }}>
          {releases.map((r) => {
            const isCurrent = r.version === version;
            const label = r.version === 'Unreleased' ? 'Unreleased' : `v${r.version}`;
            return (
              <div key={r.version} className="card" aria-label={`Release ${label}`}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 600 }}>
                    {label}
                    {isCurrent && <span className="tag">Current</span>}
                  </div>
                  {r.date && <div className="muted" style={{ fontSize: 12 }}>{shortDate(r.date)}</div>}
                </div>
                {r.sections.map((s) => (
                  <div key={s.title} style={{ marginTop: 10 }}>
                    <div className="label" style={{ marginBottom: 4 }}>{s.title}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                      {s.items.map((it, i) => <li key={i}><Inline text={it} /></li>)}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

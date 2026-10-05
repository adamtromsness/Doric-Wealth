import { useEffect, useRef, useState } from 'react';
import { api, apiDownload, apiBlob, shortDate } from '../api';
import { CHART_COLORS, Toggle } from '../components/ui';
import { useAuth } from '../auth';

interface Group { key: string; label: string; rows: number; bytes: number }
interface Sched { enabled: boolean; frequency: 'daily' | 'weekly'; start_at: string | null; groups: string[] | null; last_backup_at: string | null }
interface Snap { id: number; created_at: string; taken_at: string; name: string | null; label: string; scope: 'full' | 'partial'; pinned: boolean; bytes: number }
// Date + time in the viewer's locale (snapshots carry a precise capture moment).
const dateTime = (d: string | null | undefined): string =>
  d ? new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

// --- Local-folder auto-save (File System Access API; Chromium only) -----------
const fsSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

// A tiny IndexedDB key/value store, just to persist the chosen directory handle
// across reloads (handles are structured-cloneable; localStorage can't hold them).
const idb = (): Promise<IDBDatabase> => new Promise((res, rej) => {
  const r = indexedDB.open('ledger-fs', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbSet = async (k: string, v: any): Promise<void> => {
  const db = await idb();
  await new Promise<void>((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
};
const idbGet = async (k: string): Promise<any> => {
  const db = await idb();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const rq = tx.objectStore('kv').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
};

const ensureRWPermission = async (handle: any): Promise<boolean> => {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
};

// Stable, id-suffixed filename so re-running a sync never duplicates a snapshot.
const snapFileName = (s: Snap): string => {
  const slug = (s.name || s.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'snapshot';
  return `ledger-${slug}-${(s.taken_at || '').slice(0, 10)}--id${s.id}.json`;
};

// Write any snapshots not already in the folder; returns how many were written.
const syncSnapshotsToDir = async (handle: any, snaps: Snap[]): Promise<number> => {
  const existing: string[] = [];
  for await (const name of handle.keys()) existing.push(name);
  let written = 0;
  for (const s of snaps) {
    if (existing.some((n) => n.endsWith(`--id${s.id}.json`))) continue; // already saved
    const blob = await apiBlob(`/backup/snapshots/${s.id}/download`);
    const fh = await handle.getFileHandle(snapFileName(s), { create: true });
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
    written++;
  }
  return written;
};
// The stored snapshot a restore has been staged from (previewed, awaiting confirm).
type RestoreSource = { id: number; name: string };
const humanSize = (n: number): string => {
  if (!n || n < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${u[i]}`;
};
interface Preview {
  book: { id: number; name: string | null } | null;
  exported_at: string | null;
  schema_version: number | null;
  schema_mismatch: boolean;
  total_rows: number;
  counts: Record<string, number>;
  replaces: string[];
  current_rows: number;
  problems: string[];
}

export default function MyData() {
  const { activeBook } = useAuth();
  const [groups, setGroups] = useState<Group[]>([]);
  const [dataTab, setDataTab] = useState<'overview' | 'snapshots' | 'purge'>('overview');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Export selection (default: everything).
  const [exportSel, setExportSel] = useState<Set<string>>(new Set());
  // Purge selection (default: nothing) + date range, staged preview, confirmation.
  const [purgeSel, setPurgeSel] = useState<Set<string>>(new Set());
  const [purgeFrom, setPurgeFrom] = useState('');
  const [purgeTo, setPurgeTo] = useState('');
  const [purgePreview, setPurgePreview] = useState<{ groups: { key: string; label: string; rows: number }[]; total_rows: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purging, setPurging] = useState(false);

  // Restore flow — a staged restore can come from an uploaded file or a stored snapshot.
  const [restoreSrc, setRestoreSrc] = useState<RestoreSource | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);

  // Scheduled-backup settings — draft/baseline dirty model, mirroring the SimpleFIN
  // schedule (Save commits the draft). Snapshots (scheduled + manual) live in the DB
  // and are listed in the Available Snapshots section.
  const [sched, setSched] = useState<Sched | null>(null);
  const [schedBase, setSchedBase] = useState<Sched | null>(null);
  const [schedSaving, setSchedSaving] = useState(false);
  const [schedMsg, setSchedMsg] = useState('');
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [snapMax, setSnapMax] = useState(5);
  const [snapBusy, setSnapBusy] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  // Local-folder auto-save: a granted directory handle (persisted in IndexedDB) plus an
  // opt-in flag (persisted in localStorage). When on, snapshots are written to the folder.
  const [dirHandle, setDirHandle] = useState<any>(null);
  const [dirName, setDirName] = useState('');
  const [autoSave, setAutoSave] = useState(() => localStorage.getItem('snapAutoSave') === '1');
  const [folderMsg, setFolderMsg] = useState('');
  // Committed baselines for the folder settings, so the top Save button can show "dirty"
  // until the draft (autoSave / chosen folder) is committed to localStorage + IndexedDB.
  const [autoSaveBase, setAutoSaveBase] = useState(() => localStorage.getItem('snapAutoSave') === '1');
  const [dirHandleBase, setDirHandleBase] = useState<any>(null);
  // Selection key the schedule was last saved with (so toggling data sets marks the
  // schedule dirty). '*' = all data sets.
  const [baseGroupsKey, setBaseGroupsKey] = useState('*');

  const loadGroups = () => api.get<Group[]>('/backup/groups').then((g) => { setGroups(g); setExportSel(new Set(g.map((x) => x.key))); return g; }).catch((e) => { setErr(e.message); return [] as Group[]; });
  const loadSched = (all: Group[]) => api.get<Sched>('/backup/schedule').then((s) => {
    setSched(s); setSchedBase(s);
    setBaseGroupsKey(s.groups && s.groups.length ? [...s.groups].sort().join(',') : '*');
    // Reflect a saved partial selection in the shared picker (else keep the all-default).
    if (s.groups && s.groups.length) setExportSel(new Set(s.groups.filter((k) => all.some((g) => g.key === k))));
  }).catch((e) => setErr(e.message));
  const loadSnaps = () => api.get<{ snapshots: Snap[]; max: number }>('/backup/snapshots').then((r) => { setSnaps(r.snapshots); setSnapMax(r.max); return r.snapshots; }).catch(() => [] as Snap[]);
  useEffect(() => { loadGroups().then(loadSched); loadSnaps(); }, []);

  // Restore a previously-chosen download folder (handle survives reloads via IndexedDB).
  useEffect(() => { if (fsSupported) idbGet('snapDir').then((h) => { if (h) { setDirHandle(h); setDirName(h.name); setDirHandleBase(h); } }).catch(() => {}); }, []);

  // When the COMMITTED auto-save settings are on and the folder's permission is already
  // granted, mirror any new snapshots to disk whenever the list changes (covers
  // Create/Upload and, on reload, anything the scheduler produced while you were away).
  // Never prompts here — a first grant needs a click, handled by the buttons below.
  useEffect(() => {
    if (!autoSaveBase || !dirHandleBase || snaps.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        if ((await dirHandleBase.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
        const n = await syncSnapshotsToDir(dirHandleBase, snaps);
        if (!cancelled && n > 0) setFolderMsg(`Saved ${n} snapshot${n === 1 ? '' : 's'} to “${dirHandleBase.name}”.`);
      } catch { /* transient FS errors are non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [snaps, autoSaveBase, dirHandleBase]);

  // Picking a folder only stages it (draft) — it's committed by the top Save button.
  const chooseFolder = async (): Promise<any> => {
    setErr(''); setFolderMsg(''); setSchedMsg('');
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite', id: 'ledger-snapshots' });
      if (!(await ensureRWPermission(handle))) { setErr('Permission to write to that folder was denied.'); return null; }
      setDirHandle(handle); setDirName(handle.name);
      return handle;
    } catch (e: any) { if (e?.name !== 'AbortError') setErr(e.message || 'Could not open that folder.'); return null; }
  };

  // Immediately push every snapshot to the chosen folder (separate from saving settings).
  const saveAllNow = async () => {
    let handle = dirHandle;
    if (!handle) { handle = await chooseFolder(); if (!handle) return; }
    setErr(''); setFolderMsg('Saving…');
    try {
      if (!(await ensureRWPermission(handle))) { setErr('Permission to write to that folder was denied.'); return; }
      const n = await syncSnapshotsToDir(handle, snaps);
      setFolderMsg(n > 0 ? `Saved ${n} snapshot${n === 1 ? '' : 's'} to “${handle.name}”.` : `“${handle.name}” is already up to date.`);
    } catch (e: any) { setErr(e.message || 'Could not write to that folder.'); setFolderMsg(''); }
  };

  const toggleAutoSave = async (on: boolean) => {
    setSchedMsg(''); setFolderMsg(''); setAutoSave(on);
    if (on && !dirHandle) await chooseFolder(); // convenience: pick a folder when enabling
  };

  // '*' when every data set is selected, otherwise the sorted key list. The schedule
  // only cares about the selection when it's enabled.
  const groupsKey = exportSel.size === groups.length && groups.length > 0 ? '*' : [...exportSel].sort().join(',');
  const schedDirty = !!sched && !!schedBase && (
    sched.enabled !== schedBase.enabled ||
    sched.frequency !== schedBase.frequency ||
    (sched.start_at ?? '') !== (schedBase.start_at ?? '') ||
    (sched.enabled && groupsKey !== baseGroupsKey)
  );
  // Folder/auto-save settings are dirty until committed to localStorage + IndexedDB.
  const folderDirty = autoSave !== autoSaveBase || dirHandle !== dirHandleBase;
  // One Save button at the top covers both the schedule and the auto-save-to-folder settings.
  const settingsDirty = schedDirty || folderDirty;
  const patchSched = (p: Partial<Sched>) => { setSchedMsg(''); setSched((s) => (s ? { ...s, ...p } : s)); };
  const saveAll = async () => {
    setSchedSaving(true); setErr('');
    try {
      if (schedDirty && sched) {
        const groups = exportAll ? null : [...exportSel];
        const saved = await api.post<Sched>('/backup/schedule', { enabled: sched.enabled, frequency: sched.frequency, start_at: sched.start_at, groups });
        setSched(saved); setSchedBase(saved);
        setBaseGroupsKey(saved.groups && saved.groups.length ? [...saved.groups].sort().join(',') : '*');
      }
      if (folderDirty) {
        localStorage.setItem('snapAutoSave', autoSave ? '1' : '0');
        if (dirHandle && dirHandle !== dirHandleBase) await idbSet('snapDir', dirHandle);
        setAutoSaveBase(autoSave); setDirHandleBase(dirHandle);
      }
      setSchedMsg('Saved.');
    } catch (e: any) { setErr(e.message); } finally { setSchedSaving(false); }
  };
  const deleteSnap = async (id: number) => {
    setSnapBusy(id);
    try { await api.del(`/backup/snapshots/${id}`); setSnaps((xs) => xs.filter((s) => s.id !== id)); }
    catch (e: any) { setErr(e.message); } finally { setSnapBusy(null); }
  };
  const createNow = async () => {
    setErr(''); setMsg(''); setCreating(true);
    const groups = exportAll ? null : [...exportSel];
    try {
      await api.post('/backup/snapshots', { name: newName.trim() || undefined, groups });
      setNewName(''); await loadSnaps();
      setMsg('Snapshot created.');
    } catch (e: any) { setErr(e.message); } finally { setCreating(false); }
  };
  // Rename commits on blur; pin/unpin commits immediately (and re-sorts pinned first).
  const renameSnap = async (id: number, name: string) => {
    try { await api.patch(`/backup/snapshots/${id}`, { name }); }
    catch (e: any) { setErr(e.message); }
  };
  const setPinned = async (id: number, pinned: boolean) => {
    setErr(''); setMsg('');
    setSnaps((xs) => xs.map((s) => (s.id === id ? { ...s, pinned } : s)));
    try {
      const r = await api.patch<{ unpinned?: string[] }>(`/backup/snapshots/${id}`, { pinned });
      if (r?.unpinned?.length) setMsg(`You can keep at most 4 snapshots — unpinned “${r.unpinned[0]}”.`);
      await loadSnaps();
    } catch (e: any) { setErr(e.message); await loadSnaps(); }
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); setter(next);
  };
  const allKeys = groups.map((g) => g.key);
  const exportAll = exportSel.size === groups.length && groups.length > 0;
  const totalRows = groups.reduce((s, g) => s + g.rows, 0);
  const totalBytes = groups.reduce((s, g) => s + g.bytes, 0);
  const selectedBytes = groups.filter((g) => exportSel.has(g.key)).reduce((s, g) => s + g.bytes, 0);
  const bySize = [...groups].filter((g) => g.rows > 0).sort((a, b) => b.bytes - a.bytes);
  const maxBytes = Math.max(1, ...bySize.map((g) => g.bytes));

  // Upload a snapshot file → just add it to the list (no restore). Restore is a
  // separate, explicit per-row action with its own preview/confirm.
  const uploadSnapshot = async (file: File | undefined) => {
    if (!file) return;
    setErr(''); setMsg('');
    // Guard before reading/parsing: a huge file would freeze the tab on JSON.parse
    // (and the server caps the backup body at 200 MB anyway).
    if (file.size > 200 * 1024 * 1024) {
      setErr('That file is too large (max 200 MB).');
      return;
    }
    try {
      const env = JSON.parse(await file.text());
      const name = file.name.replace(/\.json$/i, '').slice(0, 80) || 'Uploaded snapshot';
      await api.post('/backup/snapshots/upload', { name, envelope: env });
      await loadSnaps();
      setMsg('Snapshot added to the list.');
    } catch (e: any) { setErr(e.message || 'Could not read that file.'); }
  };

  const restoreFromSnapshot = async (s: Snap) => {
    setErr(''); setMsg(''); setPreview(null); setConfirmText(''); setSnapBusy(s.id);
    try {
      const pv = await api.post<Preview>(`/backup/snapshots/${s.id}/preview`, {});
      setRestoreSrc({ id: s.id, name: s.name || s.label }); setPreview(pv);
    } catch (e: any) { setErr(e.message); } finally { setSnapBusy(null); }
  };

  const restore = async () => {
    if (!restoreSrc || confirmText !== 'REPLACE') return;
    setErr(''); setMsg(''); setRestoring(true);
    try {
      setMsg('Saving a pre-restore safety snapshot of your current data…');
      await apiDownload('/backup/export?label=pre-restore', `ledger-pre-restore-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e: any) {
      setErr(`Couldn't save a safety snapshot, so the restore was cancelled (nothing was changed): ${e.message}`);
      setRestoring(false); return;
    }
    try {
      const r = await api.post<{ restored_rows: number }>(`/backup/snapshots/${restoreSrc.id}/restore`, { confirm: 'REPLACE' });
      setMsg(`Restore complete — ${r.restored_rows.toLocaleString()} records loaded. Reloading…`);
      setTimeout(() => window.location.assign('/'), 1200);
    } catch (e: any) { setErr(e.message); setRestoring(false); }
  };
  const cancelRestore = () => { setRestoreSrc(null); setPreview(null); setConfirmText(''); };

  // Changing the selection or date range invalidates a staged preview, so the user
  // can't confirm a deletion that no longer matches what they're looking at.
  const resetPurgePreview = () => { setPurgePreview(null); setPurgeConfirm(''); };
  const togglePurge = (key: string) => { resetPurgePreview(); toggle(purgeSel, setPurgeSel, key); };
  const purgeDates = () => ({ from: purgeFrom || undefined, to: purgeTo || undefined });

  const runPurgePreview = async () => {
    if (purgeSel.size === 0) return;
    setErr(''); setMsg(''); setPreviewing(true); setPurgeConfirm('');
    try {
      const r = await api.post<{ groups: { key: string; label: string; rows: number }[]; total_rows: number }>(
        '/backup/purge/preview', { groups: [...purgeSel], ...purgeDates() });
      setPurgePreview(r);
    } catch (e: any) { setErr(e.message); setPurgePreview(null); } finally { setPreviewing(false); }
  };

  const purge = async () => {
    if (!purgePreview || purgeConfirm !== 'DELETE') return;
    setErr(''); setMsg(''); setPurging(true);
    try {
      setMsg('Saving a pre-delete safety snapshot of the data being removed…');
      await apiDownload(`/backup/export?groups=${[...purgeSel].join(',')}&label=pre-delete`, `ledger-pre-delete-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e: any) {
      setErr(`Couldn't save a safety snapshot, so the delete was cancelled (nothing was changed): ${e.message}`);
      setPurging(false); return;
    }
    try {
      const r = await api.post<{ deleted_rows: number }>('/backup/purge', { groups: [...purgeSel], confirm: 'DELETE', ...purgeDates() });
      setMsg(`Deleted ${r.deleted_rows.toLocaleString()} records. Reloading…`);
      setTimeout(() => window.location.assign('/'), 1200);
    } catch (e: any) { setErr(e.message); setPurging(false); }
  };

  const topTables = preview ? Object.entries(preview.counts).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">My Account</div>
          <h1 className="title">My Data</h1>
          <p className="subtitle">Back up or restore <strong>{activeBook?.name ?? 'your books'}</strong>, choose exactly what to include, and clear out data sets you want to start over. Everything stays on your own server.</p>
        </div>
      </div>

      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      {msg && <div className="banner" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="tabs">
        <button className={`tab ${dataTab === 'overview' ? 'active' : ''}`} onClick={() => setDataTab('overview')}>Overview</button>
        <button className={`tab ${dataTab === 'snapshots' ? 'active' : ''}`} onClick={() => setDataTab('snapshots')}>Snapshots</button>
        <button className={`tab ${dataTab === 'purge' ? 'active' : ''}`} onClick={() => setDataTab('purge')}>Purge Data</button>
      </div>

      {dataTab === 'overview' && (
        groups.length > 0 ? (
          <>
            <div className="grid grid-3" style={{ marginBottom: 16 }}>
              <div className="card stat"><div className="label">Total Records</div><div className="value">{totalRows.toLocaleString()}</div></div>
              <div className="card stat"><div className="label">Estimated Size</div><div className="value small">≈ {humanSize(totalBytes)}</div></div>
              <div className="card stat"><div className="label">Data Sets</div><div className="value small">{groups.length}</div></div>
            </div>
            {bySize.length > 0 && (
              <div className="card" style={{ padding: 0 }}>
                <table className="ledger">
                  <thead><tr><th>Data Set</th><th className="r">Records</th><th className="r">Size</th><th style={{ width: '34%' }}>Share of Size</th></tr></thead>
                  <tbody>
                    {bySize.map((g, i) => (
                      <tr key={g.key}>
                        <td>{g.label}</td>
                        <td className="r num">{g.rows.toLocaleString()}</td>
                        <td className="r num muted">≈ {humanSize(g.bytes)}</td>
                        <td>
                          <div style={{ background: 'var(--hairline)', borderRadius: 4, height: 8, width: '100%' }}>
                            <div style={{ width: `${Math.max(2, (g.bytes / maxBytes) * 100)}%`, background: CHART_COLORS[i % CHART_COLORS.length], borderRadius: 4, height: 8 }} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="card"><p className="muted" style={{ margin: 0, fontSize: 13 }}>No data to summarize yet.</p></div>
        )
      )}

      {dataTab === 'snapshots' && (
      <>
      <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', marginBottom: 8 }}>
        <div className="btn-row">
          {schedMsg && !settingsDirty && <span style={{ color: 'var(--credit)', fontSize: 13 }}>{schedMsg}</span>}
          <button onClick={saveAll} disabled={!settingsDirty || schedSaving}>{schedSaving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
      <div className="card">
        <div className="label" style={{ marginBottom: 6 }}>Generate a Snapshot</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Pick which data sets to include — the selection applies to both an instant snapshot and the scheduled backup. Snapshots are saved below (max {snapMax}) and include attached documents/receipts.</p>
        <div className="row" style={{ gap: 10, marginBottom: 10 }}>
          <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setExportSel(new Set(allKeys))}>Select All</button>
          <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setExportSel(new Set())}>Select None</button>
        </div>
        {/* Data-set picker — toggles spread across 3 columns. */}
        <div className="grid grid-3" style={{ gap: '8px 16px', marginBottom: 16 }}>
          {groups.map((g) => (
            <Toggle key={g.key} checked={exportSel.has(g.key)} onChange={() => toggle(exportSel, setExportSel, g.key)}>
              <span style={{ fontWeight: 500 }}>{g.label}</span>
              <span className="muted num" style={{ fontSize: 12, marginLeft: 6 }}>{g.rows.toLocaleString()}</span>
            </Toggle>
          ))}
        </div>

        {/* Schedule a recurring backup of the same selection. (Saved via the bottom row.) */}
        <div className="label" style={{ margin: '4px 0 6px' }}>Schedule Backup</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Automatically capture the selected data sets on a schedule. Snapshots are kept below for download — a scheduled run can't push a file to your browser.
        </p>
        {sched && (
          <>
            <div className="grid grid-3" style={{ gap: 16, alignItems: 'start' }}>
              <div>
                <div className="label" style={{ marginBottom: 6 }}>Automatic Backups</div>
                <Toggle checked={sched.enabled} onChange={(v) => patchSched({ enabled: v })}>
                  {sched.enabled ? 'On' : 'Off'}
                </Toggle>
              </div>
              <div>
                <div className="label" style={{ marginBottom: 6 }}>Frequency</div>
                <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 13, opacity: sched.frequency === 'daily' ? 1 : 0.5 }}>Daily</span>
                  <Toggle
                    checked={sched.frequency === 'weekly'}
                    disabled={!sched.enabled}
                    onChange={(v) => patchSched({ frequency: v ? 'weekly' : 'daily' })}
                  />
                  <span className="muted" style={{ fontSize: 13, opacity: sched.frequency === 'weekly' ? 1 : 0.5 }}>Weekly</span>
                </div>
              </div>
              <div>
                <div className="label" style={{ marginBottom: 6 }}>Starts</div>
                <input
                  type="datetime-local"
                  value={sched.start_at ?? ''}
                  disabled={!sched.enabled}
                  onChange={(e) => patchSched({ start_at: e.target.value || null })}
                />
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              {sched.last_backup_at ? `Last automatic backup: ${shortDate(sched.last_backup_at)}.` : 'No automatic backup has run yet.'}
            </div>
          </>
        )}

        {/* Create a snapshot instantly (stored in Available Snapshots). */}
        <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'flex-end', marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--hairline)' }}>
          {exportSel.size > 0 && <span className="muted num" style={{ fontSize: 13 }}>≈ {humanSize(selectedBytes)}</span>}
          <input style={{ maxWidth: 200 }} placeholder="Name (optional)" value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
          <button onClick={createNow} disabled={creating || exportSel.size === 0}>
            {creating ? 'Creating…' : 'Create Now'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div className="label">Available Snapshots</div>
          <span className="muted num" style={{ fontSize: 12 }}>{snaps.length} of {snapMax}</span>
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Download a snapshot to your computer for safekeeping, or use <strong>Restore</strong> to load one back in (you'll see a preview and confirm first). Upload a snapshot file to add it to the list. Pin (<strong>Keep</strong>) up to 4 snapshots so they're never auto-purged; pinning a 5th unpins the oldest. The oldest unpinned snapshot is removed once you're over {snapMax}.
        </p>

        {/* Staged restore (from a snapshot in the list) — preview, then confirm. */}
        {preview && restoreSrc && (
          <div className="card" style={{ background: 'var(--surface-alt)', borderLeft: '3px solid var(--debit)', margin: '4px 0 16px' }}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600 }}>Restore from “{restoreSrc.name}”</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {preview.book?.name ? `From "${preview.book.name}"` : 'Snapshot'}
                  {preview.exported_at ? ` · taken ${dateTime(preview.exported_at)}` : ''}{` · ${preview.total_rows.toLocaleString()} records`}
                </div>
              </div>
              <button className="ghost" onClick={cancelRestore}>Cancel</button>
            </div>
            {preview.schema_mismatch && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8, color: 'var(--warn, #b8860b)' }}>⚠ This snapshot was taken on a different app version. It can still be restored, but newer fields may be missing.</div>
            )}
            {topTables.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {topTables.map(([t, n]) => <span key={t} className="tag" style={{ fontSize: 11, textTransform: 'none' }}>{t.replace(/_/g, ' ')}: {n}</span>)}
              </div>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              This replaces <strong>{preview.replaces.join(', ')}</strong>: the {preview.current_rows.toLocaleString()} records in {preview.replaces.length === 1 ? 'it' : 'them'} now are removed and the snapshot's records are loaded. A <strong>pre-restore safety snapshot</strong> downloads to your computer right before the replace.
            </div>
            {preview.problems.length > 0 && (
              <div className="error" role="alert" style={{ marginTop: 10 }}>
                {preview.problems.map((p) => <div key={p}>{p}</div>)}
              </div>
            )}
            <div className="grid grid-2" style={{ alignItems: 'end', marginTop: 12 }}>
              <label className="field"><span>Type <strong>REPLACE</strong> to confirm</span><input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="REPLACE" /></label>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button className="ghost" onClick={cancelRestore} disabled={restoring}>Cancel</button>
                <button className="danger" onClick={restore} disabled={confirmText !== 'REPLACE' || restoring || preview.problems.length > 0}>{restoring ? 'Restoring…' : 'Replace Data'}</button>
              </div>
            </div>
          </div>
        )}

        {snaps.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No snapshots yet. Use <strong>Create Now</strong> above, set up a schedule, or upload a snapshot file.</p>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Name</th>
                <th style={{ textAlign: 'left' }}>Created</th>
                <th style={{ textAlign: 'left' }}>Type</th>
                <th style={{ textAlign: 'left' }}>Data</th>
                <th style={{ textAlign: 'left' }}>Size</th>
                <th style={{ textAlign: 'left' }}>Keep</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snaps.map((s) => (
                <tr key={s.id}>
                  <td>
                    <input defaultValue={s.name ?? ''} placeholder="Untitled" maxLength={80} style={{ width: '100%', minWidth: 120 }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== (s.name ?? '')) renameSnap(s.id, v); }} />
                  </td>
                  <td className="muted">{dateTime(s.taken_at)}</td>
                  <td className="muted" style={{ textTransform: 'capitalize' }}>{s.label === 'auto' ? 'Scheduled' : s.label}</td>
                  <td className="muted">{s.scope === 'partial' ? 'Partial' : 'Full'}</td>
                  <td className="num">{humanSize(s.bytes)}</td>
                  <td><Toggle checked={s.pinned} onChange={(v) => setPinned(s.id, v)} /></td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <button className="ghost danger" style={{ padding: '4px 10px', fontSize: 12 }} disabled={snapBusy === s.id} onClick={() => deleteSnap(s.id)}>Delete</button>
                      <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() => apiDownload(`/backup/snapshots/${s.id}/download`, `ledger-${(s.name || s.label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${s.taken_at.slice(0, 10)}.json`).catch((e) => setErr(e.message))}>Download</button>
                      <button style={{ padding: '4px 12px', fontSize: 12 }} disabled={snapBusy === s.id || restoring}
                        onClick={() => restoreFromSnapshot(s)}>Restore</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Auto-save copies of every snapshot to a folder on this computer. */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--hairline)' }}>
          {fsSupported ? (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'nowrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Toggle checked={autoSave} onChange={toggleAutoSave}>Automatically Save Snapshots to a Folder</Toggle>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {dirName
                    ? <>Folder: <strong>{dirName}</strong> — new snapshots are saved here; reopen this page to capture scheduled ones.</>
                    : 'Choose a folder on this computer to keep a copy of every snapshot.'}
                  {folderMsg && <span style={{ color: 'var(--credit)', marginLeft: 8 }}>{folderMsg}</span>}
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                <button className="ghost" onClick={chooseFolder} disabled={!autoSave}>{dirName ? 'Change Folder' : 'Choose Folder'}</button>
                <button className="ghost" onClick={saveAllNow} disabled={!autoSave || snaps.length === 0}>Save Snapshots Now</button>
              </div>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>Saving snapshots straight to a folder needs a Chromium browser (Chrome or Edge). You can still download snapshots individually from the list above.</div>
          )}
        </div>

        {/* Add a snapshot file saved on this computer to the list (does not restore). */}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <input ref={uploadRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => { uploadSnapshot(e.target.files?.[0]); e.target.value = ''; }} />
          <button onClick={() => uploadRef.current?.click()}>Upload Snapshot</button>
        </div>
      </div>
      </>
      )}

      {dataTab === 'purge' && (
      <div className="card" style={{ borderTop: '3px solid var(--debit)' }}>
        <div className="label" style={{ marginBottom: 6 }}>Purge Data</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Permanently delete records created within a date range. Records linked to deleted data may be unlinked or removed.
          A <strong>safety snapshot</strong> of the selected data sets downloads automatically first, so it can be restored later.
        </p>
        <div className="row" style={{ gap: 10, marginBottom: 10 }}>
          <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { resetPurgePreview(); setPurgeSel(new Set(allKeys)); }}>Select All</button>
          <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { resetPurgePreview(); setPurgeSel(new Set()); }}>Select None</button>
        </div>
        {/* Data-set picker — same toggles & 3-column layout as Generate a Snapshot. */}
        <div className="grid grid-3" style={{ gap: '8px 16px', marginBottom: 16 }}>
          {groups.map((g) => (
            <Toggle key={g.key} checked={purgeSel.has(g.key)} onChange={() => togglePurge(g.key)}>
              <span style={{ fontWeight: 500 }} className={purgeSel.has(g.key) ? 'debit' : ''}>{g.label}</span>
              <span className="muted num" style={{ fontSize: 12, marginLeft: 6 }}>{g.rows.toLocaleString()}</span>
            </Toggle>
          ))}
        </div>

        {/* Date range — applied to each row's DB creation time, not its business date. */}
        <div className="grid grid-3" style={{ gap: 16, alignItems: 'end', marginBottom: 8 }}>
          <label className="field" style={{ marginBottom: 0 }}><span>From</span><input type="date" value={purgeFrom} onChange={(e) => { resetPurgePreview(); setPurgeFrom(e.target.value); }} /></label>
          <label className="field" style={{ marginBottom: 0 }}><span>To</span><input type="date" value={purgeTo} onChange={(e) => { resetPurgePreview(); setPurgeTo(e.target.value); }} /></label>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={runPurgePreview} disabled={purgeSel.size === 0 || previewing}>{previewing ? 'Checking…' : 'Preview Deletion'}</button>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Filters by each record's <strong>creation date in the database</strong> (when it was added to the ledger) — not the date on the transaction, account, or other item. Leave a field blank for no bound on that end.
        </p>

        {/* Staged for deletion — must be previewed before the confirm/Delete enables. */}
        {purgePreview && (
          <div className="card" style={{ background: 'var(--surface-alt)', borderLeft: '3px solid var(--debit)', margin: '6px 0 0' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div style={{ fontWeight: 600 }}>Staged for deletion</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {purgeFrom || '—'} → {purgeTo || '—'}
              </div>
            </div>
            {purgePreview.total_rows === 0 ? (
              <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>No records were created in this range for the selected data sets — nothing to delete.</p>
            ) : (
              <>
                <table className="table" style={{ width: '100%', marginTop: 8 }}>
                  <thead><tr><th>Data Set</th><th style={{ textAlign: 'right' }}>Records to Delete</th></tr></thead>
                  <tbody>
                    {purgePreview.groups.filter((g) => g.rows > 0).map((g) => (
                      <tr key={g.key}><td>{g.label}</td><td className="num debit" style={{ textAlign: 'right' }}>{g.rows.toLocaleString()}</td></tr>
                    ))}
                    <tr><td style={{ fontWeight: 600 }}>Total</td><td className="num debit" style={{ textAlign: 'right', fontWeight: 600 }}>{purgePreview.total_rows.toLocaleString()}</td></tr>
                  </tbody>
                </table>
                <div className="grid grid-2" style={{ alignItems: 'end', marginTop: 12 }}>
                  <label className="field"><span>Type <strong>DELETE</strong> to confirm</span><input value={purgeConfirm} onChange={(e) => setPurgeConfirm(e.target.value)} placeholder="DELETE" /></label>
                  <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                    <button className="ghost" onClick={resetPurgePreview} disabled={purging}>Cancel</button>
                    <button className="danger" onClick={purge} disabled={purgeConfirm !== 'DELETE' || purging}>
                      {purging ? 'Deleting…' : `Delete ${purgePreview.total_rows.toLocaleString()} Record${purgePreview.total_rows === 1 ? '' : 's'}`}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      )}
    </>
  );
}

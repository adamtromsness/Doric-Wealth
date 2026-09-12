import { useEffect, useState } from 'react';
import { api, shortDate } from '../api';
import { Field, fileToBase64 } from './ui';
import { Pager } from '../pages/transactions/common';

export interface EntityDoc {
  id: number;
  name: string | null;
  file_name: string | null;
  file_mime: string | null;
  created_at: string;
  doc_type?: string | null;
}

const DOC_PAGE = 5;

// Reusable documents manager (used by vehicles, properties, …). Documents are
// uploaded with a name + type, listed in a type-grouped paginated table, and can be
// renamed, re-typed, re-filed, or deleted. `basePath` is the entity's REST base
// (e.g. "/vehicles/5"); `docTypes` is the [value, label] category list.
export function EntityDocuments({ basePath, docTypes }: { basePath: string; docTypes: [string, string][] }) {
  const typeLabel = (t: string | null | undefined) => docTypes.find(([v]) => v === t)?.[1] ?? 'Other';

  const [err, setErr] = useState('');
  const [docs, setDocs] = useState<EntityDoc[]>([]);
  const loadDocs = () => api.get<EntityDoc[]>(`${basePath}/documents`).then(setDocs).catch(() => {});
  useEffect(() => { loadDocs(); }, [basePath]);

  const [docId, setDocId] = useState<number | null>(null);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docName, setDocName] = useState('');
  const [docType, setDocType] = useState('other');
  const [docPage, setDocPage] = useState(0);
  const resetForm = () => { setDocId(null); setDocFile(null); setDocName(''); setDocType('other'); };
  const startEdit = (d: EntityDoc) => { setDocId(d.id); setDocFile(null); setDocName(d.name || d.file_name || ''); setDocType(d.doc_type || 'other'); };
  const pickFile = (file: File | undefined) => { if (!file) return; setDocFile(file); setDocName((n) => (n.trim() ? n : file.name)); };

  const submit = async () => {
    setErr('');
    try {
      if (docId != null) {
        const body: any = { name: docName.trim() || null, doc_type: docType };
        if (docFile) { const { data, mime, name } = await fileToBase64(docFile); body.file = data; body.file_mime = mime; body.file_name = name; }
        await api.put(`${basePath}/documents/${docId}`, body);
      } else {
        if (!docFile) return;
        const { data, mime, name } = await fileToBase64(docFile);
        await api.post(`${basePath}/documents`, { file: data, file_mime: mime, file_name: name, name: docName.trim() || name, doc_type: docType });
      }
      resetForm(); loadDocs();
    } catch (e: any) { setErr(e.message); }
  };
  const del = async (id: number) => {
    try { await api.del(`${basePath}/documents/${id}`); if (docId === id) resetForm(); loadDocs(); } catch (e: any) { setErr(e.message); }
  };

  const docsSorted = [...docs].sort((a, b) => {
    const ord = (t?: string | null) => { const i = docTypes.findIndex(([v]) => v === (t || 'other')); return i < 0 ? 99 : i; };
    return ord(a.doc_type) - ord(b.doc_type) || (a.created_at < b.created_at ? 1 : -1);
  });
  const pageCount = Math.max(1, Math.ceil(docsSorted.length / DOC_PAGE));
  const page = Math.min(docPage, pageCount - 1);
  const paged = docsSorted.slice(page * DOC_PAGE, page * DOC_PAGE + DOC_PAGE);
  const editOrig = docId != null ? docs.find((d) => d.id === docId) : undefined;
  const changed = docId != null && (
    docName.trim() !== (editOrig?.name || editOrig?.file_name || '') ||
    docType !== (editOrig?.doc_type || 'other') ||
    docFile != null
  );
  const accept = 'image/*,application/pdf,.pdf,.doc,.docx,.txt';

  return (
    <div className="card">
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Field label="Name"><input value={docName} onChange={(e) => setDocName(e.target.value)} placeholder="Document name" /></Field>
        </div>
        <Field label="Type">
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>
            {docTypes.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
          </select>
        </Field>
        {docId != null ? (
          <>
            <button className="ghost" style={{ marginBottom: 12 }} onClick={resetForm}>Cancel</button>
            <button style={{ marginBottom: 12 }} onClick={submit} disabled={!changed}>Update</button>
          </>
        ) : (
          <label className="ghost" style={{ cursor: 'pointer', display: 'inline-block', padding: '9px 16px', border: '1px solid var(--hairline-strong)', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 600, marginBottom: 12 }}
            onClick={(e) => { if (docFile) { e.preventDefault(); submit(); } }}>
            {docFile ? 'Upload' : 'Select File'}
            <input type="file" accept={accept} style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files?.[0])} />
          </label>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12, minHeight: 16 }}>
        {docId != null ? (
          <>
            {docFile ? `New file: ${docFile.name}` : 'Editing — change the name or type, then Update.'}{' '}
            <label style={{ cursor: 'pointer', color: 'var(--brass-deep)', textDecoration: 'underline' }}>
              {docFile ? 'choose a different file' : 'replace file'}
              <input type="file" accept={accept} style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files?.[0])} />
            </label>
          </>
        ) : (docFile ? docFile.name : 'Select a file, name it, pick a type, then Upload.')}
      </div>

      {docs.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No documents yet.</div>
      ) : (
        <>
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <thead><tr><th>Name</th><th>Type</th><th className="r">Uploaded</th><th></th></tr></thead>
              <tbody>
                {paged.map((d) => (
                  <tr key={d.id}>
                    <td><a href={`/api${basePath}/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.name || d.file_name || 'document'}</a></td>
                    <td className="muted">{typeLabel(d.doc_type)}</td>
                    <td className="r num muted" style={{ fontSize: 12 }}>{shortDate(d.created_at)}</td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      <button className="ghost" style={{ padding: '2px 8px' }} title="Edit name & type" onClick={() => startEdit(d)}>✎</button>
                      <button className="ghost" style={{ padding: '2px 8px', marginLeft: 4 }} title="Delete" onClick={() => del(d.id)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageCount={pageCount} total={docsSorted.length} start={page * DOC_PAGE} count={paged.length} onPage={setDocPage} />
        </>
      )}
    </div>
  );
}

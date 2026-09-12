import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { Field, Modal, EditorFooter, useDirty } from '../components/ui';
import { Pager } from './transactions/common';

interface Category {
  id: number; name: string; kind: 'expense' | 'income';
  parent_id: number | null; parent_name: string | null; has_children: boolean;
  sort_order: number; managed: boolean; source_kind: string | null;
  archived_at: string | null;
}

type Dragging = { type: 'item' | 'group'; id: number } | null;

type EditorState =
  | { mode: 'new-group'; kind: 'income' | 'expense' }
  | { mode: 'new-item'; parent: Category }
  | { mode: 'edit'; category: Category };

export default function Categories() {
  const [cats, setCats] = useState<Category[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [err, setErr] = useState('');
  const [dragging, setDragging] = useState<Dragging>(null);
  const [overGroup, setOverGroup] = useState<number | null>(null);
  const [overItem, setOverItem] = useState<number | null>(null);

  const load = () => api.get<Category[]>('/categories').then(setCats).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Every top-level category is a group (it can hold items), even before any
  // items are added. Categories with a parent are the items beneath them.
  // Income groups sort to the top, expense groups below; manual order within each.
  // Archived categories are hidden from the active tree (and pickers) but kept so
  // historical reports stay resolvable; a toggle reveals them for restoring.
  const archivedCats = useMemo(() => cats.filter((c) => c.archived_at).sort((a, b) => a.name.localeCompare(b.name)), [cats]);
  const groups = useMemo(
    () => cats.filter((c) => c.parent_id === null && !c.managed && !c.archived_at).sort((a, b) =>
      a.kind === b.kind ? a.sort_order - b.sort_order : a.kind === 'income' ? -1 : 1
    ),
    [cats]
  );
  // Auto-managed groups (Utilities, Subscriptions), shown read-only at the bottom.
  const managedGroups = useMemo(
    () => cats.filter((c) => c.parent_id === null && c.managed).sort((a, b) => a.sort_order - b.sort_order),
    [cats]
  );
  const itemsOf = (groupId: number) =>
    cats.filter((c) => c.parent_id === groupId && !c.archived_at).sort((a, b) => a.sort_order - b.sort_order);

  const remove = async (c: Category) => {
    const msg = c.has_children
      ? `Delete group "${c.name}" and all its items? If any are used in transactions or budgets, they're archived (kept for history) instead of removed.`
      : `Delete "${c.name}"? If it's used in transactions or budgets, it's archived (kept for history) instead of removed.`;
    if (!confirm(msg)) return;
    try { await api.del(`/categories/${c.id}`); load(); } catch (e: any) { setErr(e.message); }
  };
  const restore = async (c: Category) => {
    try { await api.post(`/categories/${c.id}/archive`, { archived: false }); load(); } catch (e: any) { setErr(e.message); }
  };

  const saved = () => { setEditor(null); load(); };

  // Inline rename: click a name to turn it into a text field. We send the
  // existing parent_id so an item stays nested (the API sets parent_id directly).
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const commitRename = async (c: Category) => {
    if (!renaming || renaming.id !== c.id) return;
    const value = renaming.value.trim();
    setRenaming(null);
    if (!value || value === c.name) return;
    try { await api.put(`/categories/${c.id}`, { name: value, parent_id: c.parent_id }); load(); }
    catch (e: any) { setErr(e.message); }
  };
  const nameInput = (c: Category, style: CSSProperties) => (
    <input
      autoFocus
      value={renaming!.value}
      onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
      onBlur={() => commitRename(c)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(c); }
        else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ display: 'inline-block', width: 220, ...style }}
    />
  );

  const draggedCat = dragging ? cats.find((c) => c.id === dragging.id) ?? null : null;
  const clearDrag = () => { setDragging(null); setOverGroup(null); setOverItem(null); };

  // Persist a new order for a set of siblings. parentId null => reordering groups;
  // otherwise the ids become that group's items in this order (also handles moves).
  const applyOrder = async (parentId: number | null, orderedIds: number[]) => {
    setCats((prev) => prev.map((c) => {
      const idx = orderedIds.indexOf(c.id);
      if (idx === -1) return c;
      if (parentId === null) return { ...c, sort_order: idx };
      const grp = prev.find((g) => g.id === parentId);
      return { ...c, parent_id: parentId, sort_order: idx, kind: grp ? grp.kind : c.kind, parent_name: grp ? grp.name : c.parent_name };
    }));
    try { await api.post('/categories/reorder', { parent_id: parentId, ids: orderedIds }); load(); }
    catch (e: any) { setErr(e.message); load(); }
  };

  // Drop an item into `group`, before `beforeItemId` (or at the end if null).
  const dropItem = (itemId: number, group: Category, beforeItemId: number | null) => {
    const item = cats.find((c) => c.id === itemId);
    if (!item || item.parent_id == null) return;
    if (item.kind !== group.kind &&
      !confirm(`Move "${item.name}" to "${group.name}"? Its type changes from ${item.kind} to ${group.kind}.`)) return;
    const order = itemsOf(group.id).map((i) => i.id).filter((id) => id !== itemId);
    let at = beforeItemId == null ? order.length : order.indexOf(beforeItemId);
    if (at < 0) at = order.length;
    order.splice(at, 0, itemId);
    applyOrder(group.id, order);
  };

  // Drop a group before `target` (only within the same kind, so income stays on top).
  const dropGroup = (groupId: number, target: Category) => {
    const g = cats.find((c) => c.id === groupId);
    if (!g || g.parent_id != null || g.id === target.id || g.kind !== target.kind) return;
    const order = groups.filter((x) => x.kind === g.kind).map((x) => x.id).filter((id) => id !== groupId);
    let at = order.indexOf(target.id);
    if (at < 0) at = order.length;
    order.splice(at, 0, groupId);
    applyOrder(null, order);
  };

  const incomeGroups = groups.filter((g) => g.kind === 'income');
  const expenseGroups = groups.filter((g) => g.kind === 'expense');
  // "[n] groups · [n] categories" summary for a section.
  const sectionStats = (list: Category[]) => {
    const groupCount = list.length;
    const catCount = list.reduce((s, g) => s + itemsOf(g.id).length, 0);
    return `${groupCount} group${groupCount === 1 ? '' : 's'} · ${catCount} categor${catCount === 1 ? 'y' : 'ies'}`;
  };

  const renderGroup = (g: Category) => {
    const items = itemsOf(g.id);
    const itemTarget = dragging?.type === 'item' && overGroup === g.id;
    const groupTarget = dragging?.type === 'group' && overGroup === g.id && draggedCat?.kind === g.kind && dragging.id !== g.id;
    return (
      <div
        key={g.id}
        className={`category-group-card ${g.kind}`}
        style={itemTarget ? { outline: '2px solid var(--brass)', outlineOffset: 2 } : undefined}
        onDragOver={(e) => { if (dragging?.type === 'item') { e.preventDefault(); setOverGroup(g.id); setOverItem(null); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverGroup((cur) => (cur === g.id ? null : cur)); }}
        onDrop={(e) => { if (dragging?.type === 'item') { e.preventDefault(); const id = dragging.id; clearDrag(); dropItem(id, g, null); } }}
      >
        <div
          className="category-group-header"
          style={groupTarget ? { boxShadow: 'inset 0 2px 0 var(--brass)' } : undefined}
          onDragOver={(e) => { if (dragging?.type === 'group' && draggedCat?.kind === g.kind && dragging.id !== g.id) { e.preventDefault(); setOverGroup(g.id); } }}
          onDrop={(e) => { if (dragging?.type === 'group') { e.preventDefault(); e.stopPropagation(); const id = dragging.id; clearDrag(); dropGroup(id, g); } }}
        >
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 4 }}>
            <span
              draggable
              onDragStart={(e) => { setDragging({ type: 'group', id: g.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(g.id)); }}
              onDragEnd={clearDrag}
              className="drag-handle"
              title="Drag to reorder group"
            >⠿</span>
            {renaming?.id === g.id
              ? nameInput(g, { fontSize: 14, fontWeight: 600, padding: '2px 8px' })
              : <span className="grp-name" title="Click to rename" onClick={() => setRenaming({ id: g.id, value: g.name })}>{g.name}</span>}
          </div>
          <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            <button className="ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setEditor({ mode: 'new-item', parent: g })}>+ Item</button>
            {items.length === 0 && (
              <button className="ghost grp-del" style={{ padding: '3px 9px', fontSize: 12 }} title="Delete empty group" onClick={() => remove(g)}>✕</button>
            )}
          </div>
        </div>
        <div>
          {items.map((it) => (
            <div
              key={it.id}
              className="category-item-row"
              draggable={renaming?.id !== it.id}
              onDragStart={(e) => { setDragging({ type: 'item', id: it.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(it.id)); }}
              onDragEnd={clearDrag}
              onDragOver={(e) => { if (dragging?.type === 'item') { e.preventDefault(); e.stopPropagation(); setOverItem(it.id); setOverGroup(null); } }}
              onDrop={(e) => { if (dragging?.type === 'item') { e.preventDefault(); e.stopPropagation(); const id = dragging.id; clearDrag(); dropItem(id, g, it.id); } }}
              style={{ cursor: 'grab', opacity: dragging?.type === 'item' && dragging.id === it.id ? 0.4 : 1, boxShadow: overItem === it.id ? 'inset 0 2px 0 var(--brass)' : undefined }}
            >
              <span className="drag-handle">⠿</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {renaming?.id === it.id
                  ? nameInput(it, { fontSize: 14, padding: '2px 8px' })
                  : <span className="item-name" title="Click to rename" onClick={() => setRenaming({ id: it.id, value: it.name })}>{it.name}</span>}
              </div>
              <button className="ghost" title="Delete" style={{ padding: '2px 8px' }} onClick={() => remove(it)}>✕</button>
            </div>
          ))}
          {items.length === 0 && (
            <div className="empty" style={{ padding: 12, margin: 0, border: 'none' }}>No items yet.</div>
          )}
        </div>
      </div>
    );
  };

  // Read-only render of an auto-managed group (real category rows the system
  // keeps in sync). Selectable for transactions/budgets, but not editable here.
  const SOURCE_LABEL: Record<string, string> = {
    utilities: 'Synced from your utility accounts',
    subscriptions: 'Synced from your subscriptions',
  };
  const renderAutoGroup = (g: Category) => {
    const items = itemsOf(g.id);
    return (
      <div key={g.id} className="auto-managed-card">
        <div className="auto-head">
          <span className="auto-name">{g.name}</span>
          <span className="tag" title="Created and kept in sync automatically">Auto-managed</span>
          <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>{g.source_kind ? SOURCE_LABEL[g.source_kind] : ''}</span>
        </div>
        {items.length > 0
          ? items.map((it) => <div key={it.id} className="auto-item">{it.name}</div>)
          : <div className="muted" style={{ fontSize: 12 }}>None yet.</div>}
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Track</div>
          <h1 className="title">Categories &amp; Tags</h1>
          <p className="subtitle">Organize transactions with permanent categories and temporary tags.</p>
          <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
            Categories are required buckets for transactions, budgets, and reporting.<br />
            Tags are optional labels for trips, projects, events, or one-time tracking.
          </div>
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      <TagsSection />

      <div className="section-head" style={{ marginBottom: 2 }}>
        <h2 className="section"><span className="dot" style={{ background: 'var(--expense)' }} />Categories</h2>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '0 0 14px' }}>Required buckets every transaction belongs to.</p>

      <div className={`grid ${managedGroups.length > 0 ? 'grid-3' : 'grid-2'}`} style={{ alignItems: 'start', marginBottom: 28 }}>
        {([
          { kind: 'income', title: 'Income', list: incomeGroups },
          { kind: 'expense', title: 'Expenses', list: expenseGroups },
        ] as const).map((section) => (
          <div key={section.kind} className="category-section-card" style={{ marginBottom: 0 }}>
            <div className="category-section-head">
              <div>
                <div className="name"><span className="dot" style={{ background: section.kind === 'income' ? 'var(--income)' : 'var(--expense)' }} />{section.title}</div>
                <div className="count">{sectionStats(section.list)}</div>
              </div>
              <button onClick={() => setEditor({ mode: 'new-group', kind: section.kind })}>Add Group</button>
            </div>
            {section.list.length === 0 ? (
              <div className="empty">No {section.kind} groups yet — use “Add Group”.</div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>{section.list.map(renderGroup)}</div>
            )}
          </div>
        ))}

        {managedGroups.length > 0 && (
          <div className="auto-managed-section category-section-card" style={{ marginBottom: 0 }}>
            <div className="category-section-head">
              <div>
                <div className="name" style={{ color: 'var(--muted)' }}><span className="dot" style={{ background: 'var(--muted)' }} />Automatic</div>
                <div className="count">{managedGroups.length} synced group{managedGroups.length === 1 ? '' : 's'}</div>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
              Created and kept in sync from your utility accounts. Manage them on the Utilities page.
            </p>
            <div style={{ display: 'grid', gap: 10 }}>{managedGroups.map(renderAutoGroup)}</div>
          </div>
        )}
      </div>

      {archivedCats.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <h2 className="section" style={{ margin: '0 0 8px' }}>
            Archived <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>· kept so historical reports stay resolvable</span>
          </h2>
          <div className="card" style={{ padding: 0 }}>
            <table className="ledger">
              <tbody>
                {archivedCats.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}{c.parent_name ? <span className="muted" style={{ fontSize: 12 }}> · {c.parent_name}</span> : null}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{c.kind}</td>
                    <td className="r"><button className="ghost" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => restore(c)}>Restore</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editor && <CategoryEditor state={editor} groups={cats.filter((c) => c.parent_id === null && !c.archived_at)} onClose={() => setEditor(null)} onSaved={saved} />}
    </>
  );
}

function CategoryEditor({
  state, groups, onClose, onSaved,
}: {
  state: EditorState; groups: Category[]; onClose: () => void; onSaved: () => void;
}) {
  const existing = state.mode === 'edit' ? state.category : null;
  const isItem = state.mode === 'new-item' || (existing != null && existing.parent_id !== null);
  const fixedParent = state.mode === 'new-item' ? state.parent : null;

  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<'expense' | 'income'>(
    state.mode === 'new-group' ? state.kind : existing?.kind ?? 'expense'
  );
  const [parentId, setParentId] = useState<string>(
    fixedParent ? String(fixedParent.id) : existing?.parent_id != null ? String(existing.parent_id) : ''
  );
  const [err, setErr] = useState('');
  const dirty = useDirty({ name, kind, parentId });

  const title =
    state.mode === 'new-group' ? `Add ${state.kind === 'income' ? 'Income' : 'Expense'} Group`
      : state.mode === 'new-item' ? `Add Item · ${state.parent.name}`
        : existing!.parent_id == null ? 'Edit Group' : 'Edit Item';

  const save = async () => {
    if (!name.trim()) { setErr('Name is required.'); return; }
    try {
      if (state.mode === 'new-group') {
        await api.post('/categories', { name: name.trim(), kind });
      } else if (state.mode === 'new-item') {
        await api.post('/categories', { name: name.trim(), parent_id: state.parent.id });
      } else if (isItem) {
        if (!parentId) { setErr('Pick a group for this item.'); return; }
        await api.put(`/categories/${existing!.id}`, { name: name.trim(), parent_id: Number(parentId) });
      } else {
        // editing a group
        await api.put(`/categories/${existing!.id}`, { name: name.trim(), kind, parent_id: null });
      }
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <Modal title={title} onClose={onClose}>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}
      <Field label="Name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={isItem ? 'e.g. Electricity' : 'e.g. Utilities'} />
      </Field>

      {/* New groups inherit their column's kind (income vs expense), so no chooser.
          Editing an existing group still lets you switch its type. */}
      {existing != null && existing.parent_id == null && (
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </Field>
      )}
      {existing != null && existing.parent_id == null && existing.has_children && (
        <div className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>
          Changing the type updates all items in this group.
        </div>
      )}

      {/* Reparenting an existing item */}
      {existing != null && existing.parent_id != null && (
        <Field label="Group">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.kind})</option>)}
          </select>
        </Field>
      )}
      {existing != null && existing.parent_id != null && (
        <div className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>
          Moving to another group sets this item’s type to match that group.
        </div>
      )}

      <EditorFooter onClose={onClose} onSave={save} saveLabel={state.mode === 'edit' ? 'Save Changes' : 'Add'} disabled={!dirty} />
    </Modal>
  );
}

interface UserTag { id: number; name: string; description?: string | null; archived: boolean; txn_count?: number }

// Free-form labels for transactions (e.g. a trip), managed alongside categories.
function TagsSection() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<UserTag[]>([]);
  const [vehicles, setVehicles] = useState<{ id: number; name: string; disposed_at?: string | null }[]>([]);
  const [properties, setProperties] = useState<{ id: number; name: string }[]>([]);
  const [subs, setSubs] = useState<{ id: number; name: string; status: string }[]>([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const load = () => api.get<UserTag[]>('/tags').then(setTags).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    // Vehicles, properties & subscriptions act as built-in ("auto-managed") tags —
    // managed on their own pages, but selectable on any transaction.
    api.get<typeof vehicles>('/vehicles').then(setVehicles).catch(() => {});
    api.get<typeof properties>('/properties').then(setProperties).catch(() => {});
    api.get<typeof subs>('/subscriptions').then(setSubs).catch(() => {});
  }, []);
  const activeVehicles = vehicles.filter((v) => !v.disposed_at);
  const activeSubs = subs.filter((s) => s.status !== 'canceled');

  const active = tags.filter((t) => !t.archived);
  const archived = tags.filter((t) => t.archived);

  // Commit the inline "Create tag" input. Blank cancels; a valid name creates the
  // tag and closes the input. On error (e.g. duplicate) we keep editing.
  const commitCreate = async () => {
    const n = name.trim();
    if (!n) { setCreating(false); return; }
    setErr('');
    try { await api.post('/tags', { name: n }); setName(''); setCreating(false); load(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div style={{ marginBottom: 22 }}>
      <div className="management-card">
        <div className="management-head">
          <div>
            <h2><span className="dot" style={{ background: 'var(--brass)' }} />Tags</h2>
            <div className="desc">Optional labels for trips, projects, events, or special tracking.</div>
          </div>
        </div>
        {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}

        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {creating ? (
            <input
              autoFocus
              className="tag-create-input"
              value={name}
              placeholder="Tag name (e.g. Hawaii 2026)"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitCreate(); }
                else if (e.key === 'Escape') { e.preventDefault(); setName(''); setCreating(false); }
              }}
            />
          ) : (
            <button type="button" className="tag-card create" title="Create a new tag" onClick={() => { setName(''); setCreating(true); }}>
              <span className="tc-name">+ Create tag</span>
              <span className="tc-count">New Label</span>
            </button>
          )}
          {active.map((t) => {
            const n = t.txn_count ?? 0;
            return (
              <button key={t.id} type="button" className="tag-card" title="Open tag — details, report & archive" onClick={() => setDetailId(t.id)}>
                <span className="tc-name">{t.name}</span>
                <span className="tc-count">{n} transaction{n === 1 ? '' : 's'}</span>
              </button>
            );
          })}
        </div>

        {archived.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button className="ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
            </button>
            {showArchived && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
                {archived.map((t) => {
                  const n = t.txn_count ?? 0;
                  return (
                    <button key={t.id} type="button" className="tag-card archived" title="Open tag — details, report & restore" onClick={() => setDetailId(t.id)}>
                      <span className="tc-name">{t.name}</span>
                      <span className="tc-count">{n} transaction{n === 1 ? '' : 's'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {(activeVehicles.length > 0 || properties.length > 0 || activeSubs.length > 0) && (
          <div style={{ marginTop: 16, background: 'var(--surface-alt)', border: '1px solid var(--hairline)', borderRadius: 'var(--radius)', padding: 14 }}>
            <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
              <div className="label" style={{ margin: 0 }}>Auto-managed tags</div>
              <span className="tag" title="Created and kept in sync automatically">Auto-managed</span>
              <span className="muted" style={{ fontSize: 12 }}>Tag any transaction to these. Managed on their own pages.</span>
            </div>
            {([
              { title: 'Properties', items: properties, to: (id: number) => `/properties/${id}` },
              { title: 'Subscriptions', items: activeSubs, to: () => '/subscriptions' },
              { title: 'Vehicles', items: activeVehicles, to: (id: number) => `/vehicles/${id}` },
            ] as const).filter((grp) => grp.items.length > 0).map((grp) => (
              <div key={grp.title} style={{ marginBottom: 12 }}>
                <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{grp.title} · {grp.items.length}</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  {grp.items.map((it) => (
                    <button key={`${grp.title}${it.id}`} type="button" className="tag-card auto" title={`${grp.title.slice(0, -1)} tag — open`} onClick={() => navigate(grp.to(it.id))}>
                      <span className="tc-name">{it.name}</span>
                      <span className="tc-count">Open →</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {detailId != null && (
        <TagDetailModal tagId={detailId} onClose={() => setDetailId(null)} onChanged={load} />
      )}
    </div>
  );
}

interface TagReport {
  tag: { id: number; name: string; description: string | null; archived: boolean };
  totals: { expense: number; income: number; lines: number; first_date: string | null; last_date: string | null };
  byCategory: { category_name: string | null; total: number; count: number }[];
  byMonth: { month: string; expense: number; income: number }[];
  transactions: { txn_id: number; txn_date: string | null; merchant: string | null; direction: string; account_name: string | null; amount: number; category_name: string | null }[];
  transactions_total: number;
}

const TAG_TXN_PAGE = 50;

// Editable details (name + description) plus a spending report for one tag.
function TagDetailModal({ tagId, onClose, onChanged }: { tagId: number; onClose: () => void; onChanged: () => void }) {
  const [report, setReport] = useState<TagReport | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseline, setBaseline] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [txnPage, setTxnPage] = useState(0);

  const loadReport = () => api.get<TagReport>(`/tags/${tagId}/report?limit=${TAG_TXN_PAGE}&offset=${txnPage * TAG_TXN_PAGE}`).then((r) => {
    setReport(r);
    setName(r.tag.name);
    setDescription(r.tag.description ?? '');
    setBaseline(JSON.stringify({ name: r.tag.name, description: r.tag.description ?? '' }));
  }).catch((e) => setErr(e.message));
  useEffect(() => { setTxnPage(0); }, [tagId]);          // a different tag starts at page 1
  useEffect(() => { loadReport(); }, [tagId, txnPage]);  // reload the current page

  const dirty = JSON.stringify({ name, description }) !== baseline;
  const saveDetails = async () => {
    if (!name.trim()) { setErr('A tag name is required.'); return; }
    setBusy(true); setErr('');
    try {
      await api.put(`/tags/${tagId}`, { name: name.trim(), description });
      setBaseline(JSON.stringify({ name: name.trim(), description }));
      onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggleArchive = async () => {
    if (!report) return;
    setBusy(true); setErr('');
    try { await api.put(`/tags/${tagId}`, { archived: !report.tag.archived }); onChanged(); await loadReport(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const t = report?.totals;
  const maxCat = report ? Math.max(1, ...report.byCategory.map((c) => Number(c.total))) : 1;
  const maxMonth = report ? Math.max(1, ...report.byMonth.map((m) => Number(m.expense))) : 1;

  return (
    <Modal title={report ? `Tag · ${report.tag.name}` : 'Tag'} onClose={onClose} wide>
      {err && <div className="error" style={{ marginBottom: 12 }}>{err}</div>}

      <div className="grid grid-2" style={{ alignItems: 'start', marginBottom: 16 }}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Details (what it's for, dates, who…)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Family trip to Maui, Jul 2026" />
        </Field>
      </div>

      {!report ? (
        <div className="empty">Loading report…</div>
      ) : t && t.lines === 0 ? (
        <div className="empty">No transactions tagged with “{report.tag.name}” yet. Apply it to transactions to see a report here.</div>
      ) : t && (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Total spent</div><div className="value debit">{money(t.expense)}</div></div>
            <div className="card stat"><div className="label">Transactions</div><div className="value">{t.lines}</div>
              {Number(t.income) > 0 && <div className="muted" style={{ fontSize: 11 }}>+{money(t.income)} income</div>}
            </div>
            <div className="card stat"><div className="label">Date range</div>
              <div className="value small">{t.first_date ? shortDate(t.first_date) : '—'}</div>
              <div className="muted" style={{ fontSize: 11 }}>{t.last_date ? `through ${shortDate(t.last_date)}` : ''}</div>
            </div>
          </div>

          <div className="label" style={{ marginBottom: 6 }}>Spending by category</div>
          <div className="card" style={{ padding: 0, marginBottom: 16 }}>
            <table className="ledger">
              <thead><tr><th>Category</th><th className="r">Count</th><th className="r">Total</th></tr></thead>
              <tbody>
                {report.byCategory.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <div>{c.category_name ?? <span className="muted">Uncategorized</span>}</div>
                      <div style={{ height: 4, marginTop: 4, borderRadius: 2, background: 'var(--brass)', opacity: 0.5, width: `${(Number(c.total) / maxCat) * 100}%`, minWidth: 2 }} />
                    </td>
                    <td className="r num muted">{c.count}</td>
                    <td className="r money num">{money(c.total)}</td>
                  </tr>
                ))}
                {report.byCategory.length === 0 && <tr><td colSpan={3}><div className="empty">No expense breakdown.</div></td></tr>}
              </tbody>
            </table>
          </div>

          {report.byMonth.length > 1 && (
            <>
              <div className="label" style={{ marginBottom: 6 }}>By month</div>
              <div className="card" style={{ padding: 0, marginBottom: 16 }}>
                <table className="ledger">
                  <thead><tr><th>Month</th><th className="r">Spent</th></tr></thead>
                  <tbody>
                    {report.byMonth.map((m) => (
                      <tr key={m.month}>
                        <td>
                          <div className="num">{m.month}</div>
                          <div style={{ height: 4, marginTop: 4, borderRadius: 2, background: 'var(--brass)', opacity: 0.5, width: `${(Number(m.expense) / maxMonth) * 100}%`, minWidth: 2 }} />
                        </td>
                        <td className="r money num">{money(m.expense)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="label" style={{ marginBottom: 6 }}>Transactions ({report.transactions_total})</div>
          <div className="card" style={{ padding: 0, maxHeight: 280, overflow: 'auto' }}>
            <table className="ledger">
              <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Account</th><th className="r">Amount</th></tr></thead>
              <tbody>
                {report.transactions.map((x) => (
                  <tr key={x.txn_id}>
                    <td className="num muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{x.txn_date ? shortDate(x.txn_date) : '—'}</td>
                    <td>{x.merchant || <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.category_name ?? '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.account_name ?? '—'}</td>
                    <td className={`r money num ${x.direction === 'income' ? 'credit' : 'debit'}`}>{money(x.direction === 'income' ? x.amount : -x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={txnPage}
            pageCount={Math.max(1, Math.ceil(report.transactions_total / TAG_TXN_PAGE))}
            total={report.transactions_total}
            start={txnPage * TAG_TXN_PAGE}
            count={report.transactions.length}
            onPage={setTxnPage}
          />
        </>
      )}

      <EditorFooter
        onClose={onClose}
        onSave={saveDetails}
        saveLabel="Save details"
        saving={busy}
        disabled={!dirty}
        extra={report && (
          <button className="ghost" onClick={toggleArchive} disabled={busy}>
            {report.tag.archived ? 'Restore' : 'Archive'}
          </button>
        )}
      />
    </Modal>
  );
}

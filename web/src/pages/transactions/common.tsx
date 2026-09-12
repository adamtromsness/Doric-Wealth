import { chip } from '../../components/txnFilters';
import type { Category } from '../../types';
import { byGroupOrder, byItemOrder } from './helpers';

// A multi-select pill row (like the account filter): "All" plus a toggle per
// option. Values are strings (the filter stores a comma-separated list).
// Previous / Next pager for a server-side-paginated list.
export function Pager({ page, pageCount, total, start, count, onPage, top }: {
  page: number; pageCount: number; total: number; start: number; count: number; onPage: (p: number) => void; top?: boolean;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', [top ? 'marginBottom' : 'marginTop']: 10 }}>
      <span className="muted num" style={{ fontSize: 13 }}>Showing {start + 1}–{start + count} of {total}</span>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="ghost" style={chip} disabled={page === 0} onClick={() => onPage(Math.max(0, page - 1))}>Previous</button>
        <span className="muted num" style={{ fontSize: 13 }}>Page {page + 1} of {pageCount}</span>
        <button className="ghost" style={chip} disabled={page >= pageCount - 1} onClick={() => onPage(Math.min(pageCount - 1, page + 1))}>Next</button>
      </div>
    </div>
  );
}

// Render category options grouped by their high-level category. Only leaf
// "items" are selectable; groups are <optgroup> labels.
export function categoryOptions(categories: Category[], kind?: 'expense' | 'income') {
  const groups = categories
    .filter((c) => c.parent_id === null && c.has_children && (!kind || c.kind === kind))
    .sort(byGroupOrder);
  const itemsOf = (groupId: number) =>
    categories.filter((c) => c.parent_id === groupId).sort(byItemOrder);
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.id} label={g.name}>
          {itemsOf(g.id).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
        </optgroup>
      ))}
    </>
  );
}

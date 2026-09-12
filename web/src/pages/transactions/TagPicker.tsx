import { type Tag, type TagKind, type Lookups, tagKey, nameFor } from './helpers';

export function TagPicker({ tags, onChange, lookups, compact }: { tags: Tag[]; onChange: (t: Tag[]) => void; lookups: Lookups; compact?: boolean }) {
  const has = (k: TagKind, id: number) => tags.some((t) => t.kind === k && t.ref_id === id);
  const add = (value: string) => {
    if (!value) return;
    const [kind, idStr] = value.split(':') as [TagKind, string];
    const ref_id = Number(idStr);
    if (has(kind, ref_id)) return;
    onChange([...tags, { kind, ref_id, name: nameFor(lookups, kind, ref_id) }]);
  };
  const remove = (t: Tag) => onChange(tags.filter((x) => tagKey(x) !== tagKey(t)));
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {tags.map((t) => (
        <span key={tagKey(t)} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {t.name ?? `#${t.ref_id}`}
          <span style={{ cursor: 'pointer', opacity: 0.7 }} onClick={() => remove(t)}>✕</span>
        </span>
      ))}
      <select value="" onChange={(e) => { add(e.target.value); e.target.value = ''; }} style={compact ? { width: 'auto', minWidth: 120 } : undefined}>
        <option value="">+ add tag…</option>
        {lookups.vehicles.some((v) => !v.disposed_at) && <optgroup label="Vehicles">{lookups.vehicles.filter((v) => !has('vehicle', v.id) && !v.disposed_at).map((v) => <option key={'v' + v.id} value={`vehicle:${v.id}`}>{v.name}</option>)}</optgroup>}
        {lookups.properties.length > 0 && <optgroup label="Properties">{lookups.properties.filter((p) => !has('property', p.id)).map((p) => <option key={'p' + p.id} value={`property:${p.id}`}>{p.name}</option>)}</optgroup>}
        {lookups.subscriptions.length > 0 && <optgroup label="Subscriptions">{lookups.subscriptions.filter((s) => !has('subscription', s.id)).map((s) => <option key={'s' + s.id} value={`subscription:${s.id}`}>{s.name}</option>)}</optgroup>}
        {lookups.tags.length > 0 && <optgroup label="Tags">{lookups.tags.filter((t) => !has('tag', t.id)).map((t) => <option key={'t' + t.id} value={`tag:${t.id}`}>{t.name}</option>)}</optgroup>}
      </select>
    </div>
  );
}

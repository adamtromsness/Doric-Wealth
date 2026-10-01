// Parses the repo's CHANGELOG.md (Keep a Changelog format, injected at build time as
// __APP_CHANGELOG__) into releases for the What's New page.

export interface ChangelogSection { title: string; items: string[] }
export interface Release { version: string; date: string | null; sections: ChangelogSection[] }

// "## [1.2.0] - 2026-10-01" or "## [Unreleased]"
const RELEASE_RE = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const ITEM_RE = /^[-*]\s+(.+)$/;

// Releases newest first, as written in the file. The preamble before the first
// release heading is skipped, and so are releases with no items (e.g. an empty
// Unreleased section).
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: ChangelogSection | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const r = RELEASE_RE.exec(line);
    if (r) {
      release = { version: r[1], date: r[2] ?? null, sections: [] };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release) continue;
    const s = SECTION_RE.exec(line);
    if (s) {
      section = { title: s[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const item = ITEM_RE.exec(line.trimStart());
    if (item) {
      if (!section) { section = { title: 'Changes', items: [] }; release.sections.push(section); }
      section.items.push(item[1]);
    } else if (line.trim() && section?.items.length && /^\s/.test(raw)) {
      // An indented continuation of the previous bullet.
      section.items[section.items.length - 1] += ' ' + line.trim();
    }
  }
  return releases
    .map((rel) => ({ ...rel, sections: rel.sections.filter((sec) => sec.items.length) }))
    .filter((rel) => rel.sections.length);
}

export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'issue'; number: number };

// Splits a bullet's text into the inline markup the changelog uses: **bold**,
// `code`, and #N issue references. Everything else stays plain text (rendered as
// text, never as HTML).
export function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|(^|[^\w&])#(\d+)\b/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let start = m.index;
    if (m[4] !== undefined) start += m[3].length; // keep the character before "#N" as text
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    if (m[1] !== undefined) parts.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) parts.push({ kind: 'code', text: m[2] });
    else parts.push({ kind: 'issue', number: Number(m[4]) });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

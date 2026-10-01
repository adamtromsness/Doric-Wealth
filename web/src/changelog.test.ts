import { describe, it, expect } from 'vitest';
import { parseChangelog, parseInline } from './changelog';

const MD = `# Changelog

Preamble text that is not a release.
- not a release item either

## [Unreleased]

## [1.2.0] - 2026-10-01

### Changed
- **Add Asset** opens a full page.
- A bullet that wraps
  onto a second line.

### Fixed
- Yearly cost fixed (#3).

## [1.0.0] - 2026-09-30

- An item with no section heading.

### Removed
`;

describe('parseChangelog', () => {
  it('parses releases newest first with dated sections and items', () => {
    const rs = parseChangelog(MD);
    expect(rs.map((r) => r.version)).toEqual(['1.2.0', '1.0.0']);
    expect(rs[0].date).toBe('2026-10-01');
    expect(rs[0].sections).toEqual([
      { title: 'Changed', items: ['**Add Asset** opens a full page.', 'A bullet that wraps onto a second line.'] },
      { title: 'Fixed', items: ['Yearly cost fixed (#3).'] },
    ]);
  });

  it('skips the preamble, empty releases, and empty sections; groups headless items', () => {
    const rs = parseChangelog(MD);
    expect(rs.find((r) => r.version === 'Unreleased')).toBeUndefined();
    expect(rs[1].sections).toEqual([{ title: 'Changes', items: ['An item with no section heading.'] }]);
  });

  it('keeps a non-empty Unreleased section, without a date', () => {
    const rs = parseChangelog('## [Unreleased]\n\n### Added\n- New thing\n');
    expect(rs).toEqual([{ version: 'Unreleased', date: null, sections: [{ title: 'Added', items: ['New thing'] }] }]);
  });

  it('parses the real CHANGELOG.md, including the running version', () => {
    const rs = parseChangelog(__APP_CHANGELOG__);
    expect(rs.length).toBeGreaterThan(0);
    expect(rs.some((r) => r.version === __APP_VERSION__)).toBe(true);
  });
});

describe('parseInline', () => {
  it('splits bold, code, and issue references, leaving the rest as text', () => {
    expect(parseInline('**Add Asset** uses `release.sh` (#3).')).toEqual([
      { kind: 'bold', text: 'Add Asset' },
      { kind: 'text', text: ' uses ' },
      { kind: 'code', text: 'release.sh' },
      { kind: 'text', text: ' (' },
      { kind: 'issue', number: 3 },
      { kind: 'text', text: ').' },
    ]);
  });

  it('handles an issue reference at the start and leaves non-references alone', () => {
    expect(parseInline('#12 and a#4 and &#39;')).toEqual([
      { kind: 'issue', number: 12 },
      { kind: 'text', text: ' and a#4 and &#39;' },
    ]);
  });

  it('returns plain text unchanged', () => {
    expect(parseInline('nothing special')).toEqual([{ kind: 'text', text: 'nothing special' }]);
  });
});

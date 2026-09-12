// Doric brand mark — a minimal, fluted Doric column. Abstract / iconic direction:
// a clean column glyph that doubles as the app icon, favicon, sidebar and header logo.
// Drawn in `currentColor` so it works white-on-navy (badge) or navy-on-light.

// Shared column geometry (viewBox 0 0 48 48, centred on 24,24): abacus slab, capital
// flare, five fluted shaft bars, base flare, and a wider plinth.
function ColumnGlyph() {
  const flutes = [10.5, 16.4, 22.3, 28.2, 34.1];
  return (
    <>
      <rect x="8" y="6" width="32" height="4" rx="1.4" />
      <rect x="10.5" y="10.6" width="27" height="2.6" rx="1" />
      {flutes.map((x) => (
        <rect key={x} x={x} y="13.8" width="3.4" height="20.4" rx="0.9" />
      ))}
      <rect x="10.5" y="34.8" width="27" height="2.6" rx="1" />
      <rect x="8" y="38" width="32" height="4" rx="1.4" />
    </>
  );
}

// The bare column glyph, inherits color from `currentColor`.
export function DoricMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="currentColor"
      className={className} role="img" aria-label="Doric" focusable="false">
      <ColumnGlyph />
    </svg>
  );
}

// The column inside a filled circle badge — primary app/brand mark.
export function DoricBadge({ size = 32, bg = 'var(--navy)', fg = '#ffffff', className }: {
  size?: number; bg?: string; fg?: string; className?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className}
      role="img" aria-label="Doric" focusable="false">
      <circle cx="24" cy="24" r="24" fill={bg} />
      <g transform="translate(9.12 9.12) scale(0.62)" fill={fg}>
        <ColumnGlyph />
      </g>
    </svg>
  );
}

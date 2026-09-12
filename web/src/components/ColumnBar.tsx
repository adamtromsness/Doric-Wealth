// "Columns as bar chart" — the Doric signature motif. A Recharts <Bar shape> that
// draws each vertical bar as a Doric column: a capital slab on top sitting over a
// (subtly fluted) shaft that runs to the baseline. Reads as classical structure
// while still being real data. Falls back to a plain rounded bar when a value is
// too short to render as a column.
//
// Usage:  <Bar dataKey="income" fill="var(--sage)" shape={<ColumnBar />} />
//   (drop the `radius` prop — the shape handles its own corners.)
export function ColumnBar(props: any) {
  const { x, y, width, height, fill } = props;
  if (!(height > 0) || !(width > 0)) return null;

  // Too small to read as a column — plain rounded bar.
  if (height < 14 || width < 7) {
    return <rect x={x} y={y} width={width} height={height} rx={Math.min(3, width / 2)} fill={fill} />;
  }

  const cap = Math.min(5, Math.round(height * 0.16));
  const over = Math.max(1.5, Math.round(width * 0.14)); // capital overhang
  const shaftY = y + cap + 1;
  const shaftH = Math.max(0, height - cap - 1); // shaft runs to the baseline (no base slab)
  // Flutes only when the shaft is wide enough to carry them.
  const flutes = width >= 18 ? [0.32, 0.5, 0.68] : width >= 12 ? [0.4, 0.6] : [];

  return (
    <g>
      <rect x={x - over} y={y} width={width + over * 2} height={cap} rx={1.2} fill={fill} />
      <rect x={x} y={shaftY} width={width} height={shaftH} fill={fill} />
      {flutes.map((f, i) => (
        <rect key={i} x={x + width * f - 0.5} y={shaftY + 1} width={1} height={Math.max(0, shaftH - 2)}
          fill="rgba(255,255,255,0.20)" />
      ))}
    </g>
  );
}

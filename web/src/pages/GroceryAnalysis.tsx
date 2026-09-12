import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, money, shortDate } from '../api';
import { CHART_COLORS, chartTooltip, AiOutput } from '../components/ui';
import { Pager } from './transactions/common';

interface Overview {
  total_spend: number; item_count: number; product_count: number; first_date: string | null; last_date: string | null;
  categories: string[]; by_category: { category: string; spend: number; items: number }[]; by_month: Record<string, any>[];
}
interface Product {
  name: string; brand: string | null; category: string | null; unit: string | null;
  purchases: number; total_qty: number; total_spend: number;
  avg_uom_price: number | null; first_uom_price: number | null; last_uom_price: number | null; last_purchased: string | null;
}
interface PricePoint { date: string; store: string | null; quantity: number; total_price: number; uom_price: number | null; size: number | null; unit: string | null }

const monthLabel = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
// Per-unit prices can be small ($0.102/oz) — show enough precision to be useful.
const uom = (n: number | null | undefined, unit: string | null): string =>
  n == null ? '—' : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}/${unit || 'unit'}`;
const pct = (first: number | null, last: number | null): number | null =>
  first == null || last == null || first === 0 ? null : ((last - first) / first) * 100;

const TOP_N = 7;
const PRODUCT_PAGE = 50;

export default function GroceryAnalysis() {
  const [months, setMonths] = useState(12);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productTotal, setProductTotal] = useState(0);
  const [productPage, setProductPage] = useState(0);
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [err, setErr] = useState('');

  // AI report
  const [report, setReport] = useState<string | null>(null);
  const [reportAt, setReportAt] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => { api.get<Overview>(`/receipt-items/overview?months=${months}`).then(setOverview).catch((e) => setErr(e.message)); }, [months]);
  useEffect(() => { setProductPage(0); }, [category]); // a different category starts at page 1
  useEffect(() => {
    const p = new URLSearchParams({ limit: String(PRODUCT_PAGE), offset: String(productPage * PRODUCT_PAGE) });
    if (category) p.set('category', category);
    api.get<{ products: Product[]; total: number }>(`/receipt-items/products?${p.toString()}`)
      .then((r) => { setProducts(r.products); setProductTotal(r.total); }).catch((e) => setErr(e.message));
  }, [category, productPage]);
  useEffect(() => {
    api.get<{ result: string; created_at: string }[]>('/analysis?kind=receipt_products')
      .then((rows) => { if (rows[0]) { setReport(rows[0].result); setReportAt(rows[0].created_at); } }).catch(() => {});
  }, []);

  const openProduct = (p: Product) => {
    setSelected(p); setHistory([]);
    api.get<PricePoint[]>(`/receipt-items/product?name=${encodeURIComponent(p.name)}`).then(setHistory).catch((e) => setErr(e.message));
  };
  const generateReport = async () => {
    setReporting(true); setErr('');
    try {
      const r = await api.post<{ result: string }>('/analysis/products', {});
      setReport(r.result); setReportAt(new Date().toISOString());
    } catch (e: any) { setErr(e.message); } finally { setReporting(false); }
  };

  // Stacked-area data: keep the top categories, lump the rest into "Other" so colors don't run out.
  const { areaData, seriesKeys } = useMemo(() => {
    if (!overview) return { areaData: [] as any[], seriesKeys: [] as string[] };
    const top = overview.categories.slice(0, TOP_N);
    const hasOther = overview.categories.length > TOP_N;
    const data = overview.by_month.map((m) => {
      const row: any = { month: m.month };
      let other = 0;
      for (const c of overview.categories) { const v = m[c] ?? 0; if (top.includes(c)) row[c] = v; else other += v; }
      if (hasOther) row.Other = other;
      return row;
    });
    return { areaData: data, seriesKeys: hasOther ? [...top, 'Other'] : top };
  }, [overview]);

  const empty = overview && overview.item_count === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Insights</div>
          <h1 className="title">Grocery Insights</h1>
          <p className="subtitle">Spending broken down to the individual item, from your scanned receipts.</p>
        </div>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={{ width: 'auto', alignSelf: 'center' }}>
          <option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option>
          <option value={24}>Last 24 months</option>
        </select>
      </div>

      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      {empty ? (
        <div className="card">
          <div className="label" style={{ marginBottom: 6 }}>No itemized receipts yet</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            Attach a receipt to a transaction and use <strong>Scan receipt</strong> (or <strong>Fill Details with AI</strong>) to capture its line items.
            Once items are saved with categories and sizes, this page fills in with spending breakdowns and per-item price trends.
          </p>
        </div>
      ) : overview && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <div className="card stat"><div className="label">Item Spend</div><div className="value">{money(overview.total_spend)}</div></div>
            <div className="card stat"><div className="label">Distinct Products</div><div className="value">{overview.product_count.toLocaleString()}</div></div>
            <div className="card stat"><div className="label">Items Logged</div><div className="value small">{overview.item_count.toLocaleString()}</div></div>
            <div className="card stat"><div className="label">Tracked Since</div><div className="value small">{overview.first_date ? shortDate(overview.first_date) : '—'}</div></div>
          </div>

          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="label" style={{ marginBottom: 6 }}>Spend Over Time</div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={areaData} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={monthLabel} minTickGap={24} />
                    <YAxis tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => '$' + Math.round(v)} />
                    <Tooltip formatter={(v: number, n: string) => [money(v), n]} labelFormatter={monthLabel} contentStyle={chartTooltip} />
                    {seriesKeys.map((k, i) => (
                      <Area key={k} type="monotone" dataKey={k} stackId="1" stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.85} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <div className="label" style={{ marginBottom: 6 }}>Spend by Category</div>
              <div style={{ height: 240 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={overview.by_category.slice(0, 10)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                    <XAxis type="number" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(v) => '$' + Math.round(v)} />
                    <YAxis type="category" dataKey="category" width={130} tick={{ fontSize: 11, fill: '#23262B' }} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: number) => [money(v), 'Spend']} contentStyle={chartTooltip} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                    <Bar dataKey="spend" radius={[0, 4, 4, 0]}>
                      {overview.by_category.slice(0, 10).map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className="label" style={{ margin: 0 }}>Top Products ({productTotal.toLocaleString()})</div>
              <select value={category} onChange={(e) => { setCategory(e.target.value); setSelected(null); }} style={{ width: 'auto' }}>
                <option value="">All categories</option>
                {overview.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Product</th><th>Brand</th><th>Category</th>
                  <th className="r">Bought</th><th className="r">Spend</th><th className="r">Avg $/unit</th><th className="r">Price Δ</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const ch = pct(p.first_uom_price, p.last_uom_price);
                  return (
                    <tr key={p.name} className="clickable" onClick={() => openProduct(p)}>
                      <td>{p.name}</td>
                      <td className="muted">{p.brand || '—'}</td>
                      <td className="muted">{p.category || '—'}</td>
                      <td className="r num">{p.purchases}×</td>
                      <td className="r num">{money(p.total_spend)}</td>
                      <td className="r num muted">{uom(p.avg_uom_price, p.unit)}</td>
                      <td className="r num" style={{ color: ch == null ? 'var(--ink-soft)' : ch > 0 ? 'var(--debit)' : 'var(--credit)' }}>
                        {ch == null ? '—' : `${ch > 0 ? '+' : ''}${ch.toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
                {products.length === 0 && <tr><td colSpan={7} className="muted">No products in this category yet.</td></tr>}
              </tbody>
            </table>
            <Pager
              page={productPage}
              pageCount={Math.max(1, Math.ceil(productTotal / PRODUCT_PAGE))}
              total={productTotal}
              start={productPage * PRODUCT_PAGE}
              count={products.length}
              onPage={setProductPage}
            />
          </div>

          {selected && (
            <div className="card" style={{ marginBottom: 16, background: 'var(--surface-alt)' }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{selected.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {selected.brand ? `${selected.brand} · ` : ''}{selected.category || 'Uncategorized'} · bought {selected.purchases}× · {money(selected.total_spend)} total
                  </div>
                </div>
                <button className="ghost" onClick={() => setSelected(null)}>Close</button>
              </div>
              {history.some((h) => h.uom_price != null) ? (
                <div style={{ height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={history} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                      <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} tickFormatter={(d) => shortDate(d)} minTickGap={28} />
                      <YAxis tick={{ fontSize: 11, fill: '#767C85' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => '$' + Number(v).toFixed(2)} domain={['auto', 'auto']} />
                      <Tooltip formatter={(v: number) => [uom(v, selected.unit), 'Unit price']} labelFormatter={(l) => shortDate(l as string)} contentStyle={chartTooltip} />
                      <Line type="monotone" dataKey="uom_price" stroke="#6B7F6E" strokeWidth={2} dot={{ r: 2.5 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>No per-unit price history (items need a size to compute price per unit).</p>
              )}
              <table className="ledger" style={{ marginTop: 10 }}>
                <thead><tr><th>Date</th><th>Store</th><th className="r">Qty</th><th className="r">Paid</th><th className="r">$/unit</th></tr></thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={i}>
                      <td>{shortDate(h.date)}</td>
                      <td className="muted">{h.store || '—'}</td>
                      <td className="r num">{h.quantity}{h.size ? ` × ${h.size}${h.unit || ''}` : ''}</td>
                      <td className="r num">{money(h.total_price)}</td>
                      <td className="r num muted">{uom(h.uom_price, h.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className="label" style={{ margin: 0 }}>AI Spending Report</div>
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                {reportAt && <span className="muted" style={{ fontSize: 12 }}>Last run {shortDate(reportAt)}</span>}
                <button onClick={generateReport} disabled={reporting}>{reporting ? 'Analyzing…' : report ? 'Re-run' : 'Generate Report'}</button>
              </div>
            </div>
            {report ? <AiOutput markdown={report} /> : <p className="muted" style={{ fontSize: 13 }}>Generate an AI analysis of your item spending — big drivers, price changes, and concrete ways to save.</p>}
          </div>
        </>
      )}
    </>
  );
}

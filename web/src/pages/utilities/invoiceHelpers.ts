import { todayStr, parseLocalDate } from '../../api';
import { cap } from '../../components/ui';

// How many months one billing cycle covers, for normalizing to a monthly cost.
export const cycleMonths = (c: string) => (c === 'yearly' ? 12 : c === 'quarterly' ? 3 : 1);

export const TYPES = ['electricity', 'gas', 'water', 'sewer', 'trash', 'internet', 'phone', 'other'];
export const UNIT_HINT: Record<string, string> = { electricity: 'kWh', gas: 'therms', water: 'gallons', sewer: 'gallons', internet: 'GB', phone: 'GB' };
export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly'];

export interface Property { id: number; name: string }
// How a utility bill was paid (same values as a transaction's channel).
export const PAY_CHANNELS: [string, string][] = [
  ['online', 'Online'], ['check', 'Check'], ['mail', 'Mail'], ['phone', 'Phone'], ['in_store', 'In-store'],
];
export const INVOICE_PAGE = 25;
export interface BankAccount { id: number; name: string; type?: string; archived_at?: string | null }

// Account types you obviously can't pay a utility bill from (investments, debts,
// non-cash assets). Everything else (checking/savings/credit card/cash/etc.) is fine.
const NON_PAYABLE_TYPES = new Set(['investment', 'retirement', '529', 'brokerage', 'crypto', 'asset', 'loan', 'mortgage', 'cd', 'hsa', 'fsa']);
export const isPayableFrom = (a: BankAccount) => !a.archived_at && !NON_PAYABLE_TYPES.has(a.type ?? '');

export interface UtilAccount {
  id: number; name: string; provider: string | null; utility_type: string; billing_cycle: string;
  account_number: string | null; property_id: number | null; property_name: string | null;
  due_day: number | null; usage_unit: string | null; notes: string | null;
  login_url: string | null; login_id: string | null;
  is_autopay: boolean; payment_method: string | null; meter_number: string | null;
  provider_phone: string | null; account_holder: string | null; rate_plan: string | null;
  provider_url: string | null; autopay_day: number | null; payment_plan: 'actual' | 'average';
  payment_account_id: number | null; payment_account_name: string | null;
  status: 'active' | 'canceled'; end_date: string | null;
  total_billed: number; invoice_count: number; unpaid_amount: number; unpaid_count: number;
}

export const isDisabledUtil = (a: UtilAccount) => a.status === 'canceled';
export const PAYMENT_PLANS: [string, string][] = [['actual', 'Actual Usage'], ['average', 'Average (Budget Billing)']];
export const paymentPlanLabel = (p: string | null | undefined) => PAYMENT_PLANS.find(([v]) => v === p)?.[1] ?? 'Actual Usage';

// One billed period for an account: the account's share of an invoice's amount and
// usage, dated by invoice/period/due date. Oldest → newest.
export interface BillPoint { date: string; amount: number; usage: number | null }
export function accountSeries(invoices: Invoice[], acctId: number): BillPoint[] {
  const pts: BillPoint[] = [];
  for (const inv of invoices) {
    const lines = inv.lines.filter((l) => l.utility_account_id === acctId);
    if (!lines.length) continue;
    const amount = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    const usageLines = lines.filter((l) => l.usage_quantity != null);
    const usage = usageLines.length ? usageLines.reduce((s, l) => s + Number(l.usage_quantity || 0), 0) : null;
    const date = (inv.invoice_date || inv.period_end || inv.due_date || '').slice(0, 10);
    if (date) pts.push({ date, amount, usage });
  }
  return pts.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface BillStats {
  count: number; average: number; last: number | null; prev: number | null;
  highest: number | null; lowest: number | null; ytd: number; trailing12: number;
  costPerUnit: number | null; avgUsage: number | null;
}
export function billStats(series: BillPoint[]): BillStats {
  const amts = series.map((p) => p.amount);
  const count = amts.length;
  const thisYear = todayStr().slice(0, 4);
  const d = parseLocalDate(todayStr()); d.setFullYear(d.getFullYear() - 1);
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const usagePts = series.filter((p) => p.usage != null && p.usage > 0);
  const totalUsage = usagePts.reduce((s, p) => s + (p.usage || 0), 0);
  const usageAmt = usagePts.reduce((s, p) => s + p.amount, 0);
  return {
    count,
    average: count ? amts.reduce((s, a) => s + a, 0) / count : 0,
    last: count ? series[count - 1].amount : null,
    prev: count > 1 ? series[count - 2].amount : null,
    highest: count ? Math.max(...amts) : null,
    lowest: count ? Math.min(...amts) : null,
    ytd: series.filter((p) => p.date.slice(0, 4) === thisYear).reduce((s, p) => s + p.amount, 0),
    trailing12: series.filter((p) => p.date >= cutoff).reduce((s, p) => s + p.amount, 0),
    costPerUnit: totalUsage > 0 ? usageAmt / totalUsage : null,
    avgUsage: usagePts.length ? totalUsage / usagePts.length : null,
  };
}

export { normalizeUrl } from '../../api';
export interface InvoiceLine {
  id?: number; utility_account_id: number | null; account_name: string | null; utility_type: string | null;
  description: string | null; amount: number; usage_quantity: number | null; usage_unit: string | null; notes: string | null;
}
export interface Invoice {
  id: number; provider: string | null; invoice_date: string | null;
  period_start: string | null; period_end: string | null; due_date: string | null;
  paid: boolean; paid_date: string | null; notes: string | null; channel: string | null;
  category_id: number | null; account_id: number | null; category_name: string | null; account_name: string | null;
  transaction_id: number | null; lines: InvoiceLine[]; total: number; late_total: number | null; amount_paid: number;
  has_file?: boolean; file_mime?: string | null; file_name?: string | null;
}
// The invoice's headline amount: late total once overdue, otherwise the on-time total.
export const invoiceBase = (inv: Invoice) => (inv.late_total != null && isOverdue(inv)) ? Number(inv.late_total) : inv.total;
// Outstanding balance after any partial payments.
export const amountOwed = (inv: Invoice) => Math.max(0, invoiceBase(inv) - Number(inv.amount_paid || 0));
// Partly paid but not yet settled.
export const isPartial = (inv: Invoice) => !inv.paid && Number(inv.amount_paid || 0) > 0.005;
export const lineLabel = (l: InvoiceLine) => l.description || l.account_name || (l.utility_type ? cap(l.utility_type) : '') || 'charge';

export const ordinal = (n: number) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
export const isOverdue = (inv: Invoice) => !inv.paid && inv.due_date != null && parseLocalDate(inv.due_date) < parseLocalDate(todayStr());
// Whole days from today until a due date (negative = past due).
const daysUntilDue = (d: string) => Math.round((parseLocalDate(d).getTime() - parseLocalDate(todayStr()).getTime()) / 86400000);
export const dueLabel = (d: string | null) => {
  if (!d) return '—';
  const n = daysUntilDue(d);
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} overdue`;
  if (n === 0) return 'due today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
};

// Average billed amount per account (per invoice). Used to estimate a typical
// monthly cost given each account's billing cycle. Shared by the list and the
// per-account detail page.
export function avgBilledPerAccount(invoices: Invoice[]): Map<number, number> {
  const agg = new Map<number, { total: number; count: number }>();
  for (const inv of invoices) {
    const per = new Map<number, number>();
    for (const l of inv.lines) if (l.utility_account_id != null) per.set(l.utility_account_id, (per.get(l.utility_account_id) ?? 0) + Number(l.amount || 0));
    for (const [aid, amt] of per) {
      const e = agg.get(aid) ?? { total: 0, count: 0 };
      e.total += amt; e.count += 1; agg.set(aid, e);
    }
  }
  const avg = new Map<number, number>();
  for (const [aid, e] of agg) avg.set(aid, e.count ? e.total / e.count : 0);
  return avg;
}
export const estimatedMonthly = (a: UtilAccount, avg: Map<number, number>) => (avg.get(a.id) ?? 0) / cycleMonths(a.billing_cycle);

// Does an invoice include a line tied to this utility account?
export const invoiceHasAccount = (inv: Invoice, acctId: number) => inv.lines.some((l) => l.utility_account_id === acctId);

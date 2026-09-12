import { Router } from 'express';
import { query } from '../db.js';
import { ah } from '../http.js';
import { hh } from '../tenant.js';

export const reminders = Router();

interface Reminder {
  source: string;   // subscription | utility | account | insurance | maintenance | lease
  kind: string;     // renewal | bill_due | payment_due | insurance_renewal | maintenance | lease_end | cancels | closes
  title: string;
  subtitle: string | null;
  date: string;     // YYYY-MM-DD
  amount: number | null;
  link: string;
}

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

// Next calendar date landing on `day` (1–31), today or later.
function nextByDay(day: number): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const y = today.getFullYear(), m = today.getMonth();
  let d = new Date(y, m, Math.min(day, daysInMonth(y, m)));
  if (d < today) d = new Date(y, m + 1, Math.min(day, daysInMonth(y, m + 1)));
  return d.toISOString().slice(0, 10);
}

// Aggregated upcoming obligations across every module — the single place a user
// can see what's coming due. Returns items from ~30 days overdue to 60 days out.
reminders.get(
  '/',
  ah(async (req, res) => {
    const bookId = hh(req);
    const out: Reminder[] = [];

    // Subscriptions: renewals + scheduled cancellations.
    for (const s of await query<any>(
      `SELECT id, name, amount, to_char(next_due_date,'YYYY-MM-DD') AS next_due_date,
              to_char(end_date,'YYYY-MM-DD') AS end_date, status
       FROM subscriptions WHERE book_id = $1`, [bookId])) {
      if (s.status === 'active' && s.next_due_date) out.push({ source: 'subscription', kind: 'renewal', title: s.name, subtitle: 'Subscription renews', date: s.next_due_date, amount: Number(s.amount), link: `/subscriptions/${s.id}` });
      if (s.status !== 'canceled' && s.end_date) out.push({ source: 'subscription', kind: 'cancels', title: s.name, subtitle: 'Subscription cancels', date: s.end_date, amount: null, link: `/subscriptions/${s.id}` });
    }

    // Utility accounts: next bill (by due day) + scheduled cancellations.
    for (const u of await query<any>(
      `SELECT id, name, due_day, status, to_char(end_date,'YYYY-MM-DD') AS end_date
       FROM utility_accounts WHERE book_id = $1`, [bookId])) {
      if (u.status === 'active' && u.due_day != null) out.push({ source: 'utility', kind: 'bill_due', title: u.name, subtitle: 'Utility bill due', date: nextByDay(u.due_day), amount: null, link: `/utilities/${u.id}` });
      if (u.status !== 'canceled' && u.end_date) out.push({ source: 'utility', kind: 'cancels', title: u.name, subtitle: 'Service cancels', date: u.end_date, amount: null, link: `/utilities/${u.id}` });
    }

    // Accounts: payment due (by due day, liabilities) + scheduled closures.
    for (const a of await query<any>(
      `SELECT id, name, due_day, is_liability, archived_at, to_char(closed_at,'YYYY-MM-DD') AS closed_at
       FROM accounts WHERE book_id = $1 AND archived_at IS NULL`, [bookId])) {
      if (a.is_liability && a.due_day != null && !a.closed_at) out.push({ source: 'account', kind: 'payment_due', title: a.name, subtitle: 'Payment due', date: nextByDay(a.due_day), amount: null, link: `/accounts/${a.id}` });
      if (a.closed_at) out.push({ source: 'account', kind: 'closes', title: a.name, subtitle: 'Account closes', date: a.closed_at, amount: null, link: `/accounts/${a.id}` });
    }

    // Insurance renewals (vehicle + property + asset).
    const insLink: Record<string, string> = { vehicle: 'vehicles', property: 'properties', asset: 'other-assets' };
    for (const p of await query<any>(
      `SELECT ip.entity_kind, ip.entity_id, ip.policy_type, ip.carrier, ip.premium,
              to_char(ip.renewal_date,'YYYY-MM-DD') AS renewal_date, v.name AS vname, pr.name AS pname, ast.name AS aname
       FROM insurance_policies ip
       LEFT JOIN vehicles v    ON ip.entity_kind = 'vehicle'  AND v.id   = ip.entity_id
       LEFT JOIN properties pr ON ip.entity_kind = 'property' AND pr.id  = ip.entity_id
       LEFT JOIN assets ast    ON ip.entity_kind = 'asset'    AND ast.id = ip.entity_id
       WHERE ip.book_id = $1 AND ip.renewal_date IS NOT NULL`, [bookId])) {
      const name = p.vname || p.pname || p.aname || 'Insurance';
      out.push({ source: 'insurance', kind: 'insurance_renewal', title: name, subtitle: `${p.policy_type || 'Insurance'}${p.carrier ? ` · ${p.carrier}` : ''} renews`, date: p.renewal_date, amount: p.premium != null ? Number(p.premium) : null, link: `/${insLink[p.entity_kind] || 'other-assets'}/${p.entity_id}` });
    }

    // Upcoming maintenance (vehicle + property).
    for (const m of await query<any>(
      `SELECT m.item, to_char(m.due_date,'YYYY-MM-DD') AS due_date, v.id AS vid, v.name AS vname
       FROM vehicle_maintenance m JOIN vehicles v ON v.id = m.vehicle_id
       WHERE m.book_id = $1 AND m.status = 'upcoming' AND m.due_date IS NOT NULL`, [bookId])) {
      out.push({ source: 'maintenance', kind: 'maintenance', title: m.vname, subtitle: `Maintenance: ${m.item}`, date: m.due_date, amount: null, link: `/vehicles/${m.vid}` });
    }
    for (const m of await query<any>(
      `SELECT m.item, to_char(m.due_date,'YYYY-MM-DD') AS due_date, p.id AS pid, p.name AS pname
       FROM property_maintenance m JOIN properties p ON p.id = m.property_id
       WHERE m.book_id = $1 AND m.status = 'upcoming' AND m.due_date IS NOT NULL`, [bookId])) {
      out.push({ source: 'maintenance', kind: 'maintenance', title: m.pname, subtitle: `Maintenance: ${m.item}`, date: m.due_date, amount: null, link: `/properties/${m.pid}` });
    }
    for (const m of await query<any>(
      `SELECT m.item, to_char(m.due_date,'YYYY-MM-DD') AS due_date, a.id AS aid, a.name AS aname
       FROM asset_maintenance m JOIN assets a ON a.id = m.asset_id
       WHERE m.book_id = $1 AND m.status = 'upcoming' AND m.due_date IS NOT NULL`, [bookId])) {
      out.push({ source: 'maintenance', kind: 'maintenance', title: m.aname, subtitle: `Maintenance: ${m.item}`, date: m.due_date, amount: null, link: `/other-assets/${m.aid}` });
    }

    // Property leases ending.
    for (const p of await query<any>(
      `SELECT id, name, to_char(lease_end,'YYYY-MM-DD') AS lease_end FROM properties
       WHERE book_id = $1 AND is_rental AND disposed_at IS NULL AND lease_end IS NOT NULL`, [bookId])) {
      out.push({ source: 'lease', kind: 'lease_end', title: p.name, subtitle: 'Lease ends', date: p.lease_end, amount: null, link: `/properties/${p.id}` });
    }

    // Window: ~30 days overdue through 60 days out, soonest first.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const lo = new Date(today); lo.setDate(lo.getDate() - 30);
    const hi = new Date(today); hi.setDate(hi.getDate() + 60);
    const inWindow = out.filter((r) => { const d = new Date(r.date + 'T00:00:00'); return d >= lo && d <= hi; });
    inWindow.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    res.json(inWindow);
  })
);

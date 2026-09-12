// The To-Do "action center": a Set-up checklist (onboarding) and live Needs-attention
// items. Everything is COMPUTED from current state — the only thing persisted is which
// optional setup items a book has dismissed (books.dismissed_setup_tasks), so
// the list can never drift from reality. The "Upcoming" tier lives in /reminders.
import { Router } from 'express';
import { query, one } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh } from '../tenant.js';

export const todos = Router();

todos.get('/', ah(async (req, res) => {
  const bookId = hh(req);
  const userId = req.user?.id ?? 0;

  const c = await one<any>(`
    SELECT
      (SELECT count(*) FROM accounts            WHERE book_id = $1) AS accounts,
      (SELECT count(*) FROM transactions        WHERE book_id = $1) AS transactions,
      (SELECT count(*) FROM institution_links   WHERE book_id = $1) AS connections,
      (SELECT count(*) FROM properties WHERE book_id = $1)
        + (SELECT count(*) FROM vehicles WHERE book_id = $1)
        + (SELECT count(*) FROM assets   WHERE book_id = $1) AS owned_assets,
      (SELECT count(*) FROM budgets WHERE book_id = $1)
        + (SELECT count(*) FROM goals WHERE book_id = $1) AS plans,
      (SELECT count(*) FROM tags WHERE book_id = $1) AS tags,
      (SELECT count(*) FROM transactions t WHERE t.book_id = $1 AND t.category_id IS NULL AND t.direction <> 'transfer'
         AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.category_id IS NOT NULL)) AS uncategorized,
      (SELECT count(*) FROM staged_transactions WHERE book_id = $1 AND decision = 'import') AS staged,
      (SELECT count(*) FROM account_links WHERE book_id = $1 AND account_id IS NULL) AS unmapped,
      (SELECT count(*) FROM institution_links WHERE book_id = $1 AND status = 'error') AS sync_errors,
      (SELECT dismissed_setup_tasks FROM books WHERE id = $1) AS dismissed
  `, [bookId]);

  const aiKeySet = !!(await one(`SELECT 1 FROM users WHERE id = $1 AND ai_api_key IS NOT NULL AND btrim(ai_api_key) <> ''`, [userId]));
  const dismissed: string[] = Array.isArray(c?.dismissed) ? c.dismissed : [];
  const n = (v: any) => Number(v || 0);
  const plural = (k: number) => (k === 1 ? '' : 's');

  const setup = [
    { key: 'account',      title: 'Add your first account',                  description: 'Checking, savings, credit cards, loans — the foundation of your ledger.', link: '/accounts',     dismissible: false, done: n(c?.accounts) > 0 },
    { key: 'transactions', title: 'Add or import transactions',              description: 'Type them in, import a CSV, or connect a bank below.',                     link: '/transactions', dismissible: false, done: n(c?.transactions) > 0 },
    { key: 'bank',         title: 'Connect a bank for automatic import',     description: 'Link accounts through SimpleFIN so transactions flow in automatically.',  link: '/account',      dismissible: true,  done: n(c?.connections) > 0 },
    { key: 'ai_key',       title: 'Add your AI key (analysis & scanning)',   description: 'Enables receipt/invoice scanning, value estimates, and Q&A over your data.', link: '/account',      dismissible: true,  done: aiKeySet },
    { key: 'assets',       title: 'Add a property, vehicle, or other asset', description: 'Track what you own toward your net worth.',                               link: '/assets',       dismissible: true,  done: n(c?.owned_assets) > 0 },
    { key: 'plan',         title: 'Set a budget or savings goal',            description: 'Give your spending and saving a target.',                                 link: '/budgets',      dismissible: true,  done: n(c?.plans) > 0 },
    { key: 'tags',         title: 'Create tags to group your spending',      description: 'Tag transactions by trip, project, vehicle, or anything you like.',       link: '/categories',   dismissible: true,  done: n(c?.tags) > 0 },
  ].map((s) => ({ ...s, dismissed: dismissed.includes(s.key) }));

  const attention: any[] = [];
  if (n(c?.uncategorized) > 0) attention.push({ kind: 'uncategorized', title: `Categorize ${n(c.uncategorized)} transaction${plural(n(c.uncategorized))}`, count: n(c.uncategorized), link: '/transactions?uncategorized=1', severity: 'warn' });
  if (n(c?.staged) > 0)        attention.push({ kind: 'review',        title: `Review ${n(c.staged)} imported transaction${plural(n(c.staged))}`,             count: n(c.staged),        link: '/transactions', severity: 'warn' });
  if (n(c?.unmapped) > 0)      attention.push({ kind: 'unmapped',      title: `Map ${n(c.unmapped)} connected bank account${plural(n(c.unmapped))}`,             count: n(c.unmapped),      link: '/account',      severity: 'info' });
  if (n(c?.sync_errors) > 0)   attention.push({ kind: 'sync_error',    title: 'A linked connection needs attention',                                            count: n(c.sync_errors),   link: '/account',      severity: 'debit' });

  // Open setup items = not yet done and not dismissed.
  const setupOpen = setup.filter((s) => !s.done && !s.dismissed).length;
  res.json({ setup, attention, setupOpen, attentionCount: attention.length });
}));

// Hide an optional setup item the user doesn't want.
todos.post('/dismiss', ah(async (req, res) => {
  const bookId = hh(req);
  const key = String(req.body?.key ?? '').trim();
  if (!key) throw new HttpError(400, 'A task key is required.');
  await query(
    `UPDATE books
        SET dismissed_setup_tasks = (
          SELECT to_jsonb(array_agg(DISTINCT x))
          FROM jsonb_array_elements_text(dismissed_setup_tasks || to_jsonb($2::text)) AS x
        )
      WHERE id = $1`,
    [bookId, key]
  );
  res.json({ ok: true });
}));

// Restore a previously dismissed setup item.
todos.post('/undismiss', ah(async (req, res) => {
  const bookId = hh(req);
  const key = String(req.body?.key ?? '').trim();
  if (!key) throw new HttpError(400, 'A task key is required.');
  await query(
    `UPDATE books
        SET dismissed_setup_tasks = COALESCE(
          (SELECT to_jsonb(array_agg(x)) FROM jsonb_array_elements_text(dismissed_setup_tasks) AS x WHERE x <> $2),
          '[]'::jsonb
        )
      WHERE id = $1`,
    [bookId, key]
  );
  res.json({ ok: true });
}));

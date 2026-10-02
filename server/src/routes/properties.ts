import { Router } from 'express';
import { query, one, withTransaction, withBookContext, pool } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { ask, AiNotConfiguredError } from '../ai/claude.js';
import { resolveRentcastKey, rentcastValue, fullAddress } from '../rentcast.js';
import { EFFECTIVE_LINES, EFFECTIVE_LINE_TAGS, ACCOUNT_BALANCES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import { mountInsuranceRoutes } from './insuranceRoutes.js';
import {
  requiredString, optionalEnumValue, optionalMoney, optionalNumber, optionalDateOnly, optionalBoolean,
  optionalString, booleanValue, ownedRef, integerId,
  PROPERTY_TYPES, PROPERTY_DISPOSAL_TYPES,
} from '../validation.js';

const MAINTENANCE_STATUSES = ['completed', 'upcoming'] as const;

export const properties = Router();

// Insurance policies (carrier, premium, renewal, agent) — shared with vehicles.
mountInsuranceRoutes(properties, 'property', ownedProperty);

// Value-field validation shared by create/update (throws a clean 400 on bad input).
function validateProperty(b: any): void {
  optionalEnumValue(b.property_type, 'property_type', PROPERTY_TYPES);
  optionalMoney(b.purchase_price, 'purchase_price');
  optionalMoney(b.current_value, 'current_value');
  optionalMoney(b.mortgage_balance, 'mortgage_balance');
  optionalNumber(b.lot_size_acres, 'lot_size_acres'); // NUMERIC(12,3): acres, not money
  optionalMoney(b.rental_income, 'rental_income');
  optionalMoney(b.security_deposit, 'security_deposit');
  optionalMoney(b.year_built, 'year_built');
  optionalMoney(b.square_feet, 'square_feet');
  optionalMoney(b.bedrooms, 'bedrooms');
  optionalMoney(b.bathrooms, 'bathrooms');
  optionalMoney(b.stories, 'stories');
  optionalMoney(b.garage_spaces, 'garage_spaces');
  optionalDateOnly(b.purchase_date, 'purchase_date');
  optionalDateOnly(b.lease_start, 'lease_start');
  optionalDateOnly(b.lease_end, 'lease_end');
  optionalBoolean(b.is_rental, 'is_rental');
  optionalBoolean(b.is_occupied, 'is_occupied');
  optionalBoolean(b.is_new_construction, 'is_new_construction');
}

// Estimate a property's current market value. Uses the RentCast AVM when the book
// has a RentCast key (its own, or the server's) and an address is available;
// otherwise falls back to a Claude (AI) appraisal estimate. (Zillow's Zestimate has
// no public API, and its terms prohibit scraping.)
properties.post(
  '/estimate-value',
  ah(async (req, res) => {
    const b = req.body ?? {};
    const type = b.property_type ? String(b.property_type) : null;
    const address = fullAddress(b);
    // Validated so a bad value is a clean 400, not a NaN fed into RentCast/AI.
    const sqft = optionalMoney(b.square_feet, 'square_feet');
    const lot = optionalNumber(b.lot_size_acres, 'lot_size_acres');
    const year = optionalMoney(b.year_built, 'year_built');
    const purchasePrice = optionalMoney(b.purchase_price, 'purchase_price');
    const purchaseDate = b.purchase_date ? String(b.purchase_date).slice(0, 10) : null;

    // Preferred path: real market data from RentCast (needs a key + an address).
    const { key: rentcastKey } = await resolveRentcastKey(hh(req));
    if (rentcastKey && address) {
      res.json(await rentcastValue(rentcastKey, address, sqft, type));
      return;
    }

    if (!address && !sqft && !purchasePrice) {
      throw new HttpError(400, 'Add an address, size, or purchase price before estimating value.');
    }

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Estimate the current market value (in USD) of this property as of ${today}.

PROPERTY
- Type: ${type ?? 'unknown'}
- Address: ${address ?? 'unknown'}
- Size: ${sqft != null ? sqft.toLocaleString() + ' sq ft' : 'unknown'}
- Lot size: ${lot != null ? lot + ' acres' : 'unknown'}
- Year built: ${year ?? 'unknown'}
- Purchased for: ${purchasePrice != null ? '$' + purchasePrice.toLocaleString() : 'unknown'}${purchaseDate ? ` (on ${purchaseDate})` : ''}

Use the location, size, and typical appreciation since the purchase date to ground the estimate. Respond with ONLY a JSON object, no prose, in exactly this shape:
{"value": <number>, "low": <number>, "high": <number>, "rationale": "<one or two sentences>"}
Values are whole-dollar numbers with no symbols or commas. "value" must lie between "low" and "high".`;

    let raw: string;
    try {
      raw = await ask(prompt, {
        system:
          'You are an experienced real-estate appraiser. You give realistic market valuations from location, size, age, and purchase history. You respond with valid JSON only — no markdown, no commentary.',
        maxTokens: 400,
      });
    } catch (e) {
      if (e instanceof AiNotConfiguredError) throw new HttpError(503, e.message);
      throw e;
    }

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new HttpError(502, 'Could not parse a value estimate from the AI response.');
    let parsed: any;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new HttpError(502, 'Could not parse a value estimate from the AI response.');
    }

    const toNum = (n: any) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);
    const value = toNum(parsed.value);
    if (value == null) throw new HttpError(502, 'The AI did not return a usable value.');

    res.json({
      value,
      low: toNum(parsed.low),
      high: toNum(parsed.high),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : null,
      source: 'ai' as const,
    });
  })
);

properties.get(
  '/',
  ah(async (req, res) => {
    res.json(await query(`
      WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}, ${ACCOUNT_BALANCES}
      SELECT p.*,
             COALESCE(s.total_spent, 0) AS total_spent,
             COALESCE(s.txn_count, 0)   AS txn_count,
             ma.name AS mortgage_account_name,
             mab.posted_balance AS mortgage_account_balance,
             COALESCE((SELECT count(*)::int FROM property_documents d WHERE d.property_id = p.id), 0) AS doc_count
      FROM properties p
      LEFT JOIN (
        SELECT ref_id AS property_id, SUM(amount) AS total_spent, COUNT(DISTINCT id)::int AS txn_count
        FROM eff_tag
        WHERE kind = 'property' AND direction = 'expense' AND book_id = $1
        GROUP BY ref_id
      ) s ON s.property_id = p.id
      LEFT JOIN accounts ma ON ma.id = p.mortgage_account_id
      LEFT JOIN acct_bal mab ON mab.id = p.mortgage_account_id
      WHERE p.book_id = $1
      ORDER BY p.sort_order, p.name
    `, [hh(req)]));
  })
);

// Persist a manual order (drag-to-reorder); ids are the full list in new order.
properties.post(
  '/reorder',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    await withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(`UPDATE properties SET sort_order = $1 WHERE id = $2 AND book_id = $3`, [i, ids[i], bookId]);
      }
    });
    res.json({ ok: true });
  })
);

properties.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const b = req.body;
    requiredString(b.name, 'name');
    validateProperty(b);
    const row = await one(
      `INSERT INTO properties
        (name, address, city, state, zip, property_type, purchase_date, purchase_price, current_value,
         mortgage_balance, year_built, square_feet, lot_size_acres, rental_income, notes,
         is_rental, is_occupied, tenant_name, lease_start, lease_end, security_deposit, legal_description,
         bedrooms, bathrooms, stories, garage_spaces, is_new_construction,
         property_tax_annual, hoa_dues, hoa_cycle, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING *`,
      [
        b.name, b.address ?? null, b.city ?? null, b.state ?? null, b.zip ?? null,
        b.property_type ?? 'single_family', b.purchase_date ?? null,
        b.purchase_price ?? null, b.current_value ?? null, b.mortgage_balance ?? null,
        b.year_built ?? null, b.square_feet ?? null, b.lot_size_acres ?? null, b.rental_income ?? null, b.notes ?? null,
        b.is_rental ?? false, b.is_occupied ?? null, b.tenant_name ?? null, b.lease_start ?? null, b.lease_end ?? null,
        b.security_deposit ?? null, b.legal_description ?? null,
        b.bedrooms ?? null, b.bathrooms ?? null, b.stories ?? null, b.garage_spaces ?? null, b.is_new_construction ?? false,
        b.property_tax_annual ?? null, b.hoa_dues ?? null, b.hoa_cycle ?? null, hh(req),
      ]
    );
    res.status(201).json(row);
  })
);

properties.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body;
    validateProperty(b);
    const row = await one(
      `UPDATE properties SET
         name = COALESCE($2, name), address = $3, city = $4, state = $5, zip = $6,
         property_type = COALESCE($7, property_type),
         purchase_date = $8, purchase_price = $9, current_value = COALESCE($10, current_value), mortgage_balance = $11,
         year_built = $12, square_feet = $13, lot_size_acres = $14, rental_income = $15, notes = $16,
         is_rental = COALESCE($18, is_rental), is_occupied = $19, tenant_name = $20,
         lease_start = $21, lease_end = $22, security_deposit = $23, legal_description = $24,
         bedrooms = $25, bathrooms = $26, stories = $27, garage_spaces = $28, is_new_construction = COALESCE($29, is_new_construction),
         property_tax_annual = $30, hoa_dues = $31, hoa_cycle = $32
       WHERE id = $1 AND book_id = $17 RETURNING *`,
      [
        req.params.id, b.name ?? null, b.address ?? null, b.city ?? null, b.state ?? null, b.zip ?? null,
        b.property_type ?? null,
        b.purchase_date ?? null, b.purchase_price ?? null, b.current_value ?? null,
        b.mortgage_balance ?? null, b.year_built ?? null, b.square_feet ?? null,
        b.lot_size_acres ?? null, b.rental_income ?? null, b.notes ?? null, hh(req),
        b.is_rental ?? null, b.is_occupied ?? null, b.tenant_name ?? null,
        b.lease_start ?? null, b.lease_end ?? null, b.security_deposit ?? null, b.legal_description ?? null,
        b.bedrooms ?? null, b.bathrooms ?? null, b.stories ?? null, b.garage_spaces ?? null, b.is_new_construction ?? null,
        b.property_tax_annual ?? null, b.hoa_dues ?? null, b.hoa_cycle ?? null,
      ]
    );
    if (!row) throw new HttpError(404, 'Property not found');
    res.json(row);
  })
);

// POST /:id/dispose — mark a property "no longer owned" (sold, transferred, …) so it
// drops out of active asset & net-worth totals while its history is preserved.
// Passing { disposed: false } restores it to active ownership.
properties.post(
  '/:id/dispose',
  ah(async (req, res) => {
    const bookId = hh(req);
    const disposed = booleanValue(req.body?.disposed, 'disposed', { default: true });
    const disposed_at = optionalDateOnly(req.body?.disposed_at, 'disposed_at');
    const disposal_type = optionalEnumValue(req.body?.disposal_type, 'disposal_type', PROPERTY_DISPOSAL_TYPES);
    const disposal_amount = optionalMoney(req.body?.disposal_amount, 'disposal_amount');
    const disposal_note = optionalString(req.body?.disposal_note, 'disposal_note');
    const row = await one(
      `UPDATE properties SET
         disposed_at     = CASE WHEN $2 THEN COALESCE($3::date, CURRENT_DATE) ELSE NULL END,
         disposal_type   = CASE WHEN $2 THEN $4 ELSE NULL END,
         disposal_amount = CASE WHEN $2 THEN $5::numeric ELSE NULL END,
         disposal_note   = CASE WHEN $2 THEN $6 ELSE NULL END
       WHERE id = $1 AND book_id = $7 RETURNING *`,
      [req.params.id, disposed, disposed_at, disposal_type, disposal_amount, disposal_note, bookId]
    );
    if (!row) throw new HttpError(404, 'Property not found');
    res.json(row);
  })
);

// --- Maintenance: completed repair/service history + scheduled upcoming items ---
const propMaintenanceCols = `
  m.id, m.item, m.status,
  to_char(m.service_date,'YYYY-MM-DD') AS service_date, m.cost,
  m.transaction_id, to_char(m.due_date,'YYYY-MM-DD') AS due_date,
  m.vendor, m.notes,
  to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount AS txn_amount, t.merchant AS txn_merchant`;

async function validateMaintenance(b: any, bookId: number): Promise<void> {
  requiredString(b.item, 'item');
  optionalEnumValue(b.status, 'status', MAINTENANCE_STATUSES);
  optionalDateOnly(b.service_date, 'service_date');
  optionalDateOnly(b.due_date, 'due_date');
  optionalMoney(b.cost, 'cost');
  optionalString(b.vendor, 'vendor');
  optionalString(b.notes, 'notes');
  await ownedRef('transaction', b.transaction_id, bookId, 'transaction_id');
}

properties.get(
  '/:id/maintenance',
  ah(async (req, res) => {
    await ownedProperty(req);
    res.json(await query(
      `SELECT ${propMaintenanceCols}
       FROM property_maintenance m LEFT JOIN transactions t ON t.id = m.transaction_id
       WHERE m.property_id = $1 AND m.book_id = $2
       ORDER BY COALESCE(m.service_date, m.due_date) DESC NULLS LAST, m.id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

properties.post(
  '/:id/maintenance',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedProperty(req);
    const b = req.body ?? {};
    await validateMaintenance(b, bookId);
    const status = optionalEnumValue(b.status, 'status', MAINTENANCE_STATUSES) ?? 'completed';
    const row = await one(
      `INSERT INTO property_maintenance
         (property_id, book_id, item, status, service_date, cost, transaction_id, due_date, vendor, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.params.id, bookId, b.item, status, b.service_date ?? null, b.cost ?? null,
       b.transaction_id ?? null, b.due_date ?? null, b.vendor ?? null, b.notes ?? null]
    );
    res.status(201).json(row);
  })
);

properties.put(
  '/:id/maintenance/:mid',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedProperty(req);
    const b = req.body ?? {};
    await validateMaintenance(b, bookId);
    const status = optionalEnumValue(b.status, 'status', MAINTENANCE_STATUSES) ?? 'completed';
    const row = await one(
      `UPDATE property_maintenance SET
         item = $3, status = $4, service_date = $5, cost = $6, transaction_id = $7, due_date = $8, vendor = $9, notes = $10
       WHERE id = $1 AND property_id = $2 AND book_id = $11 RETURNING id`,
      [req.params.mid, req.params.id, b.item, status, b.service_date ?? null, b.cost ?? null,
       b.transaction_id ?? null, b.due_date ?? null, b.vendor ?? null, b.notes ?? null, bookId]
    );
    if (!row) throw new HttpError(404, 'Maintenance item not found');
    res.json(row);
  })
);

properties.delete(
  '/:id/maintenance/:mid',
  ah(async (req, res) => {
    await query(`DELETE FROM property_maintenance WHERE id = $1 AND property_id = $2 AND book_id = $3`, [req.params.mid, req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// Candidate transactions to link to a maintenance item: expenses already tagged to
// THIS property, newest first.
properties.get(
  '/:id/expense-candidates',
  ah(async (req, res) => {
    await ownedProperty(req);
    res.json(await query(
      `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
       SELECT DISTINCT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.merchant, t.description, a.name AS account_name
       FROM eff_tag
       JOIN transactions t ON t.id = eff_tag.id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE eff_tag.kind = 'property' AND eff_tag.ref_id = $2 AND eff_tag.book_id = $1
         AND eff_tag.direction = 'expense'
       ORDER BY txn_date DESC, t.id DESC LIMIT 50`,
      [hh(req), req.params.id]
    ));
  })
);

properties.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    // Remove polymorphic insurance_policies rows (no FK) to avoid orphans.
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM insurance_policies WHERE entity_kind = 'property' AND entity_id = $1 AND book_id = $2`, [req.params.id, bookId]);
      // Untag this property's transactions — line_tags is polymorphic (no FK), so its
      // 'property' rows must be removed explicitly to avoid dangling tags.
      await client.query(`DELETE FROM line_tags WHERE kind = 'property' AND ref_id = $1 AND book_id = $2`, [req.params.id, bookId]);
      await client.query(`DELETE FROM properties WHERE id = $1 AND book_id = $2`, [req.params.id, bookId]);
    });
    res.status(204).end();
  })
);

// Confirm a property belongs to the active book, or 404.
async function ownedProperty(req: any): Promise<number> {
  const p = await one<{ id: number }>(`SELECT id FROM properties WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!p) throw new HttpError(404, 'Property not found');
  return p.id;
}

// Set the property's current_value to its latest-dated value snapshot (or leave
// it if there are none). Keeps current_value — what net worth uses — in sync.
async function syncCurrentValue(client: any, propertyId: number) {
  await client.query(
    `UPDATE properties SET current_value = COALESCE(
       (SELECT value FROM property_values WHERE property_id = $1 ORDER BY as_of DESC LIMIT 1),
       current_value)
     WHERE id = $1`,
    [propertyId]
  );
}

const VALUE_SOURCES = ['manual', 'rentcast', 'ai'] as const;
const AUTO_VALUE_FREQUENCIES = ['weekly', 'monthly'] as const;

// Turn automatic RentCast value updates on/off for a property, and set how often.
// Turning it on needs an address and a RentCast key for the book.
properties.put(
  '/:id/auto-value',
  ah(async (req, res) => {
    const bookId = hh(req);
    const prop = await one<any>(`SELECT * FROM properties WHERE id = $1 AND book_id = $2`, [integerId(req.params.id, 'id'), bookId]);
    if (!prop) throw new HttpError(404, 'Property not found');
    const enabled = booleanValue(req.body?.enabled, 'enabled');
    const frequency = optionalEnumValue(req.body?.frequency, 'frequency', AUTO_VALUE_FREQUENCIES) ?? prop.auto_value_frequency ?? 'monthly';
    if (enabled) {
      if (!fullAddress(prop) || !prop.address) throw new HttpError(400, 'Add the property\'s street address first. RentCast estimates are by address.');
      const { key } = await resolveRentcastKey(bookId);
      if (!key) throw new HttpError(400, 'Add a RentCast API key under Integrations → RentCast first.');
    }
    const row = await one(
      `UPDATE properties SET auto_value_enabled = $3, auto_value_frequency = $4,
              auto_value_last_error = CASE WHEN $3 THEN auto_value_last_error ELSE NULL END
        WHERE id = $1 AND book_id = $2 RETURNING *`,
      [prop.id, bookId, enabled, frequency]
    );
    res.json(row);
  })
);

// Background job: record a RentCast value snapshot for each property with automatic
// updates on whose period has passed since the last success. A failure is recorded
// on the property (shown on its Value tab) and retried at most once a day, so a bad
// key or a used-up quota doesn't burn requests every sweep.
export async function runDuePropertyValuesSafe(): Promise<void> {
  try {
    const books = (await pool.query(`SELECT id FROM books ORDER BY id`)).rows as { id: number }[];
    for (const b of books) {
      const due = await withBookContext(b.id, () => query<any>(
        `SELECT id, address, city, state, zip, square_feet, property_type FROM properties
          WHERE book_id = $1 AND auto_value_enabled AND disposed_at IS NULL
            AND (auto_value_last_success_at IS NULL OR auto_value_last_success_at <=
                 now() - CASE auto_value_frequency WHEN 'weekly' THEN interval '7 days' ELSE interval '1 month' END)
            AND (auto_value_last_attempt_at IS NULL OR auto_value_last_attempt_at <= now() - interval '23 hours')
          ORDER BY id`,
        [b.id]
      ), { readOnly: true });
      if (!due.length) continue;
      const { key } = await withBookContext(b.id, () => resolveRentcastKey(b.id), { readOnly: true });
      for (const p of due) {
        let estimate: { value: number } | null = null;
        let error: string | null = null;
        const address = fullAddress(p);
        if (!key) error = 'No RentCast API key. Add one under Integrations → RentCast.';
        else if (!address || !p.address) error = 'This property has no street address.';
        else {
          // Network call outside any transaction (no connection held while waiting).
          try { estimate = await rentcastValue(key, address, p.square_feet != null ? Number(p.square_feet) : null, p.property_type); }
          catch (e: any) {
            error = e instanceof HttpError ? e.message : 'Could not update the value automatically.';
            if (!(e instanceof HttpError)) console.error(`automatic value update failed for property ${p.id}:`, e);
          }
        }
        await withBookContext(b.id, async (client) => {
          if (estimate) {
            await client.query(
              `INSERT INTO property_values (property_id, value, as_of, book_id, source)
               VALUES ($1, $2, CURRENT_DATE, $3, 'rentcast')
               ON CONFLICT (property_id, as_of) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`,
              [p.id, estimate.value, b.id]
            );
            await syncCurrentValue(client, p.id);
          }
          await client.query(
            `UPDATE properties SET auto_value_last_attempt_at = now(),
                    auto_value_last_success_at = CASE WHEN $3::text IS NULL THEN now() ELSE auto_value_last_success_at END,
                    auto_value_last_error = $3
              WHERE id = $1 AND book_id = $2`,
            [p.id, b.id, error]
          );
        });
      }
    }
  } catch (e) {
    console.error('automatic property value sweep failed:', e);
  }
}

// --- Value snapshots (value of the home on a date; latest = current value) ---
properties.get(
  '/:id/values',
  ah(async (req, res) => {
    await ownedProperty(req);
    const rows = await query(
      `SELECT id, to_char(as_of,'YYYY-MM-DD') AS as_of, value, source FROM property_values
       WHERE property_id = $1 AND book_id = $2 ORDER BY as_of`,
      [req.params.id, hh(req)]
    );
    res.json(rows);
  })
);

properties.post(
  '/:id/values',
  ah(async (req, res) => {
    require_(req.body, ['value']);
    const bookId = hh(req);
    await ownedProperty(req);
    const { value, as_of } = req.body;
    optionalMoney(value, 'value');
    optionalDateOnly(as_of, 'as_of');
    const source = optionalEnumValue(req.body?.source, 'source', VALUE_SOURCES) ?? 'manual';
    const row = await withTransaction(async (client) => {
      const r = (await client.query(
        `INSERT INTO property_values (property_id, value, as_of, book_id, source)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5)
         ON CONFLICT (property_id, as_of) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source
         RETURNING id, to_char(as_of,'YYYY-MM-DD') AS as_of, value, source`,
        [req.params.id, value, as_of ?? null, bookId, source]
      )).rows[0];
      await syncCurrentValue(client, Number(req.params.id));
      return r;
    });
    res.status(201).json(row);
  })
);

properties.delete(
  '/:id/values/:valueId',
  ah(async (req, res) => {
    await ownedProperty(req);
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM property_values WHERE id = $1 AND property_id = $2 AND book_id = $3`, [req.params.valueId, req.params.id, hh(req)]);
      await syncCurrentValue(client, Number(req.params.id));
    });
    res.status(204).end();
  })
);

// --- Mortgage as a managed liability account ---
// Create (or return the existing) liability account that represents this property's
// mortgage and link the property to it, so the debt is managed in the Accounts page
// and counted once in net worth.
properties.post(
  '/:id/mortgage-account',
  ah(async (req, res) => {
    const bookId = hh(req);
    const account = await withTransaction(async (client) => {
      const p = (await client.query(`SELECT * FROM properties WHERE id = $1 AND book_id = $2`, [req.params.id, bookId])).rows[0];
      if (!p) throw new HttpError(404, 'Property not found');
      if (p.mortgage_account_id) {
        const existing = (await client.query(`SELECT * FROM accounts WHERE id = $1 AND book_id = $2`, [p.mortgage_account_id, bookId])).rows[0];
        if (existing) return existing;
      }
      // The amount can be specified from the property window; fall back to the field.
      const opening = optionalMoney(req.body?.opening_balance, 'opening_balance', { min: 0 }) ?? (p.mortgage_balance ?? 0);
      const acct = (await client.query(
        `INSERT INTO accounts (name, type, is_liability, opening_balance, opening_date, book_id)
         VALUES ($1, 'mortgage', true, $2, CURRENT_DATE, $3) RETURNING *`,
        [`${p.name} Mortgage`, opening, bookId]
      )).rows[0];
      await client.query(`UPDATE properties SET mortgage_account_id = $2 WHERE id = $1`, [req.params.id, acct.id]);
      return acct;
    });
    res.status(201).json(account);
  })
);

// Unlink the mortgage account (the account itself is left for the user to manage
// or delete in the Accounts page).
properties.delete(
  '/:id/mortgage-account',
  ah(async (req, res) => {
    await query(`UPDATE properties SET mortgage_account_id = NULL WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// --- Documents / images attached to a property (deed, survey, photos, …) ---
properties.get(
  '/:id/documents',
  ah(async (req, res) => {
    await ownedProperty(req);
    const rows = await query(
      `SELECT id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM property_documents WHERE property_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.params.id, hh(req)]
    );
    res.json(rows);
  })
);

properties.post(
  '/:id/documents',
  ah(async (req, res) => {
    require_(req.body, ['file']);
    const bookId = hh(req);
    await ownedProperty(req);
    const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
    if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
    // The document is served back inline later, so reject disallowed MIME types up front.
    const safeMime = assertUploadMime(file_mime);
    assertUploadSize(file);
    const buf = Buffer.from(file, 'base64');
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const row = await one(
      `INSERT INTO property_documents (property_id, book_id, doc_type, name, file, file_mime, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
      [req.params.id, bookId, docType, name || file_name, buf, safeMime, file_name]
    );
    res.status(201).json(row);
  })
);

// Update a document's metadata (name + type), optionally replacing the stored file.
properties.put(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await ownedProperty(req);
    const { name = null, doc_type = null, file = null, file_mime = null, file_name = null } = req.body ?? {};
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const returning = `RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`;
    let row;
    if (file != null) {
      if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
      const safeMime = assertUploadMime(file_mime);
      assertUploadSize(file);
      const buf = Buffer.from(file, 'base64');
      row = await one(
        `UPDATE property_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
         WHERE id = $6 AND property_id = $7 AND book_id = $8 ${returning}`,
        [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
      );
    } else {
      row = await one(
        `UPDATE property_documents SET name = $1, doc_type = $2
         WHERE id = $3 AND property_id = $4 AND book_id = $5 ${returning}`,
        [name, docType, req.params.docId, req.params.id, hh(req)]
      );
    }
    if (!row) throw new HttpError(404, 'Document not found.');
    res.json(row);
  })
);

properties.get(
  '/:id/documents/:docId/file',
  ah(async (req, res) => {
    await ownedProperty(req);
    const r = await one<any>(
      `SELECT file, file_mime, file_name FROM property_documents WHERE id = $1 AND property_id = $2 AND book_id = $3`,
      [req.params.docId, req.params.id, hh(req)]
    );
    if (!r || !r.file) throw new HttpError(404, 'Document not found.');
    sendStoredFile(res, r.file, r.file_mime, r.file_name);
  })
);

properties.delete(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await query(`DELETE FROM property_documents WHERE id = $1 AND property_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// Cost / performance summary (the AI endpoint layers narrative analysis on top).
properties.get(
  '/:id/summary',
  ah(async (req, res) => {
    res.json(await propertySummary(Number(req.params.id), hh(req)));
  })
);

export interface PropertySummary {
  property: any;
  byCategory: { category_name: string | null; total: number; count: number }[];
  totalSpent: number;
  totalIncome: number;
  net: number;
  monthsOwned: number | null;
  costPerMonth: number | null;
  equity: number | null;
  appreciation: number | null;
  annualRentalIncome: number | null;
  grossYield: number | null;
}

export async function propertySummary(id: number, bookId: number): Promise<PropertySummary> {
  const property = await one(`SELECT * FROM properties WHERE id = $1 AND book_id = $2`, [id, bookId]);
  if (!property) throw new HttpError(404, 'Property not found');

  const byCategory = await query(
    `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
     SELECT c.name AS category_name, SUM(eff_tag.amount) AS total, COUNT(*)::int AS count
     FROM eff_tag LEFT JOIN categories c ON c.id = eff_tag.category_id
     WHERE eff_tag.kind = 'property' AND eff_tag.ref_id = $1 AND eff_tag.direction = 'expense'
       AND eff_tag.book_id = $2
     GROUP BY c.name ORDER BY total DESC`,
    [id, bookId]
  );
  const totalSpent = byCategory.reduce((s, r: any) => s + Number(r.total), 0);
  const incomeRow = await one<{ total: string }>(
    `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
     SELECT COALESCE(SUM(amount),0) AS total FROM eff_tag WHERE kind = 'property' AND ref_id = $1 AND direction = 'income' AND book_id = $2`,
    [id, bookId]
  );
  const totalIncome = Number(incomeRow?.total ?? 0);

  const p: any = property;
  const monthsOwned = p.purchase_date
    ? Math.max(1, Math.round((Date.now() - new Date(p.purchase_date).getTime()) / (1000 * 60 * 60 * 24 * 30.44)))
    : null;
  const costPerMonth = monthsOwned ? totalSpent / monthsOwned : null;
  const equity = p.current_value != null ? Number(p.current_value) - Number(p.mortgage_balance ?? 0) : null;
  const appreciation =
    p.current_value != null && p.purchase_price != null ? Number(p.current_value) - Number(p.purchase_price) : null;
  const annualRentalIncome = p.rental_income != null ? Number(p.rental_income) * 12 : null;
  const grossYield =
    annualRentalIncome != null && p.current_value ? annualRentalIncome / Number(p.current_value) : null;

  return {
    property, byCategory, totalSpent, totalIncome, net: totalIncome - totalSpent,
    monthsOwned, costPerMonth, equity, appreciation, annualRentalIncome, grossYield,
  };
}

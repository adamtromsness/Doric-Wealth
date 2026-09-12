import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { ask, AiNotConfiguredError } from '../ai/claude.js';
import { EFFECTIVE_LINES, EFFECTIVE_LINE_TAGS, ACCOUNT_BALANCES } from '../effectiveLines.js';
import { hh } from '../tenant.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import { insertTransaction } from './transactions.js';
import { mountInsuranceRoutes } from './insuranceRoutes.js';
import {
  requiredString, money, optionalMoney, optionalDateOnly, optionalString, optionalEnumValue, booleanValue,
  integerId, ownedRef, VEHICLE_DISPOSAL_TYPES,
} from '../validation.js';

const PROCEEDS_MODES = ['none', 'create', 'link'] as const;
const MAINTENANCE_STATUSES = ['completed', 'upcoming'] as const;

// Validate a maintenance item's fields (clean 400) and its optional transaction
// link (404 if it belongs to another book).
async function validateMaintenance(b: any, bookId: number): Promise<void> {
  requiredString(b.item, 'item');
  optionalEnumValue(b.status, 'status', MAINTENANCE_STATUSES);
  optionalDateOnly(b.service_date, 'service_date');
  optionalDateOnly(b.due_date, 'due_date');
  optionalMoney(b.odometer, 'odometer');
  optionalMoney(b.due_odometer, 'due_odometer');
  optionalMoney(b.cost, 'cost');
  optionalString(b.vendor, 'vendor');
  optionalString(b.notes, 'notes');
  await ownedRef('transaction', b.transaction_id, bookId, 'transaction_id');
}
const intOrNull = (x: any) => (x == null || x === '' ? null : Math.round(Number(x)));

// Numeric/date value validation for vehicle create/update (clean 400 on bad input).
function validateVehicle(b: any): void {
  optionalMoney(b.year, 'year');
  optionalMoney(b.odometer_start, 'odometer_start');
  optionalMoney(b.odometer_current, 'odometer_current');
  optionalMoney(b.purchase_price, 'purchase_price');
  optionalMoney(b.current_value, 'current_value');
  optionalDateOnly(b.purchase_date, 'purchase_date');
}

export const vehicles = Router();

// Confirm a vehicle belongs to the active book, or 404.
async function ownedVehicle(req: any): Promise<number> {
  const v = await one<{ id: number }>(`SELECT id FROM vehicles WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!v) throw new HttpError(404, 'Vehicle not found');
  return v.id;
}

// Insurance policies (carrier, premium, renewal, agent) — shared with properties.
mountInsuranceRoutes(vehicles, 'vehicle', ownedVehicle);

vehicles.get(
  '/',
  ah(async (req, res) => {
    res.json(await query(
      `WITH ${ACCOUNT_BALANCES}, ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
       SELECT v.*,
              COALESCE((SELECT count(*)::int FROM vehicle_documents d WHERE d.vehicle_id = v.id), 0) AS doc_count,
              la.name AS loan_account_name,
              lab.posted_balance AS loan_account_balance,
              -- Total of expenses tagged to this vehicle (drives cost-of-ownership figures).
              COALESCE((SELECT SUM(eff_tag.amount) FROM eff_tag
                        WHERE eff_tag.kind = 'vehicle' AND eff_tag.ref_id = v.id
                          AND eff_tag.direction = 'expense' AND eff_tag.book_id = $1), 0) AS total_spent,
              -- Most recent odometer-reading date, for the "needs an update" attention flag.
              (SELECT to_char(MAX(r.as_of), 'YYYY-MM-DD') FROM vehicle_odometer_readings r WHERE r.vehicle_id = v.id) AS last_odometer_at
       FROM vehicles v
       LEFT JOIN accounts la ON la.id = v.loan_account_id
       LEFT JOIN acct_bal lab ON lab.id = v.loan_account_id
       WHERE v.book_id = $1 ORDER BY v.sort_order, v.name`,
      [hh(req)]
    ));
  })
);

// Persist a manual order (drag-to-reorder); ids are the full list in new order.
vehicles.post(
  '/reorder',
  ah(async (req, res) => {
    const bookId = hh(req);
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    await withTransaction(async (client) => {
      for (let i = 0; i < ids.length; i++) {
        await client.query(`UPDATE vehicles SET sort_order = $1 WHERE id = $2 AND book_id = $3`, [i, ids[i], bookId]);
      }
    });
    res.json({ ok: true });
  })
);

// Miles driven per month across all currently-owned vehicles. Each odometer
// reading's delta from the previous reading is spread proportionally (by day
// overlap) across the calendar months the interval spans, so a multi-month gap
// distributes its miles rather than dumping them in one month.
vehicles.get(
  '/miles-driven',
  ah(async (req, res) => {
    // Optional ?vehicle_id=… narrows the chart to a single vehicle.
    const vehicleId = req.query.vehicle_id != null && req.query.vehicle_id !== ''
      ? Number(req.query.vehicle_id) : null;
    res.json(await query(
      `WITH deltas AS (
         SELECT LAG(r.as_of)  OVER (PARTITION BY r.vehicle_id ORDER BY r.as_of) AS start_date,
                r.as_of AS end_date,
                r.reading - LAG(r.reading) OVER (PARTITION BY r.vehicle_id ORDER BY r.as_of) AS miles
         FROM vehicle_odometer_readings r
         JOIN vehicles v ON v.id = r.vehicle_id
         WHERE r.book_id = $1 AND v.disposed_at IS NULL
           AND ($2::int IS NULL OR r.vehicle_id = $2)
       ),
       intervals AS (
         SELECT start_date, end_date, miles, (end_date - start_date) AS total_days
         FROM deltas
         WHERE miles IS NOT NULL AND miles > 0 AND start_date IS NOT NULL AND end_date > start_date
       ),
       spread AS (
         SELECT to_char(gs, 'YYYY-MM') AS month,
                i.miles
                  * GREATEST(0, LEAST(i.end_date, (gs + interval '1 month')::date) - GREATEST(i.start_date, gs::date))::numeric
                  / i.total_days AS miles
         FROM intervals i
         CROSS JOIN LATERAL generate_series(date_trunc('month', i.start_date), date_trunc('month', i.end_date), interval '1 month') AS gs
       )
       SELECT month, ROUND(SUM(miles))::int AS miles
       FROM spread
       GROUP BY month HAVING ROUND(SUM(miles)) > 0
       ORDER BY month`,
      [hh(req), vehicleId]
    ));
  })
);

// Liability 'loan' accounts available to link to a vehicle: type 'loan', not closed,
// and not already linked to another vehicle's loan or a property's mortgage.
vehicles.get(
  '/loan-accounts',
  ah(async (req, res) => {
    res.json(await query(
      `WITH ${ACCOUNT_BALANCES}
       SELECT a.id, a.name, a.type, ab.posted_balance
       FROM accounts a JOIN acct_bal ab ON ab.id = a.id
       WHERE a.book_id = $1
         AND a.type = 'loan'
         AND a.closed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.loan_account_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.mortgage_account_id = a.id)
       ORDER BY lower(a.name)`,
      [hh(req)]
    ));
  })
);

// --- Car loan as a managed liability account ---
// Link this vehicle to a loan that's managed as a liability account, so the debt is
// tracked in the Accounts page and counted once in net worth. Pass `account_id` to
// link an account that already exists; otherwise a new 'loan' account is created
// (optionally seeded with `opening_balance`).
vehicles.post(
  '/:id/loan-account',
  ah(async (req, res) => {
    const bookId = hh(req);
    const account = await withTransaction(async (client) => {
      const v = (await client.query(`SELECT * FROM vehicles WHERE id = $1 AND book_id = $2`, [req.params.id, bookId])).rows[0];
      if (!v) throw new HttpError(404, 'Vehicle not found');
      if (v.loan_account_id) {
        const existing = (await client.query(`SELECT * FROM accounts WHERE id = $1 AND book_id = $2`, [v.loan_account_id, bookId])).rows[0];
        if (existing) return existing;
      }
      // Link an already-created account when an id is supplied.
      const linkId = req.body?.account_id;
      if (linkId != null && linkId !== '') {
        const existing = (await client.query(`SELECT * FROM accounts WHERE id = $1 AND book_id = $2`, [linkId, bookId])).rows[0];
        if (!existing) throw new HttpError(404, 'Account not found');
        await client.query(`UPDATE vehicles SET loan_account_id = $2 WHERE id = $1`, [req.params.id, existing.id]);
        return existing;
      }
      // Otherwise create a fresh loan account and link it.
      const opening = optionalMoney(req.body?.opening_balance, 'opening_balance', { min: 0 }) ?? 0;
      const acct = (await client.query(
        `INSERT INTO accounts (name, type, is_liability, opening_balance, opening_date, book_id)
         VALUES ($1, 'loan', true, $2, CURRENT_DATE, $3) RETURNING *`,
        [`${v.name} Loan`, opening, bookId]
      )).rows[0];
      await client.query(`UPDATE vehicles SET loan_account_id = $2 WHERE id = $1`, [req.params.id, acct.id]);
      return acct;
    });
    res.status(201).json(account);
  })
);

// Unlink the loan account (the account itself is left for the user to manage or
// delete in the Accounts page).
vehicles.delete(
  '/:id/loan-account',
  ah(async (req, res) => {
    await query(`UPDATE vehicles SET loan_account_id = NULL WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// Decode a VIN via the NHTSA vPIC API (free, no key) into make/model/year so the
// add-vehicle form can be populated from just the VIN.
vehicles.get(
  '/decode/:vin',
  ah(async (req, res) => {
    const vin = String(req.params.vin).trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{11,17}$/.test(vin)) {
      throw new HttpError(400, 'That does not look like a valid VIN.');
    }

    let r: globalThis.Response;
    try {
      r = await fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`,
        { signal: AbortSignal.timeout(15_000) }
      );
    } catch {
      throw new HttpError(502, 'Could not reach the VIN decoding service.');
    }
    if (!r.ok) throw new HttpError(502, `VIN decoding service error (${r.status}).`);

    const data = (await r.json()) as { Results?: Record<string, string>[] };
    const v = data.Results?.[0];
    if (!v) throw new HttpError(404, 'No data returned for that VIN.');

    const clean = (s?: string) => (s && s.trim() ? s.trim() : null);
    // NHTSA returns makes in ALL CAPS. Title-case them, but keep acronym brands intact.
    const ACRONYM_MAKES = new Set(['BMW', 'GMC', 'RAM', 'MINI', 'KTM', 'BYD']);
    const titleCaseMake = (s: string) =>
      ACRONYM_MAKES.has(s.toUpperCase())
        ? s.toUpperCase()
        : s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

    const rawMake = clean(v.Make);
    const make = rawMake ? titleCaseMake(rawMake) : null;
    const model = clean(v.Model);
    const yearStr = clean(v.ModelYear);
    const year = yearStr && /^\d{4}$/.test(yearStr) ? Number(yearStr) : null;

    // ErrorCode '0' means a clean decode; anything else still often has partial data.
    if (!make && !model && !year) {
      throw new HttpError(422, clean(v.ErrorText) ?? 'VIN could not be decoded.');
    }

    // Specs the VIN also encodes (license plate & exterior colour are not in a VIN).
    const trim = clean(v.Trim) ?? clean(v.Series);
    const vehicle_type = clean(v.BodyClass);
    const fuel_type = clean(v.FuelTypePrimary);
    const drivetrain = clean(v.DriveType);
    const disp = clean(v.DisplacementL);
    const cyl = clean(v.EngineCylinders);
    const engine_type = [disp ? `${Number(disp).toFixed(1)}L` : null, cyl ? `${cyl}-cyl` : null]
      .filter(Boolean).join(' ') || clean(v.EngineModel);
    const speeds = clean(v.TransmissionSpeeds);
    const transmission = [speeds ? `${speeds}-Speed` : null, clean(v.TransmissionStyle)]
      .filter(Boolean).join(' ') || null;

    res.json({
      vin,
      make,
      model,
      year,
      name: [year, make, model].filter(Boolean).join(' ') || null,
      trim,
      vehicle_type,
      fuel_type,
      engine_type,
      transmission,
      drivetrain,
    });
  })
);

// Estimate the current market value from make/model/year/mileage using Claude.
// Works from form fields, so it can be used before a vehicle is saved. Returns
// a point estimate plus a low/high range and a short rationale; the user can
// always override the value manually.
vehicles.post(
  '/estimate-value',
  ah(async (req, res) => {
    const b = req.body ?? {};
    const make = b.make ? String(b.make).trim() : null;
    const model = b.model ? String(b.model).trim() : null;
    // Validated so a bad value is a clean 400, not a NaN fed into the AI prompt.
    const year = optionalMoney(b.year, 'year');
    const miles = optionalMoney(b.odometer_current, 'odometer_current');
    const purchasePrice = optionalMoney(b.purchase_price, 'purchase_price');
    const purchaseDate = b.purchase_date ? String(b.purchase_date).slice(0, 10) : null;

    if (!make && !model && !year) {
      throw new HttpError(400, 'Add at least a make, model, or year before estimating value.');
    }

    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Estimate the current private-party resale value (in USD) of this used vehicle as of ${today}.

VEHICLE
- Year: ${year ?? 'unknown'}
- Make: ${make ?? 'unknown'}
- Model: ${model ?? 'unknown'}
- Odometer: ${miles != null ? miles.toLocaleString() + ' miles' : 'unknown'}
- Original purchase price: ${purchasePrice != null ? '$' + purchasePrice.toLocaleString() : 'unknown'}${purchaseDate ? ` (purchased ${purchaseDate})` : ''}

Use typical depreciation and the mileage to ground the estimate. Assume average condition unless the data suggests otherwise. Respond with ONLY a JSON object, no prose, in exactly this shape:
{"value": <number>, "low": <number>, "high": <number>, "rationale": "<one or two sentences>"}
Values are whole-dollar numbers with no symbols or commas. "value" must lie between "low" and "high".`;

    let raw: string;
    try {
      raw = await ask(prompt, {
        system:
          'You are an experienced used-car appraiser. You give realistic market valuations based on year, make, model, and mileage. You respond with valid JSON only — no markdown, no commentary.',
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
    });
  })
);

vehicles.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const b = req.body;
    requiredString(b.name, 'name');
    validateVehicle(b);
    const bookId = hh(req);
    const row = await withTransaction(async (client) => {
      const v = (await client.query(
        `INSERT INTO vehicles
          (name, make, model, year, vin, purchase_date, purchase_price,
           current_value, odometer_start, odometer_current,
           trim, vehicle_type, fuel_type, license_plate, engine_type, transmission, drivetrain, exterior_color,
           notes, book_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [
          b.name, b.make ?? null, b.model ?? null, b.year ?? null, b.vin ?? null,
          b.purchase_date ?? null, b.purchase_price ?? null, b.current_value ?? null,
          b.odometer_start ?? null, b.odometer_current ?? null,
          b.trim ?? null, b.vehicle_type ?? null, b.fuel_type ?? null, b.license_plate ?? null,
          b.engine_type ?? null, b.transmission ?? null, b.drivetrain ?? null, b.exterior_color ?? null,
          b.notes ?? null, bookId,
        ]
      )).rows[0];

      // Seed the odometer history from the form: the purchase mileage at the
      // purchase date, and the current mileage as of today. Upsert so a same-day
      // pair collapses to one reading; sync current odometer to the latest.
      const start = intOrNull(b.odometer_start);
      const current = intOrNull(b.odometer_current);
      const seed = async (reading: number, as_of: string | null) => {
        await client.query(
          `INSERT INTO vehicle_odometer_readings (vehicle_id, reading, as_of, book_id)
           VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4)
           ON CONFLICT (vehicle_id, as_of) DO UPDATE SET reading = EXCLUDED.reading`,
          [v.id, reading, as_of, bookId]
        );
      };
      if (start != null && b.purchase_date) await seed(start, b.purchase_date);
      if (current != null) await seed(current, null);
      if (start != null || current != null) await syncCurrentOdometer(client, v.id);
      return v;
    });
    res.status(201).json(row);
  })
);

vehicles.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body;
    validateVehicle(b);
    const row = await one(
      `UPDATE vehicles SET
         name = COALESCE($2,name), make=$3, model=$4, year=$5, vin=$6,
         purchase_date=$7, purchase_price=$8, current_value=COALESCE($9, current_value),
         odometer_start=$10, odometer_current=$11,
         trim=$13, vehicle_type=$14, fuel_type=$15, license_plate=$16,
         engine_type=$17, transmission=$18, drivetrain=$19, exterior_color=$20, notes=$21
       WHERE id=$1 AND book_id=$12 RETURNING *`,
      [
        req.params.id, b.name ?? null, b.make ?? null, b.model ?? null, b.year ?? null,
        b.vin ?? null, b.purchase_date ?? null, b.purchase_price ?? null,
        b.current_value ?? null, b.odometer_start ?? null, b.odometer_current ?? null, hh(req),
        b.trim ?? null, b.vehicle_type ?? null, b.fuel_type ?? null, b.license_plate ?? null,
        b.engine_type ?? null, b.transmission ?? null, b.drivetrain ?? null, b.exterior_color ?? null,
        b.notes ?? null,
      ]
    );
    if (!row) throw new HttpError(404, 'Vehicle not found');
    res.json(row);
  })
);

// Retire / un-retire a vehicle. Disposing (sold / traded / scrapped / totaled /
// gifted) preserves the vehicle row and every transaction tagged to it — it just
// marks the vehicle disposed so it drops out of active asset & net-worth totals.
// Passing { disposed: false } restores it to active ownership.
vehicles.post(
  '/:id/dispose',
  ah(async (req, res) => {
    const bookId = hh(req);
    const disposed = booleanValue(req.body?.disposed, 'disposed', { default: true });
    const disposed_at = optionalDateOnly(req.body?.disposed_at, 'disposed_at');
    const disposal_type = optionalEnumValue(req.body?.disposal_type, 'disposal_type', VEHICLE_DISPOSAL_TYPES);
    let disposal_amount = optionalMoney(req.body?.disposal_amount, 'disposal_amount');
    const disposal_note = optionalString(req.body?.disposal_note, 'disposal_note');
    // How the sale proceeds are recorded: nothing (info only), a new income
    // transaction, or a link to an existing one.
    const proceeds_mode = optionalEnumValue(req.body?.proceeds_mode, 'proceeds_mode', PROCEEDS_MODES) ?? 'none';

    const row = await withTransaction(async (client) => {
      // FOR UPDATE so a double-submit can't both pass the already-disposed guard and
      // each create a duplicate proceeds transaction.
      const veh = (await client.query(`SELECT * FROM vehicles WHERE id = $1 AND book_id = $2 FOR UPDATE`, [req.params.id, bookId])).rows[0];
      if (!veh) throw new HttpError(404, 'Vehicle not found');
      // Idempotency: disposing an already-disposed vehicle would record the sale (and
      // its proceeds income) a second time. Require an explicit restore first.
      if (disposed && veh.disposed_at != null) {
        throw new HttpError(409, 'This vehicle is already marked as disposed. Restore it before recording the sale again.');
      }

      let disposalTxnId: number | null = null;
      if (disposed && proceeds_mode === 'create') {
        const accountId = integerId(req.body?.proceeds_account_id, 'proceeds_account_id');
        if (disposal_amount == null || disposal_amount <= 0) throw new HttpError(400, 'Enter the sale amount to record a transaction.');
        // insertTransaction validates the account belongs to the book.
        const created = await insertTransaction(client, bookId, {
          account_id: accountId, direction: 'income', amount: disposal_amount,
          txn_date: disposed_at ?? new Date().toISOString().slice(0, 10),
          merchant: `Sale of ${veh.name}`, description: disposal_note ?? null,
          tags: [{ kind: 'vehicle', ref_id: veh.id }],
        });
        disposalTxnId = created.id;
      } else if (disposed && proceeds_mode === 'link') {
        disposalTxnId = integerId(req.body?.disposal_transaction_id, 'disposal_transaction_id');
        const txn = (await client.query(`SELECT id, amount FROM transactions WHERE id = $1 AND book_id = $2`, [disposalTxnId, bookId])).rows[0];
        if (!txn) throw new HttpError(404, 'Linked transaction not found.');
        if (disposal_amount == null) disposal_amount = Number(txn.amount);
        // Surface it in the vehicle's transaction list too, but only additively
        // (skip if it's split or already tagged, to avoid clobbering existing tags).
        const hasSplit = (await client.query(`SELECT 1 FROM transaction_splits WHERE transaction_id = $1 LIMIT 1`, [disposalTxnId])).rows[0];
        const alreadyTagged = (await client.query(`SELECT 1 FROM line_tags WHERE transaction_id = $1 AND kind = 'vehicle' AND ref_id = $2 LIMIT 1`, [disposalTxnId, veh.id])).rows[0];
        if (!hasSplit && !alreadyTagged) {
          await client.query(`INSERT INTO line_tags (transaction_id, split_id, kind, ref_id, book_id) VALUES ($1, NULL, 'vehicle', $2, $3) ON CONFLICT DO NOTHING`, [disposalTxnId, veh.id, bookId]);
        }
      }

      return (await client.query(
        `UPDATE vehicles SET
           disposed_at             = CASE WHEN $2 THEN COALESCE($3::date, CURRENT_DATE) ELSE NULL END,
           disposal_type           = CASE WHEN $2 THEN $4 ELSE NULL END,
           disposal_amount         = CASE WHEN $2 THEN $5::numeric ELSE NULL END,
           disposal_note           = CASE WHEN $2 THEN $6 ELSE NULL END,
           disposal_transaction_id = CASE WHEN $2 THEN $7::int ELSE NULL END
         WHERE id = $1 AND book_id = $8 RETURNING *`,
        [req.params.id, disposed, disposed_at, disposal_type, disposal_amount, disposal_note, disposalTxnId, bookId]
      )).rows[0];
    });
    res.json(row);
  })
);

// Candidate transactions to LINK as sale proceeds: recent income / transfer rows
// (the kinds that represent money coming in), newest first.
vehicles.get(
  '/:id/proceeds-candidates',
  ah(async (req, res) => {
    await ownedVehicle(req);
    const rows = await query(
      `SELECT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.direction,
              t.merchant, t.description, a.name AS account_name
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.book_id = $1 AND t.direction IN ('income','transfer')
       ORDER BY t.txn_date DESC, t.id DESC LIMIT 50`,
      [hh(req)]
    );
    res.json(rows);
  })
);

// --- Odometer reading history (dated snapshots; latest drives odometer_current) ---
// Keep the vehicle's odometer_current in sync with its latest-dated reading, so
// everything derived from it (miles driven, cost/mile) follows the snapshots.
async function syncCurrentOdometer(client: any, vehicleId: number) {
  await client.query(
    `UPDATE vehicles SET odometer_current = COALESCE(
       (SELECT reading FROM vehicle_odometer_readings WHERE vehicle_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1),
       odometer_current)
     WHERE id = $1`,
    [vehicleId]
  );
}

// A completed maintenance with a mileage records an odometer snapshot at its service
// date. Re-derived on every maintenance save so editing the date/odometer moves or
// updates the snapshot (and clears it if the item is no longer completed / has no
// mileage). The snapshot is linked back via maintenance_id.
async function syncMaintenanceReading(
  client: any, vehicleId: string | number, maintenanceId: number,
  status: string, serviceDate: string | null, odometer: number | null, bookId: number
) {
  await client.query(
    `DELETE FROM vehicle_odometer_readings WHERE maintenance_id = $1 AND vehicle_id = $2 AND book_id = $3`,
    [maintenanceId, vehicleId, bookId]
  );
  if (status === 'completed' && odometer != null && serviceDate) {
    await client.query(
      `INSERT INTO vehicle_odometer_readings (vehicle_id, reading, as_of, book_id, maintenance_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vehicle_id, as_of) DO UPDATE SET reading = EXCLUDED.reading, maintenance_id = EXCLUDED.maintenance_id`,
      [vehicleId, odometer, serviceDate, bookId, maintenanceId]
    );
  }
  await syncCurrentOdometer(client, Number(vehicleId));
}

vehicles.get(
  '/:id/odometer',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `SELECT id, to_char(as_of,'YYYY-MM-DD') AS as_of, reading AS value FROM vehicle_odometer_readings
       WHERE vehicle_id = $1 AND book_id = $2 ORDER BY as_of`,
      [req.params.id, hh(req)]
    ));
  })
);

vehicles.post(
  '/:id/odometer',
  ah(async (req, res) => {
    require_(req.body, ['reading']);
    const bookId = hh(req);
    await ownedVehicle(req);
    // Odometer readings are whole miles >= 0.
    const reading = Math.round(money(req.body?.reading, 'reading', { min: 0 }));
    const as_of = optionalDateOnly(req.body?.as_of, 'as_of');
    const row = await withTransaction(async (client) => {
      // An odometer only goes up: the reading can't be below the purchase mileage
      // or any earlier-dated reading, nor above any later-dated reading. The same
      // date (ON CONFLICT update) is excluded via the strict </> comparisons.
      const b = (await client.query(
        `SELECT
           (SELECT odometer_start FROM vehicles WHERE id = $1 AND book_id = $2) AS start,
           (SELECT MAX(reading) FROM vehicle_odometer_readings
              WHERE vehicle_id = $1 AND book_id = $2 AND as_of < COALESCE($3::date, CURRENT_DATE)) AS prev_max,
           (SELECT MIN(reading) FROM vehicle_odometer_readings
              WHERE vehicle_id = $1 AND book_id = $2 AND as_of > COALESCE($3::date, CURRENT_DATE)) AS next_min`,
        [req.params.id, bookId, as_of ?? null]
      )).rows[0];
      const lower = Math.max(
        b.start != null ? Number(b.start) : -Infinity,
        b.prev_max != null ? Number(b.prev_max) : -Infinity
      );
      if (reading < lower) {
        const why = b.prev_max != null && Number(b.prev_max) === lower ? 'an earlier reading' : 'the purchase mileage';
        throw new HttpError(400, `Odometer reading can't be lower than ${why} (${lower.toLocaleString()} mi).`);
      }
      if (b.next_min != null && reading > Number(b.next_min)) {
        throw new HttpError(400, `Odometer reading can't be higher than a later reading (${Number(b.next_min).toLocaleString()} mi).`);
      }
      const r = (await client.query(
        `INSERT INTO vehicle_odometer_readings (vehicle_id, reading, as_of, book_id)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4)
         ON CONFLICT (vehicle_id, as_of) DO UPDATE SET reading = EXCLUDED.reading
         RETURNING id, to_char(as_of,'YYYY-MM-DD') AS as_of, reading AS value`,
        [req.params.id, reading, as_of ?? null, bookId]
      )).rows[0];
      await syncCurrentOdometer(client, Number(req.params.id));
      return r;
    });
    res.status(201).json(row);
  })
);

vehicles.delete(
  '/:id/odometer/:readingId',
  ah(async (req, res) => {
    await ownedVehicle(req);
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM vehicle_odometer_readings WHERE id = $1 AND vehicle_id = $2 AND book_id = $3`, [req.params.readingId, req.params.id, hh(req)]);
      await syncCurrentOdometer(client, Number(req.params.id));
    });
    res.status(204).end();
  })
);

// --- Value snapshots (the value on a date; latest = current value / net worth) ---
// Keep current_value in sync with the latest-dated value snapshot.
async function syncVehicleValue(client: any, vehicleId: number) {
  await client.query(
    `UPDATE vehicles SET current_value = COALESCE(
       (SELECT value FROM vehicle_values WHERE vehicle_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1),
       current_value)
     WHERE id = $1`,
    [vehicleId]
  );
}

vehicles.get(
  '/:id/values',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `SELECT id, to_char(as_of,'YYYY-MM-DD') AS as_of, value FROM vehicle_values
       WHERE vehicle_id = $1 AND book_id = $2 ORDER BY as_of`,
      [req.params.id, hh(req)]
    ));
  })
);

vehicles.post(
  '/:id/values',
  ah(async (req, res) => {
    require_(req.body, ['value']);
    const bookId = hh(req);
    await ownedVehicle(req);
    const value = money(req.body?.value, 'value', { min: 0 });
    const as_of = optionalDateOnly(req.body?.as_of, 'as_of');
    const row = await withTransaction(async (client) => {
      const r = (await client.query(
        `INSERT INTO vehicle_values (vehicle_id, value, as_of, book_id)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4)
         ON CONFLICT (vehicle_id, as_of) DO UPDATE SET value = EXCLUDED.value
         RETURNING id, to_char(as_of,'YYYY-MM-DD') AS as_of, value`,
        [req.params.id, value, as_of ?? null, bookId]
      )).rows[0];
      await syncVehicleValue(client, Number(req.params.id));
      return r;
    });
    res.status(201).json(row);
  })
);

vehicles.delete(
  '/:id/values/:valueId',
  ah(async (req, res) => {
    await ownedVehicle(req);
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM vehicle_values WHERE id = $1 AND vehicle_id = $2 AND book_id = $3`, [req.params.valueId, req.params.id, hh(req)]);
      await syncVehicleValue(client, Number(req.params.id));
    });
    res.status(204).end();
  })
);

// --- Warranties (zero or more rows: powertrain, bumper-to-bumper, extended, …) ---
const warrantyCols = `id, coverage, provider, to_char(expiration,'YYYY-MM-DD') AS expiration, expires_miles, cost, cost_in_purchase_price, transaction_id, notes, sort_order`;

vehicles.get(
  '/:id/warranties',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `SELECT ${warrantyCols} FROM vehicle_warranties WHERE vehicle_id = $1 AND book_id = $2 ORDER BY sort_order, id`,
      [req.params.id, hh(req)]
    ));
  })
);

// Replace the full set of warranty rows for a vehicle (the editor edits them as a
// table). Validates every row up front, then swaps them atomically. Empty array
// (or all-blank rows) clears the warranties — i.e. "no warranty".
vehicles.put(
  '/:id/warranties',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedVehicle(req);
    const input = Array.isArray(req.body?.warranties) ? req.body.warranties : [];
    const rows = input
      .map((w: any, i: number) => {
        // When the cost is bundled into the purchase price, there's no separate
        // transaction to link.
        const inPrice = !!w?.cost_in_purchase_price;
        return {
          coverage: optionalString(w?.coverage, `warranties[${i}].coverage`),
          provider: optionalString(w?.provider, `warranties[${i}].provider`),
          expiration: optionalDateOnly(w?.expiration, `warranties[${i}].expiration`),
          // Absolute odometer reading at which the warranty expires.
          expires_miles: optionalMoney(w?.expires_miles, `warranties[${i}].expires_miles`),
          cost: optionalMoney(w?.cost, `warranties[${i}].cost`),
          cost_in_purchase_price: inPrice,
          transaction_id: inPrice ? null : intOrNull(w?.transaction_id),
          notes: optionalString(w?.notes, `warranties[${i}].notes`),
        };
      })
      // Drop fully-blank rows so a stray empty table row isn't persisted.
      .filter((w: any) => w.coverage || w.provider || w.expiration || w.expires_miles != null || w.cost != null || w.notes);
    // A linked transaction must belong to this book (prevents storing a
    // cross-book transaction_id — mirrors the maintenance-row validation).
    for (let i = 0; i < rows.length; i++) {
      rows[i].transaction_id = await ownedRef('transaction', rows[i].transaction_id, bookId, `warranties[${i}].transaction_id`);
    }
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM vehicle_warranties WHERE vehicle_id = $1 AND book_id = $2`, [req.params.id, bookId]);
      for (let i = 0; i < rows.length; i++) {
        const w = rows[i];
        await client.query(
          `INSERT INTO vehicle_warranties (vehicle_id, book_id, coverage, provider, expiration, expires_miles, cost, cost_in_purchase_price, transaction_id, notes, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [req.params.id, bookId, w.coverage, w.provider, w.expiration, w.expires_miles, w.cost, w.cost_in_purchase_price, w.transaction_id, w.notes, i]
        );
      }
    });
    res.json(await query(
      `SELECT ${warrantyCols} FROM vehicle_warranties WHERE vehicle_id = $1 AND book_id = $2 ORDER BY sort_order, id`,
      [req.params.id, bookId]
    ));
  })
);

// --- Maintenance log (completed history + scheduled upcoming items) ---
const maintenanceCols = `
  m.id, m.item, m.status,
  to_char(m.service_date,'YYYY-MM-DD') AS service_date, m.odometer, m.cost,
  m.transaction_id, to_char(m.due_date,'YYYY-MM-DD') AS due_date, m.due_odometer,
  m.vendor, m.notes,
  to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount AS txn_amount, t.merchant AS txn_merchant,
  (SELECT count(*)::int FROM vehicle_documents d WHERE d.maintenance_id = m.id) AS doc_count`;

vehicles.get(
  '/:id/maintenance',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `SELECT ${maintenanceCols}
       FROM vehicle_maintenance m LEFT JOIN transactions t ON t.id = m.transaction_id
       WHERE m.vehicle_id = $1 AND m.book_id = $2
       ORDER BY COALESCE(m.service_date, m.due_date) DESC NULLS LAST, m.id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

vehicles.post(
  '/:id/maintenance',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedVehicle(req);
    const b = req.body ?? {};
    await validateMaintenance(b, bookId);
    const status = optionalEnumValue(b.status, 'status', MAINTENANCE_STATUSES) ?? 'completed';
    const odo = intOrNull(b.odometer);
    const row = await withTransaction(async (client) => {
      const r = (await client.query(
        `INSERT INTO vehicle_maintenance
           (vehicle_id, book_id, item, status, service_date, odometer, cost, transaction_id, due_date, due_odometer, vendor, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.params.id, bookId, b.item, status, b.service_date ?? null, odo, b.cost ?? null,
         b.transaction_id ?? null, b.due_date ?? null, intOrNull(b.due_odometer), b.vendor ?? null, b.notes ?? null]
      )).rows[0];
      await syncMaintenanceReading(client, req.params.id, r.id, status, b.service_date ?? null, odo, bookId);
      return r;
    });
    res.status(201).json(row);
  })
);

vehicles.put(
  '/:id/maintenance/:mid',
  ah(async (req, res) => {
    const bookId = hh(req);
    await ownedVehicle(req);
    const b = req.body ?? {};
    await validateMaintenance(b, bookId);
    const status = optionalEnumValue(b.status, 'status', MAINTENANCE_STATUSES) ?? 'completed';
    const odo = intOrNull(b.odometer);
    const row = await withTransaction(async (client) => {
      const r = (await client.query(
        `UPDATE vehicle_maintenance SET
           item = $3, status = $4, service_date = $5, odometer = $6, cost = $7,
           transaction_id = $8, due_date = $9, due_odometer = $10, vendor = $11, notes = $12
         WHERE id = $1 AND vehicle_id = $2 AND book_id = $13 RETURNING id`,
        [req.params.mid, req.params.id, b.item, status, b.service_date ?? null, odo, b.cost ?? null,
         b.transaction_id ?? null, b.due_date ?? null, intOrNull(b.due_odometer), b.vendor ?? null, b.notes ?? null, bookId]
      )).rows[0];
      if (!r) return null;
      await syncMaintenanceReading(client, req.params.id, Number(req.params.mid), status, b.service_date ?? null, odo, bookId);
      return r;
    });
    if (!row) throw new HttpError(404, 'Maintenance item not found');
    res.json(row);
  })
);

vehicles.delete(
  '/:id/maintenance/:mid',
  ah(async (req, res) => {
    await query(`DELETE FROM vehicle_maintenance WHERE id = $1 AND vehicle_id = $2 AND book_id = $3`, [req.params.mid, req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// --- Documents attached to a specific maintenance record (receipts, invoices) ---
// Stored in vehicle_documents tagged with maintenance_id; the shared file-serve and
// delete routes (/:id/documents/:docId[/file]) handle viewing and removing them.
vehicles.get(
  '/:id/maintenance/:mid/documents',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `SELECT id, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM vehicle_documents WHERE maintenance_id = $1 AND vehicle_id = $2 AND book_id = $3 ORDER BY created_at DESC, id DESC`,
      [req.params.mid, req.params.id, hh(req)]
    ));
  })
);

vehicles.post(
  '/:id/maintenance/:mid/documents',
  ah(async (req, res) => {
    require_(req.body, ['file']);
    const bookId = hh(req);
    await ownedVehicle(req);
    const maint = await one(`SELECT id FROM vehicle_maintenance WHERE id = $1 AND vehicle_id = $2 AND book_id = $3`, [req.params.mid, req.params.id, bookId]);
    if (!maint) throw new HttpError(404, 'Maintenance record not found.');
    const { file, file_mime = null, file_name = null, name = null } = req.body;
    if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
    const safeMime = assertUploadMime(file_mime);
    assertUploadSize(file);
    const buf = Buffer.from(file, 'base64');
    const row = await one(
      `INSERT INTO vehicle_documents (vehicle_id, book_id, maintenance_id, doc_type, name, file, file_mime, file_name)
       VALUES ($1,$2,$3,'maintenance',$4,$5,$6,$7)
       RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
      [req.params.id, bookId, req.params.mid, name || file_name, buf, safeMime, file_name]
    );
    res.status(201).json(row);
  })
);

// Candidate transactions to attach to a maintenance item: expenses already tagged
// to THIS vehicle (so the dropdown only offers relevant transactions), newest first.
vehicles.get(
  '/:id/expense-candidates',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
       SELECT DISTINCT t.id, to_char(t.txn_date,'YYYY-MM-DD') AS txn_date, t.amount, t.merchant, t.description, a.name AS account_name
       FROM eff_tag
       JOIN transactions t ON t.id = eff_tag.id
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE eff_tag.kind = 'vehicle' AND eff_tag.ref_id = $2 AND eff_tag.book_id = $1
         AND eff_tag.direction = 'expense'
       ORDER BY txn_date DESC, t.id DESC LIMIT 50`,
      [hh(req), req.params.id]
    ));
  })
);

// --- Documents / images attached to a vehicle (title, bill of sale, service …) ---
vehicles.get(
  '/:id/documents',
  ah(async (req, res) => {
    await ownedVehicle(req);
    res.json(await query(
      `SELECT id, doc_type, maintenance_id, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
       FROM vehicle_documents WHERE vehicle_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
      [req.params.id, hh(req)]
    ));
  })
);

vehicles.post(
  '/:id/documents',
  ah(async (req, res) => {
    require_(req.body, ['file']);
    const bookId = hh(req);
    await ownedVehicle(req);
    const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
    if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
    // The document is served back inline later, so reject disallowed MIME types up front.
    const safeMime = assertUploadMime(file_mime);
    assertUploadSize(file);
    const buf = Buffer.from(file, 'base64');
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const row = await one(
      `INSERT INTO vehicle_documents (vehicle_id, book_id, doc_type, name, file, file_mime, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
      [req.params.id, bookId, docType, name || file_name, buf, safeMime, file_name]
    );
    res.status(201).json(row);
  })
);

vehicles.get(
  '/:id/documents/:docId/file',
  ah(async (req, res) => {
    await ownedVehicle(req);
    const r = await one<any>(
      `SELECT file, file_mime, file_name FROM vehicle_documents WHERE id = $1 AND vehicle_id = $2 AND book_id = $3`,
      [req.params.docId, req.params.id, hh(req)]
    );
    if (!r || !r.file) throw new HttpError(404, 'Document not found.');
    sendStoredFile(res, r.file, r.file_mime, r.file_name);
  })
);

// Update a document's metadata (name + type), optionally replacing the stored file.
vehicles.put(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await ownedVehicle(req);
    const { name = null, doc_type = null, file = null, file_mime = null, file_name = null } = req.body ?? {};
    const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
    const returning = `RETURNING id, doc_type, maintenance_id, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`;
    let row;
    if (file != null) {
      if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
      const safeMime = assertUploadMime(file_mime);
      assertUploadSize(file);
      const buf = Buffer.from(file, 'base64');
      row = await one(
        `UPDATE vehicle_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
         WHERE id = $6 AND vehicle_id = $7 AND book_id = $8 ${returning}`,
        [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
      );
    } else {
      row = await one(
        `UPDATE vehicle_documents SET name = $1, doc_type = $2
         WHERE id = $3 AND vehicle_id = $4 AND book_id = $5 ${returning}`,
        [name, docType, req.params.docId, req.params.id, hh(req)]
      );
    }
    if (!row) throw new HttpError(404, 'Document not found.');
    res.json(row);
  })
);

vehicles.delete(
  '/:id/documents/:docId',
  ah(async (req, res) => {
    await query(`DELETE FROM vehicle_documents WHERE id = $1 AND vehicle_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
    res.status(204).end();
  })
);

// Permanently delete a vehicle (transactions tagged to it are untagged). Prefer
// POST /:id/dispose to retire a vehicle while keeping its history.
vehicles.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    // insurance_policies is polymorphic (entity_kind/entity_id) with no FK, so its
    // rows must be removed explicitly to avoid orphans when the vehicle is deleted.
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM insurance_policies WHERE entity_kind = 'vehicle' AND entity_id = $1 AND book_id = $2`, [req.params.id, bookId]);
      // line_tags is polymorphic (kind/ref_id, no FK), so untag this vehicle's
      // transactions explicitly — otherwise dead 'vehicle' tags linger (the comment
      // above promised this but it was never done).
      await client.query(`DELETE FROM line_tags WHERE kind = 'vehicle' AND ref_id = $1 AND book_id = $2`, [req.params.id, bookId]);
      await client.query(`DELETE FROM vehicles WHERE id = $1 AND book_id = $2`, [req.params.id, bookId]);
    });
    res.status(204).end();
  })
);

// Quick cost summary (the AI endpoint adds narrative analysis on top of this)
vehicles.get(
  '/:id/summary',
  ah(async (req, res) => {
    res.json(await vehicleSummary(Number(req.params.id), hh(req)));
  })
);

export interface VehicleSummary {
  vehicle: any;
  byCategory: { category_name: string | null; total: number; count: number }[];
  totalSpent: number;
  monthsOwned: number | null;
  milesDriven: number | null;
  depreciation: number | null;
  costPerMonth: number | null;
  costPerMile: number | null;
  maintenanceCost: number;
  maintenanceCount: number;
}

export async function vehicleSummary(id: number, bookId: number): Promise<VehicleSummary> {
  const vehicle = await one(`SELECT * FROM vehicles WHERE id = $1 AND book_id = $2`, [id, bookId]);
  if (!vehicle) throw new HttpError(404, 'Vehicle not found');

  const byCategory = await query(
    `WITH ${EFFECTIVE_LINES}, ${EFFECTIVE_LINE_TAGS}
     SELECT c.name AS category_name, SUM(eff_tag.amount) AS total, COUNT(*)::int AS count
     FROM eff_tag LEFT JOIN categories c ON c.id = eff_tag.category_id
     WHERE eff_tag.kind = 'vehicle' AND eff_tag.ref_id = $1 AND eff_tag.direction = 'expense'
       AND eff_tag.book_id = $2
     GROUP BY c.name ORDER BY total DESC`,
    [id, bookId]
  );
  const totalSpent = byCategory.reduce((s, r: any) => s + Number(r.total), 0);

  // Recorded maintenance cost (completed items): linked transaction amount, else
  // the manually entered cost. Shown separately from tagged-transaction spending.
  const maint = await one<{ total: string; count: number }>(
    `SELECT COALESCE(SUM(COALESCE(t.amount, vm.cost)),0) AS total, COUNT(*)::int AS count
     FROM vehicle_maintenance vm LEFT JOIN transactions t ON t.id = vm.transaction_id
     WHERE vm.vehicle_id = $1 AND vm.book_id = $2 AND vm.status = 'completed'`,
    [id, bookId]
  );
  const maintenanceCost = Number(maint?.total ?? 0);
  const maintenanceCount = maint?.count ?? 0;

  const v: any = vehicle;
  const monthsOwned = v.purchase_date
    ? Math.max(
        1,
        Math.round((Date.now() - new Date(v.purchase_date).getTime()) / (1000 * 60 * 60 * 24 * 30.44))
      )
    : null;
  const milesDriven =
    v.odometer_current != null && v.odometer_start != null
      ? v.odometer_current - v.odometer_start
      : null;
  const depreciation =
    v.purchase_price != null && v.current_value != null ? v.purchase_price - v.current_value : null;

  const totalCostOfOwnership = totalSpent + (depreciation ?? 0);
  const costPerMonth = monthsOwned ? totalCostOfOwnership / monthsOwned : null;
  const costPerMile = milesDriven ? totalCostOfOwnership / milesDriven : null;

  return {
    vehicle,
    byCategory,
    totalSpent,
    monthsOwned,
    milesDriven,
    depreciation,
    costPerMonth,
    costPerMile,
    maintenanceCost,
    maintenanceCount,
  };
}

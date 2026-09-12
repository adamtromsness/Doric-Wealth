import { Router } from 'express';
import { query, one, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { assertUploadMime, assertUploadSize, sendStoredFile } from '../uploads.js';
import { mountInsuranceRoutes } from './insuranceRoutes.js';
import { requiredString, optionalEnumValue, optionalMoney, optionalDateOnly } from '../validation.js';

export const assets = Router();

export const ASSET_TYPES = ['property', 'rv', 'airplane', 'boat', 'equipment', 'collectible', 'other'] as const;
const bool = (v: any) => (v == null ? null : !!v);

// Confirm an asset belongs to the active book, or 404.
async function ownedAsset(req: any): Promise<number> {
  const a = await one<{ id: number }>(`SELECT id FROM assets WHERE id = $1 AND book_id = $2`, [req.params.id, hh(req)]);
  if (!a) throw new HttpError(404, 'Asset not found');
  return a.id;
}

// Insurance policies (carrier, premium, renewal) — shared with vehicles/properties.
mountInsuranceRoutes(assets, 'asset', ownedAsset);

function validateAsset(b: any): void {
  optionalEnumValue(b.asset_type, 'asset_type', ASSET_TYPES);
  optionalMoney(b.value, 'value');
  optionalMoney(b.purchase_price, 'purchase_price');
  optionalDateOnly(b.purchase_date, 'purchase_date');
}

assets.get(
  '/',
  ah(async (req, res) => {
    res.json(await query(`SELECT * FROM assets WHERE book_id = $1 ORDER BY asset_type, name`, [hh(req)]));
  })
);

assets.post(
  '/',
  ah(async (req, res) => {
    require_(req.body, ['name']);
    const b = req.body;
    requiredString(b.name, 'name');
    validateAsset(b);
    const row = await one(
      `INSERT INTO assets (name, asset_type, value, purchase_price, purchase_date, notes,
         tracks_value, has_maintenance, has_insurance, has_documents, book_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.name, b.asset_type ?? 'property', b.value ?? null, b.purchase_price ?? null, b.purchase_date ?? null, b.notes ?? null,
       bool(b.tracks_value) ?? false, bool(b.has_maintenance) ?? false, bool(b.has_insurance) ?? false, bool(b.has_documents) ?? false, hh(req)]
    );
    res.status(201).json(row);
  })
);

assets.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body;
    validateAsset(b);
    const row = await one(
      `UPDATE assets SET
         name = COALESCE($2, name), asset_type = COALESCE($3, asset_type),
         value = $4, purchase_price = $5, purchase_date = $6, notes = $7,
         tracks_value = COALESCE($9, tracks_value), has_maintenance = COALESCE($10, has_maintenance),
         has_insurance = COALESCE($11, has_insurance), has_documents = COALESCE($12, has_documents)
       WHERE id = $1 AND book_id = $8 RETURNING *`,
      [req.params.id, b.name ?? null, b.asset_type ?? null, b.value ?? null, b.purchase_price ?? null, b.purchase_date ?? null, b.notes ?? null, hh(req),
       bool(b.tracks_value), bool(b.has_maintenance), bool(b.has_insurance), bool(b.has_documents)]
    );
    if (!row) throw new HttpError(404, 'Asset not found');
    res.json(row);
  })
);

assets.delete(
  '/:id',
  ah(async (req, res) => {
    const bookId = hh(req);
    // Remove polymorphic insurance_policies rows (no FK) to avoid orphans.
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM insurance_policies WHERE entity_kind = 'asset' AND entity_id = $1 AND book_id = $2`, [req.params.id, bookId]);
      await client.query(`DELETE FROM assets WHERE id = $1 AND book_id = $2`, [req.params.id, bookId]);
    });
    res.status(204).end();
  })
);

// --- Value snapshots (latest drives the asset's current value) ---------------
assets.get('/:id/values', ah(async (req, res) => {
  await ownedAsset(req);
  res.json(await query(
    `SELECT id, to_char(as_of,'YYYY-MM-DD') AS as_of, value FROM asset_values
     WHERE asset_id = $1 AND book_id = $2 ORDER BY as_of`,
    [req.params.id, hh(req)]
  ));
}));

assets.post('/:id/values', ah(async (req, res) => {
  const assetId = await ownedAsset(req);
  const value = optionalMoney(req.body?.value, 'value');
  if (value == null) throw new HttpError(400, 'value is required.');
  const as_of = optionalDateOnly(req.body?.as_of, 'as_of');
  await one(
    `INSERT INTO asset_values (asset_id, book_id, as_of, value)
     VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4)
     ON CONFLICT (asset_id, as_of) DO UPDATE SET value = EXCLUDED.value
     RETURNING id`,
    [assetId, hh(req), as_of, value]
  );
  // Latest snapshot anchors the asset's current value.
  await query(
    `UPDATE assets SET value = (SELECT value FROM asset_values WHERE asset_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1)
     WHERE id = $1 AND book_id = $2`,
    [assetId, hh(req)]
  );
  res.status(201).json({ ok: true });
}));

assets.delete('/:id/values/:vid', ah(async (req, res) => {
  const assetId = await ownedAsset(req);
  await query(`DELETE FROM asset_values WHERE id = $1 AND asset_id = $2 AND book_id = $3`, [req.params.vid, assetId, hh(req)]);
  await query(
    `UPDATE assets SET value = (SELECT value FROM asset_values WHERE asset_id = $1 ORDER BY as_of DESC, id DESC LIMIT 1)
     WHERE id = $1 AND book_id = $2`,
    [assetId, hh(req)]
  );
  res.status(204).end();
}));

// --- Maintenance (completed history + upcoming items) ------------------------
const MAINT_COLS = `id, item, status, to_char(service_date,'YYYY-MM-DD') AS service_date, cost,
  transaction_id, to_char(due_date,'YYYY-MM-DD') AS due_date, vendor, notes`;
const mStr = (v: any) => (v == null || v === '' ? null : String(v));
const mNum = (v: any) => (v == null || v === '' ? null : Number(v));

assets.get('/:id/maintenance', ah(async (req, res) => {
  await ownedAsset(req);
  res.json(await query(
    `SELECT ${MAINT_COLS} FROM asset_maintenance WHERE asset_id = $1 AND book_id = $2
     ORDER BY COALESCE(service_date, due_date) DESC NULLS LAST, id DESC`,
    [req.params.id, hh(req)]
  ));
}));

assets.post('/:id/maintenance', ah(async (req, res) => {
  const assetId = await ownedAsset(req);
  const b = req.body ?? {};
  const item = requiredString(b.item, 'item');
  const status = b.status === 'upcoming' ? 'upcoming' : 'completed';
  const row = await one(
    `INSERT INTO asset_maintenance (asset_id, book_id, item, status, service_date, cost, due_date, vendor, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${MAINT_COLS}`,
    [assetId, hh(req), item, status, b.service_date || null, mNum(b.cost), b.due_date || null, mStr(b.vendor), mStr(b.notes)]
  );
  res.status(201).json(row);
}));

assets.put('/:id/maintenance/:mid', ah(async (req, res) => {
  await ownedAsset(req);
  const b = req.body ?? {};
  const row = await one(
    `UPDATE asset_maintenance SET item = $1, status = $2, service_date = $3, cost = $4, due_date = $5, vendor = $6, notes = $7
     WHERE id = $8 AND asset_id = $9 AND book_id = $10 RETURNING ${MAINT_COLS}`,
    [mStr(b.item) ?? '', b.status === 'upcoming' ? 'upcoming' : 'completed', b.service_date || null, mNum(b.cost), b.due_date || null, mStr(b.vendor), mStr(b.notes), req.params.mid, req.params.id, hh(req)]
  );
  if (!row) throw new HttpError(404, 'Maintenance item not found');
  res.json(row);
}));

assets.delete('/:id/maintenance/:mid', ah(async (req, res) => {
  await query(`DELETE FROM asset_maintenance WHERE id = $1 AND asset_id = $2 AND book_id = $3`, [req.params.mid, req.params.id, hh(req)]);
  res.status(204).end();
}));

// --- Documents ---------------------------------------------------------------
assets.get('/:id/documents', ah(async (req, res) => {
  await ownedAsset(req);
  res.json(await query(
    `SELECT id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at
     FROM asset_documents WHERE asset_id = $1 AND book_id = $2 ORDER BY created_at DESC, id DESC`,
    [req.params.id, hh(req)]
  ));
}));

assets.post('/:id/documents', ah(async (req, res) => {
  require_(req.body, ['file']);
  const assetId = await ownedAsset(req);
  const { file, file_mime = null, file_name = null, name = null, doc_type = null } = req.body;
  if (typeof file !== 'string') throw new HttpError(400, 'file must be a base64 string.');
  const safeMime = assertUploadMime(file_mime);
  assertUploadSize(file);
  const buf = Buffer.from(file, 'base64');
  const docType = typeof doc_type === 'string' && doc_type.trim() ? doc_type.trim() : 'other';
  const row = await one(
    `INSERT INTO asset_documents (asset_id, book_id, doc_type, name, file, file_mime, file_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, doc_type, name, file_name, file_mime, to_char(created_at,'YYYY-MM-DD') AS created_at`,
    [assetId, hh(req), docType, name || file_name, buf, safeMime, file_name]
  );
  res.status(201).json(row);
}));

assets.put('/:id/documents/:docId', ah(async (req, res) => {
  await ownedAsset(req);
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
      `UPDATE asset_documents SET name = $1, doc_type = $2, file = $3, file_mime = $4, file_name = $5
       WHERE id = $6 AND asset_id = $7 AND book_id = $8 ${returning}`,
      [name, docType, buf, safeMime, file_name, req.params.docId, req.params.id, hh(req)]
    );
  } else {
    row = await one(
      `UPDATE asset_documents SET name = $1, doc_type = $2
       WHERE id = $3 AND asset_id = $4 AND book_id = $5 ${returning}`,
      [name, docType, req.params.docId, req.params.id, hh(req)]
    );
  }
  if (!row) throw new HttpError(404, 'Document not found.');
  res.json(row);
}));

assets.get('/:id/documents/:docId/file', ah(async (req, res) => {
  await ownedAsset(req);
  const r = await one<any>(
    `SELECT file, file_mime, file_name FROM asset_documents WHERE id = $1 AND asset_id = $2 AND book_id = $3`,
    [req.params.docId, req.params.id, hh(req)]
  );
  if (!r || !r.file) throw new HttpError(404, 'Document not found.');
  sendStoredFile(res, r.file, r.file_mime, r.file_name);
}));

assets.delete('/:id/documents/:docId', ah(async (req, res) => {
  await query(`DELETE FROM asset_documents WHERE id = $1 AND asset_id = $2 AND book_id = $3`, [req.params.docId, req.params.id, hh(req)]);
  res.status(204).end();
}));

import type { Router } from 'express';
import { query, one } from '../db.js';
import { ah, HttpError } from '../http.js';
import { hh } from '../tenant.js';
import { optionalString, optionalMoney, optionalEnumValue, optionalDateOnly } from '../validation.js';

const COLS = `id, entity_kind, entity_id, policy_type, carrier, policy_number, premium,
  premium_cycle, coverage, deductible, agent_name, agent_phone,
  to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(renewal_date,'YYYY-MM-DD') AS renewal_date, notes`;

const PREMIUM_CYCLES = ['monthly', 'quarterly', 'semiannual', 'annual'] as const;

// Validate + normalize a policy body. Money is bounded non-negative, the cycle is
// enum-checked, dates are real dates, and free text is length-capped — replacing the
// old coercers that let NaN/Infinity/negative money and unbounded strings through.
function policyValues(b: any) {
  return {
    policy_type: optionalString(b.policy_type, 'policy_type', { max: 120 }),
    carrier: optionalString(b.carrier, 'carrier', { max: 120 }),
    policy_number: optionalString(b.policy_number, 'policy_number', { max: 120 }),
    premium: optionalMoney(b.premium, 'premium', { min: 0 }),
    premium_cycle: optionalEnumValue(b.premium_cycle, 'premium_cycle', PREMIUM_CYCLES) ?? 'monthly',
    coverage: optionalString(b.coverage, 'coverage', { max: 2000 }),
    deductible: optionalMoney(b.deductible, 'deductible', { min: 0 }),
    agent_name: optionalString(b.agent_name, 'agent_name', { max: 120 }),
    agent_phone: optionalString(b.agent_phone, 'agent_phone', { max: 60 }),
    start_date: optionalDateOnly(b.start_date, 'start_date'),
    renewal_date: optionalDateOnly(b.renewal_date, 'renewal_date'),
    notes: optionalString(b.notes, 'notes', { max: 2000 }),
  };
}

// Register CRUD endpoints for insurance policies on `router`, scoped to an owning
// entity (vehicle or property). `owned(req)` must 404 if the entity isn't the
// caller's. Mirrors the EntityDocuments REST shape: GET/POST at base, PUT/DELETE by id.
export function mountInsuranceRoutes(router: Router, kind: 'vehicle' | 'property' | 'asset', owned: (req: any) => Promise<number>) {
  router.get('/:id/insurance', ah(async (req, res) => {
    const entityId = await owned(req);
    res.json(await query(
      `SELECT ${COLS} FROM insurance_policies
       WHERE entity_kind = $1 AND entity_id = $2 AND book_id = $3
       ORDER BY renewal_date NULLS LAST, id`,
      [kind, entityId, hh(req)]
    ));
  }));

  router.post('/:id/insurance', ah(async (req, res) => {
    const entityId = await owned(req);
    const v = policyValues(req.body ?? {});
    const row = await one(
      `INSERT INTO insurance_policies
        (book_id, entity_kind, entity_id, policy_type, carrier, policy_number, premium,
         premium_cycle, coverage, deductible, agent_name, agent_phone, start_date, renewal_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${COLS}`,
      [hh(req), kind, entityId, v.policy_type, v.carrier, v.policy_number, v.premium,
       v.premium_cycle, v.coverage, v.deductible, v.agent_name, v.agent_phone,
       v.start_date, v.renewal_date, v.notes]
    );
    res.status(201).json(row);
  }));

  router.put('/:id/insurance/:pid', ah(async (req, res) => {
    const entityId = await owned(req);
    const v = policyValues(req.body ?? {});
    const row = await one(
      `UPDATE insurance_policies SET
         policy_type = $1, carrier = $2, policy_number = $3, premium = $4, premium_cycle = $5,
         coverage = $6, deductible = $7, agent_name = $8, agent_phone = $9,
         start_date = $10, renewal_date = $11, notes = $12
       WHERE id = $13 AND entity_kind = $14 AND entity_id = $15 AND book_id = $16 RETURNING ${COLS}`,
      [v.policy_type, v.carrier, v.policy_number, v.premium, v.premium_cycle,
       v.coverage, v.deductible, v.agent_name, v.agent_phone,
       v.start_date, v.renewal_date, v.notes,
       req.params.pid, kind, entityId, hh(req)]
    );
    if (!row) throw new HttpError(404, 'Policy not found');
    res.json(row);
  }));

  router.delete('/:id/insurance/:pid', ah(async (req, res) => {
    const entityId = await owned(req);
    await query(
      `DELETE FROM insurance_policies WHERE id = $1 AND entity_kind = $2 AND entity_id = $3 AND book_id = $4`,
      [req.params.pid, kind, entityId, hh(req)]
    );
    res.status(204).end();
  }));
}

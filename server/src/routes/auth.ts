import { Router } from 'express';
import { one, query, withTransaction } from '../db.js';
import { ah, require_, HttpError } from '../http.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyOtherSessions,
  SESSION_COOKIE, sessionCookieOptions,
} from '../auth.js';
import { requireAuth, mePayload } from '../tenant.js';
import { rateLimit } from '../rateLimit.js';
import { config } from '../config.js';

export const auth = Router();

// One place for the password rule, so registration and password change can't drift.
const MIN_PASSWORD_LENGTH = 8;

// Shape the AI-settings response (the raw key is never returned — only a masked hint).
function aiSettingsPayload(row: { ai_api_key: string | null; ai_model: string | null } | null) {
  const key = row?.ai_api_key?.trim() || '';
  return {
    configured: Boolean(key || config.anthropicApiKey),
    user_key_set: Boolean(key),
    key_hint: key ? `…${key.slice(-4)}` : null,
    env_fallback: Boolean(config.anthropicApiKey),
    model: (row?.ai_model?.trim()) || config.anthropicModel,
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Throttle credential endpoints to blunt brute-force / enumeration (per IP).
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: 'login:', message: 'Too many login attempts. Please wait a few minutes and try again.' });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, keyPrefix: 'register:', message: 'Too many sign-up attempts. Please wait and try again.' });
// Changing a password requires presenting the current one, so this route guesses
// credentials just like login does — rate-limit it even though the caller is
// already authenticated (a stolen session shouldn't become a password oracle).
const passwordLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyPrefix: 'password:', message: 'Too many password attempts. Please wait a few minutes and try again.' });

// Register a new user, give them a brand-new book they own, and log them in.
auth.post(
  '/register',
  registerLimiter,
  ah(async (req, res) => {
    require_(req.body, ['email', 'password']);
    const email = String(req.body.email).trim();
    const password = String(req.body.password);
    const name = req.body.name ? String(req.body.name).trim() : null;
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

    const exists = await one(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
    if (exists) throw new HttpError(409, 'An account with that email already exists.');

    const { hash, salt } = hashPassword(password);
    const bookName = req.body.book_name
      ? String(req.body.book_name).trim()
      : `${name || email.split('@')[0]}'s Book`;

    const { userId, bookId } = await withTransaction(async (client) => {
      const uid = (await client.query(
        `INSERT INTO users (email, name, password_hash, password_salt, last_login_at) VALUES ($1,$2,$3,$4, now()) RETURNING id`,
        [email, name, hash, salt]
      )).rows[0].id;
      const hid = (await client.query(
        `INSERT INTO books (name) VALUES ($1) RETURNING id`,
        [bookName]
      )).rows[0].id;
      await client.query(
        `INSERT INTO memberships (user_id, book_id, role) VALUES ($1,$2,'owner')`,
        [uid, hid]
      );
      return { userId: uid, bookId: hid };
    });

    const token = await createSession(userId, bookId);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.status(201).json(await mePayload(userId, bookId));
  })
);

auth.post(
  '/login',
  loginLimiter,
  ah(async (req, res) => {
    require_(req.body, ['email', 'password']);
    const email = String(req.body.email).trim();
    const password = String(req.body.password);
    const user = await one<any>(
      `SELECT id, password_hash, password_salt FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    // Constant-ish: only reveal a generic error either way.
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      throw new HttpError(401, 'Incorrect email or password.');
    }
    const firstHh = await one<{ book_id: number }>(
      `SELECT book_id FROM memberships WHERE user_id = $1 ORDER BY book_id LIMIT 1`,
      [user.id]
    );
    const activeId = firstHh?.book_id ?? null;
    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const token = await createSession(user.id, activeId);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json(await mePayload(user.id, activeId));
  })
);

auth.post(
  '/logout',
  ah(async (req, res) => {
    if (req.sessionToken) await destroySession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.status(204).end();
  })
);

// Change the signed-in user's password. Requires the current password, so a stolen
// session alone can't lock the real owner out. On success every OTHER session is
// revoked: changing a password is what a user does when they suspect compromise,
// and it would be worthless if the attacker's session survived it.
auth.put(
  '/password',
  requireAuth,
  passwordLimiter,
  ah(async (req, res) => {
    require_(req.body, ['current_password', 'new_password']);
    const current = String(req.body.current_password);
    const next = String(req.body.new_password);
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const user = await one<{ password_hash: string; password_salt: string }>(
      `SELECT password_hash, password_salt FROM users WHERE id = $1`,
      [req.user!.id]
    );
    if (!user || !verifyPassword(current, user.password_hash, user.password_salt)) {
      throw new HttpError(401, 'Current password is incorrect.');
    }
    if (verifyPassword(next, user.password_hash, user.password_salt)) {
      throw new HttpError(400, 'The new password must be different from the current one.');
    }
    const { hash, salt } = hashPassword(next);
    await query(`UPDATE users SET password_hash = $2, password_salt = $3 WHERE id = $1`,
      [req.user!.id, hash, salt]);
    const ended = await destroyOtherSessions(req.user!.id, req.sessionToken);
    res.json({ ended });
  })
);

// Sign out everywhere: ends this user's other sessions and keeps the caller's own,
// so the tab making the request stays usable. The lever to pull after a lost device.
auth.post(
  '/logout-all',
  requireAuth,
  ah(async (req, res) => {
    const ended = await destroyOtherSessions(req.user!.id, req.sessionToken);
    res.json({ ended });
  })
);

auth.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    res.json(await mePayload(req.user!.id, req.book?.id ?? null));
  })
);

// All editable 1:1 profile fields and how to coerce each. Used by GET/PUT /profile.
const PROFILE_FIELDS: Record<string, 'text' | 'date' | 'num' | 'int'> = {
  first_name: 'text', middle_name: 'text', last_name: 'text', preferred_name: 'text', dob: 'date',
  phone: 'text', address_line1: 'text', address_line2: 'text', city: 'text', state_region: 'text', postal_code: 'text', country: 'text',
  employer: 'text', job_title: 'text', employment_status: 'text', industry: 'text', annual_income: 'num', employment_start: 'date',
  target_retirement_age: 'int', target_retirement_date: 'date', desired_monthly_income: 'num', monthly_contribution: 'num', retirement_notes: 'text',
  emergency_name: 'text', emergency_relationship: 'text', emergency_phone: 'text', emergency_email: 'text',
  timezone: 'text', // IANA zone, e.g. 'America/Los_Angeles'; drives user-local "today"
};
const strOrNull = (v: any): string | null => { const s = String(v ?? '').trim(); return s || null; };
const dateOrNull = (v: any, field = 'Date'): string | null => {
  const s = strOrNull(v); if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${field} must be a valid date.`);
  return s;
};
const coerceField = (type: string, v: any, field: string): any => {
  const s = strOrNull(v); if (s == null) return null;
  if (type === 'text') return s;
  if (type === 'date') return dateOrNull(s, field);
  const n = Number(s);
  // isFinite (not isNaN) so "Infinity"/"-Infinity" are rejected too, not just NaN.
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);
  if (type === 'int' && !Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number.`);
  return n;
};
// SELECT list returning every profile field with dates/numerics in client-friendly form.
const PROFILE_SELECT = `id, email, name, first_name, middle_name, last_name, preferred_name,
  to_char(dob,'YYYY-MM-DD') AS dob,
  phone, address_line1, address_line2, city, state_region, postal_code, country,
  employer, job_title, employment_status, industry, annual_income::float8 AS annual_income, to_char(employment_start,'YYYY-MM-DD') AS employment_start,
  target_retirement_age, to_char(target_retirement_date,'YYYY-MM-DD') AS target_retirement_date,
  desired_monthly_income::float8 AS desired_monthly_income, monthly_contribution::float8 AS monthly_contribution, retirement_notes,
  emergency_name, emergency_relationship, emergency_phone, emergency_email, timezone`;
const dependantsOf = (userId: number) =>
  query(`SELECT id, first_name, middle_name, last_name, name, relationship, to_char(dob,'YYYY-MM-DD') AS dob, notes
           FROM user_dependants WHERE user_id = $1 ORDER BY id`, [userId]);

// Full profile (all sections) + dependants, for the My Profile page.
auth.get(
  '/profile',
  requireAuth,
  ah(async (req, res) => {
    const user = await one(`SELECT ${PROFILE_SELECT} FROM users WHERE id = $1`, [req.user!.id]);
    res.json({ ...(user ?? {}), dependants: await dependantsOf(req.user!.id) });
  })
);

// Partial update of the signed-in user's profile — only the fields present in the body
// are written, so each tab can save just its own section. Email/password are unchanged.
auth.put(
  '/profile',
  requireAuth,
  ah(async (req, res) => {
    const body = req.body ?? {};
    const sets: string[] = []; const vals: any[] = [req.user!.id];
    for (const [field, type] of Object.entries(PROFILE_FIELDS)) {
      if (!(field in body)) continue;
      vals.push(coerceField(type, body[field], field));
      sets.push(`${field} = $${vals.length}`);
    }
    // Keep the legacy single `name` in sync when any name part changes (prefer an
    // explicit preferred name, else first+last), merging with current values.
    if (['first_name', 'last_name', 'preferred_name'].some((k) => k in body)) {
      const cur = await one<any>(`SELECT first_name, last_name, preferred_name FROM users WHERE id = $1`, [req.user!.id]);
      const pick = (k: string) => (k in body ? strOrNull(body[k]) : cur?.[k] ?? null);
      const display = pick('preferred_name') || [pick('first_name'), pick('last_name')].filter(Boolean).join(' ').trim() || null;
      vals.push(display); sets.push(`name = $${vals.length}`);
    }
    if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    res.json(await mePayload(req.user!.id, req.book?.id ?? null));
  })
);

// Dependants (1:many). Scoped to the signed-in user.
const DEP_COLS = `id, first_name, middle_name, last_name, name, relationship, to_char(dob,'YYYY-MM-DD') AS dob, notes`;
// Resolve a dependant's name parts + derived display name (or fall back to a plain
// `name` for older callers); throws if there's nothing to identify them by.
function dependantName(body: any) {
  const first = strOrNull(body?.first_name);
  const middle = strOrNull(body?.middle_name);
  const last = strOrNull(body?.last_name);
  const name = [first, middle, last].filter(Boolean).join(' ').trim() || strOrNull(body?.name);
  if (!name) throw new HttpError(400, 'A dependant needs a first or last name.');
  return { first, middle, last, name };
}
auth.post(
  '/dependants',
  requireAuth,
  ah(async (req, res) => {
    const { first, middle, last, name } = dependantName(req.body);
    const row = await one(
      `INSERT INTO user_dependants (user_id, first_name, middle_name, last_name, name, relationship, dob, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DEP_COLS}`,
      [req.user!.id, first, middle, last, name, strOrNull(req.body?.relationship), dateOrNull(req.body?.dob, 'Date of birth'), strOrNull(req.body?.notes)]
    );
    res.json(row);
  })
);
auth.put(
  '/dependants/:id',
  requireAuth,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Bad dependant id.');
    const { first, middle, last, name } = dependantName(req.body);
    const row = await one(
      `UPDATE user_dependants SET first_name = $3, middle_name = $4, last_name = $5, name = $6, relationship = $7, dob = $8, notes = $9
        WHERE id = $1 AND user_id = $2 RETURNING ${DEP_COLS}`,
      [id, req.user!.id, first, middle, last, name, strOrNull(req.body?.relationship), dateOrNull(req.body?.dob, 'Date of birth'), strOrNull(req.body?.notes)]
    );
    if (!row) throw new HttpError(404, 'Dependant not found.');
    res.json(row);
  })
);
auth.delete(
  '/dependants/:id',
  requireAuth,
  ah(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Bad dependant id.');
    await query(`DELETE FROM user_dependants WHERE id = $1 AND user_id = $2`, [id, req.user!.id]);
    res.json({ ok: true });
  })
);

// Your personal Anthropic API key + model, enabling AI features for your account.
// The key is never returned — only whether one is set and a masked hint.
auth.get(
  '/ai-settings',
  requireAuth,
  ah(async (req, res) => {
    const row = await one<{ ai_api_key: string | null; ai_model: string | null }>(
      `SELECT ai_api_key, ai_model FROM users WHERE id = $1`, [req.user!.id]
    );
    res.json(aiSettingsPayload(row));
  })
);

// Set/clear your key and/or model. Only the fields present in the body change (so
// saving a model doesn't wipe the key); a blank api_key clears it (reverts to env).
auth.put(
  '/ai-settings',
  requireAuth,
  ah(async (req, res) => {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
    const setKey = has('api_key');
    const setModel = has('model');
    const keyVal = (typeof req.body?.api_key === 'string' && req.body.api_key.trim()) ? req.body.api_key.trim() : null;
    const modelVal = (typeof req.body?.model === 'string' && req.body.model.trim()) ? req.body.model.trim() : null;
    await one(
      `UPDATE users SET
         ai_api_key = CASE WHEN $2 THEN $3 ELSE ai_api_key END,
         ai_model   = CASE WHEN $4 THEN $5 ELSE ai_model END
       WHERE id = $1 RETURNING id`,
      [req.user!.id, setKey, keyVal, setModel, modelVal]
    );
    const row = await one<{ ai_api_key: string | null; ai_model: string | null }>(
      `SELECT ai_api_key, ai_model FROM users WHERE id = $1`, [req.user!.id]
    );
    res.json(aiSettingsPayload(row));
  })
);

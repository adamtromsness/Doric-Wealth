// Personal Anthropic API keys are stored encrypted at rest (users.ai_api_key), with the
// same AES-256-GCM scheme as linked-account credentials (secrets.ts). Stored form:
// "enc1:" + encryptSecret(key). Older rows may still hold plaintext; they're read as
// is and encrypted on the next boot (encryptLegacyAiKeys).
import { encodeKeyAtRest, decodeKeyAtRest } from '../secrets.js';
import { pool } from '../db.js';

const PREFIX = 'enc1:';

export const encodeAiKey = (plain: string): string => encodeKeyAtRest(plain);
export const decodeAiKey = (stored: string | null | undefined): string | null => decodeKeyAtRest(stored, 'personal AI key');

// Encrypt any plaintext keys left from before encryption. Idempotent; runs on boot.
export async function encryptLegacyAiKeys(): Promise<number> {
  const rows = (await pool.query(
    `SELECT id, ai_api_key FROM users WHERE ai_api_key IS NOT NULL AND btrim(ai_api_key) <> '' AND ai_api_key NOT LIKE '${PREFIX}%'`
  )).rows as { id: number; ai_api_key: string }[];
  for (const r of rows) {
    await pool.query(`UPDATE users SET ai_api_key = $2 WHERE id = $1 AND ai_api_key = $3`, [r.id, encodeAiKey(r.ai_api_key.trim()), r.ai_api_key]);
  }
  return rows.length;
}

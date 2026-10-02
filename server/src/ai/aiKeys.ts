// Personal Anthropic API keys are stored encrypted at rest (users.ai_api_key), with the
// same AES-256-GCM scheme as linked-account credentials (secrets.ts). Stored form:
// "enc1:" + encryptSecret(key). Older rows may still hold plaintext; they're read as
// is and encrypted on the next boot (encryptLegacyAiKeys).
import { encryptSecret, decryptSecret } from '../secrets.js';
import { pool } from '../db.js';

const PREFIX = 'enc1:';

export function encodeAiKey(plain: string): string {
  return PREFIX + encryptSecret(plain);
}

// The usable key, or null when none is stored or it can't be decrypted (e.g. the
// server's APP_SECRET_KEY changed since it was saved: the user re-enters it).
export function decodeAiKey(stored: string | null | undefined): string | null {
  const v = stored?.trim();
  if (!v) return null;
  if (!v.startsWith(PREFIX)) return v; // legacy plaintext, encrypted on next boot
  try {
    return decryptSecret(v.slice(PREFIX.length));
  } catch {
    console.warn('A stored personal AI key could not be decrypted (APP_SECRET_KEY changed?); treating it as not set.');
    return null;
  }
}

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

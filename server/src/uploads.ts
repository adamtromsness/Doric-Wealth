import type { Response } from 'express';
import { HttpError } from './http.js';

// File types accepted for uploads that are stored and later served back inline
// (receipt images, utility bills). SVG and HTML are intentionally excluded — they
// can carry executable script and would run from our own origin if served inline.
export const ALLOWED_UPLOAD_MIME = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'application/pdf',
]);

// Largest stored file we accept (decoded bytes). Generous for a high-res scan or
// multi-page PDF, but bounds a single blob so it can't bloat a DB row, the backup
// envelope, or memory (the AI receipt path loads the whole image). The request body
// parsers cap the overall payload; this caps the individual file.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Reject an oversized upload. Takes the raw base64 string (no data: prefix) and
// estimates decoded size from its length (4 base64 chars ≈ 3 bytes) — cheaper than
// decoding. A blank/absent value is fine (callers guard presence separately).
export function assertUploadSize(base64: unknown, max = MAX_UPLOAD_BYTES): void {
  if (typeof base64 !== 'string' || base64 === '') return;
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > max) {
    throw new HttpError(413, `File is too large (~${(bytes / 1024 / 1024).toFixed(1)} MB). The limit is ${Math.floor(max / 1024 / 1024)} MB.`);
  }
}

// Strip any parameters (e.g. "; charset=") and lowercase a client-supplied MIME.
function normalizeMime(mime: unknown): string {
  return String(mime ?? '').split(';')[0].trim().toLowerCase();
}

// Validate an uploaded file's MIME against the allowlist, returning the
// normalized value. Throws 400 when missing or disallowed so arbitrary content
// (text/html, image/svg+xml, executables) is never stored for later inline serving.
export function assertUploadMime(mime: unknown): string {
  const m = normalizeMime(mime);
  if (!m) throw new HttpError(400, 'A file type (MIME) is required for uploads.');
  if (!ALLOWED_UPLOAD_MIME.has(m)) {
    throw new HttpError(400, `Unsupported file type "${m}". Allowed: JPEG, PNG, WebP, GIF, HEIC, or PDF.`);
  }
  return m;
}

// Stream a stored file back safely. Allowlisted types keep their real content
// type and display inline; anything else (legacy or unexpected) is forced to
// download as an opaque octet-stream. `nosniff` stops the browser from
// re-interpreting the bytes as HTML/script regardless.
export function sendStoredFile(res: Response, data: Buffer, mime: string | null, name: string | null): void {
  const m = normalizeMime(mime);
  const allowed = ALLOWED_UPLOAD_MIME.has(m);
  const filename = String(name ?? 'file').replace(/[\r\n"]/g, '');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', allowed ? m : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${allowed ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.send(data);
}

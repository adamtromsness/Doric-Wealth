import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUploadMime, sendStoredFile, ALLOWED_UPLOAD_MIME } from '../src/uploads.js';
import { HttpError } from '../src/http.js';

// Minimal fake Express Response capturing headers + the sent body.
function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    headers,
    sent: undefined as Buffer | undefined,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
    send(data: Buffer) { res.sent = data; return res; },
  };
  return res;
}

const status = (fn: () => unknown): number | undefined => {
  try { fn(); return undefined; } catch (e) { return e instanceof HttpError ? e.status : -1; }
};

describe('assertUploadMime', () => {
  it('normalizes params + case and returns the bare type for allowed MIME', () => {
    assert.equal(assertUploadMime('image/png'), 'image/png');
    assert.equal(assertUploadMime('IMAGE/PNG'), 'image/png');
    assert.equal(assertUploadMime('image/png; charset=binary'), 'image/png');
    assert.equal(assertUploadMime('  image/jpeg  '), 'image/jpeg');
    assert.equal(assertUploadMime('application/pdf'), 'application/pdf');
  });

  it('throws 400 when the MIME is missing/blank (nullish + empty branches)', () => {
    assert.equal(status(() => assertUploadMime(undefined)), 400);
    assert.equal(status(() => assertUploadMime(null)), 400);
    assert.equal(status(() => assertUploadMime('')), 400);
    assert.equal(status(() => assertUploadMime('   ')), 400);
  });

  it('throws 400 for disallowed (script-capable) types', () => {
    assert.equal(status(() => assertUploadMime('text/html')), 400);
    assert.equal(status(() => assertUploadMime('image/svg+xml')), 400);
    assert.equal(status(() => assertUploadMime('application/octet-stream')), 400);
  });
});

describe('sendStoredFile', () => {
  it('serves an allowed type inline with its real content type + nosniff', () => {
    const res = fakeRes();
    const data = Buffer.from('img-bytes');
    sendStoredFile(res, data, 'image/png', 'receipt.png');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['content-type'], 'image/png');
    assert.match(res.headers['content-disposition'], /^inline; filename="receipt\.png"$/);
    assert.equal(res.sent, data);
  });

  it('forces a disallowed/unknown type to an octet-stream attachment (lines 55-56)', () => {
    const res = fakeRes();
    sendStoredFile(res, Buffer.from('x'), 'text/html', 'evil.html');
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'], /^attachment; filename="evil\.html"$/);
  });

  it('handles a null MIME (treated as disallowed) and a null name', () => {
    const res = fakeRes();
    sendStoredFile(res, Buffer.from('x'), null, null);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'], /^attachment; filename="file"$/);
  });

  it('strips CR/LF/quote chars from the filename (header-injection guard)', () => {
    const res = fakeRes();
    sendStoredFile(res, Buffer.from('x'), 'image/png', 'a"b\r\nc.png');
    assert.equal(res.headers['content-disposition'], 'inline; filename="abc.png"');
  });

  it('every allowlisted MIME serves inline', () => {
    for (const mime of ALLOWED_UPLOAD_MIME) {
      const res = fakeRes();
      sendStoredFile(res, Buffer.from('x'), mime, 'f');
      assert.equal(res.headers['content-type'], mime);
      assert.match(res.headers['content-disposition'], /^inline/);
    }
  });
});

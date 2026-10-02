import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  money, parseLocalDate, shortDate, todayStr, isHttpUrl, normalizeUrl, isOpenableUrl,
  formatPhone, accountTypeLabel, propertyTypeLabel, disposalTypeLabel, propertyDisposalTypeLabel,
  ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES,
  api, apiStream, apiBlob, apiDownload, setUnauthorizedHandler,
} from './api';

// ── Pure formatters ────────────────────────────────────────────────────────
describe('money', () => {
  it('formats positive with $ and two decimals', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(0)).toBe('$0.00');
  });
  it('formats negative with a minus sign', () => {
    expect(money(-42)).toBe('−$42.00');
  });
  it('adds a + sign when sign option is set (positive only)', () => {
    expect(money(5, { sign: true })).toBe('+$5.00');
    expect(money(-5, { sign: true })).toBe('−$5.00');
  });
  it('returns em dash for null/undefined/NaN', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money(NaN)).toBe('—');
  });
});

describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD as local midnight', () => {
    const d = parseLocalDate('2026-03-15');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
  });
  it('falls back to Date parsing for non-matching strings', () => {
    const d = parseLocalDate('March 1, 2026');
    expect(d.getFullYear()).toBe(2026);
  });
});

describe('shortDate', () => {
  it('returns em dash for empty', () => {
    expect(shortDate(null)).toBe('—');
    expect(shortDate(undefined)).toBe('—');
    expect(shortDate('')).toBe('—');
  });
  it('formats a date string', () => {
    expect(shortDate('2026-01-05')).toBe('Jan 5, 2026');
  });
});

describe('todayStr', () => {
  it('returns YYYY-MM-DD zero-padded', () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('url helpers', () => {
  it('isHttpUrl accepts http(s), rejects junk', () => {
    expect(isHttpUrl('https://a.com')).toBe(true);
    expect(isHttpUrl('http://a.com')).toBe(true);
    expect(isHttpUrl('ftp://a.com')).toBe(false);
    expect(isHttpUrl('nonsense')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
  it('normalizeUrl defaults to https and trims', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://x.com')).toBe('http://x.com');
    expect(normalizeUrl('  ')).toBe(null);
    expect(normalizeUrl(null)).toBe(null);
  });
  it('isOpenableUrl requires a hostname with a dot', () => {
    expect(isOpenableUrl('example.com')).toBe(true);
    expect(isOpenableUrl('https://example.com/path')).toBe(true);
    expect(isOpenableUrl('abc')).toBe(false);
    expect(isOpenableUrl('')).toBe(false);
    expect(isOpenableUrl(null)).toBe(false);
  });
});

describe('formatPhone', () => {
  it('formats 10-digit US numbers', () => {
    expect(formatPhone('5551234567')).toBe('(555) 123-4567');
    expect(formatPhone('(555) 123 4567')).toBe('(555) 123-4567');
  });
  it('formats 11-digit numbers starting with 1', () => {
    expect(formatPhone('15551234567')).toBe('+1 (555) 123-4567');
  });
  it('preserves an extension', () => {
    expect(formatPhone('5551234567 x89')).toBe('(555) 123-4567 x89');
    expect(formatPhone('5551234567 ext 89')).toBe('(555) 123-4567 x89');
  });
  it('leaves unrecognized shapes untouched', () => {
    expect(formatPhone('12345')).toBe('12345');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone('')).toBe('');
    expect(formatPhone(null)).toBe('');
  });
});

describe('type label maps', () => {
  it('labels known types and falls back to the raw value', () => {
    expect(accountTypeLabel('checking')).toBe('Checking');
    expect(accountTypeLabel('mystery')).toBe('mystery');
    expect(propertyTypeLabel('condo')).toBe('Condo');
    expect(propertyTypeLabel('mystery')).toBe('mystery');
  });
  it('disposal labels handle null with a default', () => {
    expect(disposalTypeLabel('sold')).toBe('Sold');
    expect(disposalTypeLabel(null)).toBe('Disposed');
    expect(disposalTypeLabel('weird')).toBe('weird');
    expect(propertyDisposalTypeLabel('foreclosed')).toBe('Foreclosed');
    expect(propertyDisposalTypeLabel(null)).toBe('Disposed');
  });
  it('exposes canonical type constants', () => {
    expect(ACCOUNT_TYPES.length).toBeGreaterThan(10);
    expect(LIABILITY_ACCOUNT_TYPES).toContain('credit_card');
  });
});

// ── fetch-based API layer ────────────────────────────────────────────────────
function mockResponse(opts: Partial<{ ok: boolean; status: number; json: any; headers: Record<string, string>; blobData: string; body: any }>) {
  const { ok = true, status = 200, json, headers = {}, blobData = 'x', body } = opts;
  return {
    ok, status,
    headers: new Headers(headers),
    json: async () => { if (json === undefined) throw new Error('no json'); return json; },
    blob: async () => new Blob([blobData]),
    body,
  } as unknown as Response;
}

describe('api client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it('GET returns parsed JSON and sends credentials + content-type', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { hello: 'world' } }));
    const out = await api.get<{ hello: string }>('/thing');
    expect(out).toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/thing');
    expect(init.credentials).toBe('include');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('POST/PUT/PATCH serialize the body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: { ok: 1 } }));
    await api.post('/p', { a: 1 });
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ a: 1 }));
    await api.put('/p', { b: 2 });
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    await api.patch('/p', { c: 3 });
    expect(fetchMock.mock.calls[2][1].method).toBe('PATCH');
  });

  it('POST defaults to an empty object body', async () => {
    fetchMock.mockResolvedValue(mockResponse({ json: {} }));
    await api.post('/p');
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({}));
  });

  it('DELETE returns undefined on 204', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 204 }));
    const out = await api.del('/gone');
    expect(out).toBeUndefined();
  });

  it('throws the server error message on failure', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 400, json: { error: 'Bad thing' } }));
    await expect(api.get('/x')).rejects.toThrow('Bad thing');
  });

  it('throws a generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500 }));
    await expect(api.get('/x')).rejects.toThrow('Request failed (500)');
  });

  it('invokes the unauthorized handler on 401', async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 401, json: { error: 'nope' } }));
    await expect(api.get('/x')).rejects.toThrow('nope');
    expect(onUnauth).toHaveBeenCalledOnce();
  });
});

describe('apiStream', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); setUnauthorizedHandler(null); });

  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(ctrl) {
        if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]));
        else ctrl.close();
      },
    });
  }

  it('parses NDJSON events, including a split line and a trailing no-newline event', async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: streamOf(['{"n":1}\n{"n', '":2}\n', '{"n":3}']) }));
    const events: any[] = [];
    await apiStream('/s', { go: true }, (e) => events.push(e));
    expect(events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('ignores unparseable lines', async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: streamOf(['garbage\n{"ok":true}\n']) }));
    const events: any[] = [];
    await apiStream('/s', {}, (e) => events.push(e));
    expect(events).toEqual([{ ok: true }]);
  });

  it('throws (and fires unauthorized on 401) when the response is not ok', async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 401, json: { error: 'stream denied' }, body: null }));
    await expect(apiStream('/s', {}, () => {})).rejects.toThrow('stream denied');
    expect(onUnauth).toHaveBeenCalled();
  });
});

describe('apiBlob & apiDownload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('apiBlob returns a blob on success', async () => {
    fetchMock.mockResolvedValue(mockResponse({ blobData: 'data' }));
    const blob = await apiBlob('/download');
    expect(blob).toBeInstanceOf(Blob);
  });

  it('apiBlob throws on failure', async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    await expect(apiBlob('/download')).rejects.toThrow('Download failed (404)');
  });

  it('apiDownload uses the Content-Disposition filename', async () => {
    fetchMock.mockResolvedValue(mockResponse({ headers: { 'content-disposition': 'attachment; filename="report.csv"' }, blobData: 'x' }));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await apiDownload('/export', 'fallback.csv');
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it('apiDownload falls back to the provided name and throws on failure', async () => {
    fetchMock.mockResolvedValue(mockResponse({ blobData: 'x' }));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await apiDownload('/export', 'fallback.csv');
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();

    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500 }));
    await expect(apiDownload('/export', 'fallback.csv')).rejects.toThrow('Download failed (500)');
  });
});

describe('ages and dates of birth', async () => {
  const { ageOn, dobProblem, earliestDob, MAX_AGE_YEARS } = await import('./api');

  it('ageOn counts a birthday only once it has passed', () => {
    expect(ageOn('2015-06-01', '2026-05-31')).toBe(10);
    expect(ageOn('2015-06-01', '2026-06-01')).toBe(11);
    expect(ageOn('2020-02-29', '2026-02-28')).toBe(5);
    expect(ageOn(null, '2026-01-01')).toBeNull();
    expect(ageOn('not a date', '2026-01-01')).toBeNull();
    expect(ageOn('2030-01-01', '2026-01-01')).toBeNull();
  });

  it('dobProblem allows up to 120 years and rejects older or future dates', () => {
    expect(MAX_AGE_YEARS).toBe(120);
    expect(dobProblem('', '2026-10-02')).toBeNull();
    expect(dobProblem('1906-10-02', '2026-10-02')).toBeNull(); // exactly 120
    expect(dobProblem('1905-10-03', '2026-10-02')).toBeNull(); // still 120
    expect(dobProblem('1905-10-02', '2026-10-02')).toMatch(/more than 120 years/); // 121
    expect(dobProblem('2026-10-03', '2026-10-02')).toMatch(/future/);
  });

  it('earliestDob is the oldest date of birth still allowed', () => {
    expect(earliestDob('2026-10-02')).toBe('1905-10-03');
    expect(dobProblem(earliestDob('2026-10-02'), '2026-10-02')).toBeNull();
  });
});

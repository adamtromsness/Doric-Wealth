import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dateInTz, todayInTz } from '../src/dates.js';

describe('dateInTz', () => {
  it('formats an instant as YYYY-MM-DD in UTC', () => {
    // 2026-01-15T12:00:00Z
    const ms = Date.UTC(2026, 0, 15, 12, 0, 0);
    assert.equal(dateInTz(ms, 'UTC'), '2026-01-15');
  });

  it('uses the target timezone, not the server zone (west-of-UTC rolls back a day)', () => {
    // 2026-01-15T02:00:00Z is still 2026-01-14 in America/Los_Angeles.
    const ms = Date.UTC(2026, 0, 15, 2, 0, 0);
    assert.equal(dateInTz(ms, 'America/Los_Angeles'), '2026-01-14');
    // ...and still 2026-01-15 in UTC.
    assert.equal(dateInTz(ms, 'UTC'), '2026-01-15');
  });

  it('handles east-of-UTC zones rolling forward a day', () => {
    // 2026-01-15T23:00:00Z is 2026-01-16 in Asia/Tokyo (UTC+9).
    const ms = Date.UTC(2026, 0, 15, 23, 0, 0);
    assert.equal(dateInTz(ms, 'Asia/Tokyo'), '2026-01-16');
  });

  it('falls back to UTC when tz is null', () => {
    const ms = Date.UTC(2026, 5, 1, 0, 0, 0);
    assert.equal(dateInTz(ms, null), '2026-06-01');
  });

  it('falls back to UTC when tz is undefined', () => {
    const ms = Date.UTC(2026, 5, 1, 0, 0, 0);
    assert.equal(dateInTz(ms, undefined), '2026-06-01');
  });

  it('falls back to UTC when tz is an empty string', () => {
    const ms = Date.UTC(2026, 5, 1, 0, 0, 0);
    assert.equal(dateInTz(ms, ''), '2026-06-01');
  });

  it('falls back to UTC (via ISO slice) on an invalid timezone', () => {
    const ms = Date.UTC(2026, 5, 1, 0, 0, 0);
    // An invalid IANA zone makes Intl.DateTimeFormat throw → catch → ISO slice.
    assert.equal(dateInTz(ms, 'Not/A_Zone'), '2026-06-01');
  });

  it('handles the epoch itself', () => {
    assert.equal(dateInTz(0, 'UTC'), '1970-01-01');
  });
});

describe('todayInTz', () => {
  it('returns a valid YYYY-MM-DD string', () => {
    const today = todayInTz('UTC');
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches dateInTz(now) for the same zone', () => {
    const before = dateInTz(Date.now(), 'UTC');
    const t = todayInTz('UTC');
    const after = dateInTz(Date.now(), 'UTC');
    // Guard against a midnight tick between the two Date.now() reads.
    assert.ok(t === before || t === after);
  });

  it('accepts a null zone', () => {
    assert.match(todayInTz(null), /^\d{4}-\d{2}-\d{2}$/);
  });
});

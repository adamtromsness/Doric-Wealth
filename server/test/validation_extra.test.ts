import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredString, optionalString, money, optionalMoney,
  numberValue, optionalNumber, dateOnly, optionalDateOnly,
  enumValue, optionalEnumValue, integerId, optionalIntegerId,
  booleanValue, optionalBoolean, assertSplitTotal, round2, clampText,
} from '../src/validation.js';
import { HttpError } from '../src/http.js';

const status = (fn: () => unknown): number | undefined => {
  try { fn(); return undefined; } catch (e) { return e instanceof HttpError ? e.status : -1; }
};

describe('requiredString', () => {
  it('trims by default and enforces max', () => {
    assert.equal(requiredString('  hi  ', 'f'), 'hi');
    assert.equal(status(() => requiredString('', 'f')), 400);
    assert.equal(status(() => requiredString('   ', 'f')), 400);
    assert.equal(status(() => requiredString(null, 'f')), 400);
    assert.equal(status(() => requiredString(undefined, 'f')), 400);
    assert.equal(status(() => requiredString('abcdef', 'f', { max: 3 })), 400);
  });
  it('does not trim when trim:false', () => {
    assert.equal(requiredString('  hi  ', 'f', { trim: false }), '  hi  ');
  });
  it('coerces a non-string value', () => {
    assert.equal(requiredString(123, 'f'), '123');
  });
});

describe('optionalString', () => {
  it('returns null for blank, otherwise validates', () => {
    assert.equal(optionalString('', 'f'), null);
    assert.equal(optionalString(null, 'f'), null);
    assert.equal(optionalString('  x ', 'f'), 'x');
    assert.equal(status(() => optionalString('toolong', 'f', { max: 2 })), 400);
  });
});

describe('money', () => {
  it('accepts numbers and numeric strings, snapping to cents', () => {
    assert.equal(money(12.34, 'f'), 12.34);
    assert.equal(money('12.34', 'f'), 12.34);
    assert.equal(money(' 12.30 ', 'f'), 12.3);
    assert.equal(money(0, 'f'), 0);
    assert.equal(money(-5, 'f'), -5);
  });
  it('rejects blank, non-numeric, and sub-cent', () => {
    assert.equal(status(() => money('', 'f')), 400);
    assert.equal(status(() => money('abc', 'f')), 400);
    assert.equal(status(() => money(Infinity, 'f')), 400);
    assert.equal(status(() => money(12.345, 'f')), 400);
  });
  it('enforces min and max on the snapped value', () => {
    assert.equal(status(() => money(5, 'f', { min: 10 })), 400);
    assert.equal(status(() => money(50, 'f', { max: 10 })), 400);
    assert.equal(money(10, 'f', { min: 10, max: 10 }), 10);
  });
});

describe('optionalMoney', () => {
  it('null for blank, else validates', () => {
    assert.equal(optionalMoney(null, 'f'), null);
    assert.equal(optionalMoney('', 'f'), null);
    assert.equal(optionalMoney('9.99', 'f'), 9.99);
  });
});

describe('numberValue / optionalNumber', () => {
  it('accepts >2 decimals (no cent constraint)', () => {
    assert.equal(numberValue(0.125, 'f'), 0.125);
    assert.equal(numberValue('6.125', 'f'), 6.125);
  });
  it('rejects blank and non-finite', () => {
    assert.equal(status(() => numberValue('', 'f')), 400);
    assert.equal(status(() => numberValue('nope', 'f')), 400);
  });
  it('enforces min/max', () => {
    assert.equal(status(() => numberValue(-1, 'f', { min: 0 })), 400);
    assert.equal(status(() => numberValue(100, 'f', { max: 10 })), 400);
  });
  it('optionalNumber returns null for blank', () => {
    assert.equal(optionalNumber(null, 'f'), null);
    assert.equal(optionalNumber('3.5', 'f'), 3.5);
  });
});

describe('dateOnly / optionalDateOnly', () => {
  it('accepts a valid YYYY-MM-DD', () => {
    assert.equal(dateOnly('2026-02-28', 'f'), '2026-02-28');
    assert.equal(dateOnly(' 2026-02-28 ', 'f'), '2026-02-28');
  });
  it('rejects blank and bad format', () => {
    assert.equal(status(() => dateOnly('', 'f')), 400);
    assert.equal(status(() => dateOnly('2026/02/28', 'f')), 400);
    assert.equal(status(() => dateOnly('26-02-28', 'f')), 400);
  });
  it('rejects a real-format but invalid calendar date', () => {
    assert.equal(status(() => dateOnly('2026-02-30', 'f')), 400);
    assert.equal(status(() => dateOnly('2026-13-01', 'f')), 400);
    assert.equal(status(() => dateOnly('2025-02-29', 'f')), 400); // non-leap year
  });
  it('accepts a leap day in a leap year', () => {
    assert.equal(dateOnly('2024-02-29', 'f'), '2024-02-29');
  });
  it('optionalDateOnly returns null for blank', () => {
    assert.equal(optionalDateOnly(null, 'f'), null);
    assert.equal(optionalDateOnly('2026-01-01', 'f'), '2026-01-01');
  });
});

describe('enumValue / optionalEnumValue', () => {
  const allowed = ['a', 'b'] as const;
  it('accepts allowed, rejects others', () => {
    assert.equal(enumValue('a', 'f', allowed), 'a');
    assert.equal(status(() => enumValue('z', 'f', allowed)), 400);
    assert.equal(status(() => enumValue(null, 'f', allowed)), 400);
    assert.equal(status(() => enumValue(undefined, 'f', allowed)), 400);
  });
  it('optionalEnumValue returns null for blank', () => {
    assert.equal(optionalEnumValue('', 'f', allowed), null);
    assert.equal(optionalEnumValue(null, 'f', allowed), null);
    assert.equal(optionalEnumValue('b', 'f', allowed), 'b');
    assert.equal(status(() => optionalEnumValue('z', 'f', allowed)), 400);
  });
});

describe('integerId / optionalIntegerId', () => {
  it('accepts positive ints and numeric strings', () => {
    assert.equal(integerId(5, 'f'), 5);
    assert.equal(integerId('7', 'f'), 7);
  });
  it('rejects blank, zero, negative, and non-integers', () => {
    assert.equal(status(() => integerId('', 'f')), 400);
    assert.equal(status(() => integerId(0, 'f')), 400);
    assert.equal(status(() => integerId(-3, 'f')), 400);
    assert.equal(status(() => integerId(1.5, 'f')), 400);
    assert.equal(status(() => integerId('abc', 'f')), 400);
  });
  it('optionalIntegerId returns null for blank', () => {
    assert.equal(optionalIntegerId(null, 'f'), null);
    assert.equal(optionalIntegerId('9', 'f'), 9);
  });
});

describe('booleanValue / optionalBoolean', () => {
  it('accepts booleans and "true"/"false" strings', () => {
    assert.equal(booleanValue(true, 'f'), true);
    assert.equal(booleanValue(false, 'f'), false);
    assert.equal(booleanValue('true', 'f'), true);
    assert.equal(booleanValue('false', 'f'), false);
  });
  it('uses default when null/undefined and a default is given', () => {
    assert.equal(booleanValue(undefined, 'f', { default: true }), true);
    assert.equal(booleanValue(null, 'f', { default: false }), false);
  });
  it('throws when null/undefined and no default', () => {
    assert.equal(status(() => booleanValue(undefined, 'f')), 400);
    assert.equal(status(() => booleanValue(null, 'f')), 400);
  });
  it('rejects other values', () => {
    assert.equal(status(() => booleanValue('yes', 'f')), 400);
    assert.equal(status(() => booleanValue(1, 'f')), 400);
  });
  it('optionalBoolean returns null for null/undefined', () => {
    assert.equal(optionalBoolean(undefined, 'f'), null);
    assert.equal(optionalBoolean(null, 'f'), null);
    assert.equal(optionalBoolean('true', 'f'), true);
    assert.equal(status(() => optionalBoolean('nope', 'f')), 400);
  });
});

describe('assertSplitTotal', () => {
  it('passes when splits sum to the amount (within tolerance)', () => {
    assert.doesNotThrow(() => assertSplitTotal([10, 20, 30], 60));
    assert.doesNotThrow(() => assertSplitTotal([10.004], 10)); // within 0.005
  });
  it('throws when splits do not add up', () => {
    assert.equal(status(() => assertSplitTotal([10, 20], 31)), 400);
  });
  it('throws when the sum is not finite', () => {
    assert.equal(status(() => assertSplitTotal([Infinity], 0)), 400);
  });
});

describe('round2', () => {
  it('rounds sub-cent float noise to whole cents', () => {
    assert.equal(round2(1234.5600000000001), 1234.56);
    assert.equal(round2(0.1 + 0.2), 0.3);
    assert.equal(round2(2.005), 2.01);
    assert.equal(round2(-1.005), -1);
  });
});

describe('clampText', () => {
  it('returns null for null/undefined/blank', () => {
    assert.equal(clampText(null), null);
    assert.equal(clampText(undefined), null);
    assert.equal(clampText('   '), null);
  });
  it('trims and coerces', () => {
    assert.equal(clampText('  hi  '), 'hi');
    assert.equal(clampText(42), '42');
  });
  it('clips to max length', () => {
    assert.equal(clampText('abcdef', 3), 'abc');
    assert.equal(clampText('abc', 3), 'abc');
  });
  it('uses default max of 500', () => {
    const long = 'x'.repeat(600);
    assert.equal(clampText(long)!.length, 500);
  });
});

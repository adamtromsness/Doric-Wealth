import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const r = parseCsv('a,b,c\n1,2,3\n4,5,6');
    assert.deepEqual(r.headers, ['a', 'b', 'c']);
    assert.deepEqual(r.rows, [['1', '2', '3'], ['4', '5', '6']]);
  });

  it('trims header cells but not data cells', () => {
    const r = parseCsv(' a , b \n x , y ');
    assert.deepEqual(r.headers, ['a', 'b']);
    assert.deepEqual(r.rows, [[' x ', ' y ']]);
  });

  it('handles CRLF line endings', () => {
    const r = parseCsv('a,b\r\n1,2\r\n3,4');
    assert.deepEqual(r.headers, ['a', 'b']);
    assert.deepEqual(r.rows, [['1', '2'], ['3', '4']]);
  });

  it('handles a lone CR by swallowing it', () => {
    const r = parseCsv('a,b\r1,2');
    // A lone CR is swallowed, so header and data run together on one logical record
    // until the CR is dropped — verify no crash and CR is not part of a value.
    assert.ok(!r.headers.some((h) => h.includes('\r')));
    assert.ok(!r.rows.flat().some((v) => v.includes('\r')));
  });

  it('strips a UTF-8 BOM from the first cell', () => {
    const r = parseCsv('﻿a,b\n1,2');
    assert.deepEqual(r.headers, ['a', 'b']);
    assert.deepEqual(r.rows, [['1', '2']]);
  });

  it('handles quoted fields with embedded commas', () => {
    const r = parseCsv('a,b\n"1,000",x');
    assert.deepEqual(r.rows, [['1,000', 'x']]);
  });

  it('handles quoted fields with embedded newlines', () => {
    const r = parseCsv('a,b\n"line1\nline2",x');
    assert.deepEqual(r.rows, [['line1\nline2', 'x']]);
  });

  it('handles escaped double-quotes ("")', () => {
    const r = parseCsv('a,b\n"say ""hi""",x');
    assert.deepEqual(r.rows, [['say "hi"', 'x']]);
  });

  it('ignores a trailing blank line', () => {
    const r = parseCsv('a,b\n1,2\n');
    assert.deepEqual(r.rows, [['1', '2']]);
  });

  it('ignores multiple trailing/interior fully-empty records', () => {
    const r = parseCsv('a,b\n1,2\n\n\n');
    assert.deepEqual(r.rows, [['1', '2']]);
  });

  it('flushes a final field/record with no trailing newline', () => {
    const r = parseCsv('a,b\n1,2');
    assert.deepEqual(r.rows, [['1', '2']]);
  });

  it('returns empty headers and no rows for empty input', () => {
    const r = parseCsv('');
    assert.deepEqual(r.headers, []);
    assert.deepEqual(r.rows, []);
  });

  it('caps data rows with maxRows (header not counted)', () => {
    const r = parseCsv('a,b\n1,x\n2,y\n3,z\n4,w', { maxRows: 2 });
    assert.deepEqual(r.headers, ['a', 'b']);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows, [['1', 'x'], ['2', 'y']]);
  });

  it('maxRows: 0 reads only the header', () => {
    const r = parseCsv('a,b\n1,x\n2,y', { maxRows: 0 });
    assert.deepEqual(r.headers, ['a', 'b']);
    assert.deepEqual(r.rows, []);
  });

  it('preserves empty trailing field on a data row', () => {
    const r = parseCsv('a,b,c\n1,,3');
    assert.deepEqual(r.rows, [['1', '', '3']]);
  });

  it('handles a header-only file', () => {
    const r = parseCsv('a,b,c');
    assert.deepEqual(r.headers, ['a', 'b', 'c']);
    assert.deepEqual(r.rows, []);
  });

  it('handles a quoted field at end of file with no closing newline', () => {
    const r = parseCsv('a,b\nx,"y z"');
    assert.deepEqual(r.rows, [['x', 'y z']]);
  });
});

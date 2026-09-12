import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvoiceText, extractPdfText } from '../src/invoiceScan.js';

// parseInvoiceText is pure text/regex logic — no network, no DB. We feed it
// synthetic invoice text and assert the extracted fields.

test('parses a typical utility bill: provider, dates, period, total', () => {
  const text = [
    'Pacific Power Company',
    '123 Main St',
    'Statement Date: 2026-03-15',
    'Service Period: 02/01/2026 to 02/28/2026',
    'Due Date: March 30, 2026',
    'Current charges: $142.57',
    'Total Amount Due: $142.57',
  ].join('\n');
  const r = parseInvoiceText(text);
  assert.equal(r.provider, 'Pacific Power Company');
  assert.equal(r.invoice_date, '2026-03-15');
  assert.equal(r.due_date, '2026-03-30');
  assert.equal(r.period_start, '2026-02-01');
  assert.equal(r.period_end, '2026-02-28');
  assert.equal(r.total, 142.57);
  assert.equal(r.late_total, null);
});

test('picks the on-time total and separates the late-fee total', () => {
  const text = [
    'City Water Utility',
    'Amount Due: $89.00',
    'Pay 95.50 if paid after the due date',
  ].join('\n');
  const r = parseInvoiceText(text);
  assert.equal(r.late_total, 95.5);
  // The on-time total must NOT be the late amount.
  assert.equal(r.total, 89.0);
});

test('finds a late total stated after the phrase', () => {
  // Keep the on-time total away from the late phrase so the "amount before phrase"
  // rule can't grab it; the late amount only appears after the phrase.
  const text = 'Gas Co\nAmount due $50.00 for this cycle. Past due amount owed is $57.25 total.';
  const r = parseInvoiceText(text);
  assert.equal(r.late_total, 57.25);
  assert.equal(r.total, 50.0);
});

test('period detection via a two-dates-joined-by-separator fallback', () => {
  const text = 'Some Provider\nUsage from 01/01/2026 - 01/31/2026\nBalance Due $10.00';
  const r = parseInvoiceText(text);
  assert.equal(r.period_start, '2026-01-01');
  assert.equal(r.period_end, '2026-01-31');
});

test('parses "1 Feb 2026" style and 2-digit years', () => {
  const text = 'Acme Utilities\nInvoice Date: 1 Feb 2026\nDue by: 3/15/26\nPlease pay $20.00';
  const r = parseInvoiceText(text);
  assert.equal(r.invoice_date, '2026-02-01');
  assert.equal(r.due_date, '2026-03-15');
  assert.equal(r.total, 20.0);
});

test('falls back to the max $-prefixed amount when no total label matches', () => {
  const text = 'Widget Provider\nLine A $12.00\nLine B $99.99\nLine C $3.00';
  const r = parseInvoiceText(text);
  assert.equal(r.total, 99.99);
});

test('empty / non-invoice text yields all-null fields', () => {
  const r = parseInvoiceText('   \n  \n ');
  assert.equal(r.provider, null);
  assert.equal(r.invoice_date, null);
  assert.equal(r.due_date, null);
  assert.equal(r.period_start, null);
  assert.equal(r.period_end, null);
  assert.equal(r.total, null);
  assert.equal(r.late_total, null);
});

test('provider skips leading numeric/date lines and over-long lines', () => {
  const text = [
    '2026-01-01',                 // a date — skipped
    '$100.00',                    // starts with $ — skipped
    'X'.repeat(80),               // too long — skipped
    'Northwest Natural',          // this is the provider
  ].join('\n');
  const r = parseInvoiceText(text);
  assert.equal(r.provider, 'Northwest Natural');
});

test('period via label with two adjacent date tokens', () => {
  const text = 'Elec Co\nBilling Period 2026-04-01 2026-04-30\nAmount Due $60.00';
  const r = parseInvoiceText(text);
  assert.equal(r.period_start, '2026-04-01');
  assert.equal(r.period_end, '2026-04-30');
});

// extractPdfText: build a minimal valid PDF in-memory and confirm text comes out.
// pdf-parse runs locally (no network). This also exercises the destroy() path.
test('extractPdfText reads text from a minimal PDF and strips "-- N of M --" page markers', async () => {
  const pdf = makeSimplePdf('Hello Invoice -- 1 of 2 -- World');
  const text = await extractPdfText(pdf);
  assert.match(text, /Hello Invoice/);
  assert.match(text, /World/);
  // The page-marker noise is stripped.
  assert.doesNotMatch(text, /1 of 2/);
});

// Construct a tiny single-page PDF that renders one text string. Enough for
// pdf-parse to extract the string; offsets don't need to be byte-perfect.
function makeSimplePdf(str: string): Buffer {
  const esc = str.replace(/([()\\])/g, '\\$1');
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${18 + esc.length} >>\nstream\nBT /F1 18 Tf 72 700 Td (${esc}) Tj ET\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) { offsets.push(body.length); body += o; }
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += String(off).padStart(10, '0') + ' 00000 n \n';
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

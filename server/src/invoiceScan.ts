import { PDFParse } from 'pdf-parse';

// Heuristic (no-AI) invoice scanner: pull text from a PDF and regex out the
// common fields. Best-effort — the user reviews/corrects, and can optionally
// re-scan with AI for a cleaner read.
export interface ScannedInvoice {
  provider: string | null;
  invoice_date: string | null;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  total: number | null;
  late_total: number | null;
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await parser.getText();
    return (r?.text ?? '').replace(/--\s*\d+\s*of\s*\d+\s*--/gi, ' ');
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number | string) => String(n).padStart(2, '0');
const toNum = (s: string) => Number(s.replace(/,/g, ''));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// First date found anywhere in `s`, normalized to YYYY-MM-DD (or null).
function parseDate(s: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${pad(m[1])}-${pad(m[2])}`;
  }
  if ((m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(m[2])}`;
  }
  if ((m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${pad(mo)}-${pad(m[1])}`;
  }
  return null;
}

const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})`;
const AMOUNT = String.raw`([0-9][0-9,]*\.[0-9]{2})`;

function dateNearLabel(text: string, labels: string[]): string | null {
  for (const lab of labels) {
    const m = text.match(new RegExp(esc(lab) + String.raw`.{0,60}?(` + DATE_TOKEN + `)`, 'i'));
    if (m) { const d = parseDate(m[1]); if (d) return d; }
  }
  return null;
}

function findPeriod(text: string): [string | null, string | null] | null {
  // 1. After a "period" label, take the next two date tokens (even if just space-separated).
  const labelRe = /(service period|billing period|service dates|billing dates|usage period|bill period|service from|period of service|read dates|meter read|for service from|from)/i;
  const lm = text.match(labelRe);
  if (lm && lm.index != null) {
    const after = text.slice(lm.index, lm.index + 90);
    const ds = [...after.matchAll(new RegExp(DATE_TOKEN, 'gi'))].map((x) => parseDate(x[0])).filter(Boolean) as string[];
    if (ds.length >= 2) return [ds[0], ds[1]];
  }
  // 2. Two dates joined by a separator anywhere in the text.
  const m = text.match(new RegExp(`(${DATE_TOKEN})\\s*(?:to|through|thru|–|—|-)\\s*(${DATE_TOKEN})`, 'i'));
  if (m) { const a = parseDate(m[1]), b = parseDate(m[2]); if (a || b) return [a, b]; }
  return null;
}

const LATE_PHRASE = String.raw`if paid (?:after|late)|if received after|after (?:the )?due date|past due|late payment|with late fee|including late`;

// The higher "if paid after the due date" amount, if the bill states one.
function findLateTotal(text: string): number | null {
  // amount before the phrase: "pay 317.00 if paid after July 1"
  let m = text.match(new RegExp(`\\$?\\s*${AMOUNT}\\s*(?:${LATE_PHRASE})`, 'i'));
  if (m) return toNum(m[1]);
  // amount after the phrase: "if paid after the due date: 317.00"
  m = text.match(new RegExp(`(?:${LATE_PHRASE})[^0-9$\\n]{0,20}\\$?\\s*${AMOUNT}`, 'i'));
  if (m) return toNum(m[1]);
  return null;
}

// The on-time total. `exclude` (the late total) is skipped so a late-fee amount
// is never mistaken for the amount due.
function findTotal(text: string, exclude: number | null): number | null {
  const ne = (v: number) => exclude == null || Math.abs(v - exclude) > 0.005;
  const labels = ['due upon receipt', 'total amount due', 'amount due', 'balance due', 'total due', 'please pay', 'new charges', 'current charges', 'amount enclosed', 'total'];
  for (const lab of labels) {
    const m = text.match(new RegExp(esc(lab) + String.raw`[^0-9$\n]{0,25}\$?\s*` + AMOUNT, 'i'));
    if (m) { const v = toNum(m[1]); if (ne(v)) return v; }
  }
  const all = [...text.matchAll(new RegExp(`\\$\\s*${AMOUNT}`, 'g'))].map((x) => toNum(x[1])).filter(ne);
  return all.length ? Math.max(...all) : null;
}

export function parseInvoiceText(raw: string): ScannedInvoice {
  const text = raw.replace(/\r/g, ' ');
  const flat = text.replace(/\s+/g, ' ');
  const provider = text.split('\n').map((l) => l.trim())
    .find((l) => l.length >= 2 && l.length <= 50 && /[A-Za-z]/.test(l) && !/^[\d$.\-]/.test(l) && !parseDate(l)) ?? null;
  const period = findPeriod(flat);
  const lateTotal = findLateTotal(flat);
  return {
    provider,
    invoice_date: dateNearLabel(flat, ['statement date', 'invoice date', 'bill date', 'billing date', 'statement']),
    due_date: dateNearLabel(flat, ['amount due by', 'payments must be received by', 'payment due', 'due date', 'pay by', 'due by', 'autopay']),
    period_start: period?.[0] ?? null,
    period_end: period?.[1] ?? null,
    total: findTotal(flat, lateTotal),
    late_total: lateTotal,
  };
}

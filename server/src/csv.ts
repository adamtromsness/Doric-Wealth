// Minimal RFC4180-ish CSV parser (no dependency). Handles quoted fields, escaped
// double-quotes (""), commas and newlines inside quotes, and CRLF or LF line endings.
// Returns the header row separately from the data rows. A trailing blank line is ignored.

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

// `maxRows`, when set, stops parsing once that many DATA rows have been read (the
// header is always read first). Lets callers bound work on untrusted input — e.g.
// the stateless /preview, which only needs a sample and an (approximate) count —
// without parsing a whole large file into memory.
export function parseCsv(text: string, opts: { maxRows?: number } = {}): ParsedCsv {
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  // +1 so the header row doesn't count against the data-row cap.
  const maxRecords = opts.maxRows != null ? opts.maxRows + 1 : null;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => { endField(); records.push(record); record = []; };

  while (i < n) {
    if (maxRecords != null && records.length >= maxRecords) break;
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i++; continue; } // swallow CR (CRLF or lone CR)
    if (c === '\n') { endRecord(); i++; continue; }
    field += c; i++;
  }
  // Flush the final field/record if the file didn't end with a newline.
  if (field.length > 0 || record.length > 0) endRecord();

  // Drop fully-empty trailing records (e.g. a final blank line).
  const cleaned = records.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  const headers = (cleaned.shift() ?? []).map((h) => h.trim());
  return { headers, rows: cleaned };
}

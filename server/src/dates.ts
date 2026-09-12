// Timezone-aware date helpers. The app stores dates as plain YYYY-MM-DD; "today"
// and epoch→date conversions must happen in the user's zone, not the server's UTC
// day, or a user west of UTC sees the wrong day near midnight / a period boundary.

// The calendar date (YYYY-MM-DD) of an instant in an IANA timezone. en-CA formats
// as YYYY-MM-DD. A null/invalid zone falls back to UTC.
export function dateInTz(epochMs: number, tz: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 10); // invalid tz → UTC
  }
}

// "Today" (YYYY-MM-DD) in the given zone.
export function todayInTz(tz: string | null | undefined): string {
  return dateInTz(Date.now(), tz);
}

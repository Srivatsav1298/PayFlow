/**
 * CSV serialisation (RFC 4180) with spreadsheet formula-injection protection.
 *
 * Cells that Excel/Sheets would evaluate as a formula (starting with = + @ tab CR, or a minus
 * that is not a plain negative number) are prefixed with a single quote, so an attacker-controlled
 * payment reference like `=HYPERLINK("http://evil",...)` is shown as text, never executed.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function neutralise(value: string): string {
  if (!value) return value;
  const first = value[0];
  const risky = first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r' || (first === '-' && !PLAIN_NUMBER.test(value));
  return risky ? `'${value}` : value;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const raw = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const safe = neutralise(raw);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

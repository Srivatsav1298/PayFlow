import type { Role } from '../api/types';

/** Amounts arrive as decimal strings. Number() is used only to DISPLAY them (and for UI hints); the API does all real money arithmetic with exact decimals. */
export function money(amount: string | number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2 }).format(Number(amount)).replace(/\u00a0/g, ' ');
  } catch {
    return `${amount} ${currency}`;
  }
}

export const moneyList = (m: { currency: string; amount: string }[]) => (m.length ? m.map((x) => money(x.amount, x.currency)).join(' · ') : money(0, 'EUR'));

export const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const label = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const RANK: Record<Role, number> = { ANALYST: 1, MANAGER: 2, ADMIN: 3 };
/** UI hint only — the API enforces roles server-side. Hiding a button is convenience, not security. */
export const atLeast = (role: Role | undefined, min: Role) => !!role && RANK[role] >= RANK[min];

/** Minimal RFC 4180 CSV parser for invoice import (handles quoted fields and escaped quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

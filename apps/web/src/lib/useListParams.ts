import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Filter + page state kept in the URL: filtered views are shareable, survive reload, work with the back
 * button, and other pages can deep-link in (e.g. /invoices?overdue=true). Changing a filter resets to page 1.
 */
export function useListParams<K extends string>(keys: readonly K[]) {
  const [sp, setSp] = useSearchParams();
  const values = Object.fromEntries(keys.map((k) => [k, sp.get(k) ?? ''])) as Record<K, string>;
  const page = Math.max(Number(sp.get('page')) || 1, 1);
  const set = useCallback((patch: Partial<Record<K | 'page', string | number>>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === '' || v === undefined || v === null) next.delete(k); else next.set(k, String(v));
      }
      if (!('page' in patch)) next.delete('page');
      return next;
    }, { replace: true });
  }, [setSp]);
  return { values, page, set, query: { ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')), page } as Record<string, string | number> };
}

/** Delay a fast-changing input (search box) so we do not fire a request per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

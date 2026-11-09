import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHead, Select, Tabs } from '../components/ui';
import { label, money } from '../lib/format';

type Id = 'reconciliation' | 'transaction-volume' | 'failed-payments' | 'outstanding-invoices' | 'provider-performance';
const REPORTS: { id: Id; title: string; blurb: string; ranged: boolean }[] = [
  { id: 'reconciliation', title: 'Reconciliation', blurb: 'Every match decision: who confirmed what, with what evidence.', ranged: true },
  { id: 'transaction-volume', title: 'Transaction volume', blurb: 'Payments per period, provider and currency.', ranged: true },
  { id: 'failed-payments', title: 'Failed payments', blurb: 'Failed payments and how each exception was handled.', ranged: true },
  { id: 'outstanding-invoices', title: 'Outstanding invoices', blurb: 'Open balances with ageing buckets.', ranged: false },
  { id: 'provider-performance', title: 'Provider performance', blurb: 'Success rates and webhook reliability per provider.', ranged: true },
];
interface ReportResult { columns: string[]; data: Record<string, unknown>[]; summary?: Record<string, unknown> }

const MONEY_COLS = new Set(['amount', 'paid', 'outstanding', 'succeededVolume']);
const cell = (col: string, v: unknown, row: Record<string, unknown>) => {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY_COLS.has(col) && typeof row.currency === 'string') return money(String(v), row.currency);
  if (/At$/.test(col) && typeof v === 'string') return new Date(v).toLocaleDateString('en-GB');
  if (col === 'status' || col === 'type') return label(String(v));
  return String(v);
};

export function Reports() {
  const [id, setId] = useState<Id>('reconciliation');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState('day');
  const def = REPORTS.find((r) => r.id === id)!;
  const params = {
    from: def.ranged && from ? new Date(from).toISOString() : undefined,
    to: def.ranged && to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
    ...(id === 'transaction-volume' ? { groupBy } : {}),
  };
  const { data, error, isLoading } = useQuery({ queryKey: ['report', id, params], queryFn: () => api.get<ReportResult>(`/reports/${id}`, params) });
  const dl = useMutation({ mutationFn: () => api.download(`/reports/${id}`, { ...params, format: 'csv' }, `payflow-${id}.csv`) });

  return (
    <div className="stack">
      <PageHead title="Reports" sub="Financial reports with CSV export. Exports are recorded in the audit log." />
      <Card>
        <Tabs<Id> value={id} onChange={setId} tabs={REPORTS.map((r) => ({ id: r.id, label: r.title }))} />
        <div className="filters">
          <div style={{ flex: 1, minWidth: 220 }}><strong>{def.title}</strong><div className="hint">{def.blurb}</div></div>
          {def.ranged && <>
            <Field label="From">{(f) => <Input id={f} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="To">{(f) => <Input id={f} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </>}
          {id === 'transaction-volume' && <Field label="Group by">{(f) => <Select id={f} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}><option value="day">Day</option><option value="month">Month</option></Select>}</Field>}
          <Button variant="primary" disabled={dl.isPending} onClick={() => dl.mutate()}>{dl.isPending ? 'Preparing…' : 'Download CSV'}</Button>
        </div>
        {dl.error && <div className="card-pad"><ErrorBox error={dl.error} /></div>}
        {error ? <div className="card-pad"><ErrorBox error={error} /></div> : isLoading ? <Loading /> : !data?.data.length ? <Empty>No data for this report and period.</Empty> : (
          <>
            {id === 'outstanding-invoices' && Array.isArray(data.summary?.outstandingByCurrency) && (
              <div className="card-pad" style={{ paddingBottom: 0 }}><span className="muted">Total outstanding: </span><strong>{(data.summary!.outstandingByCurrency as { currency: string; amount: string }[]).map((m) => money(m.amount, m.currency)).join(' · ')}</strong></div>
            )}
            <div className="table-wrap"><table>
              <caption className="sr-only">{def.title} report</caption>
              <thead><tr>{data.columns.map((c) => <th key={c}>{label(c.replace(/([A-Z])/g, ' $1'))}</th>)}</tr></thead>
              <tbody>{data.data.slice(0, 200).map((r, i) => <tr key={i}>{data.columns.map((c) => <td key={c} className={MONEY_COLS.has(c) || typeof r[c] === 'number' ? 'num right' : ''}>{cell(c, r[c], r)}</td>)}</tr>)}</tbody>
            </table></div>
            {data.data.length > 200 && <div className="pager"><span>Showing the first 200 of {data.data.length} rows — download the CSV for everything.</span></div>}
          </>
        )}
      </Card>
    </div>
  );
}

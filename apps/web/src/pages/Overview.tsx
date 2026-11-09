import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Overview as O, Trend } from '../api/types';
import { Badge, Card, CardHead, Empty, ErrorBox, Kpi, Loading, PageHead, Select } from '../components/ui';
import { label, money, moneyList } from '../lib/format';

type Mode = 'volume' | 'count';

function Trends({ trends }: { trends: O['trends'] }) {
  const [period, setPeriod] = useState<'daily' | 'monthly'>('daily');
  const [mode, setMode] = useState<Mode>('volume');
  const rows = trends[period];
  const currencies = useMemo(() => [...new Set(rows.map((r) => r.currency))], [rows]);
  const [cur, setCur] = useState<string>('');
  const currency = currencies.includes(cur) ? cur : currencies[0];

  const data = useMemo(() => {
    const by = new Map<string, Trend>();
    rows.filter((r) => r.currency === currency).forEach((r) => by.set(r.bucket, r));
    return [...by.values()].map((r) => ({
      label: new Date(r.bucket).toLocaleDateString('en-GB', period === 'daily' ? { day: '2-digit', month: 'short' } : { month: 'short', year: '2-digit' }),
      volume: Number(r.volume), succeeded: r.succeeded, failed: r.failed, pending: r.pending,
    }));
  }, [rows, currency, period]);

  return (
    <Card>
      <CardHead title="Transaction trends">
        {currencies.length > 1 && <Select aria-label="Currency" value={currency} onChange={(e) => setCur(e.target.value)} style={{ width: 90 }}>{currencies.map((c) => <option key={c}>{c}</option>)}</Select>}
        <Select aria-label="Metric" value={mode} onChange={(e) => setMode(e.target.value as Mode)} style={{ width: 130 }}><option value="volume">Volume</option><option value="count">Count by status</option></Select>
        <Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as 'daily' | 'monthly')} style={{ width: 110 }}><option value="daily">Last 30 days</option><option value="monthly">Last 12 months</option></Select>
      </CardHead>
      <div className="card-pad">
        {!data.length ? <Empty>No transactions in this period.</Empty> : (
          <>
            <div style={{ height: 280 }} role="img" aria-label={`${mode === 'volume' ? 'Succeeded volume' : 'Transaction counts by status'}, ${period}. Data table below.`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} interval="preserveStartEnd" />
                  <YAxis tickLine={false} axisLine={false} width={56} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
                  <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8 }} formatter={(v) => (mode === 'volume' ? money(String(v), currency) : String(v))} />
                  {mode === 'volume' ? (
                    <Bar dataKey="volume" name="Succeeded volume" fill="var(--chart-1)" radius={[3, 3, 0, 0]} />
                  ) : (
                    <>
                      <Legend iconType="circle" />
                      <Bar dataKey="succeeded" name="Succeeded" stackId="s" fill="var(--chart-1)" />
                      <Bar dataKey="pending" name="Pending" stackId="s" fill="var(--chart-3)" />
                      <Bar dataKey="failed" name="Failed" stackId="s" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary className="hint" style={{ cursor: 'pointer' }}>View as table</summary>
              <div className="table-wrap"><table><caption className="sr-only">Transaction trend data</caption>
                <thead><tr><th>Period</th><th className="right">Volume</th><th className="right">Succeeded</th><th className="right">Pending</th><th className="right">Failed</th></tr></thead>
                <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td className="right num">{money(d.volume, currency)}</td><td className="right num">{d.succeeded}</td><td className="right num">{d.pending}</td><td className="right num">{d.failed}</td></tr>)}</tbody>
              </table></div>
            </details>
          </>
        )}
      </div>
    </Card>
  );
}

export function Overview() {
  const { data: o, error, isLoading } = useQuery({ queryKey: ['overview'], queryFn: () => api.get<O>('/reports/overview'), refetchInterval: 60_000 });
  if (isLoading) return <Loading />;
  if (error || !o) return <ErrorBox error={error} />;
  const rate = o.reconciliation.successRate;
  return (
    <div className="stack">
      <PageHead title="Financial overview" sub="Live from your payment records and reconciliation results" />
      <div className="grid kpis">
        <Kpi label="Total transaction volume" value={moneyList(o.totals.volume)} sub={`${o.totals.transactions.toLocaleString()} transactions`} />
        <Kpi label="Successfully processed" tone="ok" value={o.totals.succeeded.count.toLocaleString()} sub={moneyList(o.totals.succeeded.amount)} />
        <Kpi label="Failed" tone="bad" value={o.totals.failed.count.toLocaleString()} sub={moneyList(o.totals.failed.amount)} />
        <Kpi label="Pending" tone="warn" value={o.totals.pending.count.toLocaleString()} sub={o.totals.pending.amount.length ? moneyList(o.totals.pending.amount) : 'Nothing waiting'} />
        <Kpi label="Reconciliation success rate" value={rate === null ? '—' : `${rate}%`} sub={`${o.reconciliation.reconciledPayments} of ${o.reconciliation.succeededPayments} succeeded payments matched`} />
        <Kpi label="Unmatched payments" tone={o.reconciliation.unmatchedPayments ? 'warn' : 'ok'} value={o.reconciliation.unmatchedPayments.toLocaleString()} sub={<Link to="/reconciliation">Review suggestions</Link>} />
      </div>
      <div className="grid two">
        <Trends trends={o.trends} />
        <div className="stack">
          <Card>
            <CardHead title="Open exceptions"><Link to="/exceptions">View all</Link></CardHead>
            {!o.openExceptions.byType.length ? <Empty>No open exceptions 🎉</Empty> : (
              <div className="table-wrap"><table><caption className="sr-only">Open exceptions by type</caption><tbody>
                {o.openExceptions.byType.map((e) => (
                  <tr key={e.type}><td><Link to={`/exceptions?type=${e.type}`}>{label(e.type)}</Link></td><td className="right num"><Badge value={String(e.count)} tone="warn" /></td></tr>
                ))}
              </tbody></table></div>
            )}
          </Card>
          <Card>
            <CardHead title="Invoices"><Link to="/invoices">View all</Link></CardHead>
            <div className="card-pad stack" style={{ gap: 8 }}>
              <div className="row spread"><span className="muted">Outstanding balance</span><strong className="num">{moneyList(o.invoices.outstanding)}</strong></div>
              <div className="row spread"><span className="muted">Overdue invoices</span><Link to="/invoices?overdue=true"><strong>{o.invoices.overdue}</strong></Link></div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

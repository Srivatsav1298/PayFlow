import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Paginated, Transaction } from '../api/types';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHead, Pager, Select } from '../components/ui';
import { dateTime, money } from '../lib/format';
import { useDebounced, useListParams } from '../lib/useListParams';

const KEYS = ['search', 'status', 'provider', 'currency', 'from', 'to', 'minAmount', 'maxAmount'] as const;
const STATUSES = ['CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED'];

export function Transactions() {
  const nav = useNavigate();
  const { values, set, query } = useListParams(KEYS);
  const [search, setSearch] = useState(values.search);
  const debounced = useDebounced(search);
  useEffect(() => { if (debounced !== values.search) set({ search: debounced }); }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ key: string; name: string }[]>('/payment-providers'), staleTime: Infinity });
  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: ['transactions', query],
    queryFn: () => api.get<Paginated<Transaction>>('/transactions', { ...query, pageSize: 25, from: values.from ? new Date(values.from).toISOString() : undefined, to: values.to ? new Date(`${values.to}T23:59:59`).toISOString() : undefined }),
    placeholderData: keepPreviousData,
  });
  const hasFilters = KEYS.some((k) => values[k]);

  return (
    <div className="stack">
      <PageHead title="Transactions" sub="Payments imported from your providers, with their full event history" />
      <Card>
        <form className="filters" role="search" aria-label="Filter transactions" onSubmit={(e) => e.preventDefault()}>
          <Field label="Search reference" wide>{(id) => <Input id={id} type="search" placeholder="Reference or provider id" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
          <Field label="Status">{(id) => <Select id={id} value={values.status} onChange={(e) => set({ status: e.target.value })}><option value="">All</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</Select>}</Field>
          <Field label="Provider">{(id) => <Select id={id} value={values.provider} onChange={(e) => set({ provider: e.target.value })}><option value="">All</option>{providers.data?.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</Select>}</Field>
          <Field label="Currency">{(id) => <Input id={id} maxLength={3} placeholder="EUR" value={values.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
          <Field label="From">{(id) => <Input id={id} type="date" value={values.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={values.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
          <Field label="Min amount">{(id) => <Input id={id} inputMode="decimal" placeholder="0.00" value={values.minAmount} onChange={(e) => set({ minAmount: e.target.value })} />}</Field>
          <Field label="Max amount">{(id) => <Input id={id} inputMode="decimal" placeholder="0.00" value={values.maxAmount} onChange={(e) => set({ maxAmount: e.target.value })} />}</Field>
          {hasFilters && <Button onClick={() => { setSearch(''); set(Object.fromEntries(KEYS.map((k) => [k, '']))); }}>Clear</Button>}
        </form>
        {error ? <div className="card-pad"><ErrorBox error={error} /></div> : isLoading ? <Loading /> : !data?.data.length ? (
          <Empty>{hasFilters ? 'No transactions match these filters.' : 'No transactions yet. Import from a provider in Settings → Integrations.'}</Empty>
        ) : (
          <>
            <div className="table-wrap" aria-busy={isFetching}>
              <table>
                <caption className="sr-only">Transactions</caption>
                <thead><tr><th>Date</th><th>Reference</th><th>Provider ref</th><th>Provider</th><th>Status</th><th className="right">Amount</th></tr></thead>
                <tbody>
                  {data.data.map((t) => (
                    <tr key={t.id} className="clickable" onClick={() => nav(`/transactions/${t.id}`)}>
                      <td className="muted">{dateTime(t.occurredAt)}</td>
                      <td><a href={`/transactions/${t.id}`} onClick={(e) => { e.preventDefault(); nav(`/transactions/${t.id}`); }}>{t.reference ?? <span className="muted">—</span>}</a></td>
                      <td className="mono">{t.providerRef}</td>
                      <td>{t.connection.provider.name}</td>
                      <td><Badge value={t.status} /></td>
                      <td className="right num">{money(t.amount, t.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager meta={data.meta} onPage={(p) => set({ page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Invoice, Paginated } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHead, Pager, Select } from '../components/ui';
import { atLeast, date, money, parseCsv } from '../lib/format';
import { useDebounced, useListParams } from '../lib/useListParams';

const KEYS = ['search', 'status', 'overdue', 'unmatched'] as const;
const MONEY = /^\d{1,15}(\.\d{1,4})?$/;
const COLUMNS = ['reference', 'customerId', 'customerName', 'amount', 'currency', 'issuedAt', 'dueAt'];

function CreateInvoice({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ reference: '', customerId: '', customerName: '', amount: '', currency: 'EUR', issuedAt: today, dueAt: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) });
  const m = useMutation({
    mutationFn: () => api.post('/invoices', { ...f, customerId: f.customerId || undefined, customerName: f.customerName || undefined, issuedAt: new Date(f.issuedAt).toISOString(), dueAt: new Date(f.dueAt).toISOString() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoices'] }); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === 'currency' ? e.target.value.toUpperCase() : e.target.value });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open title="New invoice" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Create invoice</Button></>}>
      <form className="stack" onSubmit={submit}>
        {m.error && <ErrorBox error={m.error} />}
        <Field label="Invoice reference">{(id) => <Input id={id} required value={f.reference} onChange={set('reference')} />}</Field>
        <div className="row">
          <Field label="Amount">{(id) => <Input id={id} required inputMode="decimal" pattern={MONEY.source} title="Positive amount, up to 4 decimals" value={f.amount} onChange={set('amount')} />}</Field>
          <Field label="Currency">{(id) => <Input id={id} required maxLength={3} pattern="[A-Z]{3}" value={f.currency} onChange={set('currency')} />}</Field>
        </div>
        <div className="row">
          <Field label="Customer ID">{(id) => <Input id={id} value={f.customerId} onChange={set('customerId')} />}</Field>
          <Field label="Customer name">{(id) => <Input id={id} value={f.customerName} onChange={set('customerName')} />}</Field>
        </div>
        <div className="row">
          <Field label="Issued">{(id) => <Input id={id} type="date" required value={f.issuedAt} onChange={set('issuedAt')} />}</Field>
          <Field label="Due">{(id) => <Input id={id} type="date" required value={f.dueAt} onChange={set('dueAt')} />}</Field>
        </div>
      </form>
    </Modal>
  );
}

/** Validates every row in the browser first so the user fixes a whole file in one pass, not one 400 at a time. */
export function validateRows(text: string) {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const errors: string[] = [];
  const missing = COLUMNS.filter((c) => !['customerId', 'customerName'].includes(c) && !header.includes(c));
  if (missing.length) return { invoices: [], errors: [`Missing column(s): ${missing.join(', ')}`] };
  const invoices = rows.slice(1).map((r, i) => {
    const o = Object.fromEntries(header.map((h, k) => [h, (r[k] ?? '').trim()]));
    const n = i + 2;
    if (!o.reference) errors.push(`Row ${n}: reference is required`);
    if (!MONEY.test(o.amount) || Number(o.amount) <= 0) errors.push(`Row ${n}: amount "${o.amount}" is not a positive decimal`);
    if (!/^[A-Z]{3}$/.test(o.currency)) errors.push(`Row ${n}: currency "${o.currency}" must be 3 upper-case letters`);
    const issued = new Date(o.issuedAt), due = new Date(o.dueAt);
    if (Number.isNaN(issued.getTime()) || Number.isNaN(due.getTime())) errors.push(`Row ${n}: dates must be ISO (YYYY-MM-DD)`);
    else if (due < issued) errors.push(`Row ${n}: due date is before issue date`);
    return { reference: o.reference, customerId: o.customerId || undefined, customerName: o.customerName || undefined, amount: o.amount, currency: o.currency, issuedAt: Number.isNaN(issued.getTime()) ? '' : issued.toISOString(), dueAt: Number.isNaN(due.getTime()) ? '' : due.toISOString() };
  });
  if (!invoices.length) errors.push('The file has no data rows');
  if (invoices.length > 1000) errors.push('At most 1000 invoices per import');
  return { invoices, errors };
}

function ImportInvoices({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [parsed, setParsed] = useState<ReturnType<typeof validateRows> | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number }>('/invoices/import', { invoices: parsed!.invoices }),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['invoices'] }); },
  });
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setResult(null);
    if (file) setParsed(validateRows(await file.text()));
  };
  const ready = parsed && !parsed.errors.length;
  return (
    <Modal open title="Import invoices from CSV" onClose={onClose} footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || m.isPending} onClick={() => m.mutate()}>Import {ready ? parsed!.invoices.length : ''} invoices</Button></>}>
      <p style={{ margin: 0 }}>Columns: <code className="mono">{COLUMNS.join(', ')}</code>. Dates as YYYY-MM-DD. Existing references are skipped, so re-importing a file is safe.</p>
      <Field label="CSV file">{(id) => <Input id={id} type="file" accept=".csv,text/csv" onChange={onFile} />}</Field>
      {parsed?.errors.length ? <div className="banner bad" role="alert"><strong>Fix these before importing:</strong><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{parsed.errors.slice(0, 8).map((x) => <li key={x}>{x}</li>)}{parsed.errors.length > 8 && <li>…and {parsed.errors.length - 8} more</li>}</ul></div> : ready && !result ? <div className="banner info">{parsed.invoices.length} rows look valid.</div> : null}
      {m.error && <ErrorBox error={m.error} />}
      {result && <div className="banner ok" role="status">Imported {result.created} new invoices{result.skipped ? `, skipped ${result.skipped} that already existed` : ''}.</div>}
    </Modal>
  );
}

export function Invoices() {
  const nav = useNavigate();
  const { role } = useAuth();
  const { values, set, query } = useListParams(KEYS);
  const [search, setSearch] = useState(values.search);
  const debounced = useDebounced(search);
  useEffect(() => { if (debounced !== values.search) set({ search: debounced }); }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dialog, setDialog] = useState<'create' | 'import' | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['invoices', query], queryFn: () => api.get<Paginated<Invoice>>('/invoices', { ...query, pageSize: 25 }), placeholderData: keepPreviousData });
  const canEdit = atLeast(role, 'MANAGER');
  return (
    <div className="stack">
      <PageHead title="Invoices" sub="What you have billed, what has been paid and what is still outstanding">
        {canEdit && <><Button onClick={() => setDialog('import')}>Import CSV</Button><Button variant="primary" onClick={() => setDialog('create')}>New invoice</Button></>}
      </PageHead>
      <Card>
        <form className="filters" role="search" aria-label="Filter invoices" onSubmit={(e) => e.preventDefault()}>
          <Field label="Search" wide>{(id) => <Input id={id} type="search" placeholder="Reference or customer" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
          <Field label="Status">{(id) => <Select id={id} value={values.status} onChange={(e) => set({ status: e.target.value })}><option value="">All</option>{['OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID'].map((s) => <option key={s}>{s}</option>)}</Select>}</Field>
          <Field label="Show">{(id) => (
            <Select id={id} value={values.overdue ? 'overdue' : values.unmatched ? 'unmatched' : ''} onChange={(e) => set({ overdue: e.target.value === 'overdue' ? 'true' : '', unmatched: e.target.value === 'unmatched' ? 'true' : '' })}>
              <option value="">Everything</option><option value="overdue">Overdue only</option><option value="unmatched">Unmatched (no payment)</option>
            </Select>
          )}</Field>
        </form>
        {error ? <div className="card-pad"><ErrorBox error={error} /></div> : isLoading ? <Loading /> : !data?.data.length ? <Empty>No invoices found.</Empty> : (
          <>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Invoices</caption>
                <thead><tr><th>Reference</th><th>Customer</th><th>Status</th><th>Due</th><th className="right">Amount</th><th className="right">Paid</th><th className="right">Outstanding</th></tr></thead>
                <tbody>
                  {data.data.map((i) => (
                    <tr key={i.id} className="clickable" onClick={() => nav(`/invoices/${i.id}`)}>
                      <td><a href={`/invoices/${i.id}`} onClick={(e) => { e.preventDefault(); nav(`/invoices/${i.id}`); }}>{i.reference}</a></td>
                      <td>{i.customerName ?? i.customerId ?? '—'}</td>
                      <td><span className="row" style={{ gap: 6 }}><Badge value={i.status} />{i.isOverdue && <Badge value="Overdue" tone="bad" />}</span></td>
                      <td className={i.isOverdue ? '' : 'muted'}>{date(i.dueAt)}</td>
                      <td className="right num">{money(i.amount, i.currency)}</td>
                      <td className="right num">{money(i.amountPaid, i.currency)}</td>
                      <td className="right num"><strong>{money(i.outstanding, i.currency)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager meta={data.meta} onPage={(p) => set({ page: p })} />
          </>
        )}
      </Card>
      {dialog === 'create' && <CreateInvoice onClose={() => setDialog(null)} />}
      {dialog === 'import' && <ImportInvoices onClose={() => setDialog(null)} />}
    </div>
  );
}

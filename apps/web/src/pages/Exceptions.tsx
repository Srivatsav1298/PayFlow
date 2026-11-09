import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Paginated, PayException } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHead, Pager, Select, Textarea } from '../components/ui';
import { atLeast, dateTime, label, money } from '../lib/format';
import { useListParams } from '../lib/useListParams';

const TYPES = ['DUPLICATE_TRANSACTION', 'MISSING_PAYMENT', 'AMOUNT_DISCREPANCY', 'CURRENCY_MISMATCH', 'UNMATCHED_INVOICE', 'UNMATCHED_TRANSACTION', 'FAILED_PAYMENT', 'DELAYED_EVENT'];
const STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { role, user } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const { data: e, error, isLoading } = useQuery({ queryKey: ['exception', id], queryFn: () => api.get<PayException>(`/exceptions/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['exception', id] }); qc.invalidateQueries({ queryKey: ['exceptions'] }); qc.invalidateQueries({ queryKey: ['overview'] }); };
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSuccess: refresh });
  const closed = e?.status === 'RESOLVED' || e?.status === 'DISMISSED';
  const manager = atLeast(role, 'MANAGER');
  const addNote = (ev: FormEvent) => { ev.preventDefault(); if (note.trim()) act.mutate(() => api.post(`/exceptions/${id}/notes`, { text: note }).then(() => setNote(''))); };

  return (
    <Modal open title={e ? label(e.type) : 'Exception'} onClose={onClose}>
      {isLoading && <Loading />}
      {error && <ErrorBox error={error} />}
      {e && (
        <>
          <div className="row spread"><Badge value={e.status} /><span className="hint">Raised {dateTime(e.createdAt)}</span></div>
          <p style={{ margin: 0 }}><strong>{e.summary}</strong></p>
          <dl className="dl">
            {e.transaction && <><dt>Payment</dt><dd><Link to={`/transactions/${e.transaction.id}`} className="mono">{e.transaction.providerRef}</Link> · {money(e.transaction.amount, e.transaction.currency)} · <Badge value={e.transaction.status} /></dd></>}
            {e.invoice && <><dt>Invoice</dt><dd><Link to={`/invoices/${e.invoice.id}`}>{e.invoice.reference}</Link> · {money(e.invoice.amount, e.invoice.currency)}</dd></>}
            <dt>Assigned to</dt><dd>{e.assignee?.name ?? <span className="muted">Unassigned</span>}</dd>
            {Object.entries(e.details ?? {}).map(([k, v]) => <><dt key={`k${k}`}>{label(k)}</dt><dd key={`v${k}`}>{String(v)}</dd></>)}
            {e.resolution && <><dt>Resolution</dt><dd>{e.resolution}</dd></>}
          </dl>
          {act.error && <ErrorBox error={act.error} />}
          <div>
            <h3 style={{ marginBottom: 6 }}>Notes</h3>
            {!e.notes.length ? <p className="hint" style={{ margin: 0 }}>No notes yet.</p> : <ul style={{ margin: 0, paddingLeft: 18 }}>{e.notes.map((n, i) => <li key={i}>{n.text} <span className="hint">· {dateTime(n.at)}</span></li>)}</ul>}
            {!closed && <form className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }} onSubmit={addNote}><Input aria-label="Add a note" placeholder="Document what you found…" value={note} onChange={(ev) => setNote(ev.target.value)} /><Button type="submit" disabled={!note.trim() || act.isPending}>Add</Button></form>}
          </div>
          {!closed && (
            <div className="row">
              {e.status === 'OPEN' && <Button onClick={() => act.mutate(() => api.patch(`/exceptions/${id}/investigate`))}>Start investigating</Button>}
              {manager && e.assignee?.id !== user?.id && <Button onClick={() => act.mutate(() => api.patch(`/exceptions/${id}/assign`, { assigneeId: user!.id }))}>Assign to me</Button>}
              {manager && e.assignee && <Button onClick={() => act.mutate(() => api.patch(`/exceptions/${id}/assign`, { assigneeId: null }))}>Unassign</Button>}
            </div>
          )}
          {!closed && manager && (
            <div className="stack" style={{ gap: 8 }}>
              <Field label="Resolution" hint="Required. Kept in the audit trail.">{(fid) => <Textarea id={fid} value={resolution} onChange={(ev) => setResolution(ev.target.value)} placeholder="e.g. Customer contacted, payment re-issued" />}</Field>
              <div className="row"><Button variant="primary" disabled={!resolution.trim() || act.isPending} onClick={() => act.mutate(() => api.patch(`/exceptions/${id}/resolve`, { resolution, status: 'RESOLVED' }))}>Mark resolved</Button><Button disabled={!resolution.trim() || act.isPending} onClick={() => act.mutate(() => api.patch(`/exceptions/${id}/resolve`, { resolution, status: 'DISMISSED' }))}>Dismiss</Button></div>
            </div>
          )}
          {!closed && !manager && <p className="hint" style={{ margin: 0 }}>Analysts can investigate and add notes. A finance manager resolves exceptions.</p>}
        </>
      )}
    </Modal>
  );
}

export function Exceptions() {
  const { values, set, query } = useListParams(['type', 'status'] as const);
  const [sp, setSp] = useSearchParams();
  const openId = sp.get('id');
  const { data, error, isLoading } = useQuery({ queryKey: ['exceptions', query], queryFn: () => api.get<Paginated<PayException>>('/exceptions', { ...query, pageSize: 25 }), placeholderData: keepPreviousData });
  const close = () => setSp((p) => { const n = new URLSearchParams(p); n.delete('id'); return n; }, { replace: true });
  const open = (id: string) => setSp((p) => { const n = new URLSearchParams(p); n.set('id', id); return n; }, { replace: true });
  return (
    <div className="stack">
      <PageHead title="Exceptions" sub="Payments and invoices that need a person: investigate, assign, resolve and document" />
      <Card>
        <form className="filters" role="search" aria-label="Filter exceptions" onSubmit={(e) => e.preventDefault()}>
          <Field label="Type" wide>{(id) => <Select id={id} value={values.type} onChange={(e) => set({ type: e.target.value })}><option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select>}</Field>
          <Field label="Status">{(id) => <Select id={id} value={values.status} onChange={(e) => set({ status: e.target.value })}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>}</Field>
        </form>
        {error ? <div className="card-pad"><ErrorBox error={error} /></div> : isLoading ? <Loading /> : !data?.data.length ? <Empty>No exceptions match.</Empty> : (
          <>
            <div className="table-wrap"><table>
              <caption className="sr-only">Exceptions</caption>
              <thead><tr><th>Type</th><th>Summary</th><th>Status</th><th>Assignee</th><th>Raised</th></tr></thead>
              <tbody>{data.data.map((x) => (
                <tr key={x.id} className="clickable" onClick={() => open(x.id)}>
                  <td><Badge value={x.type} /></td>
                  <td><button className="btn ghost sm" style={{ padding: 0, fontWeight: 500, textAlign: 'left' }} onClick={(ev) => { ev.stopPropagation(); open(x.id); }}>{x.summary}</button></td>
                  <td><Badge value={x.status} /></td>
                  <td className="muted">{x.assignee?.name ?? '—'}</td>
                  <td className="muted">{dateTime(x.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pager meta={data.meta} onPage={(p) => set({ page: p })} />
          </>
        )}
      </Card>
      {openId && <Detail id={openId} onClose={close} />}
    </div>
  );
}

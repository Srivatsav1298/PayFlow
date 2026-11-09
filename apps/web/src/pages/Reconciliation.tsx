import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Match, Paginated, Run } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Kpi, Loading, Modal, PageHead, Pager, Reasons, Tabs } from '../components/ui';
import { atLeast, dateTime, money } from '../lib/format';

type Tab = 'SUGGESTED' | 'CONFIRMED' | 'REJECTED' | 'runs';
type Action = 'confirm' | 'reject' | 'reverse';
const COPY: Record<Action, { title: string; verb: string; body: string; variant?: 'danger' | 'primary' }> = {
  confirm: { title: 'Confirm match', verb: 'Confirm match', body: 'This applies the payment to the invoice and updates its balance.', variant: 'primary' },
  reject: { title: 'Reject suggestion', verb: 'Reject', body: 'The pair will not be suggested again.', variant: 'danger' },
  reverse: { title: 'Reverse confirmed match', verb: 'Reverse match', body: 'This removes the payment from the invoice and restores its balance.', variant: 'danger' },
};

function Review({ match, action, onClose }: { match: Match; action: Action; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const c = COPY[action];
  const m = useMutation({
    mutationFn: () => api.post(`/reconciliation/matches/${match.id}/${action}`, { note: note || undefined }),
    onSuccess: () => { qc.invalidateQueries(); onClose(); },
  });
  return (
    <Modal open title={c.title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={c.variant} disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Working…' : c.verb}</Button></>}>
      <p style={{ margin: 0 }}>{c.body}</p>
      <dl className="dl">
        <dt>Payment</dt><dd className="mono">{match.transaction.providerRef} · {money(match.transaction.amount, match.transaction.currency)}</dd>
        <dt>Invoice</dt><dd>{match.invoice.reference}</dd>
        <dt>Amount applied</dt><dd className="num"><strong>{money(match.matchedAmount, match.transaction.currency)}</strong></dd>
      </dl>
      {m.error && <ErrorBox error={m.error} />}
      <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </Modal>
  );
}

function Matches({ status }: { status: 'SUGGESTED' | 'CONFIRMED' | 'REJECTED' }) {
  const { role } = useAuth();
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<{ match: Match; action: Action } | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['matches', status, page], queryFn: () => api.get<Paginated<Match>>('/reconciliation/results', { status, page, pageSize: 20 }), placeholderData: keepPreviousData });
  const canAct = atLeast(role, 'MANAGER');
  if (error) return <div className="card-pad"><ErrorBox error={error} /></div>;
  if (isLoading) return <Loading />;
  if (!data?.data.length) return <Empty>{status === 'SUGGESTED' ? 'Nothing needs review — every payment is matched or has no candidate.' : `No ${status.toLowerCase()} matches.`}</Empty>;
  return (
    <>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{status.toLowerCase()} matches</caption>
          <thead><tr><th>Payment</th><th>Invoice</th><th>Score</th><th>Evidence</th><th className="right">Applies</th>{canAct && status !== 'REJECTED' && <th><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>
            {data.data.map((m) => (
              <tr key={m.id}>
                <td><Link to={`/transactions/${m.transaction.id}`} className="mono">{m.transaction.providerRef}</Link><div className="hint">{m.transaction.reference ?? 'no reference'} · {money(m.transaction.amount, m.transaction.currency)}</div></td>
                <td><Link to={`/invoices/${m.invoice.id}`}>{m.invoice.reference}</Link><div className="hint">{money(m.invoice.amount, m.invoice.currency)} · paid {money(m.invoice.amountPaid, m.invoice.currency)}</div></td>
                <td><span className="score num">{m.score}</span><div><Badge value={m.type} /></div></td>
                <td><Reasons reasons={m.reasons} /></td>
                <td className="right num">{money(m.matchedAmount, m.transaction.currency)}</td>
                {canAct && status === 'SUGGESTED' && <td className="right"><span className="row" style={{ justifyContent: 'flex-end' }}><Button small variant="primary" onClick={() => setReview({ match: m, action: 'confirm' })}>Confirm</Button><Button small onClick={() => setReview({ match: m, action: 'reject' })}>Reject</Button></span></td>}
                {canAct && status === 'CONFIRMED' && <td className="right"><Button small onClick={() => setReview({ match: m, action: 'reverse' })}>Reverse</Button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager meta={data.meta} onPage={setPage} />
      {review && <Review {...review} onClose={() => setReview(null)} />}
    </>
  );
}

function Runs() {
  const { data, error, isLoading } = useQuery({ queryKey: ['runs'], queryFn: () => api.get<Paginated<Run>>('/reconciliation/runs', { pageSize: 15 }) });
  if (error) return <div className="card-pad"><ErrorBox error={error} /></div>;
  if (isLoading) return <Loading />;
  if (!data?.data.length) return <Empty>No reconciliation runs yet.</Empty>;
  return (
    <div className="table-wrap"><table><caption className="sr-only">Reconciliation run history</caption>
      <thead><tr><th>Started</th><th>Status</th><th className="right">Payments</th><th className="right">Invoices</th><th className="right">Auto-matched</th><th className="right">Suggested</th><th className="right">Exceptions</th></tr></thead>
      <tbody>{data.data.map((r) => <tr key={r.id}><td>{dateTime(r.startedAt)}</td><td><Badge value={r.status} />{r.error && <div className="hint">{r.error}</div>}</td><td className="right num">{r.transactionsScanned}</td><td className="right num">{r.invoicesScanned}</td><td className="right num">{r.exactMatches}</td><td className="right num">{r.suggestedMatches}</td><td className="right num">{r.exceptionsRaised}</td></tr>)}</tbody>
    </table></div>
  );
}

export function Reconciliation() {
  const { role } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('SUGGESTED');
  const runs = useQuery({ queryKey: ['runs-latest'], queryFn: () => api.get<Paginated<Run>>('/reconciliation/runs', { pageSize: 1 }) });
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.get<import('../api/types').Overview>('/reports/overview') });
  const run = useMutation({ mutationFn: () => api.post<Run>('/reconciliation/run'), onSuccess: () => qc.invalidateQueries() });
  const last = runs.data?.data[0];
  return (
    <div className="stack">
      <PageHead title="Reconciliation" sub="Exact matches are applied automatically. Anything uncertain waits here for a person to decide.">
        {atLeast(role, 'MANAGER') && <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Running…' : 'Run reconciliation'}</Button>}
      </PageHead>
      {run.error && <ErrorBox error={run.error} />}
      {run.data && <div className="banner ok" role="status">Run complete: {run.data.exactMatches} matched automatically, {run.data.suggestedMatches} new suggestions, {run.data.exceptionsRaised} new exceptions.</div>}
      <div className="grid kpis">
        <Kpi label="Success rate" value={overview.data?.reconciliation.successRate == null ? '—' : `${overview.data.reconciliation.successRate}%`} sub="of succeeded payments matched" />
        <Kpi label="Unmatched payments" tone="warn" value={overview.data?.reconciliation.unmatchedPayments ?? '—'} />
        <Kpi label="Last run" value={last ? <Badge value={last.status} /> : '—'} sub={last ? dateTime(last.startedAt) : 'Never run'} />
        <Kpi label="Last run result" value={last ? `${last.exactMatches} / ${last.suggestedMatches}` : '—'} sub="auto-matched / suggested" />
      </div>
      <Card>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'SUGGESTED', label: 'Needs review' }, { id: 'CONFIRMED', label: 'Confirmed' }, { id: 'REJECTED', label: 'Rejected' }, { id: 'runs', label: 'Run history' }]} />
        {tab === 'runs' ? <Runs /> : <Matches key={tab} status={tab} />}
      </Card>
    </div>
  );
}

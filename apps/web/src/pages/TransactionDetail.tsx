import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { HistoryEntry, Invoice, Match, Paginated, PayException, Transaction } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, CardHead, Empty, ErrorBox, Field, Input, Loading, Modal, PageHead, Reasons, Select } from '../components/ui';
import { atLeast, dateTime, label, money } from '../lib/format';

type Detail = Transaction & {
  history: HistoryEntry[];
  invoicePayments: { id: string; amount: string; currency: string; invoice: { id: string; reference: string; status: string } }[];
  matches: Match[];
  exceptions: PayException[];
};

function ManualMatch({ txn, onClose }: { txn: Detail; onClose: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const invoices = useQuery({ queryKey: ['invoice-picker', search], queryFn: () => api.get<Paginated<Invoice>>('/invoices', { search, pageSize: 20 }) });
  const open = (invoices.data?.data ?? []).filter((i) => i.status === 'OPEN' || i.status === 'PARTIALLY_PAID');
  const m = useMutation({
    mutationFn: () => api.post('/reconciliation/matches/manual', { transactionId: txn.id, invoiceId, amount: amount || undefined, note: note || undefined }),
    onSuccess: () => { qc.invalidateQueries(); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal open title="Match payment to invoice" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!invoiceId || m.isPending} onClick={() => m.mutate()}>Confirm match</Button></>}>
      <form className="stack" onSubmit={submit}>
        <p style={{ margin: 0 }}>Payment <span className="mono">{txn.providerRef}</span> · <strong>{money(txn.amount, txn.currency)}</strong></p>
        {m.error && <ErrorBox error={m.error} />}
        <Field label="Find invoice">{(id) => <Input id={id} type="search" placeholder="Invoice reference or customer" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
        <Field label="Invoice">{(id) => (
          <Select id={id} required value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} size={Math.min(Math.max(open.length, 2), 6)}>
            {open.map((i) => <option key={i.id} value={i.id}>{i.reference} — outstanding {money(i.outstanding, i.currency)}</option>)}
          </Select>
        )}</Field>
        <Field label="Amount to apply (optional)" hint="Defaults to the largest amount that fits both the payment and the invoice.">{(id) => <Input id={id} inputMode="decimal" placeholder="e.g. 125.50" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </form>
    </Modal>
  );
}

export function TransactionDetail() {
  const { id } = useParams();
  const { role } = useAuth();
  const [matching, setMatching] = useState(false);
  const { data: t, error, isLoading } = useQuery({ queryKey: ['transaction', id], queryFn: () => api.get<Detail>(`/transactions/${id}`) });
  if (isLoading) return <Loading />;
  if (error || !t) return <ErrorBox error={error} />;
  const allocated = t.invoicePayments.reduce((n, p) => n + Number(p.amount), 0);
  const canMatch = atLeast(role, 'MANAGER') && t.status === 'SUCCEEDED' && allocated < Number(t.amount);

  return (
    <div className="stack">
      <PageHead title={t.reference ?? t.providerRef} sub={`Payment ${t.providerRef}`}>
        <Link to="/transactions" className="btn">← Transactions</Link>
        {canMatch && <Button variant="primary" onClick={() => setMatching(true)}>Match to invoice</Button>}
      </PageHead>
      <div className="grid two">
        <div className="stack">
          <Card>
            <CardHead title="Details"><Badge value={t.status} /></CardHead>
            <dl className="dl card-pad">
              <dt>Amount</dt><dd className="num"><strong>{money(t.amount, t.currency)}</strong></dd>
              <dt>Customer</dt><dd>{t.customerId ?? '—'}</dd>
              <dt>Provider</dt><dd>{t.connection.provider.name} · {t.connection.label}</dd>
              <dt>Occurred</dt><dd>{dateTime(t.occurredAt)}</dd>
              <dt>Applied to invoices</dt><dd className="num">{money(allocated, t.currency)}{allocated === 0 && <span className="muted"> · not yet matched</span>}</dd>
            </dl>
          </Card>
          <Card>
            <CardHead title="Linked invoices" />
            {!t.invoicePayments.length ? <Empty>This payment has not been applied to any invoice.</Empty> : (
              <div className="table-wrap"><table><caption className="sr-only">Invoices paid by this transaction</caption><tbody>
                {t.invoicePayments.map((p) => <tr key={p.id}><td><Link to={`/invoices/${p.invoice.id}`}>{p.invoice.reference}</Link></td><td><Badge value={p.invoice.status} /></td><td className="right num">{money(p.amount, p.currency)}</td></tr>)}
              </tbody></table></div>
            )}
          </Card>
          {!!t.matches.length && (
            <Card>
              <CardHead title="Reconciliation matches" />
              <div className="table-wrap"><table><caption className="sr-only">Matches</caption>
                <thead><tr><th>Invoice</th><th>Status</th><th>Score</th><th>Why</th></tr></thead>
                <tbody>{t.matches.map((m) => <tr key={m.id}><td><Link to={`/invoices/${m.invoice.id}`}>{m.invoice.reference}</Link></td><td><Badge value={m.status} /></td><td className="score num">{m.score}</td><td><Reasons reasons={m.reasons} /></td></tr>)}</tbody>
              </table></div>
            </Card>
          )}
          {!!t.exceptions.length && (
            <Card>
              <CardHead title="Exceptions" />
              <div className="table-wrap"><table><caption className="sr-only">Exceptions</caption><tbody>
                {t.exceptions.map((e) => <tr key={e.id}><td><Link to={`/exceptions?id=${e.id}`}>{label(e.type)}</Link></td><td>{e.summary}</td><td><Badge value={e.status} /></td></tr>)}
              </tbody></table></div>
            </Card>
          )}
        </div>
        <Card>
          <CardHead title="Status history" />
          <div className="card-pad">
            <ol className="timeline">
              {t.history.map((h) => (
                <li key={h.id}>
                  <div className="row">{h.fromStatus && <><Badge value={h.fromStatus} /><span aria-label="to">→</span></>}<Badge value={h.toStatus} /></div>
                  <div className="hint">{label(h.eventType.replace('.', ' '))} · {dateTime(h.occurredAt)}</div>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      </div>
      {matching && <ManualMatch txn={t} onClose={() => setMatching(false)} />}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Invoice, Match, PayException } from '../api/types';
import { Badge, Card, CardHead, Empty, ErrorBox, Loading, PageHead, Reasons } from '../components/ui';
import { date, dateTime, label, money } from '../lib/format';

type Detail = Invoice & {
  payments: { id: string; amount: string; currency: string; createdAt: string; transaction: { id: string; providerRef: string; status: string; occurredAt: string } }[];
  matches: (Match & { transactionId: string })[];
  exceptions: PayException[];
};

export function InvoiceDetail() {
  const { id } = useParams();
  const { data: i, error, isLoading } = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Detail>(`/invoices/${id}`) });
  if (isLoading) return <Loading />;
  if (error || !i) return <ErrorBox error={error} />;
  const pct = Math.min(100, Math.round((Number(i.amountPaid) / Number(i.amount)) * 100));
  return (
    <div className="stack">
      <PageHead title={i.reference} sub={i.customerName ?? i.customerId ?? undefined}>
        <Link to="/invoices" className="btn">← Invoices</Link>
      </PageHead>
      <div className="grid two">
        <div className="stack">
          <Card>
            <CardHead title="Balance"><span className="row"><Badge value={i.status} />{i.isOverdue && <Badge value="Overdue" tone="bad" />}</span></CardHead>
            <div className="card-pad stack" style={{ gap: 12 }}>
              <div className="row spread"><span className="muted">Outstanding</span><strong className="kpi-value num" style={{ margin: 0 }}>{money(i.outstanding, i.currency)}</strong></div>
              <div role="progressbar" aria-label="Paid" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, background: 'var(--neutral-soft)', borderRadius: 99 }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--ok)', borderRadius: 99 }} />
              </div>
              <dl className="dl">
                <dt>Invoice total</dt><dd className="num">{money(i.amount, i.currency)}</dd>
                <dt>Paid</dt><dd className="num">{money(i.amountPaid, i.currency)}</dd>
                <dt>Issued</dt><dd>{date(i.issuedAt)}</dd>
                <dt>Due</dt><dd>{date(i.dueAt)}</dd>
              </dl>
            </div>
          </Card>
          <Card>
            <CardHead title="Payments applied" />
            {!i.payments.length ? <Empty>No payments applied yet.</Empty> : (
              <div className="table-wrap"><table><caption className="sr-only">Payments applied to this invoice</caption>
                <thead><tr><th>Payment</th><th>Status</th><th>Applied</th><th className="right">Amount</th></tr></thead>
                <tbody>{i.payments.map((p) => <tr key={p.id}><td><Link to={`/transactions/${p.transaction.id}`} className="mono">{p.transaction.providerRef}</Link></td><td><Badge value={p.transaction.status} /></td><td className="muted">{dateTime(p.createdAt)}</td><td className="right num">{money(p.amount, p.currency)}</td></tr>)}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        <div className="stack">
          {!!i.matches.length && (
            <Card>
              <CardHead title="Match candidates" />
              <div className="table-wrap"><table><caption className="sr-only">Reconciliation matches</caption><tbody>
                {i.matches.map((m) => <tr key={m.id}><td><Link to={`/transactions/${m.transactionId}`}>View payment</Link></td><td><Badge value={m.status} /></td><td className="score num">{m.score}</td><td><Reasons reasons={m.reasons} /></td></tr>)}
              </tbody></table></div>
            </Card>
          )}
          {!!i.exceptions.length && (
            <Card>
              <CardHead title="Exceptions" />
              <div className="table-wrap"><table><caption className="sr-only">Exceptions</caption><tbody>
                {i.exceptions.map((e) => <tr key={e.id}><td><Link to={`/exceptions?id=${e.id}`}>{label(e.type)}</Link></td><td>{e.summary}</td><td><Badge value={e.status} /></td></tr>)}
              </tbody></table></div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

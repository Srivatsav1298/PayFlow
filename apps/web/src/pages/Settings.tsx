import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { AuditEntry, Paginated, WebhookEvent } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, PageHead, Pager, Select, Tabs } from '../components/ui';
import { atLeast, dateTime, label } from '../lib/format';
import { Integrations, OrganisationSettings, Team } from './SettingsAdmin';

function Webhooks() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, isLoading } = useQuery({ queryKey: ['webhook-events', status, page], queryFn: () => api.get<Paginated<WebhookEvent>>('/webhooks/events/history', { status, page, pageSize: 20 }), placeholderData: keepPreviousData, refetchInterval: 15_000 });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/webhooks/events/${id}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhook-events'] }) });
  return (
    <>
      <div className="filters">
        <Field label="Status">{(id) => <Select id={id} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option>{['RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED', 'DEAD_LETTER'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>}</Field>
        <span className="hint" style={{ alignSelf: 'center' }}>Failed events retry automatically with exponential backoff, then move to dead-letter for manual retry.</span>
      </div>
      {retry.error && <div className="card-pad"><ErrorBox error={retry.error} /></div>}
      {error ? <div className="card-pad"><ErrorBox error={error} /></div> : isLoading ? <Loading /> : !data?.data.length ? <Empty>No webhook events yet.</Empty> : (
        <>
          <div className="table-wrap"><table><caption className="sr-only">Webhook events</caption>
            <thead><tr><th>Received</th><th>Event</th><th>Type</th><th>Status</th><th className="right">Attempts</th><th className="right">Duplicates</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{data.data.map((e) => (
              <tr key={e.id}>
                <td className="muted">{dateTime(e.receivedAt)}</td><td className="mono">{e.providerEventId.slice(0, 24)}</td><td>{e.type}</td>
                <td><Badge value={e.status} />{e.lastError && <div className="hint">{e.lastError}</div>}</td>
                <td className="right num">{e.attempts}</td><td className="right num">{e.duplicateCount}</td>
                <td className="right">{['FAILED', 'DEAD_LETTER', 'RECEIVED'].includes(e.status) && <Button small disabled={retry.isPending} onClick={() => retry.mutate(e.id)}>Retry</Button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <Pager meta={data.meta} onPage={setPage} />
        </>
      )}
    </>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const { data, error, isLoading } = useQuery({ queryKey: ['audit', page], queryFn: () => api.get<Paginated<AuditEntry>>('/audit-logs', { page, pageSize: 25 }), placeholderData: keepPreviousData });
  if (error) return <div className="card-pad"><ErrorBox error={error} /></div>;
  if (isLoading) return <Loading />;
  if (!data?.data.length) return <Empty>No audit entries.</Empty>;
  return (
    <>
      <div className="table-wrap"><table><caption className="sr-only">Audit log</caption>
        <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
        <tbody>{data.data.map((a) => <tr key={a.id}><td className="muted">{dateTime(a.createdAt)}</td><td><code className="mono">{a.action}</code></td><td>{a.entityType}{a.entityId && <span className="hint mono"> {a.entityId.slice(0, 8)}</span>}</td><td className="muted">{a.ip ?? '—'}</td></tr>)}</tbody>
      </table></div>
      <Pager meta={data.meta} onPage={setPage} />
    </>
  );
}

type Tab = 'webhooks' | 'integrations' | 'team' | 'organisation' | 'audit';
export function Settings() {
  const { role } = useAuth();
  const admin = atLeast(role, 'ADMIN');
  const [tab, setTab] = useState<Tab>(admin ? 'integrations' : 'webhooks');
  const tabs: { id: Tab; label: string }[] = [{ id: 'webhooks', label: 'Webhook events' }, ...(admin ? [{ id: 'integrations' as Tab, label: 'Integrations' }, { id: 'team' as Tab, label: 'Team' }, { id: 'organisation' as Tab, label: 'Organisation & rules' }, { id: 'audit' as Tab, label: 'Audit log' }] : [])];
  return (
    <div className="stack">
      <PageHead title={admin ? 'Settings' : 'Activity'} sub={admin ? 'Integrations, team, matching rules and audit trail' : 'Webhook delivery and processing history'} />
      <Card>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={tabs} />
        {tab === 'webhooks' && <Webhooks />}
        {admin && tab === 'integrations' && <Integrations />}
        {admin && tab === 'team' && <Team />}
        {admin && tab === 'organisation' && <OrganisationSettings />}
        {admin && tab === 'audit' && <Audit />}
      </Card>
    </div>
  );
}

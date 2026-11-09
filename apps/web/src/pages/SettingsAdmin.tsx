import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Connection, Member, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Empty, ErrorBox, Field, Input, Loading, Modal, Select } from '../components/ui';
import { dateTime } from '../lib/format';

// ───────── Integrations ─────────

function Simulate({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ type: 'payment.succeeded', amount: '100.00', reference: '', eventId: '', sequence: '' });
  const m = useMutation({
    mutationFn: () => api.post<{ status: string; paymentRef: string; sequence: number }>(`/integrations/${conn.id}/simulate`, {
      type: f.type, amount: f.amount, reference: f.reference || undefined, eventId: f.eventId || undefined, sequence: f.sequence ? Number(f.sequence) : undefined,
    }),
    onSuccess: () => { setTimeout(() => qc.invalidateQueries(), 800); },
  });
  return (
    <Modal open title="Simulate provider event" onClose={onClose} footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Send signed event</Button></>}>
      <p className="hint" style={{ margin: 0 }}>Sandbox only. Sends a correctly signed webhook through the real intake: signature check → duplicate detection → queue → worker.</p>
      <Field label="Event type">{(id) => <Select id={id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['payment.created', 'payment.pending', 'payment.succeeded', 'payment.failed', 'payment.refunded'].map((t) => <option key={t}>{t}</option>)}</Select>}</Field>
      <div className="row">
        <Field label="Amount">{(id) => <Input id={id} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        <Field label="Reference">{(id) => <Input id={id} placeholder="INV-1001" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
      </div>
      <div className="row">
        <Field label="Event id" hint="Reuse one to simulate a duplicate delivery">{(id) => <Input id={id} value={f.eventId} onChange={(e) => setF({ ...f, eventId: e.target.value })} />}</Field>
        <Field label="Sequence" hint="Lower than current = out-of-order">{(id) => <Input id={id} inputMode="numeric" value={f.sequence} onChange={(e) => setF({ ...f, sequence: e.target.value })} />}</Field>
      </div>
      {m.error && <ErrorBox error={m.error} />}
      {m.data && <div className="banner ok" role="status">{m.data.status === 'duplicate' ? 'Duplicate event acknowledged — nothing was applied twice.' : `Accepted and queued for payment ${m.data.paymentRef} (sequence ${m.data.sequence}).`}</div>}
    </Modal>
  );
}

export function Integrations() {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [count, setCount] = useState('60');
  const [secret, setSecret] = useState<{ label: string; secret: string; path: string } | null>(null);
  const [sim, setSim] = useState<Connection | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['connections'], queryFn: () => api.get<Connection[]>('/integrations') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['connections'] });
  const create = useMutation({
    mutationFn: () => api.post<Connection & { webhookSecret: string }>('/integrations', { providerKey: 'mock', label, credentials: { seed: label.toLowerCase().replace(/\W+/g, '-') || 'default', count: Number(count) } }),
    onSuccess: (c) => { setSecret({ label: c.label, secret: c.webhookSecret, path: c.webhookPath }); setLabel(''); refresh(); },
  });
  const sync = useMutation({
    mutationFn: (id: string) => api.post<{ created: number; updated: number; unchanged: number; fetched: number }>('/transactions/import', { connectionId: id }),
    onSuccess: (r) => { setNote(`Import finished: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged (of ${r.fetched} fetched).`); qc.invalidateQueries(); },
    onError: () => { setNote(null); refresh(); },
  });
  const rotate = useMutation({ mutationFn: (c: Connection) => api.post<{ webhookSecret: string }>(`/integrations/${c.id}/rotate-webhook-secret`).then((r) => ({ c, r })), onSuccess: ({ c, r }) => setSecret({ label: c.label, secret: r.webhookSecret, path: c.webhookPath }) });
  const off = useMutation({ mutationFn: (id: string) => api.del(`/integrations/${id}`), onSuccess: refresh });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <div className="stack" style={{ padding: 20 }}>
      <div className="banner info">PayFlow runs in <strong>sandbox mode</strong>: only the simulated mock provider can be connected. No real money moves and no live credentials are accepted.</div>
      {secret && (
        <div className="banner ok" role="status">
          <strong>Webhook secret for “{secret.label}” — shown once, copy it now:</strong>
          <div className="mono" style={{ margin: '6px 0', wordBreak: 'break-all' }}>{secret.secret}</div>
          <div>Endpoint: <span className="mono">{secret.path}</span> · header <span className="mono">X-PayFlow-Signature: t=…,v1=…</span> <Button small variant="ghost" onClick={() => setSecret(null)}>Dismiss</Button></div>
        </div>
      )}
      {note && <div className="banner ok" role="status">{note}</div>}
      {(sync.error || off.error || rotate.error) && <ErrorBox error={sync.error ?? off.error ?? rotate.error} />}
      {error ? <ErrorBox error={error} /> : isLoading ? <Loading /> : !data?.length ? <Empty>No integrations yet. Connect the mock provider below.</Empty> : (
        <div className="table-wrap"><table><caption className="sr-only">Provider connections</caption>
          <thead><tr><th>Connection</th><th>Provider</th><th>Last sync</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.label}</strong><div className="hint mono">{c.id.slice(0, 8)}</div></td>
              <td>{c.provider.name}</td>
              <td>{c.lastSyncAt ? dateTime(c.lastSyncAt) : <span className="muted">Never</span>}{c.lastSyncError && <div className="error-text">{c.lastSyncError}</div>}</td>
              <td><Badge value={c.isActive ? 'OPEN' : 'VOID'} tone={c.isActive ? 'ok' : 'neutral'} />{' '}<span className="hint">{c.isActive ? 'Active' : 'Inactive'}</span></td>
              <td className="right"><span className="row" style={{ justifyContent: 'flex-end' }}>
                {c.isActive && <><Button small variant="primary" disabled={sync.isPending} onClick={() => sync.mutate(c.id)}>{sync.isPending && sync.variables === c.id ? 'Importing…' : 'Import now'}</Button>
                <Button small onClick={() => setSim(c)}>Simulate event</Button>
                <Button small onClick={() => rotate.mutate(c)}>Rotate secret</Button>
                <Button small variant="danger" onClick={() => window.confirm(`Deactivate “${c.label}”? Its history is kept.`) && off.mutate(c.id)}>Deactivate</Button></>}
              </span></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={submit} aria-label="Connect mock provider">
        <Field label="New connection name" wide>{(id) => <Input id={id} required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Mock sandbox (Nordics)" />}</Field>
        <Field label="Simulated payments">{(id) => <Input id={id} type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} />}</Field>
        <Button variant="primary" type="submit" disabled={create.isPending}>Connect mock provider</Button>
      </form>
      {create.error && <ErrorBox error={create.error} />}
      {sim && <Simulate conn={sim} onClose={() => setSim(null)} />}
    </div>
  );
}

// ───────── Team ─────────

export function Team() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', name: '', password: '', role: 'ANALYST' as Role });
  const { data, error, isLoading } = useQuery({ queryKey: ['members'], queryFn: () => api.get<Member[]>('/organisations/current/members') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['members'] });
  const add = useMutation({ mutationFn: () => api.post('/organisations/current/members', f), onSuccess: () => { setF({ email: '', name: '', password: '', role: 'ANALYST' }); refresh(); } });
  const patch = useMutation({ mutationFn: (v: { id: string; role: Role }) => api.patch(`/organisations/current/members/${v.id}`, { role: v.role }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/organisations/current/members/${id}`), onSuccess: refresh });
  const submit = (e: FormEvent) => { e.preventDefault(); add.mutate(); };
  return (
    <div className="stack" style={{ padding: 20 }}>
      {(patch.error || remove.error) && <ErrorBox error={patch.error ?? remove.error} />}
      {error ? <ErrorBox error={error} /> : isLoading ? <Loading /> : (
        <div className="table-wrap"><table><caption className="sr-only">Team members</caption>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{data?.map((m) => (
            <tr key={m.id}>
              <td>{m.user.name}{m.user.id === user?.id && <span className="hint"> (you)</span>}</td><td className="muted">{m.user.email}</td>
              <td><Select aria-label={`Role for ${m.user.name}`} value={m.role} onChange={(e) => patch.mutate({ id: m.id, role: e.target.value as Role })} style={{ width: 140 }}><option value="ADMIN">Admin</option><option value="MANAGER">Finance manager</option><option value="ANALYST">Finance analyst</option></Select></td>
              <td className="right"><Button small variant="danger" onClick={() => window.confirm(`Remove ${m.user.name} from this organisation?`) && remove.mutate(m.id)}>Remove</Button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      <form className="stack" onSubmit={submit} aria-label="Add team member" style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
        <h3>Add a team member</h3>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Email">{(id) => <Input id={id} type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="Initial password" hint="10+ chars, upper, lower, digit">{(id) => <Input id={id} type="password" autoComplete="new-password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
          <Field label="Role">{(id) => <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}><option value="ANALYST">Finance analyst</option><option value="MANAGER">Finance manager</option><option value="ADMIN">Admin</option></Select>}</Field>
          <Button variant="primary" type="submit" disabled={add.isPending}>Add</Button>
        </div>
        {add.error && <ErrorBox error={add.error} />}
      </form>
    </div>
  );
}

// ───────── Organisation & matching rules ─────────

interface OrgData { name: string; baseCurrency: string; reconciliationConfig: Config }
interface Config { amountTolerance: number; dateWindowDays: number; suggestMinScore: number; autoConfirmExact: boolean; missingPaymentGraceDays: number; delayedEventHours: number; weights: Record<string, number> }

export function OrganisationSettings() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['org'], queryFn: () => api.get<OrgData>('/organisations/current') });
  const [f, setF] = useState<OrgData | null>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  const save = useMutation({ mutationFn: (v: OrgData) => api.patch('/organisations/current', { name: v.name, baseCurrency: v.baseCurrency, reconciliationConfig: v.reconciliationConfig }), onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }) });
  if (error) return <div className="card-pad"><ErrorBox error={error} /></div>;
  if (isLoading || !f) return <Loading />;
  const cfg = f.reconciliationConfig;
  const num = (k: keyof Config) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, reconciliationConfig: { ...cfg, [k]: Number(e.target.value) } });
  const weight = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, reconciliationConfig: { ...cfg, weights: { ...cfg.weights, [k]: Number(e.target.value) } } });
  return (
    <form className="stack" style={{ padding: 20 }} onSubmit={(e) => { e.preventDefault(); save.mutate(f); }} aria-label="Organisation settings">
      <div className="row">
        <Field label="Organisation name" wide>{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Base currency">{(id) => <Input id={id} required maxLength={3} pattern="[A-Z]{3}" value={f.baseCurrency} onChange={(e) => setF({ ...f, baseCurrency: e.target.value.toUpperCase() })} />}</Field>
      </div>
      <h3>Matching rules</h3>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Field label="Amount tolerance" hint="Absolute amount still counted as exact">{(id) => <Input id={id} type="number" min={0} step="0.01" value={cfg.amountTolerance} onChange={num('amountTolerance')} />}</Field>
        <Field label="Date window (days)" hint="Around the invoice due date">{(id) => <Input id={id} type="number" min={0} value={cfg.dateWindowDays} onChange={num('dateWindowDays')} />}</Field>
        <Field label="Suggestion threshold" hint="Minimum score (1–100) to suggest">{(id) => <Input id={id} type="number" min={1} max={100} value={cfg.suggestMinScore} onChange={num('suggestMinScore')} />}</Field>
        <Field label="Missing-payment grace (days)">{(id) => <Input id={id} type="number" min={0} value={cfg.missingPaymentGraceDays} onChange={num('missingPaymentGraceDays')} />}</Field>
        <Field label="Delayed after (hours)" hint="Pending longer than this raises an exception">{(id) => <Input id={id} type="number" min={1} value={cfg.delayedEventHours} onChange={num('delayedEventHours')} />}</Field>
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {(['reference', 'amount', 'currency', 'date', 'customer'] as const).map((k) => (
          <Field key={k} label={`Weight: ${k}`}>{(id) => <Input id={id} type="number" min={0} max={1000} value={cfg.weights[k]} onChange={weight(k)} />}</Field>
        ))}
      </div>
      <label className="row"><input type="checkbox" checked={cfg.autoConfirmExact} onChange={(e) => setF({ ...f, reconciliationConfig: { ...cfg, autoConfirmExact: e.target.checked } })} /> Confirm exact matches automatically <span className="hint">(uncertain matches always wait for review)</span></label>
      {save.error && <ErrorBox error={save.error} />}
      {save.isSuccess && <div className="banner ok" role="status">Settings saved. They apply from the next reconciliation run.</div>}
      <div><Button variant="primary" type="submit" disabled={save.isPending}>Save settings</Button></div>
    </form>
  );
}

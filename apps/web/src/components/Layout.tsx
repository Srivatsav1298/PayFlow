import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import type { Notification, Paginated } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { atLeast, dateTime } from '../lib/format';
import { Button, Select } from './ui';

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICONS = {
  overview: 'M3 12l9-9 9 9M5 10v10h14V10',
  tx: 'M4 7h16M4 12h16M4 17h10',
  inv: 'M7 3h8l4 4v14H7zM15 3v4h4M10 13h6M10 17h6',
  rec: 'M4 12a8 8 0 0114-5l2-2v6h-6l2.2-2.2A5 5 0 007 12M20 12a8 8 0 01-14 5l-2 2v-6h6l-2.2 2.2A5 5 0 0017 12',
  exc: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  rep: 'M5 21V9M12 21V3M19 21v-8',
  set: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1a7 7 0 00-2-1l-.5-2h-4L10 7a7 7 0 00-2 1L6 7 4 11l2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1l.5 2h4l.5-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z',
};

function NavItem({ to, icon, children, end }: { to: string; icon: keyof typeof ICONS; children: ReactNode; end?: boolean }) {
  return <NavLink to={to} end={end}><Icon d={ICONS[icon]} />{children}</NavLink>;
}

function Bell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<Paginated<Notification> & { unread: number }>('/notifications', { pageSize: 8 }), refetchInterval: 30_000 });
  const read = useMutation({ mutationFn: (id: string) => api.patch(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);
  return (
    <div className="bell" ref={ref}>
      <Button variant="ghost" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 004 0" /></svg>
        {!!data?.unread && <span className="bell-count" aria-hidden="true">{data.unread > 99 ? '99+' : data.unread}</span>}
      </Button>
      {open && (
        <div className="card popover" role="region" aria-label="Notifications">
          {!data?.data.length && <div className="empty">You're all caught up</div>}
          {data?.data.map((n) => (
            <div key={n.id} className={`item ${n.readAt ? '' : 'unread'}`}>
              <div className="row spread"><strong>{n.title}</strong>{!n.readAt && <Button small variant="ghost" onClick={() => read.mutate(n.id)}>Mark read</Button>}</div>
              <div>{n.body}</div><div className="hint">{dateTime(n.createdAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, org, role, logout, switchOrg } = useAuth();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Primary">
        <div className="brand"><span className="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 16l5-6 4 3 7-8" /></svg></span>PayFlow</div>
        <nav className="nav">
          <NavItem to="/" icon="overview" end>Overview</NavItem>
          <div className="nav-label">Money</div>
          <NavItem to="/transactions" icon="tx">Transactions</NavItem>
          <NavItem to="/invoices" icon="inv">Invoices</NavItem>
          <div className="nav-label">Control</div>
          <NavItem to="/reconciliation" icon="rec">Reconciliation</NavItem>
          <NavItem to="/exceptions" icon="exc">Exceptions</NavItem>
          {atLeast(role, 'MANAGER') && <NavItem to="/reports" icon="rep">Reports</NavItem>}
          {atLeast(role, 'MANAGER') && <NavItem to="/settings" icon="set">{atLeast(role, 'ADMIN') ? 'Settings' : 'Activity'}</NavItem>}
        </nav>
        <div className="sidebar-foot">
          <div><strong>{user?.name}</strong></div>
          <div className="muted">{role?.toLowerCase()} · {org?.organisationName}</div>
          <Button small className="ghost" onClick={logout} style={{ marginTop: 8 }}>Sign out</Button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Button className="menu-btn" variant="ghost" aria-label="Open menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>☰</Button>
          {user && user.memberships.length > 1 && (
            <Select aria-label="Organisation" value={org?.organisationId} onChange={(e) => switchOrg(e.target.value)} style={{ width: 200 }}>
              {user.memberships.map((m) => <option key={m.organisationId} value={m.organisationId}>{m.organisationName}</option>)}
            </Select>
          )}
          <Bell />
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

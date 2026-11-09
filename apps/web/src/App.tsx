import { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Role } from './api/types';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { atLeast } from './lib/format';
import { Exceptions } from './pages/Exceptions';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { Invoices } from './pages/Invoices';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Reconciliation } from './pages/Reconciliation';
import { Reports } from './pages/Reports';
import { Settings } from './pages/Settings';
import { TransactionDetail } from './pages/TransactionDetail';
import { Transactions } from './pages/Transactions';

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}

/** Route-level role gate. This is a UX convenience; the API independently enforces the same rules. */
function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const { role } = useAuth();
  if (!atLeast(role, min)) return <div className="banner bad" role="alert">Your role does not have access to this page.</div>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route index element={<Overview />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="transactions/:id" element={<TransactionDetail />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="reconciliation" element={<Reconciliation />} />
        <Route path="exceptions" element={<Exceptions />} />
        <Route path="reports" element={<RequireRole min="MANAGER"><Reports /></RequireRole>} />
        <Route path="settings" element={<RequireRole min="MANAGER"><Settings /></RequireRole>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

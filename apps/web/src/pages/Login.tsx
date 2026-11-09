import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Field, Input } from '../components/ui';

export function Login() {
  const { user, login } = useAuth();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={(loc.state as { from?: string } | null)?.from ?? '/'} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await login(email, password); } catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed'); } finally { setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <Card className="login-card">
        <form className="card-pad stack" onSubmit={submit} aria-labelledby="login-title">
          <div><h1 id="login-title">Sign in to PayFlow</h1><p className="muted" style={{ margin: '4px 0 0' }}>Payment reconciliation &amp; monitoring</p></div>
          {error && <div className="banner bad" role="alert">{error}</div>}
          <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          <p className="hint">Sandbox environment — demo data only, no real money moves.</p>
        </form>
      </Card>
    </div>
  );
}

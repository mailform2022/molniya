import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useStore, type Access, type User } from '../lib/store';

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setAuth = useStore((s) => s.setAuth);
  const nav = useNavigate();
  const loc = useLocation();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ token: string; user: User; access: Access }>(`/auth/${mode}`, { method: 'POST', json: { email, password } });
      await setAuth(r.token, { user: r.user, access: r.access });
      nav((loc.state as { from?: string } | null)?.from ?? '/account');
    } catch (e) {
      const m = e instanceof ApiError ? String(e.body.error) : (e as Error).message;
      setErr({ invalid_credentials: 'Неверный email или пароль', email_taken: 'Email уже зарегистрирован', fingerprint_taken: 'С этого устройства уже есть аккаунт', blocked: 'Аккаунт заблокирован' }[m] ?? m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '30px auto' }}>
      <Card title={mode === 'login' ? 'Вход' : 'Регистрация'}>
        <form onSubmit={submit}>
          <label>Email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <label>Пароль</label>
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          {err && <p className="err">{err}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button disabled={busy}>{mode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
            <button type="button" className="secondary" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Нет аккаунта?' : 'Уже есть аккаунт'}
            </button>
          </div>
        </form>
        {mode === 'register' && <p className="muted" style={{ marginTop: 10 }}>Один аккаунт на устройство. После регистрации — пробный доступ к тарифу Base.</p>}
      </Card>
    </div>
  );
}

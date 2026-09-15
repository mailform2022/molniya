import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AccessBar, InstallPwaButton, Toast } from './components/ui';
import { useStore } from './lib/store';
import { AdminLayout } from './admin/AdminLayout';
import { AccountPage } from './pages/Account';
import { AuthPage } from './pages/Auth';
import { AutoFlashPage } from './pages/AutoFlash';
import { BoardPage } from './pages/Board';
import { ConnectPage } from './pages/Connect';
import { DiffPage } from './pages/Diff';
import { EmulatorsPage } from './pages/Emulators';
import { HomePage } from './pages/Home';
import { NewsPage } from './pages/News';
import { SubmitPage } from './pages/Submit';
import { TransmitterPage } from './pages/Transmitter';
import { VtxWizardPage } from './pages/VtxWizard';
import { WizardPage } from './pages/Wizard';

const NAV = [
  ['/wizard', 'Мастер'],
  ['/board', 'Борт'],
  ['/vtx', 'VTX'],
  ['/transmitter', 'Пульт'],
  ['/emulators', 'Эмуляторы'],
  ['/news', 'Новости'],
  ['/account', 'Кабинет']
] as const;

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useStore();
  const loc = useLocation();
  if (loading) return <p className="muted">Загрузка…</p>;
  return user ? children : <Navigate to="/auth" state={{ from: loc.pathname }} replace />;
}

export function App() {
  const { init, user, config, presence, sessionRole } = useStore();
  useEffect(() => {
    void init();
  }, [init]);
  useEffect(() => {
    document.body.classList.toggle('bg-anim', config?.flags['ui.animated_background'] !== false);
    if (config?.flags['ui.block_devtools'] === true) {
      const h = (e: KeyboardEvent) => {
        if (e.key === 'F12' || (e.ctrlKey && (e.key === 'u' || e.key === 'U' || (e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase()))))) e.preventDefault();
      };
      const c = (e: MouseEvent) => e.preventDefault();
      window.addEventListener('keydown', h);
      window.addEventListener('contextmenu', c);
      return () => {
        window.removeEventListener('keydown', h);
        window.removeEventListener('contextmenu', c);
      };
    }
  }, [config]);

  return (
    <div className="app">
      <header className="top">
        <NavLink to="/" className="brand">
          <img src="/favicon.svg" width={24} height={24} alt="" /> VTX Services
        </NavLink>
        {user && <AccessBar />}
        {user && presence.length > 1 && (
          <span className="badge" title={presence.map((p) => `${p.role} · ${p.device ?? ''}`).join('\n')}>
            {presence.length} сессии · вы {sessionRole}
          </span>
        )}
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
          {user?.role === 'admin' && <NavLink to="/admin">Админ</NavLink>}
          {!user && <NavLink to="/auth">Войти</NavLink>}
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/board/*" element={<Protected><BoardPage /></Protected>} />
          <Route path="/wizard" element={<Protected><WizardPage /></Protected>} />
          <Route path="/vtx" element={<Protected><VtxWizardPage /></Protected>} />
          <Route path="/transmitter" element={<Protected><TransmitterPage /></Protected>} />
          <Route path="/autoflash" element={<Protected><AutoFlashPage /></Protected>} />
          <Route path="/diff" element={<Protected><DiffPage /></Protected>} />
          <Route path="/diff/shared/:token" element={<DiffPage />} />
          <Route path="/emulators" element={<EmulatorsPage />} />
          <Route path="/submit" element={<Protected><SubmitPage /></Protected>} />
          <Route path="/news/*" element={<NewsPage />} />
          <Route path="/account/*" element={<Protected><AccountPage /></Protected>} />
          <Route path="/admin/*" element={<Protected><AdminLayout /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        {NAV.slice(0, 4).map(([to, label]) => (
          <NavLink key={to} to={to}>
            {label}
          </NavLink>
        ))}
        <NavLink to="/account">Кабинет</NavLink>
      </nav>
      <div style={{ position: 'fixed', right: 12, bottom: 70 }}>
        <InstallPwaButton />
      </div>
      <Toast />
    </div>
  );
}

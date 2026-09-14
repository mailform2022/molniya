import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../lib/store';

export function Card({ title, children, right }: { title?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card">
      {(title || right) && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          {title && <h3 style={{ margin: 0 }}>{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tip({ children }: { children: ReactNode }) {
  const flags = useStore((s) => s.config?.flags);
  if (flags && flags['ui.tooltips'] === false) return null;
  return <div className="tip">{children}</div>;
}

export function Steps({ n, current }: { n: number; current: number }) {
  return (
    <div className="steps">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i <= current ? 'done' : ''} />
      ))}
    </div>
  );
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  return toast ? <div className="toast">{toast}</div> : null;
}

export function AccessBar() {
  const access = useStore((s) => s.access);
  if (!access) return null;
  if (access.type === 'none') return <span className="badge err">Нет подписки</span>;
  const exp = access.expires_at ? new Date(access.expires_at) : null;
  const daysLeft = exp ? Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 86400_000)) : 0;
  const cls = daysLeft <= 3 ? 'err' : daysLeft <= 7 ? 'warn' : 'ok';
  return (
    <span className={`badge ${cls}`} title={exp?.toLocaleString()}>
      {access.plan ?? '—'} · {daysLeft} дн. · пульты {access.devices_used}/{access.device_limit}
    </span>
  );
}

export function InstallPwaButton() {
  const [prompt, setPrompt] = useState<(Event & { prompt(): Promise<void> }) | null>(null);
  const flags = useStore((s) => s.config?.flags);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setPrompt(e as Event & { prompt(): Promise<void> });
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  if (!prompt || flags?.['feature.pwa_install_prompt'] === false) return null;
  return (
    <button className="secondary" onClick={() => void prompt.prompt().then(() => setPrompt(null))}>
      Установить приложение
    </button>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: Error) => alive && setState({ data: null, error: e.message, loading: false })
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

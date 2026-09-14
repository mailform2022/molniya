import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Card, Tip, useAsync } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useFc } from '../lib/fc';
import { useStore, type Access } from '../lib/store';

interface Device { id: string; kind: 'transmitter' | 'board'; uid: string; name: string | null; firmwareVersion: string | null; authExpiresAt: string | null; lastSyncAt: string | null; hasBackup: boolean }
interface Firmware { id: string; kind: string; target: string; version: string; fileName: string; sha256: string; sizeBytes: number; changelog: string | null }

export function AccountPage() {
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <NavLink to="/account" end className="badge">Подписка</NavLink>
        <NavLink to="/account/devices" className="badge">Устройства</NavLink>
        <NavLink to="/account/firmware" className="badge">Прошивки</NavLink>
        <NavLink to="/account/sessions" className="badge">Сессии</NavLink>
      </div>
      <Routes>
        <Route index element={<Subscription />} />
        <Route path="devices" element={<Devices />} />
        <Route path="firmware" element={<FirmwareList />} />
        <Route path="sessions" element={<Sessions />} />
      </Routes>
    </>
  );
}

function Subscription() {
  const { access, user, refreshAccess, notify, logout } = useStore();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const plans = useAsync(() => api<{ plans: Array<{ code: string; name: string; durationDays: number; deviceLimit: number; priceRub: number }>; addons: Array<{ code: string; name: string; priceRub: number }> }>('/plans'));
  async function redeem() {
    setErr(null);
    try {
      await api('/subscription/redeem', { method: 'POST', json: { code } });
      await refreshAccess();
      notify('Код активирован');
      setCode('');
    } catch (e) {
      setErr(e instanceof ApiError ? String(e.body.error) : (e as Error).message);
    }
  }
  async function addon(codeName: string) {
    try {
      const r = await api<{ payment: { redirectUrl?: string; message?: string } }>('/subscription/purchase-addon', { method: 'POST', json: { addonCode: codeName, provider: 'manual' } });
      if (r.payment.redirectUrl) location.href = r.payment.redirectUrl;
      await refreshAccess();
      notify(r.payment.message ?? 'Готово');
    } catch (e) {
      notify(e instanceof ApiError ? String(e.body.message ?? e.body.error) : (e as Error).message);
    }
  }
  return (
    <>
      <Card title="Подписка" right={<button className="secondary" onClick={() => void logout()}>Выйти</button>}>
        <p className="muted">{user?.email}</p>
        <AccessView access={access} />
        {access && access.type !== 'none' && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="secondary" onClick={() => void addon('extra_device')}>+1 пульт</button>
            <button className="secondary" onClick={() => void addon('extra_time')}>+30 дней</button>
          </div>
        )}
      </Card>
      <Card title="Активировать код">
        <Tip>Формат: <span className="kbd">MLN-ACT-BASE-30D-3XABCD-XXXXXX</span>. Код продления (EXT) добавляет дни к текущей подписке.</Tip>
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="MLN-…" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ flex: 1 }} />
          <button onClick={() => void redeem()} disabled={code.length < 20}>Активировать</button>
        </div>
        {err && <p className="err">{{ invalid_code: 'Неверный код', code_used: 'Код уже использован', code_expired: 'Код истёк', code_revoked_or_unknown: 'Код отозван' }[err] ?? err}</p>}
      </Card>
      <Card title="Тарифы">
        {plans.data?.plans.map((p) => (
          <div key={p.code} className="row" style={{ justifyContent: 'space-between', padding: '6px 0' }}>
            <b>{p.name}</b>
            <span className="muted">{p.durationDays} дн. · {p.deviceLimit} пульта · безлимит бортов и конфигуратора</span>
            <span>{p.priceRub ? `${p.priceRub} ₽` : 'по коду'}</span>
          </div>
        ))}
        <p className="muted">Оплата и коды: Telegram {useStore.getState().config?.telegram}</p>
      </Card>
    </>
  );
}

export function AccessView({ access }: { access: Access | null }) {
  if (!access) return null;
  if (access.type === 'none') return <p className="err">Подписки нет — активируйте код или свяжитесь с нами.</p>;
  const exp = access.expires_at ? new Date(access.expires_at) : null;
  const left = exp ? Math.max(0, (exp.getTime() - Date.now()) / 86400_000) : 0;
  const pct = Math.min(100, (left / 30) * 100);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>Тариф <b>{access.plan}</b> {access.type === 'trial' && <span className="badge warn">пробный</span>}</span>
        <span>до {exp?.toLocaleDateString()} ({Math.ceil(left)} дн.)</span>
      </div>
      <div className={`progress ${left <= 3 ? 'err' : left <= 7 ? 'warn' : ''}`} style={{ marginTop: 6 }}><div style={{ width: `${pct}%` }} /></div>
      <p className="muted" style={{ marginTop: 6 }}>Пульты: {access.devices_used} из {access.device_limit} · борты: безлимит</p>
    </>
  );
}

function Devices() {
  const list = useAsync(() => api<{ devices: Device[]; access: Access }>('/devices'));
  const { notify, refreshAccess } = useStore();
  const fc = useFc();
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [tokenOut, setTokenOut] = useState<string | null>(null);

  async function add(kind: 'transmitter' | 'board') {
    try {
      await api('/devices', { method: 'POST', json: { kind, uid, name } });
      await refreshAccess();
      list.reload();
      setUid('');
      notify('Устройство добавлено');
    } catch (e) {
      const b = e instanceof ApiError ? e.body : {};
      notify(String(b.error) === 'device_limit_reached' ? 'Лимит пультов исчерпан — купите +1 пульт' : String(b.error ?? (e as Error).message));
    }
  }
  async function issueToken(d: Device) {
    const r = await api<{ token: string; expiresAt: number }>(`/devices/${d.uid}/auth-token`, { method: 'POST' });
    setTokenOut(r.token);
    if (fc.client && fc.info?.uid === d.uid) {
      const bytes = Uint8Array.from(r.token.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
      await fc.client.setAuthToken(bytes);
      notify('Токен записан в устройство по MSP');
    } else notify('Токен выдан. Подключите устройство и запишите его во вкладке «Борт».');
    list.reload();
  }
  return (
    <>
      <Card title="Добавить устройство">
        <Tip>UID пульта отображается в его меню «Info» (прошивка VtxAuto v3.1) либо читается автоматически при подключении по USB (MSP2 0x2F20).</Tip>
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="UID (hex)" value={uid} onChange={(e) => setUid(e.target.value.trim())} style={{ flex: 2 }} />
          <input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          {fc.info && <button className="secondary" onClick={() => setUid(fc.info!.uid)}>UID с борта</button>}
          <button onClick={() => void add('transmitter')} disabled={uid.length < 8}>Пульт</button>
          <button className="secondary" onClick={() => void add('board')} disabled={uid.length < 8}>Борт</button>
        </div>
      </Card>
      <Card title="Мои устройства">
        <table>
          <thead><tr><th>Тип</th><th>Название</th><th>UID</th><th>Авторизация до</th><th /></tr></thead>
          <tbody>
            {list.data?.devices.map((d) => (
              <tr key={d.id}>
                <td>{d.kind === 'transmitter' ? 'Пульт' : 'Борт'}</td>
                <td>{d.name ?? '—'} <span className="muted">{d.firmwareVersion}</span></td>
                <td className="kbd">{d.uid}</td>
                <td>{d.authExpiresAt ? new Date(d.authExpiresAt).toLocaleDateString() : <span className="muted">—</span>}</td>
                <td className="row">
                  {d.kind === 'transmitter' && <button className="secondary" onClick={() => void issueToken(d)}>Авторизовать</button>}
                  <button className="danger" onClick={() => api(`/devices/${d.id}`, { method: 'DELETE' }).then(() => { list.reload(); void refreshAccess(); })}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tokenOut && <p className="muted" style={{ marginTop: 8 }}>Токен: <span className="kbd">{tokenOut}</span></p>}
      </Card>
    </>
  );
}

function FirmwareList() {
  const fw = useAsync(() => api<{ firmware: Firmware[] }>('/firmware'));
  const groups = { transmitter: 'Пульты (VtxAuto v3.1)', fc: 'Полётные контроллеры (INAV 7)', configurator: 'Конфигуратор' } as const;
  return (
    <>
      {Object.entries(groups).map(([kind, title]) => (
        <Card key={kind} title={title}>
          <table>
            <tbody>
              {fw.data?.firmware.filter((f) => f.kind === kind).map((f) => (
                <tr key={f.id}>
                  <td><b>{f.target}</b> {f.version}</td>
                  <td className="muted">{f.changelog}</td>
                  <td>{(f.sizeBytes / 1024).toFixed(0)} КБ</td>
                  <td><a href={`${import.meta.env.VITE_API_URL ?? ''}/api/firmware/${f.id}/download`} onClick={(e) => { e.preventDefault(); void download(f); }}>{f.fileName}</a></td>
                </tr>
              ))}
              {fw.data && !fw.data.firmware.some((f) => f.kind === kind) && <tr><td className="muted">пока нет опубликованных файлов</td></tr>}
            </tbody>
          </table>
        </Card>
      ))}
      <Tip>Пульт: скопируйте .bin в папку FIRMWARE на SD-карте и прошейте через Bootloader. FC: используйте AutoFlash или INAV Configurator (DFU).</Tip>
    </>
  );
}

async function download(f: Firmware) {
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/firmware/${f.id}/download`, { headers: { Authorization: `Bearer ${localStorage.getItem('vtx.token')}` } });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = f.fileName;
  a.click();
}

function Sessions() {
  const { presence, sessionRole } = useStore();
  const sid = sessionStorage.getItem('vtx.sid');
  return (
    <Card title="Активные сессии">
      <Tip>Оператор — полный доступ; техник — только прошивка/сохранение; наблюдатель — просмотр. Роль меняется оператором.</Tip>
      <table style={{ marginTop: 10 }}>
        <tbody>
          {presence.map((p) => (
            <tr key={p.sid}>
              <td>{p.sid === sid ? <b>эта сессия</b> : p.device}</td>
              <td>
                {p.sid === sid ? p.role : (
                  <select value={p.role} disabled={sessionRole !== 'operator'} onChange={(e) => void api(`/auth/sessions/${p.sid}/role`, { method: 'PATCH', json: { role: e.target.value } })}>
                    <option value="operator">operator</option><option value="technician">technician</option><option value="viewer">viewer</option>
                  </select>
                )}
              </td>
              <td className="muted">{new Date(p.lastSeenAt).toLocaleTimeString()}</td>
              <td>{p.sid !== sid && sessionRole === 'operator' && <button className="danger" onClick={() => void api(`/auth/sessions/${p.sid}`, { method: 'DELETE' })}>Завершить</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

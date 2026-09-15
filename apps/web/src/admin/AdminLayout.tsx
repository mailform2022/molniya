import { useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Card, Tip, useAsync } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { AdminSection, type Col } from './Section';

const SECTIONS: Array<[string, string]> = [
  ['stats', 'Статистика'], ['users', 'Пользователи'], ['plans', 'Тарифы'], ['codes', 'Коды'], ['firmware', 'Прошивки'], ['models', 'Модели'],
  ['board-layouts', 'Раскладки'], ['vtx-models', 'VTX'], ['vtx-photos', 'Фото VTX'], ['vtx-submissions', 'Заявки VTX'], ['board-submissions', 'Заявки бортов'],
  ['diff', 'Diff'], ['reports', 'Репорты'], ['vtx-sync-logs', 'Sync-логи'], ['news', 'Новости'], ['feedback', 'Обратная связь'], ['flags', 'Флаги/CMS']
];

export function AdminLayout() {
  const { user } = useStore();
  const [adminOk, setAdminOk] = useState<boolean>(() => {
    try { return Boolean(JSON.parse(atob(localStorage.getItem('vtx.token')!.split('.')[1]!)).adminOk); } catch { return false; }
  });
  if (user?.role !== 'admin') return <p className="err">Доступ запрещён.</p>;
  if (!adminOk) return <AdminLogin onOk={() => setAdminOk(true)} />;
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        {SECTIONS.map(([path, title]) => <NavLink key={path} to={`/admin/${path}`} className="badge">{title}</NavLink>)}
      </div>
      <Routes>
        <Route index element={<Stats />} />
        <Route path="stats" element={<Stats />} />
        <Route path="users" element={<Users />} />
        <Route path="plans" element={<Plans />} />
        <Route path="codes" element={<Codes />} />
        <Route path="firmware" element={<Firmware />} />
        <Route path="models" element={<Models />} />
        <Route path="board-layouts" element={<AdminSection title="Раскладки пинов" list="/admin/models" pick="layouts" create="/admin/board-layouts" update={(id) => `/admin/board-layouts/${id}`} cols={[['fcTarget', 'Target'], ['totalPins', 'Пинов', 'number'], ['status', 'Статус', ['draft', 'published']], ['pins', 'Пины (JSON)', 'json']]} />} />
        <Route path="vtx-models" element={<AdminSection title="Модели VTX" list="/admin/vtx-models" pick="models" create="/admin/vtx-models" update={(id) => `/admin/vtx-models/${id}`} cols={[['name', 'Название'], ['manufacturer', 'Производитель'], ['protocol', 'Протокол'], ['bands', 'Bands', 'number'], ['channels', 'Channels', 'number'], ['freqTable', 'Сетка (JSON)', 'json'], ['isDisabled', 'Отключён', 'bool'], ['flagged', 'Флаг', 'bool']]} />} />
        <Route path="vtx-photos" element={<AdminSection title="Фото подключения VTX" list="/vtx-models" pick="photos" create="/admin/vtx-photos" cols={[['vtxModelId', 'VTX id'], ['fcTarget', 'Target'], ['imagePath', 'URL картинки'], ['annotations', 'Аннотации (JSON)', 'json']]} />} />
        <Route path="vtx-submissions" element={<Moderation kind="vtx" />} />
        <Route path="board-submissions" element={<Moderation kind="board" />} />
        <Route path="diff" element={<DiffAdmin />} />
        <Route path="reports" element={<Reports />} />
        <Route path="vtx-sync-logs" element={<AdminSection title="VTX sync-логи" list="/admin/vtx-sync-logs" pick="entries" cols={[['createdAt', 'Время'], ['userId', 'User'], ['deviceId', 'Device'], ['direction', 'Направление'], ['ok', 'OK', 'bool'], ['payload', 'Payload', 'json']]} />} />
        <Route path="news" element={<AdminSection title="Новости" list="/admin/news" pick="posts" create="/admin/news" update={(id) => `/admin/news/${id}`} remove={(id) => `/admin/news/${id}`} cols={[['slug', 'Slug'], ['title', 'Заголовок'], ['body', 'Текст', 'text'], ['tags', 'Теги (JSON)', 'json'], ['publishedAt', 'Опубликовано (ISO)']]} />} />
        <Route path="feedback" element={<AdminSection title="Обратная связь" list="/admin/feedback" pick="messages" update={(id) => `/admin/feedback/${id}`} method="PATCH" cols={[['createdAt', 'Время'], ['email', 'Email'], ['subject', 'Тема'], ['message', 'Сообщение', 'text'], ['status', 'Статус', ['new', 'in_progress', 'answered', 'closed']], ['adminReply', 'Ответ', 'text']]} />} />
        <Route path="flags" element={<Flags />} />
      </Routes>
    </>
  );
}

function AdminLogin({ onOk }: { onOk: () => void }) {
  const { user, setAuth, notify } = useStore();
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [backup, setBackup] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loginPath = import.meta.env.VITE_ADMIN_LOGIN_PATH ?? '/admin-login';
  async function login(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api<{ token: string; needsTotpSetup: boolean }>(loginPath, { method: 'POST', json: { email: user!.email, password, totp: totp || undefined } });
      await setAuth(r.token);
      if (r.needsTotpSetup) setSetup(await api<{ secret: string; otpauth: string }>('/admin/2fa/setup', { method: 'POST' }));
      else onOk();
    } catch (e) {
      setErr(e instanceof ApiError ? String(e.body.error) : (e as Error).message);
    }
  }
  async function confirm() {
    const r = await api<{ backupCodes: string[]; token: string }>('/admin/2fa/confirm', { method: 'POST', json: { totp } });
    await setAuth(r.token);
    setBackup(r.backupCodes);
    notify('2FA включена');
  }
  if (backup) return <Card title="Резервные коды"><Tip>Сохраните — показываются один раз. Каждый код одноразовый, вводится вместо TOTP.</Tip><pre className="log">{backup.join('\n')}</pre><button onClick={onOk}>Продолжить</button></Card>;
  if (setup) return (
    <Card title="Настройка 2FA">
      <p>Добавьте секрет в Google Authenticator / Aegis:</p>
      <p className="kbd">{setup.secret}</p>
      <p className="muted" style={{ wordBreak: 'break-all' }}>{setup.otpauth}</p>
      <label>Код из приложения</label><input value={totp} onChange={(e) => setTotp(e.target.value)} maxLength={6} />
      <button style={{ marginTop: 10 }} onClick={() => void confirm()}>Подтвердить</button>
    </Card>
  );
  return (
    <div style={{ maxWidth: 420, margin: '30px auto' }}>
      <Card title="Вход в админку">
        <form onSubmit={login}>
          <label>Пароль</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label>TOTP / резервный код</label><input value={totp} onChange={(e) => setTotp(e.target.value)} />
          {err && <p className="err">{err}</p>}
          <button style={{ marginTop: 10 }}>Войти</button>
        </form>
      </Card>
    </div>
  );
}

function Stats() {
  const s = useAsync(() => api<{ users: number; mau: number; activeSubscriptions: number; flashesPerDay: Array<{ day: string; n: number }>; pendingVtxSubmissions: number; openReports: number }>('/admin/stats'));
  if (!s.data) return <p className="muted">{s.error ?? '…'}</p>;
  const max = Math.max(1, ...s.data.flashesPerDay.map((d) => d.n));
  return (
    <>
      <div className="grid">
        {[['Пользователи', s.data.users], ['MAU', s.data.mau], ['Активные подписки', s.data.activeSubscriptions], ['Заявки VTX', s.data.pendingVtxSubmissions], ['Открытые репорты', s.data.openReports]].map(([k, v]) => <Card key={String(k)}><div className="muted">{k}</div><div style={{ fontSize: 32, fontWeight: 700 }}>{v}</div></Card>)}
      </div>
      <Card title="Прошивок в день (30 дн.)">
        <div className="row" style={{ alignItems: 'flex-end', height: 120, gap: 3 }}>
          {s.data.flashesPerDay.map((d) => <div key={d.day} title={`${d.day}: ${d.n}`} style={{ flex: 1, background: 'var(--accent)', height: `${(d.n / max) * 100}%`, borderRadius: 3 }} />)}
          {!s.data.flashesPerDay.length && <span className="muted">нет данных</span>}
        </div>
      </Card>
    </>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const list = useAsync(() => api<{ users: Array<{ id: string; email: string; role: string; fingerprint: string | null; isBlocked: boolean; createdAt: string }> }>(`/admin/users?q=${encodeURIComponent(q)}`), [q]);
  const { notify } = useStore();
  async function grant(id: string) {
    const days = Number(prompt('Дней подписки BASE', '30'));
    if (!days) return;
    await api(`/admin/users/${id}/subscription`, { method: 'POST', json: { planCode: 'BASE', days, deviceLimit: 1 } });
    notify('Подписка выдана');
  }
  return (
    <Card title="Пользователи" right={<input placeholder="email / fingerprint" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />}>
      <table>
        <thead><tr><th>Email</th><th>Роль</th><th>Fingerprint</th><th>Создан</th><th /></tr></thead>
        <tbody>{list.data?.users.map((u) => (
          <tr key={u.id}>
            <td>{u.email} {u.isBlocked && <span className="badge err">блок</span>}</td><td>{u.role}</td><td className="kbd">{u.fingerprint?.slice(0, 12)}</td><td className="muted">{new Date(u.createdAt).toLocaleDateString()}</td>
            <td className="row">
              <button className="secondary" onClick={() => void grant(u.id)}>+подписка</button>
              <button className={u.isBlocked ? 'secondary' : 'danger'} onClick={() => void api(`/admin/users/${u.id}`, { method: 'PATCH', json: { isBlocked: !u.isBlocked } }).then(list.reload)}>{u.isBlocked ? 'разблок' : 'блок'}</button>
            </td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}

function Plans() {
  const cols: Col[] = [['code', 'Код'], ['name', 'Название'], ['durationDays', 'Дней', 'number'], ['deviceLimit', 'Пультов', 'number'], ['priceRub', 'Цена ₽', 'number'], ['features', 'Фичи (JSON)', 'json'], ['isActive', 'Активен', 'bool'], ['applyToExisting', 'Применить к текущим подпискам', 'bool']];
  return (
    <>
      <AdminSection title="Тарифы" list="/admin/plans" pick="plans" create="/admin/plans" update={(id) => `/admin/plans/${id}`} cols={cols} />
      <AdminSection title="Add-ons" list="/admin/plans" pick="addons" create="/admin/addons" update={(id) => `/admin/addons/${id}`} cols={[['code', 'Код'], ['name', 'Название'], ['kind', 'Тип', ['extra_device', 'extra_time']], ['amount', 'Кол-во', 'number'], ['priceRub', 'Цена ₽', 'number'], ['isActive', 'Активен', 'bool']]} />
    </>
  );
}

function Codes() {
  const list = useAsync(() => api<{ codes: Array<{ id: string; code: string; type: string; planCode: string; durationDays: number; deviceLimit: number; redemptions: number; maxRedemptions: number; isRevoked: boolean; note: string | null }>; stats: { total: number; redeemed: number } }>('/admin/codes'));
  const [form, setForm] = useState({ type: 'ACT', planCode: 'BASE', durationDays: 30, deviceLimit: 1, count: 1, note: '' });
  const [out, setOut] = useState<Array<{ code: string; encoderForm: string }>>([]);
  async function gen() {
    const r = await api<{ codes: Array<{ code: string; encoderForm: string }> }>('/admin/codes', { method: 'POST', json: { ...form, note: form.note || undefined } });
    setOut(r.codes);
    list.reload();
  }
  return (
    <>
      <Card title="Генератор кодов">
        <div className="row">
          <select style={{ width: 'auto' }} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{['ACT', 'EXT', 'TST', 'SES'].map((t) => <option key={t}>{t}</option>)}</select>
          <input style={{ width: 100 }} value={form.planCode} onChange={(e) => setForm({ ...form, planCode: e.target.value })} />
          <input style={{ width: 90 }} type="number" value={form.durationDays} onChange={(e) => setForm({ ...form, durationDays: +e.target.value })} title="дней" />
          <input style={{ width: 70 }} type="number" value={form.deviceLimit} onChange={(e) => setForm({ ...form, deviceLimit: +e.target.value })} title="пультов" />
          <input style={{ width: 70 }} type="number" value={form.count} onChange={(e) => setForm({ ...form, count: +e.target.value })} title="штук" />
          <input style={{ flex: 1 }} placeholder="заметка" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <button onClick={() => void gen()}>Сгенерировать</button>
        </div>
        {out.length > 0 && <pre className="log" style={{ marginTop: 10 }}>{out.map((c) => `${c.code}\t(энкодер: ${c.encoderForm})`).join('\n')}</pre>}
      </Card>
      <Card title={`Коды · всего ${list.data?.stats.total ?? 0}, активаций ${list.data?.stats.redeemed ?? 0}`}>
        <table><thead><tr><th>Код</th><th>Тип</th><th>Тариф</th><th>Дн/пульт</th><th>Исп.</th><th /></tr></thead>
          <tbody>{list.data?.codes.map((c) => <tr key={c.id} style={{ opacity: c.isRevoked ? 0.4 : 1 }}><td className="kbd">{c.code}</td><td>{c.type}</td><td>{c.planCode}</td><td>{c.durationDays}/{c.deviceLimit}</td><td>{c.redemptions}/{c.maxRedemptions}</td><td>{!c.isRevoked && <button className="danger" onClick={() => void api(`/admin/codes/${c.id}/revoke`, { method: 'POST' }).then(list.reload)}>отозвать</button>}</td></tr>)}</tbody></table>
      </Card>
    </>
  );
}

type FwRow = { id: string; kind: string; target: string; version: string; fileName: string; sha256: string; sizeBytes: number; isPublished: boolean; changelog: string | null; verification: string; section: string | null; flightEvidenceNote: string | null; provenance: Record<string, string> | null };

function Firmware() {
  const list = useAsync(() => api<{ firmware: FwRow[] }>('/admin/firmware'));
  const { notify } = useStore();
  const [meta, setMeta] = useState({ kind: 'transmitter', target: 'TX12MK2', version: '3.1.0', section: '', changelog: '', verification: 'experimental', provenance: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  function fail(e: unknown) { notify(e instanceof ApiError ? e.message : String(e)); }
  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      Object.entries(meta).forEach(([k, v]) => { if (v !== '') fd.append(k, String(v)); });
      fd.append('file', file);
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/admin/firmware`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${localStorage.getItem('vtx.token')}` } });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new ApiError(res.status, body);
      notify(`Загружено, sha256 ${String((body.firmware as FwRow).sha256).slice(0, 12)}…`);
      list.reload();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function patch(id: string, json: Record<string, unknown>) {
    try { await api(`/admin/firmware/${id}`, { method: 'PATCH', json }); list.reload(); } catch (e) { fail(e); }
  }
  async function remove(f: FwRow) {
    if (!window.confirm(`Удалить ${f.fileName} (${f.target} ${f.version})? Файл и запись будут удалены безвозвратно.`)) return;
    try { await api(`/admin/firmware/${f.id}`, { method: 'DELETE' }); list.reload(); notify('Прошивка удалена'); } catch (e) { fail(e); }
  }
  function setVerification(f: FwRow, verification: string) {
    if (verification === 'withdrawn') {
      const withdrawnReason = window.prompt('Причина отзыва прошивки (увидят пользователи):') ?? '';
      if (!withdrawnReason) return;
      return void patch(f.id, { verification, withdrawnReason });
    }
    if (verification === 'flight_tested') {
      const flightEvidenceNote = window.prompt('Доказательство полёта, если отзывов «отлетал нормально» в сервисе нет: кто, на каком борте/пульте, когда, сколько полётов (минимум 20 символов). Оставьте пустым, чтобы опереться только на отзывы в сервисе.') ?? '';
      return void patch(f.id, flightEvidenceNote ? { verification, flightEvidenceNote } : { verification });
    }
    void patch(f.id, { verification });
  }
  return (
    <>
      <Card title="Загрузить прошивку">
        <Tip>
          Имена пультов: <span className="kbd">TX12MK2_VtxAuto_v3.1.bin</span>, FC: <span className="kbd">inav_7.1.2_CADDXF405_WING.hex</span>. Загрузка всегда создаёт <b>неопубликованную</b> запись
          (experimental/diagnostic). Опубликовать можно только <b>flight_tested</b>: отзыв «отлетал нормально», подтверждённое исправление крэша или явная запись о полётах. Provenance — JSON вида{' '}
          <span className="kbd">{'{"repo":"…","commit":"…","toolchain":"…"}'}</span>: откуда собран бинарник.
        </Tip>
        <div className="row" style={{ marginTop: 10 }}>
          <select style={{ width: 'auto' }} value={meta.kind} onChange={(e) => setMeta({ ...meta, kind: e.target.value })}><option value="transmitter">Пульт</option><option value="fc">FC</option><option value="configurator">Конфигуратор</option></select>
          <input style={{ width: 160 }} placeholder="target" value={meta.target} onChange={(e) => setMeta({ ...meta, target: e.target.value })} />
          <input style={{ width: 100 }} placeholder="версия" value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} />
          <input style={{ width: 120 }} placeholder="раздел" value={meta.section} onChange={(e) => setMeta({ ...meta, section: e.target.value })} />
          <select style={{ width: 'auto' }} value={meta.verification} onChange={(e) => setMeta({ ...meta, verification: e.target.value })}><option value="experimental">experimental</option><option value="diagnostic">diagnostic</option></select>
          <input type="file" style={{ width: 'auto' }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input style={{ flex: 1 }} placeholder="changelog" value={meta.changelog} onChange={(e) => setMeta({ ...meta, changelog: e.target.value })} />
          <input style={{ flex: 1 }} placeholder='provenance JSON {"repo":"…","commit":"…"}' value={meta.provenance} onChange={(e) => setMeta({ ...meta, provenance: e.target.value })} />
          <button disabled={!file || busy} onClick={() => void upload()}>Загрузить</button>
        </div>
      </Card>
      <Card title="Прошивки">
        <table><thead><tr><th>Тип</th><th>Target</th><th>Версия</th><th>Раздел</th><th>Файл</th><th>SHA-256</th><th>Проверка</th><th>Публ.</th><th></th></tr></thead>
          <tbody>{list.data?.firmware.map((f) => (
            <tr key={f.id} style={{ opacity: f.verification === 'withdrawn' ? 0.5 : 1 }}>
              <td>{f.kind}</td><td>{f.target}</td><td>{f.version}</td>
              <td><input style={{ width: 90 }} defaultValue={f.section ?? ''} onBlur={(e) => { if (e.target.value !== (f.section ?? '')) void patch(f.id, { section: e.target.value || null }); }} /></td>
              <td title={f.provenance ? JSON.stringify(f.provenance, null, 1) : 'provenance не указан'}>{f.fileName} <span className="muted">{(f.sizeBytes / 1024).toFixed(0)} КБ{f.provenance ? '' : ' · без provenance'}</span></td>
              <td className="kbd" title={f.sha256}>{f.sha256.slice(0, 12)}…</td>
              <td title={f.flightEvidenceNote ?? ''}>
                <select style={{ width: 'auto' }} value={f.verification} onChange={(e) => setVerification(f, e.target.value)}>
                  {['experimental', 'diagnostic', 'flight_tested', 'withdrawn'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </td>
              <td><input type="checkbox" style={{ width: 'auto' }} checked={f.isPublished} disabled={!f.isPublished && f.verification !== 'flight_tested'} onChange={(e) => void patch(f.id, { isPublished: e.target.checked })} /></td>
              <td><button className="secondary" disabled={f.isPublished} title={f.isPublished ? 'Сначала снимите с публикации' : 'Удалить файл и запись'} onClick={() => void remove(f)}>Удалить</button></td>
            </tr>
          ))}</tbody></table>
      </Card>
    </>
  );
}

function Models() {
  return (
    <>
      <AdminSection title="Полётные контроллеры" list="/admin/models" pick="boards" create="/admin/models/boards" update={(id) => `/admin/models/boards/${id}`} cols={[['code', 'Код'], ['name', 'Название'], ['fcTarget', 'INAV target'], ['totalPins', 'Пинов', 'number'], ['description', 'Описание'], ['isActive', 'Активен', 'bool']]} />
      <AdminSection title="Пульты" list="/admin/models" pick="transmitters" create="/admin/models/transmitters" update={(id) => `/admin/models/transmitters/${id}`} cols={[['code', 'Код'], ['name', 'Название'], ['platform', 'Платформа'], ['firmwareTarget', 'FW target'], ['display', 'Дисплей'], ['channels', 'Каналов', 'number'], ['isActive', 'Активен', 'bool']]} />
    </>
  );
}

function Moderation({ kind }: { kind: 'vtx' | 'board' }) {
  const path = kind === 'vtx' ? '/admin/vtx-submissions' : '/admin/board-submissions';
  const list = useAsync(() => api<{ submissions: Array<Record<string, unknown> & { id: string; name: string; status: string; createdAt: string }> }>(path), [path]);
  const { notify } = useStore();
  async function decide(id: string, action: string) {
    const note = action === 'request_info' ? prompt('Что уточнить?') : undefined;
    const r = await api<{ generatedDiff?: string }>(`${path}/${id}/decision`, { method: 'POST', json: { action, note: note ?? undefined } });
    notify(r.generatedDiff ? 'Одобрено, diff vtxtable создан' : 'Готово');
    list.reload();
  }
  return (
    <Card title={kind === 'vtx' ? 'Заявки VTX' : 'Заявки бортов'}>
      {list.data?.submissions.map((s) => (
        <div key={s.id} className="card" style={{ background: 'var(--panel2)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>{s.name}</b><span className={`badge ${s.status === 'approved' ? 'ok' : s.status === 'rejected' ? 'err' : 'warn'}`}>{s.status}</span></div>
          <pre className="log" style={{ maxHeight: 140 }}>{JSON.stringify(kind === 'vtx' ? { manufacturer: s.manufacturer, protocol: s.protocol, freqTable: s.freqTable, parsed: s.parsedStatus } : { fcTarget: s.fcTarget, detected: s.detected, layoutId: s.layoutId }, null, 1)}</pre>
          {s.status === 'pending_review' && <div className="row"><button onClick={() => void decide(s.id, 'approve')}>Одобрить</button><button className="secondary" onClick={() => void decide(s.id, 'request_info')}>Уточнить</button><button className="danger" onClick={() => void decide(s.id, 'reject')}>Отклонить</button></div>}
        </div>
      ))}
      {list.data && !list.data.submissions.length && <p className="muted">Заявок нет.</p>}
    </Card>
  );
}

function Reports() {
  const list = useAsync(() => api<{ reports: Array<{ id: string; category: string; message: string; status: string; vtxModelId: string | null; adminReply: string | null; createdAt: string }> }>('/admin/reports'));
  async function act(id: string, action: string) {
    const reply = action === 'reply' ? prompt('Ответ пользователю') : undefined;
    await api(`/admin/reports/${id}/action`, { method: 'POST', json: { action, reply: reply ?? undefined } });
    list.reload();
  }
  return (
    <Card title="Репорты">
      <Tip>3+ репорта на один VTX за 7 дней автоматически ставят флаг ⚠ на модель.</Tip>
      <table style={{ marginTop: 10 }}><thead><tr><th>Дата</th><th>Категория</th><th>Сообщение</th><th>Статус</th><th /></tr></thead>
        <tbody>{list.data?.reports.map((r) => <tr key={r.id}><td className="muted">{new Date(r.createdAt).toLocaleDateString()}</td><td>{r.category}</td><td>{r.message}{r.adminReply && <div className="muted">↳ {r.adminReply}</div>}</td><td>{r.status}</td>
          <td className="row">{['fix', 'reply', 'disable_vtx', 'disable_range', 'close'].map((a) => <button key={a} className="secondary" onClick={() => void act(r.id, a)}>{a}</button>)}</td></tr>)}</tbody></table>
    </Card>
  );
}

function DiffAdmin() {
  const list = useAsync(() => api<{ templates: Array<{ id: string; name: string; boardModelId: string | null; currentVersionId: string | null; isDefault: boolean }>; versions: Array<{ id: string; templateId: string; version: string; changelog: string | null; createdAt: string }> }>('/admin/diff'));
  const models = useAsync(() => api<{ boards: Array<{ id: string; name: string }> }>('/admin/models'));
  const { notify } = useStore();
  const [form, setForm] = useState({ name: '', boardModelId: '', version: '1.0.0', content: '', changelog: '', isDefault: false });
  const [selT, setSelT] = useState<string | null>(null);
  async function create() {
    const r = await api<{ parsed: { unknown: string[]; conflicts: string[] } }>('/admin/diff', { method: 'POST', json: { ...form, boardModelId: form.boardModelId || null } });
    notify(r.parsed.unknown.length || r.parsed.conflicts.length ? `Создан с предупреждениями: ${r.parsed.unknown.length} неизв., ${r.parsed.conflicts.length} конфл.` : 'Создан');
    list.reload();
  }
  async function newVersion() {
    if (!selT) return;
    await api(`/admin/diff/${selT}/versions`, { method: 'POST', json: { version: form.version, content: form.content, changelog: form.changelog, publish: true } });
    notify('Версия опубликована, новость создана');
    list.reload();
  }
  return (
    <>
      <Card title="Эталонные diff">
        {list.data?.templates.map((t) => (
          <div key={t.id} style={{ padding: '6px 0', borderBottom: '1px solid #ffffff10' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><b>{t.name}</b> {t.isDefault && <span className="badge ok">default</span>}<button className="secondary" onClick={() => setSelT(t.id)}>+ версия</button></div>
            <div className="row">{list.data!.versions.filter((v) => v.templateId === t.id).map((v) => <span key={v.id} className={`badge ${v.id === t.currentVersionId ? 'ok' : ''}`} title={v.changelog ?? ''} onClick={() => void api(`/admin/diff/${t.id}/rollback/${v.id}`, { method: 'POST' }).then(list.reload)} style={{ cursor: 'pointer' }}>{v.version}</span>)}</div>
          </div>
        ))}
      </Card>
      <Card title={selT ? `Новая версия для ${list.data?.templates.find((t) => t.id === selT)?.name}` : 'Новый эталонный diff'} right={selT && <button className="secondary" onClick={() => setSelT(null)}>новый шаблон</button>}>
        {!selT && <><label>Название</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Модель FC</label><select value={form.boardModelId} onChange={(e) => setForm({ ...form, boardModelId: e.target.value })}><option value="">—</option>{models.data?.boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> сделать default для модели</label></>}
        <label>Версия (semver)</label><input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
        <label>Changelog</label><input value={form.changelog} onChange={(e) => setForm({ ...form, changelog: e.target.value })} />
        <label>Содержимое</label><textarea className="code" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} spellCheck={false} />
        <button style={{ marginTop: 10 }} disabled={!form.content || (!selT && !form.name)} onClick={() => void (selT ? newVersion() : create())}>{selT ? 'Опубликовать версию' : 'Создать'}</button>
      </Card>
    </>
  );
}

function Flags() {
  const flags = useAsync(() => api<{ flags: Array<{ key: string; value: unknown; description: string | null }> }>('/admin/flags'));
  const cfg = useAsync(() => api<{ content: Record<string, unknown> }>('/config'));
  const { notify } = useStore();
  const [cmsKey, setCmsKey] = useState('home.hero');
  const [cmsVal, setCmsVal] = useState('');
  async function setFlag(key: string, value: unknown) {
    await api(`/admin/flags/${key}`, { method: 'PUT', json: { value } });
    flags.reload();
  }
  async function saveCms() {
    try {
      await api(`/admin/cms/${cmsKey}`, { method: 'PUT', json: { content: JSON.parse(cmsVal) } });
      notify('CMS обновлён — клиенты получат событие');
      cfg.reload();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  return (
    <>
      <Card title="Feature flags">
        <Tip>Изменения применяются на клиентах мгновенно через WebSocket — без деплоя (quick-fix).</Tip>
        <table style={{ marginTop: 10 }}><tbody>{flags.data?.flags.map((f) => (
          <tr key={f.key}><td className="kbd">{f.key}</td><td className="muted">{f.description}</td>
            <td>{typeof f.value === 'boolean' ? <input type="checkbox" style={{ width: 'auto' }} checked={f.value} onChange={(e) => void setFlag(f.key, e.target.checked)} /> : <input defaultValue={JSON.stringify(f.value)} onBlur={(e) => void setFlag(f.key, JSON.parse(e.target.value))} />}</td></tr>))}</tbody></table>
      </Card>
      <Card title="CMS-контент">
        <div className="row"><select style={{ width: 'auto' }} value={cmsKey} onChange={(e) => { setCmsKey(e.target.value); setCmsVal(JSON.stringify(cfg.data?.content[e.target.value] ?? {}, null, 2)); }}>{Object.keys(cfg.data?.content ?? {}).map((k) => <option key={k}>{k}</option>)}<option value="__new">новый ключ…</option></select>
          {cmsKey === '__new' && <input placeholder="ключ" onBlur={(e) => setCmsKey(e.target.value)} />}</div>
        <textarea className="code" style={{ minHeight: 140, marginTop: 8 }} value={cmsVal || JSON.stringify(cfg.data?.content[cmsKey] ?? {}, null, 2)} onChange={(e) => setCmsVal(e.target.value)} />
        <button style={{ marginTop: 8 }} onClick={() => void saveCms()}>Сохранить</button>
      </Card>
    </>
  );
}

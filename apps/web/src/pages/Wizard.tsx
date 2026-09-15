import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseDiff, takeFcSnapshot, type FcSnapshot } from '@vtx/msp';
import { Card, Steps, Tip, useAsync } from '../components/ui';
import { ArmRelayEditor, OsdZonesEditor } from '../components/DiffBuilders';
import { api, apiDownload, apiUpload, ApiError } from '../lib/api';
import { connectivityHint, useFc, webSerialSupported } from '../lib/fc';
import { useStore } from '../lib/store';
import { TRUST_LABEL, canWrite, snapshotRequired, useWizard, type DiagBuild, type Trust } from '../lib/wizard';
import { VtxFlow } from './VtxWizard';
import { TransmitterPanel } from './Transmitter';

const STEPS = ['Борт', 'Снимок', 'Diff и опции', 'Прошивка', 'VTX и сетка', 'Пульт', 'Артефакты', 'После полёта'];

interface Firmware { id: string; kind: string; target: string; version: string; fileName: string; sha256: string; sizeBytes: number; changelog: string | null; verification: string; section: string | null }

/**
 * One safe path for a board that is not switching channels yet:
 * identify → read-only snapshot + server trust → user diff with hints → firmware (verified build or diagnostic logging script)
 * → VTX detect + frequency grid → transmitter pairs (TX12 MK2 by default) → two artifacts → post-flight crash report.
 * Every write is blocked until the snapshot of an unverified board is stored.
 */
export function WizardPage() {
  const w = useWizard();
  const fc = useFc();
  const gate = canWrite(w);
  return (
    <>
      <Steps n={STEPS.length} current={w.step} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {STEPS.map((s, i) => (
          <button key={s} className={i === w.step ? '' : 'secondary'} disabled={i > 0 && !w.uid} onClick={() => w.setStep(i)} style={{ padding: '4px 10px', fontSize: 12 }}>{i + 1}. {s}</button>
        ))}
      </div>
      {fc.info && w.trust && (
        <p style={{ marginTop: 0 }}>
          <span className="badge">{fc.info.target} · INAV {fc.info.version} · UID {fc.info.uid.slice(0, 8)}…</span>{' '}
          <span className={`badge ${TRUST_LABEL[w.trust].cls}`} title={TRUST_LABEL[w.trust].hint}>{TRUST_LABEL[w.trust].text}</span>{' '}
          {w.snapshot ? <span className="badge ok">снимок сохранён</span> : <span className="badge warn">снимка нет</span>}
          {fc.emulated && <span className="badge"> эмулятор</span>}
        </p>
      )}
      {w.step === 0 && <StepConnect />}
      {w.step === 1 && <StepSnapshot />}
      {w.step === 2 && <StepDiff gate={gate} />}
      {w.step === 3 && <StepFirmware gate={gate} />}
      {w.step === 4 && (fc.info ? <VtxFlow writeAllowed={gate} onDone={(vtx) => { w.patch({ vtx }); w.setStep(5); }} /> : <NeedBoard />)}
      {w.step === 5 && <TransmitterPanel embedded onNext={() => w.setStep(6)} />}
      {w.step === 6 && <StepArtifacts />}
      {w.step === 7 && <StepCrash />}
    </>
  );
}

function NeedBoard() {
  const w = useWizard();
  return <Card title="Борт отключён"><p className="muted">Подключите борт заново, чтобы продолжить с этого шага.</p><button onClick={() => w.setStep(0)}>К подключению</button></Card>;
}

// ---------------------------------------------------------------- 1. connect + identify + trust
export function StepConnect() {
  const fc = useFc();
  const w = useWizard();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function go(opts?: Parameters<typeof fc.connect>[0]) {
    setBusy(true);
    setErr(null);
    try {
      if (!fc.info || opts) {
        if (fc.client) await fc.disconnect();
        await fc.connect(opts);
      }
      const info = useFc.getState().info!;
      const t = await api<{ trust: Trust }>(`/trust?fcTarget=${encodeURIComponent(info.target)}&fcVersion=${encodeURIComponent(info.version)}`);
      w.startFor({ uid: info.uid, target: info.target, version: info.version }, t.trust);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="1. Подключите борт">
      <Tip>Борт по USB, INAV 7/8/9. Сначала только читаем: variant, версию, target, UID. Затем сервер говорит, проверен ли этот target на этой версии в полёте. Без этого не будет понятно, можно ли вообще что-то менять.</Tip>
      {fc.info ? (
        <p><span className="badge ok">{fc.info.variant} {fc.info.version}</span> {fc.info.target} · board {fc.info.boardId} · UID <span className="kbd">{fc.info.uid}</span></p>
      ) : (
        <p className="muted">{webSerialSupported ? 'Нажмите «Подключить» и выберите порт борта.' : connectivityHint()}</p>
      )}
      {fc.link === 'lost' && fc.info && (
        <p className="err">Связь с бортом потеряна (порт закрыт). <button className="secondary" disabled={busy} onClick={() => { setBusy(true); fc.ensureLink().catch((e: Error) => setErr(e.message)).finally(() => setBusy(false)); }}>Переподключить</button></p>
      )}
      {(err ?? fc.error) && <p className="err">{err ?? fc.error}</p>}
      <p className="muted" style={{ fontSize: 12 }}>{connectivityHint()}</p>
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={busy || !webSerialSupported} onClick={() => void go(fc.info && !fc.emulated ? undefined : {})}>{fc.info && !fc.emulated ? 'Определить доверие' : 'Подключить'}</button>
        <button className="secondary" disabled={busy} onClick={() => void go({ emulate: true, preset: 'molniya' })}>Эмулятор: Молния (проверенный)</button>
        <button className="secondary" disabled={busy} onClick={() => void go({ emulate: true, preset: 'utka' })}>Эмулятор: Утка (без flash, упала)</button>
      </div>
      {w.trust && (
        <div className="tip" style={{ marginTop: 12 }}>
          <b className={TRUST_LABEL[w.trust].cls}>{TRUST_LABEL[w.trust].text}</b> — {TRUST_LABEL[w.trust].hint}
          <div className="row" style={{ marginTop: 8 }}>
            {w.trust !== 'banned' && <button onClick={() => w.setStep(1)}>Далее: снимок →</button>}
            {w.trust === 'banned' && <Link className="btn secondary" to="/feedback">Написать администратору</Link>}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- 2. read-only snapshot → /snapshots
export function StepSnapshot() {
  const fc = useFc();
  const w = useWizard();
  const { notify } = useStore();
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<FcSnapshot | null>(w.snapshot?.local ?? null);
  const [imgSource, setImgSource] = useState('dfu-util');

  async function take() {
    if (!fc.client || !fc.info) return;
    setBusy(true);
    setProgress([]);
    try {
      setProgress(['Проверка связи с бортом…']);
      const client = await fc.ensureLink();
      const snap = await takeFcSnapshot(client, (t) => setProgress((p) => [...p, t]));
      setLocal(snap);
      const r = await api<{ snapshot: { id: string; diffSha256: string | null }; trust: Trust }>('/snapshots', {
        method: 'POST',
        json: {
          uid: snap.uid, fcVariant: snap.variant, fcVersion: snap.version, fcTarget: snap.target, boardId: snap.boardId, transport: snap.transport,
          diffAll: snap.diffAll, diffError: snap.diffError, statusText: snap.statusText, vtxConfig: snap.vtxConfig, vtxMap: snap.vtxMap,
          capability: { flash: snap.capability.flash, sdcard: snap.capability.sdcard, config: snap.capability.config, recommended: snap.capability.recommended, reasons: snap.capability.reasons }
        }
      });
      w.patch({ trust: r.trust, snapshot: { id: r.snapshot.id, uid: snap.uid, target: snap.target, version: snap.version, trust: r.trust, takenAt: snap.takenAt, diffSha256: r.snapshot.diffSha256, local: snap } });
      setProgress((p) => [...p, `Сохранено на сервере: ${r.snapshot.id}`]);
      notify('Снимок борта сохранён');
      if (!fc.emulated && snap.diffAll) {
        setProgress((p) => [...p, 'Борт перезагружается после CLI, ждём USB…']);
        try {
          await fc.reconnectAfterReboot();
          setProgress((p) => [...p, 'Связь с бортом восстановлена']);
        } catch (e) {
          setProgress((p) => [...p, `Снимок сохранён, но борт не вернулся на связь: ${(e as Error).message}`]);
        }
      }
    } catch (e) {
      setProgress((p) => [...p, `Ошибка: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  async function uploadImage(f: File) {
    if (!w.snapshot) return;
    const fd = new FormData();
    fd.append('source', imgSource);
    fd.append('file', f);
    try {
      const r = await apiUpload<{ sha256: string; sizeBytes: number }>(`/snapshots/${w.snapshot.id}/image`, fd);
      notify(`Образ прикреплён: ${Math.round(r.sizeBytes / 1024)} КБ, sha256 ${r.sha256.slice(0, 12)}…`);
    } catch (e) {
      notify(`Образ не прикреплён: ${(e as Error).message}`);
    }
  }

  const parsed = local?.diffAll ? parseDiff(local.diffAll) : null;
  return (
    <Card title="2. Снимок борта до любых изменений">
      <Tip>Снимаем только чтением: MSP (identity, UID, VTX, наличие flash/SD, blackbox) и CLI <span className="kbd">status</span>, <span className="kbd">diff all</span>. CLI идёт последним — INAV перезагружается при выходе. Снимок хранится неизменяемым и потом сравнивается с состоянием после полёта/падения.</Tip>
      {!snapshotRequired(w.trust) && <p className="ok">Борт проверенный — снимок не обязателен, но сохраните его: по нему потом ищутся отклонения.</p>}
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={busy || !fc.info} onClick={() => void take()}>{w.snapshot ? 'Снять ещё раз' : 'Снять и сохранить'}</button>
        {(w.snapshot || !snapshotRequired(w.trust)) && <button className="secondary" onClick={() => w.setStep(2)}>Далее: diff и опции →</button>}
      </div>
      {progress.length > 0 && <div className="log" style={{ marginTop: 10 }}>{progress.join('\n')}</div>}
      {local && (
        <div style={{ marginTop: 12 }}>
          <h4>Хранилище логов</h4>
          <p><b>Рекомендуемый путь: </b>{{ flash: 'встроенная flash (blackbox на борту)', sdcard: 'SD-карта (blackbox на борту)', serial_host: 'serial → внешний хост (ПК/телефон); это НЕ бортовой чёрный ящик', none: 'нет' }[local.capability.recommended]}</p>
          <ul>{local.capability.reasons.map((r, i) => <li key={i} className={/нет|не обнаружена|без blackbox|без хост/i.test(r) ? 'warn' : ''}>{r}</li>)}</ul>
          <h4>Конфигурация</h4>
          {parsed ? (
            <p className="muted">{parsed.versionLine ?? 'без заголовка версии'} · {parsed.lineCount} строк · {Object.keys(parsed.settings).length} set · {Object.entries(parsed.groups).map(([g, l]) => `${g}:${l.length}`).join(' ')}{w.snapshot?.diffSha256 && ` · sha256 ${w.snapshot.diffSha256.slice(0, 12)}…`}</p>
          ) : (
            <p className="err">diff all не получен: {local.diffError ?? 'пустой ответ'}. Без diff снимок неполный — проверьте, что борт не в режиме CLI и порт не занят конфигуратором.</p>
          )}
          {local.diffAll && <details><summary>diff all</summary><pre className="log">{local.diffAll}</pre></details>}
          {local.vtxMap === null && <p className="warn">Карта VTX (MSP2 0x2F10) не поддерживается этой прошивкой — переключать каналы с пульта она не умеет, нужна проектная прошивка INAV 7 (шаг «Прошивка»).</p>}
        </div>
      )}
      {w.snapshot && (
        <details style={{ marginTop: 12 }}>
          <summary>Образ прошивки с борта (опционально)</summary>
          <p className="muted">По MSP прошивку прочитать нельзя. Если вы сняли образ внешним инструментом, прикрепите его — он будет храниться с указанием источника, а не как «снято сервисом».</p>
          <label>Источник</label>
          <select value={imgSource} onChange={(e) => setImgSource(e.target.value)}><option value="dfu-util">dfu-util</option><option value="stm32cubeprog">STM32CubeProgrammer</option><option value="stlink">ST-Link</option><option value="other">другой</option></select>
          <input type="file" accept=".bin,.hex,.dfu" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadImage(f); }} />
        </details>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- 3. user diff + options with hints
const OPTION_HINTS: Array<{ title: string; hint: string; lines: string }> = [
  { title: 'Увеличенный газ в круизе', hint: 'nav_fw_cruise_thr — газ автопилота (1000–2000). Больше — быстрее, но растёт ток и падает время полёта.', lines: 'set nav_fw_cruise_thr = 1500\nset nav_fw_max_thr = 1900' },
  { title: 'Серва на RC-канале (например, сброс)', hint: 'smix <правило> <servo> <источник> <вес> <скорость> <условие>. Источники RC: CH5=8, CH6=9, CH7=10, CH8=11, CH9=15 … CH16=22. Пин выхода = моторы + порядковый номер servo среди используемых (на Молнии servo 5 → S7 от CH10).', lines: 'servo 5 1000 2000 1500 100\nsmix 4 5 16 100 0 -1' }
];

export function StepDiff({ gate }: { gate: { ok: boolean; why: string | null } }) {
  const fc = useFc();
  const w = useWizard();
  const { notify } = useStore();
  const templates = useAsync(() => api<{ templates: Array<{ id: string; name: string; description: string | null; content: string }> }>('/diff/templates'));
  const [analysis, setAnalysis] = useState<{ commands: number; unknown: string[]; conflicts: string[]; settings: Record<string, string> } | null>(null);
  const [applyLog, setApplyLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const base = w.snapshot?.local.diffAll ? parseDiff(w.snapshot.local.diffAll) : null;

  useEffect(() => {
    if (!w.userDiff.trim()) { setAnalysis(null); return; }
    const t = setTimeout(() => { api<{ analysis: typeof analysis }>('/diff/analyze', { method: 'POST', json: { content: w.userDiff } }).then((r) => setAnalysis(r.analysis)).catch(() => undefined); }, 400);
    return () => clearTimeout(t);
  }, [w.userDiff]);

  const overrides = analysis && base ? Object.entries(analysis.settings).filter(([k, v]) => k in base.settings && base.settings[k] !== v).map(([k, v]) => `${k}: ${base.settings[k]} → ${v}`) : [];

  async function apply() {
    if (!gate.ok) return;
    setBusy(true);
    setApplyLog([]);
    try {
      const lines = w.userDiff.split(/\r?\n/);
      await fc.runCliScript(lines, 'save', (l, out) => setApplyLog((p) => [...p, `> ${l}`, ...(out.trim() ? [out.trim()] : [])]));
      w.patch({ userDiffApplied: true });
      setApplyLog((p) => [...p, 'save → борт перезагружен, настройки записаны']);
      notify('Diff применён');
    } catch (e) {
      setApplyLog((p) => [...p, `Ошибка: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="3. Diff и опции">
      <Tip>Здесь только ваши изменения поверх текущей конфигурации (она в снимке). Подсказки справа объясняют, что делает каждая строка. Строки <span className="kbd">save</span>/<span className="kbd">exit</span>/<span className="kbd">defaults</span> не выполняются — save делает сервис сам одной CLI-сессией.</Tip>
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <div>
          <textarea className="code" style={{ minHeight: 220 }} value={w.userDiff} onChange={(e) => w.patch({ userDiff: e.target.value, userDiffApplied: false })} placeholder={'set nav_fw_cruise_thr = 1500\nsmix 4 5 38 100 0'} />
          {analysis && (
            <p className="muted">{analysis.commands} команд{analysis.unknown.length > 0 && <> · <span className="err">неизвестные: {analysis.unknown.join('; ')}</span></>}{analysis.conflicts.length > 0 && <> · <span className="warn">конфликты: {analysis.conflicts.join('; ')}</span></>}</p>
          )}
          {overrides.length > 0 && <p className="warn">Меняет текущие значения: {overrides.join('; ')}</p>}
          {!gate.ok && <p className="err">{gate.why}</p>}
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy || !gate.ok || !fc.info || !w.userDiff.trim() || (analysis?.unknown.length ?? 0) > 0} onClick={() => void apply()}>Применить на борт (одна CLI-сессия + save)</button>
            <button className="secondary" onClick={() => w.setStep(3)}>{w.userDiff.trim() ? 'Не применять сейчас, дальше →' : 'Без изменений, дальше →'}</button>
          </div>
          {applyLog.length > 0 && <div className="log" style={{ marginTop: 8 }}>{applyLog.join('\n')}</div>}
        </div>
        <div>
          <OsdZonesEditor baseDiff={w.snapshot?.local.diffAll ?? undefined} onAdd={(lines) => w.patch({ userDiff: `${w.userDiff.trimEnd()}\n${lines}\n`.trimStart(), userDiffApplied: false })} />
          <ArmRelayEditor baseDiff={w.snapshot?.local.diffAll ?? undefined} onAdd={(lines) => w.patch({ userDiff: `${w.userDiff.trimEnd()}\n${lines}\n`.trimStart(), userDiffApplied: false })} />
          {OPTION_HINTS.map((h) => (
            <details key={h.title} style={{ marginBottom: 6 }}>
              <summary>{h.title}</summary>
              <p className="muted" style={{ fontSize: 13 }}>{h.hint}</p>
              <pre className="log" style={{ maxHeight: 80 }}>{h.lines}</pre>
              <button className="secondary" style={{ fontSize: 12 }} onClick={() => w.patch({ userDiff: `${w.userDiff.trimEnd()}\n${h.lines}\n`.trimStart(), userDiffApplied: false })}>Добавить</button>
            </details>
          ))}
          {templates.data?.templates.map((t) => (
            <details key={t.id} style={{ marginBottom: 6 }}>
              <summary>Шаблон: {t.name}</summary>
              <p className="muted" style={{ fontSize: 13 }}>{t.description}</p>
              <button className="secondary" style={{ fontSize: 12 }} onClick={() => w.patch({ userDiff: `${w.userDiff.trimEnd()}\n${t.content}\n`.trimStart(), userDiffApplied: false })}>Добавить</button>
            </details>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- 4. firmware: verified build or diagnostic script
export function StepFirmware({ gate }: { gate: { ok: boolean; why: string | null } }) {
  const fc = useFc();
  const w = useWizard();
  const { notify } = useStore();
  const fw = useAsync(() => (fc.info ? api<{ firmware: Firmware[] }>(`/firmware?kind=fc&target=${encodeURIComponent(fc.info.target)}`) : Promise.resolve({ firmware: [] })), [fc.info?.target]);
  const cap = w.snapshot?.local.capability;
  const [logPath, setLogPath] = useState<DiagBuild['logPath']>(cap && cap.recommended !== 'none' ? cap.recommended : 'serial_host');
  const [serialPort, setSerialPort] = useState(1);
  const [debugMode, setDebugMode] = useState('NONE');
  const [busy, setBusy] = useState(false);
  const [applyLog, setApplyLog] = useState<string[]>([]);
  const diagNeeded = w.trust !== 'verified';

  async function build() {
    if (!w.snapshot) return;
    setBusy(true);
    try {
      const r = await api<{ build: { id: string; logPath: DiagBuild['logPath']; cliScript: string; status: string } }>('/diagnostic-builds', {
        method: 'POST',
        json: { snapshotId: w.snapshot.id, baseFirmwareId: w.firmwareId ?? undefined, logPath, serialPort: logPath === 'serial_host' ? serialPort : undefined, debugMode, userDiff: w.userDiff || undefined }
      });
      w.patch({ diagBuild: { id: r.build.id, logPath: r.build.logPath, cliScript: r.build.cliScript, status: r.build.status }, diagApplied: false });
      notify('Диагностический скрипт собран');
    } catch (e) {
      notify(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyDiag() {
    if (!w.diagBuild || !gate.ok) return;
    setBusy(true);
    setApplyLog([]);
    try {
      await fc.runCliScript(w.diagBuild.cliScript.split('\n'), 'save', (l, out) => setApplyLog((p) => [...p, `> ${l}`, ...(out.trim() ? [out.trim()] : [])]));
      await api(`/diagnostic-builds/${w.diagBuild.id}`, { method: 'PATCH', json: { status: 'applied' } });
      w.patch({ diagApplied: true, userDiffApplied: true, diagBuild: { ...w.diagBuild, status: 'applied' } });
      notify('Логирование включено, борт перезагружен');
    } catch (e) {
      setApplyLog((p) => [...p, `Ошибка: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  const list = fw.data?.firmware ?? [];
  const chosen = list.find((f) => f.id === w.firmwareId) ?? null;
  return (
    <Card title="4. Прошивка">
      <Tip>Прошивка по DFU из браузера не выполняется: скачайте файл проектного INAV 7 для вашего target и прошейте через INAV Configurator / dfu-util, затем вернитесь и подключите борт. Для непроверенного борта сначала включается логирование — иначе после падения анализировать будет нечего.</Tip>
      <h4>Проектная прошивка INAV 7 для {fc.info?.target ?? '—'}</h4>
      {fw.loading && <p className="muted">загрузка…</p>}
      {!fw.loading && list.length === 0 && <p className="warn">Опубликованной прошивки для target {fc.info?.target} нет. Для этого борта доступен только диагностический контур на текущей прошивке; проектная сборка появится после проверки администратором.</p>}
      {list.map((f) => (
        <label key={f.id} style={{ display: 'block', margin: '6px 0' }}>
          <input type="radio" name="fw" checked={w.firmwareId === f.id} onChange={() => w.patch({ firmwareId: f.id })} /> {f.fileName} · v{f.version} · <span className={`badge ${f.verification === 'flight_tested' ? 'ok' : 'warn'}`}>{{ flight_tested: 'проверена в полёте', diagnostic: 'диагностическая', experimental: 'экспериментальная', withdrawn: 'отозвана' }[f.verification] ?? f.verification}</span>{f.section && <span className="badge"> раздел: {f.section}</span>} <span className="muted">sha256 {f.sha256.slice(0, 12)}…</span>
        </label>
      ))}
      {chosen && (
        <p>
          <FirmwareDownload fw={chosen} />
          {chosen.changelog && <span className="muted"> · {chosen.changelog}</span>}
        </p>
      )}

      <h4 style={{ marginTop: 16 }}>Диагностический контур {diagNeeded ? <span className="badge warn">обязателен для этого борта</span> : <span className="badge">по желанию</span>}</h4>
      {!w.snapshot ? (
        <p className="err">Нужен сохранённый снимок (шаг 2): скрипт логирования строится от него и сверяется с target.</p>
      ) : (
        <>
          <label>Куда писать лог</label>
          <select value={logPath} onChange={(e) => setLogPath(e.target.value as DiagBuild['logPath'])}>
            <option value="flash" disabled={cap?.flash?.supported === false}>Встроенная flash{cap?.flash?.supported === false ? ' — на этом борту нет' : ''}</option>
            <option value="sdcard" disabled={cap?.sdcard?.supported === false}>SD-карта{cap?.sdcard?.supported === false ? ' — не обнаружена' : ''}</option>
            <option value="serial_host">Serial → внешний хост (ПК/телефон), не бортовой blackbox</option>
          </select>
          {logPath === 'serial_host' && (<><label>UART для BLACKBOX (serial N)</label><input type="number" min={0} max={7} value={serialPort} onChange={(e) => setSerialPort(+e.target.value)} /><p className="warn">В полёте без подключённого хоста логов не будет. Для «Утки» это единственный путь: flash нет, SD нет.</p></>)}
          <label>debug_mode</label>
          <select value={debugMode} onChange={(e) => setDebugMode(e.target.value)}>{['NONE', 'GYRO', 'FLOW_RAW', 'ALTITUDE', 'AUTOTRIM', 'AUTOTUNE', 'RATE_DYNAMICS', 'LANDING', 'POS_EST', 'SMARTAUDIO', 'VTX'].map((m) => <option key={m}>{m}</option>)}</select>
          <div className="row" style={{ marginTop: 8 }}>
            <button disabled={busy} onClick={() => void build()}>{w.diagBuild ? 'Пересобрать скрипт' : 'Собрать скрипт логирования'}</button>
            {w.diagBuild && <button disabled={busy || !gate.ok || !fc.info || w.diagApplied} onClick={() => void applyDiag()}>{w.diagApplied ? 'Применён' : 'Применить на борт (одна CLI-сессия + save)'}</button>}
          </div>
          {!gate.ok && <p className="err">{gate.why}</p>}
          {w.diagBuild && <details open><summary>Скрипт ({w.diagBuild.logPath})</summary><pre className="log">{w.diagBuild.cliScript}</pre></details>}
          {applyLog.length > 0 && <div className="log" style={{ marginTop: 8 }}>{applyLog.join('\n')}</div>}
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="secondary" onClick={() => w.setStep(2)}>Назад</button>
        <button onClick={() => w.setStep(4)} disabled={diagNeeded && !w.diagBuild && !chosen}>Далее: VTX →</button>
        {diagNeeded && !w.diagBuild && !chosen && <span className="muted">для непроверенного борта нужен хотя бы скрипт логирования или выбранная прошивка</span>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- 7. artifacts (generated and stored server-side: POST /build-sets)
/** Firmware file download goes through the API gate (trust/snapshot for FC, subscription for transmitter). */
export function FirmwareDownload({ fw }: { fw: Firmware }) {
  const w = useWizard();
  const [err, setErr] = useState<string | null>(null);
  const q = fw.kind === 'fc' ? `?uid=${encodeURIComponent(w.uid ?? '')}&fcVersion=${encodeURIComponent(w.fcVersion ?? '')}` : '';
  return (
    <>
      <button className="secondary" onClick={() => apiDownload(`/firmware/${fw.id}/download${q}`, fw.fileName).then(() => setErr(null), (e: Error) => setErr(e.message))}>Скачать {fw.fileName}</button>
      {err && <span className="warn"> {err}</span>}
    </>
  );
}

interface BuildSet { id: string; hashes: { fcScript: string; fcBundle: string; txYaml: string }; status: string; createdAt: string }

function StepArtifacts() {
  const w = useWizard();
  const fc = useFc();
  const txFw = useAsync(() => api<{ firmware: Firmware[] }>(`/firmware?kind=transmitter&target=${encodeURIComponent(w.tx.code)}`), [w.tx.code]);
  const fcFw = useAsync(() => (w.fcTarget ? api<{ firmware: Firmware[] }>(`/firmware?kind=fc&target=${encodeURIComponent(w.fcTarget)}`) : Promise.resolve({ firmware: [] })), [w.fcTarget]);
  const bs = useAsync<{ buildSet: BuildSet | null }>(() => (w.buildSetId ? api<{ buildSet: BuildSet }>(`/build-sets/${w.buildSetId}`) : Promise.resolve({ buildSet: null })), [w.buildSetId]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pairs = w.vtx?.pairs ?? [];
  const target = w.fcTarget ?? w.snapshot?.target ?? fc.info?.target ?? 'FC';
  const chosenFc = fcFw.data?.firmware.find((f) => f.id === w.firmwareId) ?? null;
  const txBin = txFw.data?.firmware[0] ?? null;
  const txName = `${w.tx.code.toUpperCase()}_VtxAuto_v3.1`;
  const saved = bs.data?.buildSet ?? null;

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ buildSet: BuildSet }>('/build-sets', {
        method: 'POST',
        json: {
          uid: w.uid,
          fcTarget: target,
          fcVersion: w.fcVersion ?? w.snapshot?.version ?? '',
          snapshotId: w.snapshot?.id ?? null,
          fcFirmwareId: w.firmwareId,
          txFirmwareId: txBin?.id ?? null,
          diagnosticBuildId: w.diagBuild?.id ?? null,
          vtxProfileId: w.tx.profileId,
          vtxModelId: w.vtx?.modelId ?? null,
          vtxModelName: w.vtx?.modelName ?? null,
          freqSource: w.vtx?.freqSource ?? 'manual',
          txModelCode: w.tx.code,
          userDiff: w.userDiff,
          pairs,
          fcApplied: w.userDiffApplied,
          vtxMapWritten: w.vtx?.writtenToFc ?? false
        }
      });
      w.patch({ buildSetId: r.buildSet.id });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dl = (kind: 'fc_cli' | 'fc_bundle' | 'tx_yaml', name: string) => () => {
    if (!w.buildSetId) return;
    apiDownload(`/build-sets/${w.buildSetId}/artifact/${kind}`, name).catch((e: Error) => setErr(e.message));
  };

  return (
    <>
      <Card title="7. Два артефакта">
        <Tip>Артефакты формирует сервер из сохранённых данных (снимок, diff, скрипт логирования, карта VTX, пары пульта) и хранит вместе с sha256 — то, что вы скачаете, можно потом сопоставить с крэш-отчётом. FC-артефакт: diff + логирование + карта VTX; артефакт пульта: YAML-фрагмент модели EdgeTX для VtxAuto v3.1 и сама прошивка пульта, если она опубликована.</Tip>
        <div className="row" style={{ marginBottom: 8 }}>
          <button disabled={busy || !pairs.length || !w.uid} onClick={() => void save()}>{saved ? 'Пересобрать комплект' : 'Сохранить комплект на сервере'}</button>
          {saved && <span className="badge ok">комплект {saved.id.slice(0, 8)} · {new Date(saved.createdAt).toLocaleString('ru')}</span>}
          {!pairs.length && <span className="warn">Сначала задайте пары VTX (шаг 5).</span>}
        </div>
        {err && <p className="warn">{err}</p>}
        <div className="grid">
          <div>
            <h4>Борт {target}</h4>
            <ul>
              <li>Прошивка: {chosenFc ? <>{chosenFc.fileName} <span className={`badge ${chosenFc.verification === 'flight_tested' ? 'ok' : 'warn'}`}>{chosenFc.verification}</span> · <FirmwareDownload fw={chosenFc} /></> : <span className="muted">не выбрана — остаётся текущая прошивка борта</span>}</li>
              <li>Diff: {w.userDiff.trim() ? `${w.userDiff.trim().split('\n').length} строк, ${w.userDiffApplied ? 'применён' : 'не применён'}` : 'нет'}</li>
              <li>Логирование: {w.diagBuild ? `${w.diagBuild.logPath}, ${w.diagApplied ? 'включено' : 'скрипт не применён'}` : 'нет'}</li>
              <li>Карта VTX: {pairs.length ? `${pairs.length} пар, ${w.vtx?.writtenToFc ? 'записана в FC' : 'НЕ записана'}` : 'нет'}</li>
            </ul>
            <div className="row">
              <button className="secondary" disabled={!saved} onClick={dl('fc_cli', `fc-${target}.cli.txt`)}>CLI-скрипт</button>
              <button className="secondary" disabled={!saved} onClick={dl('fc_bundle', `fc-${target}.json`)}>Бандл JSON</button>
            </div>
            {saved && <p className="muted" style={{ fontSize: 12 }}>sha256 CLI {saved.hashes.fcScript.slice(0, 16)}… · JSON {saved.hashes.fcBundle.slice(0, 16)}…</p>}
          </div>
          <div>
            <h4>Пульт {w.tx.name}</h4>
            <ul>
              <li>Прошивка: {txBin ? <>{txBin.fileName} <span className={`badge ${txBin.verification === 'flight_tested' ? 'ok' : 'warn'}`}>{txBin.verification}</span> · <FirmwareDownload fw={txBin} /></> : <span className="warn">{txName}.bin ещё не опубликована для этой модели</span>}</li>
              <li>Конфигурация: {pairs.length} пар, RC-канал {pairs[0]?.rcChannel ?? '—'}</li>
              <li>Профиль в кабинете: {w.tx.profileId ? 'сохранён' : 'не сохранён'}</li>
            </ul>
            <div className="row">
              <button className="secondary" disabled={!saved} onClick={dl('tx_yaml', `${txName}.yml`)}>YAML модели EdgeTX</button>
            </div>
            {saved && <p className="muted" style={{ fontSize: 12 }}>sha256 YAML {saved.hashes.txYaml.slice(0, 16)}…</p>}
            <p className="muted" style={{ fontSize: 13 }}>Фрагмент вставляется в MODELS/modelNN.yml на SD пульта (или вводится в меню VTX AUTO). Значения переведены в проценты хода канала, как их хранит прошивка.</p>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="secondary" onClick={() => w.setStep(5)}>Назад</button>
          <button onClick={() => w.setStep(7)}>После полёта: отчёт →</button>
          <Link className="btn secondary" to="/account/devices">Кабинет</Link>
        </div>
        {w.trust !== 'verified' && <p className="warn" style={{ marginTop: 8 }}>Борт не проверен в полёте. Эмулятор и статический анализ — не проверка. Первый полёт — только с включённым логированием и в безопасном месте.</p>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- 8. post-flight: crash report
interface CrashReport { id: string; status: string; analysis: { diffNote: string; logs: Array<{ name: string; kind: string; note: string }>; findings: Array<{ severity: string; text: string }> } | null; fixFirmwareId: string | null; fixDiffContent: string | null; userVerdict: string | null }

export function StepCrash() {
  const w = useWizard();
  const fc = useFc();
  const { notify } = useStore();
  const [desc, setDesc] = useState('');
  const [diffAfter, setDiffAfter] = useState('');
  const [files, setFiles] = useState<Record<string, FileList | null>>({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CrashReport | null>(null);
  const mine = useAsync(() => api<{ reports: CrashReport[] }>('/crash-reports'));

  async function readDiffAfter() {
    if (!fc.client) return;
    setBusy(true);
    try {
      const client = await fc.ensureLink();
      const s = await client.cliSession();
      try { setDiffAfter(await s.run('diff all', 8000)); } finally { await s.end('exit'); }
      if (!fc.emulated) await fc.reconnectAfterReboot();
    } catch (e) {
      notify(`diff all не прочитан: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    setBusy(true);
    try {
      const fd = new FormData();
      if (w.snapshot) fd.append('snapshotId', w.snapshot.id);
      if (w.diagBuild) fd.append('diagnosticBuildId', w.diagBuild.id);
      if (w.uid) fd.append('uid', w.uid);
      if (w.snapshot) fd.append('fcTarget', w.snapshot.target);
      if (desc) fd.append('description', desc);
      if (diffAfter) fd.append('diffAfter', diffAfter);
      for (const [kind, list] of Object.entries(files)) for (const f of Array.from(list ?? [])) fd.append(kind, f);
      const r = await apiUpload<{ report: CrashReport }>('/crash-reports', fd);
      setReport(r.report);
      mine.reload();
      notify('Отчёт сохранён и проанализирован');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verdict(id: string, v: 'ok' | 'still_crashes' | 'not_flown') {
    try {
      await api(`/crash-reports/${id}/verdict`, { method: 'POST', json: { verdict: v } });
      notify('Отзыв сохранён');
      mine.reload();
    } catch (e) {
      notify((e as Error).message);
    }
  }

  const fileInput = (kind: string, label: string, accept?: string) => (
    <label style={{ display: 'block' }}>{label}<input type="file" multiple accept={accept} onChange={(e) => setFiles((f) => ({ ...f, [kind]: e.target.files }))} /></label>
  );

  return (
    <>
      <Card title="8. После полёта / падения">
        <Tip>Загрузите всё, что есть: blackbox (.bbl/.txt), логи хоста, фото, и снимите <span className="kbd">diff all</span> с борта после падения. Сервис сравнит его со снимком до изменений, разберёт заголовки логов и покажет отклонения. Это отклонения, а не причина — причину подтверждает только исправленная прошивка и ваш отзыв после полёта.</Tip>
        {!w.snapshot && <p className="warn">Снимка «до» нет — сравнение diff будет невозможно, останутся только логи.</p>}
        <label>Что произошло</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Через 40 с после взлёта борт ушёл в крен вправо и не реагировал…" />
        <label>diff all после падения</label>
        <div className="row"><button className="secondary" disabled={busy || !fc.info} onClick={() => void readDiffAfter()}>Снять с подключённого борта</button><span className="muted">{diffAfter ? `${diffAfter.split('\n').length} строк` : 'или вставьте текст ниже'}</span></div>
        <textarea className="code" value={diffAfter} onChange={(e) => setDiffAfter(e.target.value)} />
        {fileInput('blackbox', 'Blackbox-логи', '.bbl,.bfl,.txt,.log')}
        {fileInput('host_log', 'Логи хоста (MSP/serial)', '.txt,.log,.csv,.bin')}
        {fileInput('photo', 'Фото', 'image/*')}
        {fileInput('other', 'Другое')}
        <button style={{ marginTop: 10 }} disabled={busy || (!desc && !diffAfter && !Object.values(files).some((l) => l && l.length))} onClick={() => void send()}>Отправить и проанализировать</button>
      </Card>
      {(report ? [report] : mine.data?.reports ?? []).map((r) => (
        <Card key={r.id} title={`Отчёт ${r.id.slice(0, 8)} · ${r.status}`}>
          {r.analysis ? (
            <>
              <p className="muted">{r.analysis.diffNote}</p>
              <ul>{r.analysis.findings.map((f, i) => <li key={i} className={f.severity === 'critical' ? 'err' : f.severity === 'warning' ? 'warn' : ''}>[{f.severity}] {f.text}</li>)}</ul>
              {r.analysis.logs.length > 0 && <ul>{r.analysis.logs.map((l, i) => <li key={i}>{l.kind}: {l.name} — {l.note}</li>)}</ul>}
            </>
          ) : <p className="muted">анализ ещё не выполнен</p>}
          {(r.fixFirmwareId || r.fixDiffContent) ? (
            <>
              <p className="ok">Администратор предложил исправление{r.fixDiffContent && <details><summary>diff</summary><pre className="log">{r.fixDiffContent}</pre></details>}</p>
              {r.userVerdict ? <p>Ваш отзыв: <b>{r.userVerdict}</b></p> : (
                <div className="row"><button onClick={() => void verdict(r.id, 'ok')}>Летает нормально</button><button className="secondary" onClick={() => void verdict(r.id, 'still_crashes')}>Снова упал</button><button className="secondary" onClick={() => void verdict(r.id, 'not_flown')}>Ещё не летал</button></div>
              )}
            </>
          ) : <p className="muted">Исправление ещё не предложено администратором. Публикация прошивки для этого борта возможна только после вашего отзыва «летает нормально».</p>}
        </Card>
      ))}
    </>
  );
}

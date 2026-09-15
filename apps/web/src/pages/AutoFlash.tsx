import { useState } from 'react';
import { Card, Tip, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useFc } from '../lib/fc';
import { useStore } from '../lib/store';
import { TRUST_LABEL, canWrite, useWizard, type Trust } from '../lib/wizard';

interface Preset { id: string; name: string; allowedTargets: string[]; inavVersion: string; firmwareId: string | null; diffId: string | null; vtxProfileId: string | null; options: Record<string, boolean> | null }
interface Fw { id: string; kind: string; target: string; version: string; fileName: string }
interface Diff { id: string; name: string; content: string; isActive: boolean }
interface Profile { id: string; name: string; pairs: Array<{ band: number; channel: number; freqMhz: number; rcChannel: number; rcLevel: number }> }

const DEFAULT_OPTS = { skipIfSame: true, applyDiff: true, applyOsd: false, applyVtx: true, autoEepromWrite: true, syncTransmitter: false };

/** AutoFlashPreset + conveyor mode. Flashing itself (DFU) is out of Web Serial scope: we verify version, apply diff/VTX map over MSP, and log every step. */
export function AutoFlashPage() {
  const fc = useFc();
  const { notify, access } = useStore();
  const presets = useAsync(() => api<{ presets: Preset[] }>('/flash-presets'));
  const fw = useAsync(() => api<{ firmware: Fw[] }>('/firmware?kind=fc'));
  const diffs = useAsync(() => api<{ diffs: Diff[] }>('/diffs'));
  const profiles = useAsync(() => api<{ profiles: Profile[] }>('/vtx-profiles'));
  const [sel, setSel] = useState<string | null>(null);
  const [conveyor, setConveyor] = useState(false);
  const [runs, setRuns] = useState<Array<{ uid: string; status: string; note: string }>>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Partial<Preset> & { options: Record<string, boolean> }>({ name: '', allowedTargets: ['CADDXF405_WING'], inavVersion: '7.1.2', options: DEFAULT_OPTS });
  const preset = presets.data?.presets.find((p) => p.id === sel) ?? null;
  const push = (s: string) => setLog((l) => [...l.slice(-300), `${new Date().toLocaleTimeString()} ${s}`]);

  async function runOnce() {
    if (!fc.client || !fc.info || !preset) return;
    setBusy(true);
    // Trust + snapshot gate: same rule as the master wizard — nothing is written to an unverified board without a stored snapshot.
    const trustRes = await api<{ trust: Trust }>(`/trust?fcTarget=${encodeURIComponent(fc.info.target)}&fcVersion=${encodeURIComponent(fc.info.version)}`).catch(() => ({ trust: 'unverified' as Trust }));
    const wz = useWizard.getState();
    const gate = canWrite({ trust: trustRes.trust, snapshot: wz.uid === fc.info.uid ? wz.snapshot : null });
    if (!gate.ok) {
      push(`[gate] ${TRUST_LABEL[trustRes.trust].text}: ${gate.why}`);
      notify('Заблокировано: пройдите шаги «Борт» и «Снимок» в мастере');
      setBusy(false);
      return;
    }
    const run = await api<{ run: { id: string } }>('/autoflash/runs', { method: 'POST', json: { presetId: preset.id, boardUid: fc.info.uid, fcTarget: fc.info.target, fromVersion: fc.info.version } });
    const entries: Array<{ level: 'info' | 'warn' | 'error'; step?: string; message: string }> = [];
    const step = (s: string, m: string, level: 'info' | 'warn' | 'error' = 'info') => { push(`[${s}] ${m}`); entries.push({ level, step: s, message: m }); };
    let status: 'ok' | 'failed' | 'skipped' = 'ok';
    try {
      step('check', `UID ${fc.info.uid}, ${fc.info.target} INAV ${fc.info.version}`);
      if (preset.allowedTargets.length && !preset.allowedTargets.includes(fc.info.target)) throw new Error(`Target ${fc.info.target} не входит в пресет (${preset.allowedTargets.join(', ')})`);
      const opts = preset.options ?? DEFAULT_OPTS;
      if (opts.skipIfSame && preset.inavVersion !== 'latest' && fc.info.version === preset.inavVersion) step('firmware', 'версия совпадает — прошивка пропущена');
      else if (preset.firmwareId) step('firmware', 'Требуется прошивка через DFU: скачайте файл во вкладке «Прошивки» и прошейте INAV Configurator. Web Serial DFU не поддерживает.', 'warn');
      if (opts.applyDiff && preset.diffId) {
        const d = diffs.data?.diffs.find((x) => x.id === preset.diffId);
        if (d) {
          step('diff', `применяем ${d.name} (${d.content.split('\n').length} строк)`);
          await fc.runCliScript(d.content.split(/\r?\n/), 'save', (l, out) => { if (/error|invalid|unknown/i.test(out)) step('diff', `${l}: ${out.trim()}`, 'warn'); });
          step('diff', 'save → перезагрузка, переподключено');
          await api('/diffs/usage', { method: 'POST', json: { diffId: d.id, action: 'applied' } });
        }
      }
      if (opts.applyVtx && preset.vtxProfileId) {
        const p = profiles.data?.profiles.find((x) => x.id === preset.vtxProfileId);
        if (p) { step('vtx', `карта VTX ${p.name}: ${p.pairs.length} пар`); await fc.client.vtxMapWrite(p.pairs); }
      }
      if (opts.autoEepromWrite) { step('eeprom', 'MSP_EEPROM_WRITE'); await fc.client.eepromWrite(); }
      step('done', 'готово');
    } catch (e) {
      status = 'failed';
      step('error', (e as Error).message, 'error');
    }
    await api(`/autoflash/runs/${run.run.id}/log`, { method: 'POST', json: { entries } });
    await api(`/autoflash/runs/${run.run.id}`, { method: 'PATCH', json: { status, toVersion: fc.info.version } });
    setRuns((r) => [{ uid: fc.info!.uid, status, note: entries.at(-1)?.message ?? '' }, ...r]);
    setBusy(false);
    notify(status === 'ok' ? 'Борт готов. Отключите и подключите следующий.' : 'Ошибка — см. журнал');
    if (conveyor) await fc.disconnect();
  }

  async function savePreset() {
    await api('/flash-presets', { method: 'POST', json: form });
    presets.reload();
    notify('Пресет сохранён');
  }

  if (access && !access.features.autoflash) return <Card title="AutoFlash"><p className="err">Недоступно в вашем тарифе.</p></Card>;

  return (
    <>
      <Card title="Пресет" right={<label className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={conveyor} onChange={(e) => setConveyor(e.target.checked)} /> конвейер</label>}>
        <select value={sel ?? ''} onChange={(e) => setSel(e.target.value || null)}>
          <option value="">— выберите пресет</option>
          {presets.data?.presets.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.allowedTargets.join('/')} · INAV {p.inavVersion}</option>)}
        </select>
        {preset && (
          <p className="muted" style={{ marginTop: 8 }}>
            diff: {diffs.data?.diffs.find((d) => d.id === preset.diffId)?.name ?? '—'} · VTX: {profiles.data?.profiles.find((d) => d.id === preset.vtxProfileId)?.name ?? '—'} · опции: {Object.entries(preset.options ?? DEFAULT_OPTS).filter(([, v]) => v).map(([k]) => k).join(', ')}
          </p>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          {!fc.info ? <button onClick={() => fc.connect().catch(() => undefined)}>Подключить борт</button> : <span className="badge ok">{fc.info.target} {fc.info.version} · {fc.info.uid.slice(0, 8)}</span>}
          <button disabled={!fc.info || !preset || busy} onClick={() => void runOnce()}>Выполнить</button>
          {!fc.info && <button className="secondary" onClick={() => fc.connect({ emulate: true }).catch(() => undefined)}>Эмулятор</button>}
        </div>
        {conveyor && <Tip>Конвейер: после каждого борта соединение закрывается автоматически. Подключайте следующий и нажимайте «Выполнить». Результаты — в таблице ниже и в CSV.</Tip>}
      </Card>
      {runs.length > 0 && (
        <Card title="Результаты партии" right={<a className="btn secondary" href="#" onClick={(e) => { e.preventDefault(); void exportCsv(); }}>CSV</a>}>
          <table><tbody>{runs.map((r, i) => <tr key={i}><td className="kbd">{r.uid}</td><td className={r.status === 'ok' ? 'ok' : 'err'}>{r.status}</td><td className="muted">{r.note}</td></tr>)}</tbody></table>
        </Card>
      )}
      <Card title="Журнал"><div className="log">{log.join('\n') || 'пусто'}</div></Card>
      <Card title="Новый пресет">
        <label>Название</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label>Разрешённые target (через запятую)</label><input value={form.allowedTargets?.join(',')} onChange={(e) => setForm({ ...form, allowedTargets: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        <label>Версия INAV</label><input value={form.inavVersion} onChange={(e) => setForm({ ...form, inavVersion: e.target.value })} />
        <label>Файл прошивки</label>
        <select value={form.firmwareId ?? ''} onChange={(e) => setForm({ ...form, firmwareId: e.target.value || null })}><option value="">—</option>{fw.data?.firmware.map((f) => <option key={f.id} value={f.id}>{f.target} {f.version}</option>)}</select>
        <label>Diff</label>
        <select value={form.diffId ?? ''} onChange={(e) => setForm({ ...form, diffId: e.target.value || null })}><option value="">—</option>{diffs.data?.diffs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <label>VTX профиль</label>
        <select value={form.vtxProfileId ?? ''} onChange={(e) => setForm({ ...form, vtxProfileId: e.target.value || null })}><option value="">—</option>{profiles.data?.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <div className="row" style={{ marginTop: 8 }}>
          {Object.keys(DEFAULT_OPTS).map((k) => (
            <label key={k} className="row" style={{ margin: 0 }}><input type="checkbox" style={{ width: 'auto' }} checked={form.options[k]} onChange={(e) => setForm({ ...form, options: { ...form.options, [k]: e.target.checked } })} /> {k}</label>
          ))}
        </div>
        <button style={{ marginTop: 10 }} disabled={!form.name} onClick={() => void savePreset()}>Сохранить пресет</button>
      </Card>
    </>
  );
}

async function exportCsv() {
  const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/autoflash/runs?format=csv`, { headers: { Authorization: `Bearer ${localStorage.getItem('vtx.token')}` } });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = 'autoflash-log.csv';
  a.click();
}

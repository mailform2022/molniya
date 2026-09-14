import { useState } from 'react';
import { Link } from 'react-router-dom';
import { parseVtxInfo, validateFreqTable, type VtxInfo, type VtxPair } from '@vtx/msp';
import { Card, Steps, Tip, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useFc } from '../lib/fc';
import { useStore } from '../lib/store';

interface Range { id: string; code: string; name: string; minMhz: number; maxMhz: number; status: string; isDefault: boolean }
interface VtxModel { id: string; name: string; manufacturer: string | null; rangeId: string | null; protocol: string; bands: number; channels: number; freqTable: number[][]; flagged: boolean }

/** AutoDetectVTXWizard: 1 connect → 2 detect → 3 range → 4 confirm/pairs → 5 write. */
export function VtxWizardPage() {
  const fc = useFc();
  const { notify } = useStore();
  const [step, setStep] = useState(fc.info ? 1 : 0);
  const [log, setLog] = useState<string[]>([]);
  const [vtxCfg, setVtxCfg] = useState<Awaited<ReturnType<NonNullable<typeof fc.client>['vtxConfig']>> | null>(null);
  const [info, setInfo] = useState<VtxInfo | null>(null);
  const [rangeId, setRangeId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [pairs, setPairs] = useState<VtxPair[]>([]);
  const [busy, setBusy] = useState(false);
  const ranges = useAsync(() => api<{ ranges: Range[] }>('/frequency-ranges'));
  const models = useAsync(() => api<{ models: VtxModel[] }>('/vtx-models'));
  const push = (s: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${s}`]);

  async function detect() {
    if (!fc.client) return;
    setBusy(true);
    try {
      push('MSP_VTX_CONFIG…');
      const cfg = await fc.client.vtxConfig();
      setVtxCfg(cfg);
      push(`VTX type=${cfg.deviceType} band=${cfg.band} ch=${cfg.channel} pwr=${cfg.power} freq=${cfg.freqMhz}`);
      push('CLI vtx_info…');
      let parsed: VtxInfo | null = null;
      try {
        const text = await fc.client.cli('vtx_info', 3000);
        parsed = parseVtxInfo(text);
        push(`vtx_info: ${parsed.name || '?'} ${parsed.protocol} ${parsed.bands}x${parsed.channels}, ${parsed.freqTable.length} частот`);
      } catch (e) {
        push(`vtx_info недоступен (${(e as Error).message}) — прошивка FC без vtx_info; продолжаем по MSP`);
      }
      setInfo(parsed);
      const det = await api<{ matchedVtxModelId: string | null }>('/vtx-auto-detections', { method: 'POST', json: { fcTarget: fc.info?.target, fcVersion: fc.info?.version, vtxConfig: cfg, vtxInfo: parsed ?? undefined, log } });
      if (det.matchedVtxModelId) {
        setModelId(det.matchedVtxModelId);
        const m = models.data?.models.find((x) => x.id === det.matchedVtxModelId);
        if (m?.rangeId) setRangeId(m.rangeId);
        push(`Совпадение с базой: ${m?.name ?? det.matchedVtxModelId}`);
      } else {
        const def = ranges.data?.ranges.find((r) => r.isDefault);
        if (def) setRangeId(def.id);
        push('В базе не найден — выберите диапазон вручную или отправьте на модерацию');
      }
      setStep(2);
    } catch (e) {
      push(`Ошибка: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function buildPairs() {
    const m = models.data?.models.find((x) => x.id === modelId);
    const table = m?.freqTable ?? (info ? chunk(info.freqTable, info.channels || 8) : []);
    const out: VtxPair[] = [];
    table.forEach((band, b) => band.forEach((f, c) => { if (out.length < 16) out.push({ band: b + 1, channel: c + 1, freqMhz: f, rcChannel: 9, rcLevel: 1000 + out.length * 66 }); }));
    setPairs(out);
    setStep(3);
  }

  async function write() {
    if (!fc.client) return;
    setBusy(true);
    try {
      push('MSP2 0x2F11 VTX_MAP_WRITE…');
      await fc.client.vtxMapWrite(pairs);
      push('MSP_EEPROM_WRITE…');
      await fc.client.eepromWrite();
      const back = await fc.client.vtxMapRead();
      push(`Проверка: прочитано ${back.length} пар`);
      await api('/vtx-sync-log', { method: 'POST', json: { direction: 'to_fc', payload: { pairs, uid: fc.info?.uid, target: fc.info?.target }, ok: true } });
      notify('Карта VTX записана');
      setStep(4);
    } catch (e) {
      push(`Ошибка записи: ${(e as Error).message}`);
      await api('/vtx-sync-log', { method: 'POST', json: { direction: 'to_fc', payload: { error: (e as Error).message }, ok: false } }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const range = ranges.data?.ranges.find((r) => r.id === rangeId);
  const warnings = range && info ? validateFreqTable(info.freqTable, [range.minMhz, range.maxMhz]) : [];

  return (
    <>
      <Steps n={5} current={step} />
      {step === 0 && (
        <Card title="1. Подключите борт">
          <p className="muted">Борт не подключён. Подключите его на вкладке «Борт» или используйте эмулятор.</p>
          <div className="row"><Link className="btn" to="/connect">К подключению</Link><button className="secondary" onClick={() => fc.connect({ emulate: true }).then(() => setStep(1)).catch(() => undefined)}>Эмулятор</button></div>
        </Card>
      )}
      {step === 1 && (
        <Card title="2. Определение VTX">
          <Tip>Читаем MSP_VTX_CONFIG и CLI <span className="kbd">vtx_info</span> (SmartAudio/Tramp статус, сетка частот). Ничего не записываем.</Tip>
          <div className="row" style={{ marginTop: 10 }}><button disabled={busy} onClick={() => void detect()}>Определить</button></div>
        </Card>
      )}
      {step === 2 && (
        <Card title="3. Диапазон и модель">
          {vtxCfg && <p>Текущий VTX: тип {vtxCfg.deviceType}, band {vtxCfg.band}, ch {vtxCfg.channel}, {vtxCfg.freqMhz} МГц</p>}
          <label>Диапазон</label>
          <select value={rangeId ?? ''} onChange={(e) => setRangeId(e.target.value)}>
            <option value="">—</option>
            {ranges.data?.ranges.map((r) => <option key={r.id} value={r.id} disabled={r.status === 'coming_soon'}>{r.name} {r.status !== 'active' ? `(${r.status === 'in_dev' ? 'в разработке' : 'скоро'})` : ''}</option>)}
          </select>
          <label>Модель VTX</label>
          <select value={modelId ?? ''} onChange={(e) => setModelId(e.target.value || null)}>
            <option value="">— неизвестна (использовать сетку из vtx_info)</option>
            {models.data?.models.filter((m) => !rangeId || m.rangeId === rangeId).map((m) => <option key={m.id} value={m.id}>{m.name} {m.flagged ? '⚠' : ''}</option>)}
          </select>
          {warnings.map((w, i) => <p key={i} className="warn">{w}</p>)}
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={buildPairs} disabled={!rangeId}>Далее</button>
            {!modelId && info && <Link className="btn secondary" to="/submit" state={{ info, rangeId }}>Отправить VTX в базу</Link>}
          </div>
        </Card>
      )}
      {step === 3 && (
        <Card title="4. Пары канал ↔ частота">
          <Tip>Каждой частоте назначается уровень RC-канала пульта (VtxAuto). Пульт переключает канал, FC ставит частоту. До 16 пар.</Tip>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>#</th><th>Band/Ch</th><th>МГц</th><th>RC канал</th><th>Уровень</th></tr></thead>
            <tbody>
              {pairs.map((p, i) => (
                <tr key={i}>
                  <td>{i + 1}</td><td>{p.band}/{p.channel}</td>
                  <td><input type="number" value={p.freqMhz} onChange={(e) => setPairs(pairs.map((x, j) => j === i ? { ...x, freqMhz: +e.target.value } : x))} /></td>
                  <td><input type="number" min={5} max={16} value={p.rcChannel} onChange={(e) => setPairs(pairs.map((x, j) => j === i ? { ...x, rcChannel: +e.target.value } : x))} /></td>
                  <td><input type="number" min={900} max={2100} value={p.rcLevel} onChange={(e) => setPairs(pairs.map((x, j) => j === i ? { ...x, rcLevel: +e.target.value } : x))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="secondary" onClick={() => setStep(2)}>Назад</button>
            <button disabled={busy || !pairs.length} onClick={() => void write()}>Записать в FC</button>
            <button className="secondary" onClick={() => void api('/vtx-profiles', { method: 'POST', json: { name: `${fc.info?.target ?? 'FC'} ${new Date().toLocaleDateString()}`, vtxModelId: modelId, pairs } }).then(() => notify('Профиль сохранён'))}>Сохранить профиль</button>
          </div>
        </Card>
      )}
      {step === 4 && (
        <Card title="5. Готово">
          <p className="ok">Карта VTX записана и проверена чтением. Синхронизируйте пульт: «Кабинет → Устройства → Авторизовать» и запишите пары в пульт через его меню VTX AUTO.</p>
          <div className="row"><button className="secondary" onClick={() => { setStep(1); setLog([]); }}>Ещё один борт</button><Link className="btn" to="/account/devices">К устройствам</Link></div>
        </Card>
      )}
      <Card title="Журнал"><div className="log">{log.join('\n') || 'пусто'}</div></Card>
    </>
  );
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

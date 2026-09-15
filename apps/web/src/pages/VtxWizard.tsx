import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseVtxInfo, validateFreqTable, type MspLogEntry, type VtxInfo, type VtxPair } from '@vtx/msp';
import { Card, Steps, Tip, useAsync } from '../components/ui';
import { api, apiUpload, apiUrl } from '../lib/api';
import { useFc } from '../lib/fc';
import { useStore } from '../lib/store';
import type { VtxResult } from '../lib/wizard';

interface Range { id: string; code: string; name: string; minMhz: number; maxMhz: number; status: string; isDefault: boolean }
interface VtxModel { id: string; name: string; manufacturer: string | null; rangeId: string | null; protocol: string; bands: number; channels: number; freqTable: number[][]; flagged: boolean }
type FreqSource = VtxResult['freqSource'];
type RawLogEntry = { t: number; dir: 'tx' | 'rx' | 'info'; text: string };

/** Standalone page: AutoDetectVTXWizard. The same flow is embedded into /wizard via <VtxFlow/>. */
export function VtxWizardPage() {
  const fc = useFc();
  if (!fc.info) {
    return (
      <Card title="1. Подключите борт">
        <p className="muted">Борт не подключён. Подключите его на вкладке «Борт» или используйте эмулятор.</p>
        <div className="row"><Link className="btn" to="/connect">К подключению</Link><button className="secondary" onClick={() => fc.connect({ emulate: true }).catch(() => undefined)}>Эмулятор</button></div>
      </Card>
    );
  }
  return <VtxFlow writeAllowed={{ ok: true, why: null }} />;
}

/**
 * detect → range/model + frequency source (catalog | vtx_info | manual | file) → pairs → write (MSP2 0x2F11) + read-back.
 * Raw MSP/CLI exchange during detection is kept and sent with the submission so an unknown VTX can be added to the base
 * with evidence, not by hand-typed values only.
 */
export function VtxFlow({ writeAllowed, onDone }: { writeAllowed: { ok: boolean; why: string | null }; onDone?: (r: VtxResult) => void }) {
  const fc = useFc();
  const { notify } = useStore();
  const [step, setStep] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [vtxCfg, setVtxCfg] = useState<Awaited<ReturnType<NonNullable<typeof fc.client>['vtxConfig']>> | null>(null);
  const [info, setInfo] = useState<VtxInfo | null>(null);
  const [rangeId, setRangeId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [freqSource, setFreqSource] = useState<FreqSource>('catalog');
  const [manualGrid, setManualGrid] = useState('');
  const [fileTable, setFileTable] = useState<{ table: number[][]; name: string; sha256: string } | null>(null);
  const [pairs, setPairs] = useState<VtxPair[]>([]);
  const [rcChannel, setRcChannel] = useState(9);
  const [busy, setBusy] = useState(false);
  const rawLog = useRef<RawLogEntry[]>([]);
  const ranges = useAsync(() => api<{ ranges: Range[] }>('/frequency-ranges'));
  const models = useAsync(() => api<{ models: VtxModel[] }>('/vtx-models'));
  const push = (s: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()} ${s}`]);

  async function detect() {
    if (!fc.client) return;
    setBusy(true);
    const logStart = fc.log.length;
    try {
      const client = await fc.ensureLink();
      push('MSP_VTX_CONFIG…');
      const cfg = await client.vtxConfig();
      setVtxCfg(cfg);
      push(`VTX type=${cfg.deviceType} band=${cfg.band} ch=${cfg.channel} pwr=${cfg.power} freq=${cfg.freqMhz}`);
      if (cfg.deviceType === 0) push('FC сообщает: VTX не сконфигурирован (type=0). Проверьте, что VTX подключён к UART и в INAV выбран SmartAudio/Tramp.');
      push('CLI vtx_info…');
      let parsed: VtxInfo | null = null;
      try {
        const text = await client.cli('vtx_info', 3000);
        parsed = parseVtxInfo(text);
        push(`vtx_info: ${parsed.name || '?'} ${parsed.protocol} ${parsed.bands}x${parsed.channels}, ${parsed.freqTable.length} частот`);
      } catch (e) {
        push(`vtx_info недоступен (${(e as Error).message}) — прошивка FC без vtx_info; продолжаем по MSP`);
      }
      if (!fc.emulated) {
        push('CLI exit → FC перезагружается, переподключение…');
        await fc.reconnectAfterReboot();
      }
      setInfo(parsed);
      const entries: MspLogEntry[] = useFc.getState().log.slice(logStart);
      rawLog.current = entries.filter((e) => e.dir !== 'err').map((e) => ({ t: e.t, dir: e.dir as RawLogEntry['dir'], text: e.text.slice(0, 512) }));
      const det = await api<{ matchedVtxModelId: string | null }>('/vtx-auto-detections', { method: 'POST', json: { fcTarget: fc.info?.target, fcVersion: fc.info?.version, vtxConfig: cfg, vtxInfo: parsed ?? undefined, log } });
      if (det.matchedVtxModelId) {
        setModelId(det.matchedVtxModelId);
        setFreqSource('catalog');
        const m = models.data?.models.find((x) => x.id === det.matchedVtxModelId);
        if (m?.rangeId) setRangeId(m.rangeId);
        push(`Совпадение с базой: ${m?.name ?? det.matchedVtxModelId}`);
      } else {
        const def = ranges.data?.ranges.find((r) => r.isDefault);
        if (def) setRangeId(def.id);
        setFreqSource(parsed && parsed.freqTable.length ? 'vtx_info' : 'manual');
        push(parsed && parsed.freqTable.length ? 'В базе не найден — сетка взята из vtx_info, проверьте её' : 'В базе не найден и VTX не отдал сетку — введите её вручную или загрузите файл');
      }
      setStep(1);
    } catch (e) {
      push(`Ошибка: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const range = ranges.data?.ranges.find((r) => r.id === rangeId);
  const model = models.data?.models.find((x) => x.id === modelId);
  const table: number[][] =
    freqSource === 'catalog' ? model?.freqTable ?? []
    : freqSource === 'vtx_info' ? (info ? chunk(info.freqTable, info.channels || 8) : [])
    : freqSource === 'file' ? fileTable?.table ?? []
    : manualGrid.split('\n').map((l) => l.trim().split(/[\s,;]+/).filter(Boolean).map(Number)).filter((b) => b.length);
  const flat = table.flat();
  const problems: string[] = [];
  if (flat.some((f) => !Number.isInteger(f))) problems.push('В сетке есть нечисловые значения');
  if (new Set(flat).size !== flat.length) problems.push('Повторяющиеся частоты');
  if (table.length > 1 && table.some((b) => b.length !== table[0]!.length)) problems.push('Во всех бэндах должно быть одинаковое число каналов');
  if (range && flat.length) problems.push(...validateFreqTable(flat, [range.minMhz, range.maxMhz]));

  async function uploadFile(f: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await apiUpload<{ freqTable: number[][]; sha256: string; format: string; warnings: string[] }>('/vtx-frequency-file', fd);
      setFileTable({ table: r.freqTable, name: f.name, sha256: r.sha256 });
      r.warnings.forEach((w) => push(`Файл: ${w}`));
      push(`Файл ${f.name} (${r.format}): ${r.freqTable.length} band × ${r.freqTable[0]?.length ?? 0} ch, sha256 ${r.sha256.slice(0, 12)}…`);
    } catch (e) {
      push(`Файл не разобран: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function buildPairs() {
    const out: VtxPair[] = [];
    table.forEach((band, b) => band.forEach((f, c) => { if (out.length < 16) out.push({ band: b + 1, channel: c + 1, freqMhz: f, rcChannel, rcLevel: 1000 + out.length * 66 }); }));
    setPairs(out);
    setStep(2);
  }

  async function write() {
    if (!fc.client || !writeAllowed.ok) return;
    setBusy(true);
    try {
      const client = await fc.ensureLink();
      push('MSP2 0x2F11 VTX_MAP_WRITE…');
      await client.vtxMapWrite(pairs);
      push('MSP_EEPROM_WRITE…');
      await client.eepromWrite();
      const back = await client.vtxMapRead();
      const same = back.length === pairs.length && back.every((p, i) => p.band === pairs[i]!.band && p.channel === pairs[i]!.channel && p.freqMhz === pairs[i]!.freqMhz && p.rcChannel === pairs[i]!.rcChannel && p.rcLevel === pairs[i]!.rcLevel);
      push(`Проверка чтением: ${back.length} пар, ${same ? 'совпадает' : 'НЕ совпадает с записанным'}`);
      if (!same) throw new Error('прочитанная карта отличается от записанной');
      await api('/vtx-sync-log', { method: 'POST', json: { direction: 'to_fc', payload: { pairs, uid: fc.info?.uid, target: fc.info?.target, freqSource }, ok: true } });
      notify('Карта VTX записана');
      finish(true);
    } catch (e) {
      const msg = (e as Error).message;
      push(`Ошибка записи: ${msg}`);
      if (/unsupported|not supported|0x2f/i.test(msg)) push('Прошивка FC не поддерживает MSP2 0x2F11 — нужна проектная прошивка INAV 7 с VTX map (шаг «Прошивка»).');
      await api('/vtx-sync-log', { method: 'POST', json: { direction: 'to_fc', payload: { error: msg }, ok: false } }).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function finish(written: boolean) {
    setStep(3);
    onDone?.({ modelId, modelName: model?.name ?? info?.name ?? null, rangeId, freqSource, freqTable: table, pairs, writtenToFc: written });
  }

  const submitState = { info, rangeId, rawLog: rawLog.current, freqSource, freqTable: table, fcTarget: fc.info?.target, fcVersion: fc.info?.version };

  return (
    <>
      <Steps n={4} current={step} />
      {step === 0 && (
        <Card title="Определение VTX">
          <Tip>Подключите VTX к UART борта (TX↔RX, GND) и включите питание. Читаем MSP_VTX_CONFIG и CLI <span className="kbd">vtx_info</span> — ничего не записываем. Сырой обмен сохраняется как доказательство для добавления VTX в базу.</Tip>
          <div className="row" style={{ marginTop: 10 }}><button disabled={busy} onClick={() => void detect()}>Определить</button></div>
        </Card>
      )}
      {step === 1 && (
        <Card title="Диапазон, модель и сетка частот">
          {vtxCfg && <p>Текущий VTX: тип {vtxCfg.deviceType}, band {vtxCfg.band}, ch {vtxCfg.channel}, {vtxCfg.freqMhz} МГц</p>}
          <label>Диапазон</label>
          <select value={rangeId ?? ''} onChange={(e) => setRangeId(e.target.value || null)}>
            <option value="">—</option>
            {ranges.data?.ranges.map((r) => <option key={r.id} value={r.id} disabled={r.status === 'coming_soon'}>{r.name} {r.status !== 'active' ? `(${r.status === 'in_dev' ? 'в разработке' : 'скоро'})` : ''}</option>)}
          </select>
          <label>Источник сетки частот</label>
          <select value={freqSource} onChange={(e) => setFreqSource(e.target.value as FreqSource)}>
            <option value="catalog">Модель из базы</option>
            <option value="vtx_info" disabled={!info?.freqTable.length}>Прочитано с VTX (vtx_info)</option>
            <option value="manual">Ввести вручную</option>
            <option value="file">Файл (CSV/TXT/JSON/vtxtable)</option>
          </select>
          {freqSource === 'catalog' && (
            <>
              <label>Модель VTX</label>
              <select value={modelId ?? ''} onChange={(e) => setModelId(e.target.value || null)}>
                <option value="">—</option>
                {models.data?.models.filter((m) => !rangeId || m.rangeId === rangeId).map((m) => <option key={m.id} value={m.id}>{m.name} {m.flagged ? '⚠' : ''}</option>)}
              </select>
              {modelId && <VtxPhotos modelId={modelId} />}
            </>
          )}
          {freqSource === 'manual' && (
            <>
              <Tip>Одна строка — один band, частоты в МГц через пробел (из документации или наклейки VTX).</Tip>
              <textarea className="code" value={manualGrid} onChange={(e) => setManualGrid(e.target.value)} placeholder={'3300 3310 3320 3330 3340 3350 3360 3370\n3380 3390 …'} />
            </>
          )}
          {freqSource === 'file' && (
            <>
              <input type="file" accept=".csv,.txt,.json,.tsv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); }} />
              {fileTable && <p className="muted">{fileTable.name} · sha256 {fileTable.sha256.slice(0, 16)}…</p>}
            </>
          )}
          {table.length > 0 && <div className="log" style={{ marginTop: 8 }}>{table.map((b, i) => `${String.fromCharCode(65 + i)}: ${b.join(' ')}`).join('\n')}</div>}
          {problems.map((w, i) => <p key={i} className="warn">{w}</p>)}
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={buildPairs} disabled={!rangeId || !table.length || problems.length > 0}>Далее</button>
            {freqSource !== 'catalog' && table.length > 0 && <Link className="btn secondary" to="/submit" state={submitState}>Отправить VTX в базу</Link>}
          </div>
        </Card>
      )}
      {step === 2 && (
        <Card title="Пары канал ↔ частота">
          <Tip>Каждой частоте назначается уровень RC-канала пульта (VtxAuto). Пульт ставит уровень на канале, FC по карте выставляет band/ch на VTX. До 16 пар; уровни должны отличаться минимум на 50 мкс.</Tip>
          <label>RC-канал для VTX AUTO</label>
          <input type="number" min={5} max={16} value={rcChannel} onChange={(e) => { const v = +e.target.value; setRcChannel(v); setPairs(pairs.map((p) => ({ ...p, rcChannel: v }))); }} />
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>#</th><th>Band/Ch</th><th>МГц</th><th>Уровень, мкс</th><th></th></tr></thead>
            <tbody>
              {pairs.map((p, i) => (
                <tr key={i}>
                  <td>{i + 1}</td><td>{String.fromCharCode(64 + p.band)}{p.channel}</td>
                  <td>{p.freqMhz}</td>
                  <td><input type="number" min={900} max={2100} value={p.rcLevel} onChange={(e) => setPairs(pairs.map((x, j) => j === i ? { ...x, rcLevel: +e.target.value } : x))} /></td>
                  <td><button className="secondary" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {pairLevelProblem(pairs) && <p className="warn">{pairLevelProblem(pairs)}</p>}
          {!writeAllowed.ok && <p className="err">{writeAllowed.why}</p>}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="secondary" onClick={() => setStep(1)}>Назад</button>
            <button disabled={busy || !pairs.length || !writeAllowed.ok || Boolean(pairLevelProblem(pairs))} onClick={() => void write()}>Записать в FC</button>
            <button className="secondary" onClick={() => void api('/vtx-profiles', { method: 'POST', json: { name: `${fc.info?.target ?? 'FC'} ${new Date().toLocaleDateString()}`, vtxModelId: modelId, pairs } }).then(() => notify('Профиль сохранён'))}>Сохранить профиль</button>
            {onDone && <button className="secondary" disabled={!pairs.length} onClick={() => finish(false)}>Не записывать, идти дальше</button>}
          </div>
        </Card>
      )}
      {step === 3 && (
        <Card title="VTX готов">
          <p className="ok">Пары зафиксированы{onDone ? ' — переходите к пульту.' : '. Синхронизируйте пульт: «Кабинет → Устройства» и меню VTX AUTO.'}</p>
          {!onDone && <div className="row"><button className="secondary" onClick={() => { setStep(0); setLog([]); }}>Ещё один борт</button><Link className="btn" to="/account/devices">К устройствам</Link></div>}
        </Card>
      )}
      <Card title="Журнал"><div className="log">{log.join('\n') || 'пусто'}</div></Card>
    </>
  );
}

function pairLevelProblem(pairs: VtxPair[]): string | null {
  const lv = [...pairs].map((p) => p.rcLevel).sort((a, b) => a - b);
  for (let i = 1; i < lv.length; i++) if (lv[i]! - lv[i - 1]! < 50) return `Уровни ${lv[i - 1]} и ${lv[i]} мкс слишком близки (<50) — пульт не сможет их надёжно различить`;
  const freqs = pairs.map((p) => p.freqMhz);
  if (new Set(freqs).size !== freqs.length) return 'Одна частота встречается в двух парах';
  return null;
}

function VtxPhotos({ modelId }: { modelId: string }) {
  const photos = useAsync(() => api<{ photos: Array<{ id: string; caption: string | null }> }>(`/vtx-photos?vtxModelId=${modelId}`), [modelId]);
  const { notify } = useStore();
  const [busy, setBusy] = useState(false);
  async function upload(f: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('vtxModelId', modelId);
      fd.append('file', f);
      await apiUpload('/vtx-photos', fd);
      notify('Фото загружено');
      await photos.reload();
    } catch (e) {
      notify(`Фото не загружено: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {photos.data?.photos.map((p) => <img key={p.id} src={apiUrl(`/vtx-photos/${p.id}/image`)} alt={p.caption ?? 'VTX'} title={p.caption ?? ''} style={{ height: 72, borderRadius: 8 }} />)}
        {photos.data && photos.data.photos.length === 0 && <span className="muted">Фото этой модели пока нет.</span>}
      </div>
      <label className="muted">Своё фото VTX (jpeg/png/webp) — для визуальной идентификации</label>
      <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
    </div>
  );
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

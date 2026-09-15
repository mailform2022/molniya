import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { VtxInfo } from '@vtx/msp';
import { Card, Steps, Tip, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { useFc } from '../lib/fc';
import { useStore } from '../lib/store';

/** CrowdSourceWizard (VTX) + BoardSubmissionWizard. */
export function SubmitPage() {
  const loc = useLocation();
  const pre = (loc.state as SubmitPrefill | null) ?? {};
  const [tab, setTab] = useState<'vtx' | 'board'>('vtx');
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={tab === 'vtx' ? '' : 'secondary'} onClick={() => setTab('vtx')}>Новый VTX</button>
        <button className={tab === 'board' ? '' : 'secondary'} onClick={() => setTab('board')}>Новый борт</button>
      </div>
      {tab === 'vtx' ? <VtxSubmit pre={pre} /> : <BoardSubmit />}
    </>
  );
}

/** Prefill passed from the VTX flow: parsed vtx_info, raw MSP/CLI exchange and the grid the user ended up with. */
interface SubmitPrefill {
  info?: VtxInfo | null;
  rangeId?: string | null;
  rawLog?: Array<{ t: number; dir: 'tx' | 'rx' | 'info'; text: string }>;
  freqSource?: 'catalog' | 'vtx_info' | 'manual' | 'file';
  freqTable?: number[][];
  fcTarget?: string;
  fcVersion?: string;
}

function VtxSubmit({ pre }: { pre: SubmitPrefill }) {
  const info = pre.info ?? undefined;
  const preRange = pre.rangeId ?? undefined;
  const { notify } = useStore();
  const ranges = useAsync(() => api<{ ranges: Array<{ id: string; name: string }> }>('/frequency-ranges'));
  const [step, setStep] = useState(0);
  const [name, setName] = useState(info?.name ?? '');
  const [manufacturer, setManufacturer] = useState('');
  const [rangeId, setRangeId] = useState(preRange ?? '');
  const [protocol, setProtocol] = useState(info?.protocol ?? 'smartaudio');
  const [grid, setGrid] = useState(pre.freqTable?.length ? pre.freqTable.map((b) => b.join(' ')).join('\n') : info ? chunk(info.freqTable, info.channels || 8).map((b) => b.join(' ')).join('\n') : '');
  const [done, setDone] = useState(false);
  const table = grid.split('\n').map((l) => l.trim().split(/[\s,]+/).filter(Boolean).map(Number)).filter((b) => b.length);
  const flat = table.flat();
  const dup = new Set(flat).size !== flat.length;

  async function send() {
    await api('/vtx-submissions', {
      method: 'POST',
      json: {
        name, manufacturer: manufacturer || undefined, rangeId: rangeId || undefined, protocol, freqTable: table,
        cliStatusHex: info?.rawStatus.map((b) => b.toString(16).padStart(2, '0')).join('') || undefined, parsedStatus: info ?? undefined,
        rawLog: pre.rawLog ?? [], freqSource: pre.freqSource ?? 'manual', fcTarget: pre.fcTarget, fcVersion: pre.fcVersion
      }
    });
    setDone(true);
    notify('Отправлено на модерацию');
  }
  if (done) return <Card title="Спасибо!"><p className="ok">Заявка отправлена. После проверки модератором VTX появится в базе, а вам придёт уведомление.</p></Card>;
  return (
    <>
      <Steps n={3} current={step} />
      {step === 0 && <Card title="1. Модель">
        <Tip>Данные из AutoDetect уже подставлены, если вы пришли из мастера{pre.rawLog?.length ? ` (сырой обмен: ${pre.rawLog.length} записей — уйдёт модератору как доказательство)` : ''}. Иначе заполните вручную по наклейке/документации.</Tip>
        <label>Название</label><input value={name} onChange={(e) => setName(e.target.value)} />
        <label>Производитель</label><input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
        <label>Диапазон</label><select value={rangeId} onChange={(e) => setRangeId(e.target.value)}><option value="">—</option>{ranges.data?.ranges.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <label>Протокол</label><select value={protocol} onChange={(e) => setProtocol(e.target.value)}><option value="smartaudio">SmartAudio</option><option value="tramp">Tramp</option><option value="msp">MSP</option></select>
        <button style={{ marginTop: 10 }} disabled={name.length < 2} onClick={() => setStep(1)}>Далее</button>
      </Card>}
      {step === 1 && <Card title="2. Сетка частот">
        <Tip>Одна строка — один band, частоты в МГц через пробел. Дубликаты не допускаются.</Tip>
        <textarea className="code" value={grid} onChange={(e) => setGrid(e.target.value)} placeholder={'3300 3310 3320 3330 3340 3350 3360 3370\n3380 3390 …'} />
        {dup && <p className="err">В сетке есть повторяющиеся частоты</p>}
        <div className="row" style={{ marginTop: 10 }}><button className="secondary" onClick={() => setStep(0)}>Назад</button><button disabled={!table.length || dup} onClick={() => setStep(2)}>Далее</button></div>
      </Card>}
      {step === 2 && <Card title="3. Проверка">
        <p><b>{name}</b> {manufacturer && `(${manufacturer})`} · {protocol} · {table.length} band × {Math.max(...table.map((b) => b.length))} ch · {flat.length} частот ({Math.min(...flat)}–{Math.max(...flat)} МГц)</p>
        <div className="row" style={{ marginTop: 10 }}><button className="secondary" onClick={() => setStep(1)}>Назад</button><button onClick={() => void send()}>Отправить на модерацию</button></div>
      </Card>}
    </>
  );
}

function BoardSubmit() {
  const fc = useFc();
  const { notify } = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [total, setTotal] = useState(12);
  const [pins, setPins] = useState<Array<{ pin: string; x: number; y: number; role: string; rcChannel?: number; signal?: 'pwm' | 'digital' | 'servo' }>>([]);
  const [done, setDone] = useState(false);
  function gen() {
    setPins(Array.from({ length: total }, (_, i) => ({ pin: `S${i + 1}`, x: 0.12 + (i % 6) * 0.15, y: i < 6 ? 0.25 : 0.75, role: 'Резерв' })));
    setStep(1);
  }
  async function send() {
    await api('/board-submissions', { method: 'POST', json: { name, fcTarget: fc.info?.target, detected: fc.info ?? undefined, totalPins: total, pins } });
    setDone(true);
    notify('Заявка на новый борт отправлена');
  }
  if (done) return <Card title="Спасибо!"><p className="ok">Заявка на борт отправлена модератору.</p></Card>;
  return (
    <>
      <Steps n={3} current={step} />
      {step === 0 && <Card title="1. Борт">
        <Tip>Подключите борт — определим target и версию автоматически. Затем укажите число выходов.</Tip>
        <p>{fc.info ? <span className="badge ok">{fc.info.target} INAV {fc.info.version}</span> : <button className="secondary" onClick={() => fc.connect().catch(() => undefined)}>Подключить</button>}</p>
        <label>Название</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Утка v2" />
        <label>Число выходов (S1…Sn)</label><input type="number" min={1} max={64} value={total} onChange={(e) => setTotal(+e.target.value)} />
        <button style={{ marginTop: 10 }} disabled={name.length < 2} onClick={gen}>Далее</button>
      </Card>}
      {step === 1 && <Card title="2. Назначение пинов">
        <div className="pins">{pins.map((p) => <div key={p.pin} className="pin" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} title={p.role}>{p.pin}</div>)}</div>
        <table style={{ marginTop: 10 }}><tbody>{pins.map((p, i) => (
          <tr key={p.pin}><td>{p.pin}</td>
            <td><input value={p.role} onChange={(e) => setPins(pins.map((x, j) => j === i ? { ...x, role: e.target.value } : x))} /></td>
            <td><input type="number" placeholder="RC" style={{ width: 70 }} value={p.rcChannel ?? ''} onChange={(e) => setPins(pins.map((x, j) => j === i ? { ...x, rcChannel: e.target.value ? +e.target.value : undefined } : x))} /></td>
            <td><select value={p.signal ?? ''} onChange={(e) => setPins(pins.map((x, j) => j === i ? { ...x, signal: (e.target.value || undefined) as typeof p.signal } : x))}><option value="">—</option><option value="servo">servo</option><option value="pwm">pwm</option><option value="digital">digital</option></select></td>
          </tr>))}</tbody></table>
        <div className="row" style={{ marginTop: 10 }}><button className="secondary" onClick={() => setStep(0)}>Назад</button><button onClick={() => setStep(2)}>Далее</button></div>
      </Card>}
      {step === 2 && <Card title="3. Отправка">
        <p><b>{name}</b> · {fc.info?.target ?? 'target не определён'} · {total} выходов · назначено {pins.filter((p) => p.role !== 'Резерв').length}</p>
        <div className="row" style={{ marginTop: 10 }}><button className="secondary" onClick={() => setStep(1)}>Назад</button><button onClick={() => void send()}>Отправить</button></div>
      </Card>}
    </>
  );
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { VtxPair } from '@vtx/msp';
import { Card, Tip, useAsync } from '../components/ui';
import { api, apiDownload, ApiError } from '../lib/api';
import { useFc } from '../lib/fc';
import { useStore } from '../lib/store';
import { useWizard } from '../lib/wizard';

interface TxModel { id: string; code: string; name: string; platform: string; firmwareTarget: string | null; display: string | null }
interface VtxProfile { id: string; name: string; pairs: VtxPair[]; vtxModelId: string | null }
interface VtxModel { id: string; name: string; manufacturer: string | null; bands: number; channels: number; freqTable: number[][] }
interface Firmware { id: string; kind: string; target: string; version: string; fileName: string; sha256: string; sizeBytes: number; verification: string }

type PairSource = 'wizard' | 'profile' | 'vtx_model' | 'manual';

/** Radio section is independent from the board: lives here, embedded into /wizard as step 6. */
export function TransmitterPage() {
  return (
    <>
      <Tip>Пульт настраивается сам по себе: модель, пары «band/канал → уровень RC-канала», YAML для EdgeTX и прошивка VtxAuto v3.1. Борт не нужен. Если борт подключён — можно по кнопке записать в него ту же карту, чтобы пульт и FC совпали; делать это или нет — решаете вы.</Tip>
      <TransmitterPanel />
    </>
  );
}

export function TransmitterPanel({ embedded = false, onNext }: { embedded?: boolean; onNext?: () => void }) {
  const w = useWizard();
  const fc = useFc();
  const { notify, access, user, refreshAccess } = useStore();
  const models = useAsync(() => api<{ transmitters: TxModel[] }>('/models'));
  const profiles = useAsync(() => api<{ profiles: VtxProfile[] }>('/vtx-profiles'));
  const vtxModels = useAsync(() => api<{ models: VtxModel[] }>('/vtx-models'));
  const fw = useAsync(() => api<{ firmware: Firmware[] }>(`/firmware?kind=transmitter&target=${encodeURIComponent(w.tx.code)}`), [w.tx.code]);
  const wizardPairs = w.vtx?.pairs ?? [];
  const [source, setSource] = useState<PairSource>(wizardPairs.length ? 'wizard' : w.tx.profileId ? 'profile' : 'vtx_model');
  const [vtxModelId, setVtxModelId] = useState<string>(w.vtx?.modelId ?? '');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rcChannel, setRcChannel] = useState(w.tx.rcChannel);
  const [manualPairs, setManualPairs] = useState<VtxPair[]>([]);
  const [txUid, setTxUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [yaml, setYaml] = useState<{ text: string; sha256: string } | null>(null);
  const [fcLog, setFcLog] = useState<string[]>([]);
  const model = models.data?.transmitters.find((m) => m.code === w.tx.code);
  const vtxModel = vtxModels.data?.models.find((m) => m.id === vtxModelId) ?? null;
  const profile = profiles.data?.profiles.find((p) => p.id === w.tx.profileId) ?? null;

  const pairs: VtxPair[] = (() => {
    if (source === 'wizard') return wizardPairs;
    if (source === 'profile') return profile?.pairs ?? [];
    if (source === 'manual') return manualPairs;
    if (!vtxModel) return [];
    const out: VtxPair[] = [];
    vtxModel.freqTable.forEach((band, b) => band.forEach((f, c) => { if (picked.has(`${b + 1}:${c + 1}`) && out.length < 16) out.push({ band: b + 1, channel: c + 1, freqMhz: f, rcChannel, rcLevel: 0 }); }));
    // evenly spaced levels 1000..2000 so the radio's switch positions are unambiguous
    return out.map((p, i, a) => ({ ...p, rcLevel: a.length === 1 ? 1500 : Math.round(1000 + (i * 1000) / (a.length - 1)) }));
  })();
  const problem = pairProblem(pairs);

  useEffect(() => { setYaml(null); }, [pairs.length, source, vtxModelId, rcChannel]);

  async function makeYaml() {
    setBusy(true);
    try {
      const r = await api<{ yaml: string; sha256: string }>('/transmitter/yaml', { method: 'POST', json: { pairs, name: vtxModel?.name ?? w.vtx?.modelName ?? 'VTX' } });
      setYaml({ text: r.yaml, sha256: r.sha256 });
      w.patch({ tx: { ...w.tx, rcChannel: pairs[0]?.rcChannel ?? rcChannel } });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function downloadYaml() {
    if (!yaml) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([yaml.text], { type: 'text/yaml' }));
    a.download = `${w.tx.code.toUpperCase()}_VtxAuto_v3.1.yml`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function saveProfile() {
    setBusy(true);
    try {
      const r = await api<{ profile: VtxProfile }>('/vtx-profiles', { method: 'POST', json: { name: `${w.tx.name} · ${vtxModel?.name ?? w.vtx?.modelName ?? 'VTX'} · ${new Date().toLocaleDateString()}`, vtxModelId: vtxModel?.id ?? w.vtx?.modelId ?? undefined, pairs } });
      w.patch({ tx: { ...w.tx, profileId: r.profile.id } });
      profiles.reload();
      notify('Профиль пульта сохранён');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function registerTx() {
    setBusy(true);
    try {
      await api('/devices', { method: 'POST', json: { kind: 'transmitter', uid: txUid.trim().toLowerCase(), name: w.tx.name, modelId: model?.id } });
      await refreshAccess();
      notify('Пульт зарегистрирован — VTX AUTO активен на нём по тарифу');
    } catch (e) {
      notify(e instanceof ApiError && e.body.error === 'device_limit_reached' ? `Лимит пультов по тарифу (${access?.device_limit ?? 1}) исчерпан — докупите «+1 пульт» в кабинете` : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** Optional: push the same pairs into the connected FC so radio and board agree. Never automatic. */
  async function syncToFc() {
    setBusy(true);
    setFcLog([]);
    const push = (s: string) => setFcLog((l) => [...l, s]);
    try {
      const client = await fc.ensureLink();
      push('MSP2 0x2F11 VTX_MAP_WRITE…');
      await client.vtxMapWrite(pairs);
      await client.eepromWrite();
      const back = await client.vtxMapRead();
      const same = back.length === pairs.length && back.every((p, i) => p.band === pairs[i]!.band && p.channel === pairs[i]!.channel && p.freqMhz === pairs[i]!.freqMhz && p.rcChannel === pairs[i]!.rcChannel && p.rcLevel === pairs[i]!.rcLevel);
      push(`Проверка чтением: ${back.length} пар, ${same ? 'совпадает' : 'НЕ совпадает'}`);
      if (!same) throw new Error('прочитанная карта отличается от записанной');
      w.patch({ vtx: { modelId: vtxModel?.id ?? w.vtx?.modelId ?? null, modelName: vtxModel?.name ?? w.vtx?.modelName ?? null, rangeId: w.vtx?.rangeId ?? null, freqSource: w.vtx?.freqSource ?? 'catalog', freqTable: vtxModel?.freqTable ?? w.vtx?.freqTable ?? [], pairs, writtenToFc: true } });
      await api('/vtx-sync-log', { method: 'POST', json: { direction: 'to_fc', payload: { pairs, uid: fc.info?.uid, target: fc.info?.target, from: 'transmitter' }, ok: true } });
      notify('Карта VTX записана в борт');
    } catch (e) {
      const msg = (e as Error).message;
      push(`Ошибка: ${msg}`);
      if (/unsupported|not supported|0x2f/i.test(msg)) push('Прошивка борта не поддерживает MSP2 0x2F11 — нужна проектная прошивка INAV 7 с VTX map (раздел «Борт → Прошивка»).');
    } finally {
      setBusy(false);
    }
  }

  const txBin = fw.data?.firmware[0] ?? null;
  const fcWriteGate = !fc.info ? 'борт не подключён' : w.trust && w.trust !== 'verified' && !w.snapshot ? 'борт не проверен, снимка нет — запись запрещена (раздел «Борт → Снимок»)' : null;

  return (
    <Card title={embedded ? '6. Пульт: те же пары band/канал' : 'Пульт'}>
      {embedded && <Tip>Пульт (EdgeTX + VTX AUTO v3.1) хранит в модели список пар «band/канал → уровень RC-канала». FC по своей карте ставит частоту по тому же уровню. По умолчанию пары берутся из шага VTX — они обязаны совпадать, иначе пульт и борт «разъедутся».</Tip>}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div>
          <label>Модель пульта</label>
          <select value={w.tx.code} onChange={(e) => { const m = models.data?.transmitters.find((x) => x.code === e.target.value); if (m) w.patch({ tx: { ...w.tx, code: m.code, name: m.name } }); }}>
            {models.data?.transmitters.map((m) => <option key={m.code} value={m.code}>{m.name}{m.code === 'tx12mk2' ? ' (по умолчанию)' : ''}</option>)}
          </select>
          {model && <p className="muted" style={{ fontSize: 12 }}>{model.platform}{model.display ? ` · экран ${model.display}` : ''}{model.firmwareTarget ? ` · target ${model.firmwareTarget}` : ''}</p>}

          <label>Откуда пары band/канал</label>
          <select value={source} onChange={(e) => setSource(e.target.value as PairSource)}>
            <option value="wizard" disabled={!wizardPairs.length}>Из шага VTX мастера{wizardPairs.length ? ` (${wizardPairs.length} пар)` : ' — нет'}</option>
            <option value="profile">Сохранённый профиль</option>
            <option value="vtx_model">Выбрать из сетки VTX в базе</option>
            <option value="manual">Ввести вручную</option>
          </select>
          {source === 'profile' && (
            <select value={w.tx.profileId ?? ''} onChange={(e) => w.patch({ tx: { ...w.tx, profileId: e.target.value || null } })}>
              <option value="">— выберите профиль</option>
              {profiles.data?.profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.pairs.length} пар)</option>)}
            </select>
          )}
          {source === 'vtx_model' && (
            <>
              <select value={vtxModelId} onChange={(e) => { setVtxModelId(e.target.value); setPicked(new Set()); }}>
                <option value="">— VTX из базы</option>
                {vtxModels.data?.models.map((m) => <option key={m.id} value={m.id}>{m.manufacturer ? `${m.manufacturer} ` : ''}{m.name} ({m.bands}×{m.channels})</option>)}
              </select>
              {vtxModel && (
                <div style={{ overflowX: 'auto', marginTop: 6 }}>
                  <table style={{ fontSize: 12 }}>
                    <tbody>
                      {vtxModel.freqTable.map((band, b) => (
                        <tr key={b}><th>{String.fromCharCode(65 + b)}</th>{band.map((f, c) => { const k = `${b + 1}:${c + 1}`; const on = picked.has(k); return <td key={c}><button className={on ? '' : 'secondary'} style={{ padding: '2px 6px', fontSize: 11 }} disabled={!on && picked.size >= 16} onClick={() => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>{f}</button></td>; })}</tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted" style={{ fontSize: 12 }}>Отметьте до 16 частот — уровни RC-канала распределятся равномерно 1000…2000 мкс.</p>
                </div>
              )}
            </>
          )}
          {source === 'manual' && <ManualPairs pairs={manualPairs} rcChannel={rcChannel} onChange={setManualPairs} />}
          <label>RC-канал VTX AUTO на пульте</label>
          <input type="number" min={5} max={16} value={source === 'wizard' || source === 'profile' ? (pairs[0]?.rcChannel ?? rcChannel) : rcChannel} readOnly={source === 'wizard' || source === 'profile'} onChange={(e) => { const v = +e.target.value; setRcChannel(v); setManualPairs((m) => m.map((p) => ({ ...p, rcChannel: v }))); }} />
        </div>
        <div>
          <TxScreen model={w.tx.code} pairs={pairs} />
          {pairs.length > 0 && (
            <table style={{ fontSize: 12, marginTop: 8 }}>
              <thead><tr><th>#</th><th>Band</th><th>CH</th><th>МГц</th><th>RC</th><th>мкс</th></tr></thead>
              <tbody>{pairs.map((p, i) => <tr key={i}><td>{i + 1}</td><td>{String.fromCharCode(64 + p.band)}</td><td>{p.channel}</td><td>{p.freqMhz}</td><td>{p.rcChannel}</td><td>{p.rcLevel}</td></tr>)}</tbody>
            </table>
          )}
          {problem && <p className="warn">{problem}</p>}
        </div>
      </div>

      <h4 style={{ marginTop: 14 }}>Артефакты пульта</h4>
      <div className="row">
        <button disabled={busy || !pairs.length || Boolean(problem)} onClick={() => void makeYaml()}>Сформировать YAML модели</button>
        <button className="secondary" disabled={!yaml} onClick={downloadYaml}>Скачать {w.tx.code.toUpperCase()}_VtxAuto_v3.1.yml</button>
        <button className="secondary" disabled={busy || !pairs.length || Boolean(problem) || !user} onClick={() => void saveProfile()}>Сохранить профиль</button>
      </div>
      {yaml && <details style={{ marginTop: 6 }}><summary>YAML · sha256 {yaml.sha256.slice(0, 16)}…</summary><pre className="log">{yaml.text}</pre></details>}
      <p style={{ marginTop: 8 }}>
        Прошивка пульта: {fw.loading ? <span className="muted">загрузка…</span> : txBin ? (
          <>{txBin.fileName} · v{txBin.version} <span className={`badge ${txBin.verification === 'flight_tested' ? 'ok' : 'warn'}`}>{txBin.verification}</span> <button className="secondary" onClick={() => apiDownload(`/firmware/${txBin.id}/download`, txBin.fileName).catch((e: Error) => notify(e.message))}>Скачать</button> <span className="muted">sha256 {txBin.sha256.slice(0, 12)}…</span></>
        ) : (
          <span className="warn">{w.tx.code.toUpperCase()}_VtxAuto_v3.1 для этой модели ещё не опубликована{['tx16s', 'tx15'].includes(w.tx.code) ? ' — для цветных экранов VTX AUTO пока не портирован' : ''}</span>
        )}
      </p>
      <p className="muted" style={{ fontSize: 13 }}>YAML-фрагмент вставляется в MODELS/modelNN.yml на SD пульта или вводится в меню VTX AUTO. Скачивание прошивки пульта — по активному тарифу.</p>

      <details style={{ marginTop: 10 }}>
        <summary>Зарегистрировать пульт по UID (тариф: {access?.devices_used ?? 0}/{access?.device_limit ?? 1} пультов)</summary>
        <p className="muted">UID показан на пульте: меню VTX AUTO → Info. Без регистрации VTX AUTO на пульте не активируется; дополнительные пульты докупаются отдельно в кабинете.</p>
        <input value={txUid} onChange={(e) => setTxUid(e.target.value)} placeholder="24 hex" />
        <button disabled={busy || !/^[0-9a-fA-F]{8,64}$/.test(txUid.trim())} onClick={() => void registerTx()}>Зарегистрировать</button>
      </details>

      <details style={{ marginTop: 10 }}>
        <summary>Синхронизировать с бортом (по желанию){fc.info ? ` — подключён ${fc.info.target}` : ' — борт не подключён'}</summary>
        <p className="muted">Записывает те же пары в карту VTX борта (MSP2 0x2F11) с проверкой чтением. Без этого борт останется на своей карте, а пульт — на своей.</p>
        {fcWriteGate && <p className="warn">{fcWriteGate}</p>}
        <button disabled={busy || !pairs.length || Boolean(problem) || Boolean(fcWriteGate)} onClick={() => void syncToFc()}>Записать карту в борт</button>
        {fcLog.length > 0 && <div className="log" style={{ marginTop: 6 }}>{fcLog.join('\n')}</div>}
      </details>

      <div className="row" style={{ marginTop: 12 }}>
        {embedded && onNext && <button disabled={!pairs.length || Boolean(problem)} onClick={() => { w.patch({ tx: { ...w.tx, rcChannel: pairs[0]?.rcChannel ?? rcChannel }, vtx: w.vtx ? { ...w.vtx, pairs } : { modelId: vtxModel?.id ?? null, modelName: vtxModel?.name ?? null, rangeId: null, freqSource: 'catalog', freqTable: vtxModel?.freqTable ?? [], pairs, writtenToFc: false } }); onNext(); }}>Далее: артефакты →</button>}
        {!embedded && <Link className="btn secondary" to="/account/devices">Мои пульты в кабинете</Link>}
        {!embedded && <Link className="btn secondary" to="/emulators">Эмулятор пульта</Link>}
      </div>
    </Card>
  );
}

function ManualPairs({ pairs, rcChannel, onChange }: { pairs: VtxPair[]; rcChannel: number; onChange: (p: VtxPair[]) => void }) {
  const upd = (i: number, k: keyof VtxPair, v: number) => onChange(pairs.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <div style={{ marginTop: 6 }}>
      <table style={{ fontSize: 12 }}>
        <thead><tr><th>Band</th><th>CH</th><th>МГц</th><th>мкс</th><th /></tr></thead>
        <tbody>
          {pairs.map((p, i) => (
            <tr key={i}>
              <td><input type="number" min={1} max={8} value={p.band} onChange={(e) => upd(i, 'band', +e.target.value)} style={{ width: 50 }} /></td>
              <td><input type="number" min={1} max={8} value={p.channel} onChange={(e) => upd(i, 'channel', +e.target.value)} style={{ width: 50 }} /></td>
              <td><input type="number" min={1000} max={6000} value={p.freqMhz} onChange={(e) => upd(i, 'freqMhz', +e.target.value)} style={{ width: 70 }} /></td>
              <td><input type="number" min={900} max={2100} value={p.rcLevel} onChange={(e) => upd(i, 'rcLevel', +e.target.value)} style={{ width: 70 }} /></td>
              <td><button className="secondary" style={{ fontSize: 11 }} onClick={() => onChange(pairs.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="secondary" style={{ fontSize: 12 }} disabled={pairs.length >= 16} onClick={() => onChange([...pairs, { band: 1, channel: pairs.length + 1, freqMhz: 5800, rcChannel, rcLevel: 1000 + pairs.length * 66 }])}>+ пара</button>
    </div>
  );
}

export function pairProblem(pairs: VtxPair[]): string | null {
  if (!pairs.length) return null;
  const lv = [...pairs].map((p) => p.rcLevel).sort((a, b) => a - b);
  for (let i = 1; i < lv.length; i++) if (lv[i]! - lv[i - 1]! < 50) return `Уровни ${lv[i - 1]} и ${lv[i]} мкс слишком близки (<50) — пульт не сможет их надёжно различить`;
  const freqs = pairs.map((p) => p.freqMhz);
  if (new Set(freqs).size !== freqs.length) return 'Одна частота встречается в двух парах';
  if (new Set(pairs.map((p) => `${p.band}:${p.channel}`)).size !== pairs.length) return 'Пара band/канал повторяется';
  if (new Set(pairs.map((p) => p.rcChannel)).size > 1) return 'Все пары должны использовать один RC-канал пульта';
  return null;
}

/** What the VTX AUTO menu will show on the radio for the given pairs (128x64 mono for TX12/Pocket/Boxer). */
export function TxScreen({ model, pairs }: { model: string; pairs: VtxPair[] }) {
  const mono = ['tx12', 'tx12mk2', 'pocket', 'boxer'].includes(model);
  return (
    <div className="log" style={{ maxWidth: mono ? 320 : 480, background: mono ? '#c7d6b0' : '#0b1020', color: mono ? '#101810' : '#e5e7eb' }}>
      {`VTX AUTO  ${model.toUpperCase()}  ${pairs.length ? `1/${pairs.length}` : '-'}\n`}
      {pairs.slice(0, 8).map((p, i) => `${i === 0 ? '>' : ' '}${String.fromCharCode(64 + p.band)}${p.channel}  ${p.freqMhz} MHz  CH${p.rcChannel} ${p.rcLevel}us`).join('\n') || 'нет пар'}
      {pairs.length > 8 && `\n… ещё ${pairs.length - 8}`}
    </div>
  );
}

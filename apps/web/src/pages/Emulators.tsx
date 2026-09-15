import { useEffect, useMemo, useState } from 'react';
import { EmulatedFc, MspClient, type VtxPair } from '@vtx/msp';
import { Card, Tip, useAsync } from '../components/ui';
import { api } from '../lib/api';

interface TxModel { code: string; name: string; display: string | null; channels: number }
interface VtxModel { id: string; name: string; manufacturer: string | null; protocol: string; bands: number; channels: number; freqTable: number[][] }

type Mode = 0 | 1; // Manual | Auto (vtxModeNames in the EdgeTX patch)
type Screen = 'vtx' | 'pairs';

const usToPercent = (us: number) => Math.max(-100, Math.min(100, Math.round((us - 1500) / 5.12)));
const bandLetter = (b: number) => String.fromCharCode(64 + b);

/**
 * Transmitter emulator: the VTX AUTO page of the EdgeTX patch (Enabled / Profile / Channel / Mode / Time / Chan sw /
 * Mode sw / Edit pairs) on the left; on the right the VTX picked from the catalog. Pairs are built from that VTX's own
 * grid and bound through the chosen RC channel; the emulated FC receives the level over MSP and resolves it back to a
 * band/channel, so the highlighted row on the radio and the frequency on the board are two independent views that must agree.
 */
export function EmulatorsPage() {
  const tx = useAsync(() => api<{ transmitters: TxModel[] }>('/models'));
  const vtxModels = useAsync(() => api<{ models: VtxModel[] }>('/vtx-models'));
  const [model, setModel] = useState('tx12mk2');
  const [screen, setScreen] = useState<Screen>('vtx');
  const [row, setRow] = useState(0);
  const [enabled, setEnabled] = useState(true);
  const [rcChannel, setRcChannel] = useState(12);
  const [mode, setMode] = useState<Mode>(0);
  const [fixedS, setFixedS] = useState(3);
  const [pairIdx, setPairIdx] = useState(0);
  const [vtxId, setVtxId] = useState<string | null>(null);
  const [blink, setBlink] = useState(false);
  const fc = useMemo(() => new EmulatedFc(), []);
  const client = useMemo(() => new MspClient(fc.transport), [fc]);
  const [boardVtx, setBoardVtx] = useState<{ band: number; channel: number; freqMhz: number; level: number } | null>(null);
  const [fcLog, setFcLog] = useState<string[]>([]);

  const vtx = vtxModels.data?.models.find((m) => m.id === vtxId) ?? vtxModels.data?.models[0] ?? null;
  const pairs: VtxPair[] = useMemo(() => {
    if (!vtx) return [];
    const out: VtxPair[] = [];
    vtx.freqTable.forEach((band, b) => band.forEach((f, c) => { if (out.length < 16) out.push({ band: b + 1, channel: c + 1, freqMhz: f, rcChannel, rcLevel: 1000 + out.length * 66 }); }));
    return out;
  }, [vtx, rcChannel]);

  useEffect(() => { void client.open(); return () => void client.close(); }, [client]);
  useEffect(() => {
    if (!pairs.length) return;
    void client.vtxMapWrite(pairs).then(() => { setPairIdx(0); return applyPair(pairs[0]!); });
  }, [pairs]);

  async function applyPair(p: VtxPair) {
    await client.vtxMapLive(p.rcChannel, p.rcLevel);
    // The board resolves the RC level to the nearest pair, like the firmware does; we read the map back and pick it.
    const map = await client.vtxMapRead();
    const hit = map.filter((m) => m.rcChannel === p.rcChannel).reduce((best, m) => (Math.abs(m.rcLevel - p.rcLevel) < Math.abs(best.rcLevel - p.rcLevel) ? m : best), map[0]!);
    setBoardVtx({ band: hit.band, channel: hit.channel, freqMhz: hit.freqMhz, level: p.rcLevel });
    setFcLog((l) => [...l.slice(-12), `CH${p.rcChannel} = ${p.rcLevel} мкс (${usToPercent(p.rcLevel)}%) → VTX ${bandLetter(hit.band)}${hit.channel} ${hit.freqMhz} МГц`]);
  }

  useEffect(() => {
    if (!enabled || mode !== 1 || pairs.length < 2) return;
    const t = setInterval(() => {
      setPairIdx((i) => { const n = (i + 1) % pairs.length; void applyPair(pairs[n]!); return n; });
    }, fixedS * 1000);
    const b = setInterval(() => setBlink((x) => !x), 400);
    return () => { clearInterval(t); clearInterval(b); };
  }, [enabled, mode, fixedS, pairs]);

  const rows = [
    { name: 'Enabled', value: enabled ? 'On' : 'Off', dec: () => setEnabled(false), inc: () => setEnabled(true) },
    { name: 'Profile', value: vtx?.name.slice(0, 10) ?? '---', dec: () => undefined, inc: () => undefined },
    { name: 'Channel', value: `CH${rcChannel}`, dec: () => setRcChannel((c) => Math.max(5, c - 1)), inc: () => setRcChannel((c) => Math.min(16, c + 1)) },
    { name: 'Mode', value: mode === 0 ? 'Manual' : 'Auto', dec: () => setMode(0), inc: () => setMode(1) },
    ...(mode === 1
      ? [
          { name: 'Time', value: 'Fixed', dec: () => undefined, inc: () => undefined },
          { name: 'Fixed s', value: String(fixedS), dec: () => setFixedS((s) => Math.max(1, s - 1)), inc: () => setFixedS((s) => Math.min(1800, s + 1)) }
        ]
      : [{ name: 'Manual type', value: 'Pair step', dec: () => undefined, inc: () => undefined }, { name: 'Pair sw', value: 'S1', dec: () => undefined, inc: () => undefined }]),
    { name: 'Mode sw', value: 'SB', dec: () => undefined, inc: () => undefined },
    { name: 'Edit pairs', value: String(pairs.length), dec: () => undefined, inc: () => undefined, enter: () => setScreen('pairs') }
  ];
  const sel = tx.data?.transmitters.find((t) => t.code === model);
  const active = pairs[pairIdx];
  const step = (d: -1 | 1) => {
    if (screen === 'pairs') { const n = Math.max(0, Math.min(pairs.length - 1, pairIdx + d)); setPairIdx(n); if (mode === 0 && enabled) void applyPair(pairs[n]!); return; }
    setRow((r) => Math.max(0, Math.min(rows.length - 1, r + d)));
  };

  return (
    <>
      <Tip>Слева — меню VTX AUTO пульта, как после прошивки (EdgeTX, патч VtxAuto). Справа — VTX из каталога: его сетка даёт пары, пары привязываются к уровням выбранного канала. В Manual выбранная пара выделена и борт должен показать ту же частоту; в Auto пары перемигиваются раз в «Fixed s».</Tip>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 12 }}>
        <Card title="Пульт" right={<select style={{ width: 'auto' }} value={model} onChange={(e) => setModel(e.target.value)}>{tx.data?.transmitters.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select>}>
          <div className="tx-screen mono" style={{ fontSize: 13, lineHeight: 1.35 }}>
            {screen === 'vtx' && (
              <>
                <div style={{ textDecoration: 'underline' }}>VTX AUTO{'  '}{sel?.name ?? ''}</div>
                {rows.map((r, i) => (
                  <div key={r.name} onClick={() => setRow(i)} style={{ display: 'flex', justifyContent: 'space-between', background: i === row ? '#cfe' : undefined, color: i === row ? '#051' : undefined, cursor: 'pointer' }}>
                    <span>{r.name}</span><span>{r.value}{'enter' in r ? ' >' : ''}</span>
                  </div>
                ))}
              </>
            )}
            {screen === 'pairs' && (
              <>
                <div style={{ textDecoration: 'underline' }}>Pairs {pairIdx + 1}/{pairs.length}{mode === 1 ? (blink ? ' ●' : ' ○') : ''}</div>
                {pairs.slice(Math.max(0, Math.min(pairIdx - 3, pairs.length - 7)), Math.max(7, pairIdx + 4)).map((p) => {
                  const on = p === active && (mode === 0 || blink);
                  return (
                    <div key={`${p.band}-${p.channel}`} onClick={() => { const i = pairs.indexOf(p); setPairIdx(i); if (mode === 0) void applyPair(p); }} style={{ display: 'flex', justifyContent: 'space-between', background: on ? '#cfe' : undefined, color: on ? '#051' : undefined, cursor: 'pointer' }}>
                      <span>{bandLetter(p.band)}{p.channel} {p.freqMhz}</span><span>CH{p.rcChannel} {usToPercent(p.rcLevel)}%</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="secondary" onClick={() => step(-1)}>▲</button>
            <button className="secondary" onClick={() => step(1)}>▼</button>
            <button className="secondary" disabled={screen !== 'vtx'} onClick={() => rows[row]?.dec()}>−</button>
            <button className="secondary" disabled={screen !== 'vtx'} onClick={() => rows[row]?.inc()}>+</button>
            <button onClick={() => { const r = rows[row]; if (screen === 'vtx' && r && 'enter' in r) r.enter?.(); }}>ENTER</button>
            <button className="secondary" onClick={() => setScreen('vtx')}>EXIT</button>
          </div>
          {active && <p className="muted" style={{ fontSize: 13 }}>Эфир: CH{active.rcChannel} = {active.rcLevel} мкс ({usToPercent(active.rcLevel)}%) · {mode === 0 ? 'Manual — пара выбрана вручную' : `Auto — смена каждые ${fixedS} с`}</p>}
        </Card>
        <Card title="Видеопередатчик" right={<select style={{ width: 'auto' }} value={vtx?.id ?? ''} onChange={(e) => setVtxId(e.target.value || null)}>{vtxModels.data?.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}>
          {vtx ? (
            <>
              <p className="muted" style={{ fontSize: 13 }}>{vtx.manufacturer ?? ''} {vtx.name} · {vtx.protocol} · {vtx.bands} band × {vtx.channels} ch. Сетка — из каталога, та же, что зашита в прошивку Молнии.</p>
              <table style={{ fontSize: 13 }}>
                <thead><tr><th>Band</th>{vtx.freqTable[0]?.map((_, c) => <th key={c}>{c + 1}</th>)}</tr></thead>
                <tbody>
                  {vtx.freqTable.map((band, b) => (
                    <tr key={b}><td>{bandLetter(b + 1)}</td>{band.map((f, c) => {
                      const isBoard = boardVtx?.band === b + 1 && boardVtx.channel === c + 1;
                      const isSel = active?.band === b + 1 && active.channel === c + 1;
                      return <td key={c} className={isBoard ? 'ok' : ''} style={{ fontWeight: isSel ? 700 : 400, opacity: mode === 1 && isBoard && !blink ? 0.4 : 1 }} title={isBoard ? 'борт выставил на VTX' : ''}>{f}</td>;
                    })}</tr>
                  ))}
                </tbody>
              </table>
              <p style={{ marginTop: 8 }}>На VTX сейчас: <b>{boardVtx ? `${bandLetter(boardVtx.band)}${boardVtx.channel} · ${boardVtx.freqMhz} МГц` : '—'}</b>{boardVtx && active && boardVtx.freqMhz !== active.freqMhz && <span className="err"> — не совпадает с пультом!</span>}</p>
              <details><summary className="muted">Что принял борт</summary><div className="log">{fcLog.join('\n') || 'ожидание уровня с пульта…'}</div></details>
            </>
          ) : <p className="muted">В каталоге нет VTX.</p>}
        </Card>
      </div>
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { EmulatedFc, MspClient, type VtxPair } from '@vtx/msp';
import { Card, Tip, useAsync } from '../components/ui';
import { api } from '../lib/api';

interface Layout { id: string; boardModelId: string | null; fcTarget: string; totalPins: number; pins: Array<{ pin: string; x: number; y: number; role: string; rcChannel?: number; range?: [number, number]; signal?: string }> }
interface TxModel { code: string; name: string; display: string | null; channels: number }

/** Transmitter emulator (VtxAuto v3.1 menu) + board emulator (pin layout + live MSP). */
export function EmulatorsPage() {
  const tx = useAsync(() => api<{ transmitters: TxModel[]; layouts: Layout[] }>('/models'));
  const [model, setModel] = useState('tx16s');
  const [screen, setScreen] = useState<'main' | 'vtx' | 'auth' | 'info'>('main');
  const [chan, setChan] = useState(0);
  const [live, setLive] = useState<{ ch: number; level: number } | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  const fc = useMemo(() => new EmulatedFc(), []);
  const client = useMemo(() => new MspClient(fc.transport), [fc]);
  const [map, setMap] = useState<VtxPair[]>([]);
  const [fcLog, setFcLog] = useState<string[]>([]);
  const [expiresIn, setExpiresIn] = useState(30 * 86400);
  const mono = !model.startsWith('tx1');
  const layout = tx.data?.layouts[0];
  const sel = tx.data?.transmitters.find((t) => t.code === model);

  useEffect(() => {
    void client.open().then(async () => {
      const m = await client.vtxMapRead();
      setMap(m.length ? m : Array.from({ length: 8 }, (_, i) => ({ band: 1, channel: i + 1, freqMhz: 3300 + i * 10, rcChannel: 9, rcLevel: 1000 + i * 140 })));
    });
    return () => void client.close();
  }, [client]);
  useEffect(() => {
    const t = setInterval(() => setExpiresIn((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  async function selectChannel(i: number) {
    setChan(i);
    const p = map[i];
    if (!p) return;
    await client.vtxMapLive(p.rcChannel, p.rcLevel);
    setLive({ ch: p.rcChannel, level: p.rcLevel });
    setFcLog((l) => [...l.slice(-30), `RC${p.rcChannel}=${p.rcLevel} → VTX ${p.freqMhz} МГц (band ${p.band} ch ${p.channel})`]);
  }
  const days = Math.floor(expiresIn / 86400);

  return (
    <>
      <Tip>Эмуляторы работают полностью в браузере через @vtx/msp (LoopbackTransport). Железо не нужно. Пульт передаёт уровень RC-канала — борт переключает частоту VTX.</Tip>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 12 }}>
        <Card title="Пульт" right={<select style={{ width: 'auto' }} value={model} onChange={(e) => setModel(e.target.value)}>{tx.data?.transmitters.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select>}>
          <div className={`tx-screen ${mono ? 'mono' : ''}`}>
            {screen === 'main' && (
              <>
                <div>{sel?.name ?? model} · VtxAuto v3.1</div>
                <div style={{ marginTop: 8 }}>[1] VTX AUTO {'>'}</div>
                <div>[2] Authorization {'>'}</div>
                <div>[3] Info {'>'}</div>
                <div style={{ marginTop: 8, color: days <= 3 ? '#f87171' : undefined }}>Enabled: {days > 0 ? 'YES' : 'NO'} · {days}d {Math.floor((expiresIn % 86400) / 3600)}h</div>
              </>
            )}
            {screen === 'vtx' && (
              <>
                <div>VTX AUTO — канал {chan + 1}/{map.length}</div>
                {map.slice(Math.max(0, chan - 2), chan + 3).map((p) => <div key={p.freqMhz} style={{ fontWeight: p === map[chan] ? 700 : 400 }}>{p === map[chan] ? '>' : ' '} B{p.band}C{p.channel} {p.freqMhz} MHz  RC{p.rcChannel}={p.rcLevel}</div>)}
              </>
            )}
            {screen === 'auth' && (
              <>
                <div>Authorization</div>
                <div>UID: {fc.state.uid.slice(0, 16)}</div>
                <div>Token: {fc.state.auth.authorized ? "set" : "none"} · expires in {days}d</div>
                <div style={{ marginTop: 6 }}>Введите токен из кабинета → «Устройства → Авторизовать»</div>
              </>
            )}
            {screen === 'info' && (
              <>
                <div>Info</div>
                <div>FW: {model.toUpperCase()}_VtxAuto_v3.1</div>
                <div>UID: {fc.state.uid}</div>
                <div>Anti-clone: UID bound</div>
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="secondary" onClick={() => setScreen('main')}>MENU</button>
            <button className="secondary" onClick={() => setScreen(screen === 'main' ? 'vtx' : screen === 'vtx' ? 'auth' : screen === 'auth' ? 'info' : 'main')}>PAGE</button>
            <button className="secondary" onClick={() => screen === 'vtx' && void selectChannel(Math.max(0, chan - 1))}>−</button>
            <button className="secondary" onClick={() => screen === 'vtx' && void selectChannel(Math.min(map.length - 1, chan + 1))}>+</button>
            <button onClick={() => { setScreen('vtx'); void selectChannel(chan); }}>ENTER</button>
            <button className="secondary" onClick={() => setExpiresIn(2 * 86400)}>⏩ до истечения</button>
          </div>
          {live && <p className="muted">Эфир: RC{live.ch} = {live.level} мкс</p>}
        </Card>
        <Card title={`Борт${layout ? ` — ${layout.fcTarget}` : ''}`}>
          <div className="pins">
            {layout?.pins.map((p) => (
              <div key={p.pin} className={`pin ${activePin === p.pin ? 'active' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} title={p.role} onClick={() => setActivePin(p.pin)}>{p.pin}</div>
            ))}
            {!layout && <p className="muted" style={{ padding: 12 }}>Раскладка пинов не опубликована</p>}
          </div>
          {activePin && layout && (() => { const p = layout.pins.find((x) => x.pin === activePin)!; return <p style={{ marginTop: 8 }}><b>{p.pin}</b>: {p.role}{p.rcChannel ? ` · RC${p.rcChannel}` : ''}{p.range ? ` · ${p.range[0]}–${p.range[1]}` : ''}{p.signal ? ` · ${p.signal}` : ''}</p>; })()}
          <p style={{ marginTop: 8 }}>VTX: <b>{map[chan]?.freqMhz ?? '—'} МГц</b> · band {map[chan]?.band} ch {map[chan]?.channel}</p>
          <div className="log" style={{ marginTop: 8 }}>{fcLog.join('\n') || 'ожидание команд с пульта…'}</div>
        </Card>
      </div>
    </>
  );
}

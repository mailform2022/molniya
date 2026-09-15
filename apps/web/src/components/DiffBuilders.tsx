import { useMemo, useState } from 'react';
import { ARM_RELAY_DEFAULT, ARM_RELAY_PRESETS, armRelayLines, relayContext, servoForPin, type ArmRelayConfig } from '../lib/armrelay';
import { OSD_DEFAULT_LAYOUT, OSD_ZONES, osdDef, osdLayoutLines, osdPlacementsFromDiff, type OsdPlacement, type OsdZone } from '../lib/osd';

/** Which OSD elements are shown and in which of five zones; emits `osd_layout` lines. */
export function OsdZonesEditor({ baseDiff, onAdd }: { baseDiff?: string; onAdd: (lines: string) => void }) {
  const fromBoard = useMemo(() => (baseDiff ? osdPlacementsFromDiff(baseDiff) : null), [baseDiff]);
  const [items, setItems] = useState<OsdPlacement[]>(() => {
    const base = OSD_DEFAULT_LAYOUT.map((d) => ({ ...d }));
    for (const p of fromBoard ?? []) {
      const i = base.findIndex((b) => b.id === p.id);
      if (i >= 0) base[i] = p; else base.push(p);
    }
    return base;
  });
  const lines = useMemo(() => osdLayoutLines(items), [items]);
  const update = (id: number, patch: Partial<OsdPlacement>) => setItems((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const zoneItems = (z: OsdZone) => items.filter((i) => i.enabled && i.zone === z);

  return (
    <details style={{ marginBottom: 6 }}>
      <summary>OSD: что показывать и в каком углу</summary>
      <p className="muted" style={{ fontSize: 13 }}>
        Источник: {fromBoard ? 'раскладка из снимка борта' : 'раскладка летающей Молнии'}. Отмечаете элементы и угол — сервис сам считает координаты <span className="kbd">osd_layout</span> для сетки 30×16 (аналоговый OSD). Прицел и авиагоризонт INAV всегда рисует по центру.
      </p>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: 12, marginBottom: 8 }}>
        {(['tl', 'center', 'tr', 'bl', 'br'] as OsdZone[]).map((z, idx) => (
          <div key={z} className="log" style={{ minHeight: 48, gridColumn: idx === 1 ? 2 : idx === 0 ? 1 : idx === 2 ? 3 : idx === 3 ? 1 : 3, gridRow: idx < 3 ? 1 : 2 }}>
            <b>{OSD_ZONES.find((o) => o.id === z)?.name}</b>
            {zoneItems(z).map((i) => <div key={i.id}>{osdDef(i.id).name}</div>)}
          </div>
        ))}
      </div>
      <table style={{ fontSize: 13, width: '100%' }}>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td><label><input type="checkbox" checked={i.enabled} onChange={(e) => update(i.id, { enabled: e.target.checked })} /> {osdDef(i.id).name}</label></td>
              <td>
                <select value={i.zone} disabled={!i.enabled || osdDef(i.id).fixedCenter} onChange={(e) => update(i.id, { zone: e.target.value as OsdZone })}>
                  {OSD_ZONES.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details><summary className="muted">Строки CLI ({lines.length})</summary><pre className="log" style={{ maxHeight: 120 }}>{lines.join('\n')}</pre></details>
      <button className="secondary" style={{ fontSize: 12 }} onClick={() => onAdd(lines.join('\n'))}>Добавить в diff</button>
    </details>
  );
}

/** Arm relay on a servo output: board preset → RC channel/range → pin; emits aux/servo/smix with an explanation of each line. */
export function ArmRelayEditor({ baseDiff, onAdd }: { baseDiff?: string; onAdd: (lines: string) => void }) {
  const ctx = useMemo(() => relayContext(baseDiff), [baseDiff]);
  const [cfg, setCfg] = useState<ArmRelayConfig>({ ...ARM_RELAY_DEFAULT, usedServos: ctx.usedServos, motors: ctx.motors });
  const res = useMemo(() => armRelayLines(cfg, ctx.smixCount, ctx.auxSlots), [cfg, ctx]);
  const target = servoForPin(cfg.outputPin, cfg.motors, cfg.usedServos);
  const set = (p: Partial<ArmRelayConfig>) => setCfg((c) => ({ ...c, ...p }));
  const pickBoard = (b: ArmRelayConfig['board']) => {
    if (b === 'custom') return set({ board: b });
    const preset = ARM_RELAY_PRESETS[b];
    set({ board: b, rcChannel: preset.rcChannel!, rangeMin: preset.rangeMin!, rangeMax: preset.rangeMax!, outputPin: preset.outputPin!, kind: preset.kind!, armedUs: preset.armedUs!, disarmedUs: preset.disarmedUs! });
  };

  return (
    <details style={{ marginBottom: 6 }}>
      <summary>Реле взвода на выходе S… (Молния S6 / Утка S9)</summary>
      <p className="muted" style={{ fontSize: 13 }}>{cfg.board !== 'custom' ? ARM_RELAY_PRESETS[cfg.board].note : 'Своя схема: выберите канал, диапазон и пин.'}</p>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 13 }}>
        <label>Борт
          <select value={cfg.board} onChange={(e) => pickBoard(e.target.value as ArmRelayConfig['board'])}>
            <option value="molniya">{ARM_RELAY_PRESETS.molniya.name}</option>
            <option value="utka">{ARM_RELAY_PRESETS.utka.name}</option>
            <option value="custom">своя схема</option>
          </select>
        </label>
        <label>Вид сигнала
          <select value={cfg.kind} onChange={(e) => set({ kind: e.target.value as ArmRelayConfig['kind'] })}><option value="pwm">PWM-реле</option><option value="logic">логический уровень</option></select>
        </label>
        <label>Канал взвода CH<input type="number" min={5} max={16} value={cfg.rcChannel} onChange={(e) => set({ rcChannel: Number(e.target.value) })} /></label>
        <label>Пин выхода S<input type="number" min={1} max={16} value={cfg.outputPin} onChange={(e) => set({ outputPin: Number(e.target.value) })} /></label>
        <label>Диапазон от<input type="number" step={50} value={cfg.rangeMin} onChange={(e) => set({ rangeMin: Number(e.target.value) })} /></label>
        <label>до<input type="number" step={50} value={cfg.rangeMax} onChange={(e) => set({ rangeMax: Number(e.target.value) })} /></label>
        <label>Взведено, мкс<input type="number" step={50} value={cfg.armedUs} onChange={(e) => set({ armedUs: Number(e.target.value) })} /></label>
        <label>Покой, мкс<input type="number" step={50} value={cfg.disarmedUs} disabled={cfg.kind === 'logic'} onChange={(e) => set({ disarmedUs: Number(e.target.value) })} /></label>
        <label>Взвод и от другого борта, CH (необязательно)
          <input type="number" min={0} max={16} value={cfg.peerChannel ?? 0} onChange={(e) => set({ peerChannel: Number(e.target.value) || null })} />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Моторов: {cfg.motors}, сервы в миксере: {cfg.usedServos.join(', ') || 'нет'} → пин S{cfg.outputPin} = {target ? `servo ${target.servo}${target.fillers.length ? ` (+${target.fillers.length} пустых правил)` : ''}` : 'недостижим'}.
        {' '}Схема: CH{cfg.rcChannel} {cfg.rangeMin}–{cfg.rangeMax} → USER3 (взвод) и одновременно → S{cfg.outputPin} ({cfg.kind === 'pwm' ? `PWM ${cfg.armedUs}/${cfg.disarmedUs}` : 'высокий/низкий уровень'}).
      </p>
      {res.errors.map((e) => <p key={e} className="err">{e}</p>)}
      {res.lines.length > 0 && (
        <>
          <pre className="log" style={{ maxHeight: 120 }}>{res.lines.join('\n')}</pre>
          <ul style={{ fontSize: 12 }}>{res.explain.map((e) => <li key={e}>{e}</li>)}</ul>
          <button className="secondary" style={{ fontSize: 12 }} onClick={() => onAdd(res.lines.join('\n'))}>Добавить в diff</button>
        </>
      )}
    </details>
  );
}

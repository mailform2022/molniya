/**
 * INAV OSD layout as five zones instead of raw `osd_layout` coordinates.
 * Element ids and default visibility come from the `diff all` of the reference Молния board (INAV 7.1.2, 889d6f08).
 * Output is plain `osd_layout <layout> <id> <x> <y> <V|H>` lines, so the result stays inspectable and editable.
 */
export type OsdZone = 'tl' | 'tr' | 'br' | 'bl' | 'center';

export const OSD_ZONES: Array<{ id: OsdZone; name: string }> = [
  { id: 'tl', name: 'Левый верхний' },
  { id: 'tr', name: 'Правый верхний' },
  { id: 'center', name: 'Центр' },
  { id: 'bl', name: 'Левый нижний' },
  { id: 'br', name: 'Правый нижний' }
];

export interface OsdElementDef {
  id: number;
  name: string;
  /** approximate width in characters on a 30x16 analog grid */
  width: number;
  /** INAV draws these centered regardless of x/y */
  fixedCenter?: boolean;
}

export const OSD_ELEMENTS: OsdElementDef[] = [
  { id: 41, name: 'Тангаж (pitch)', width: 6 },
  { id: 42, name: 'Крен (roll)', width: 6 },
  { id: 9, name: 'Газ (%)', width: 5 },
  { id: 0, name: 'RSSI', width: 5 },
  { id: 1, name: 'Напряжение батареи', width: 7 },
  { id: 38, name: 'Батарея, %', width: 5 },
  { id: 2, name: 'Прицел', width: 3, fixedCenter: true },
  { id: 24, name: 'Компас (курс)', width: 5 },
  { id: 34, name: 'Компас (шкала)', width: 9 },
  { id: 3, name: 'Авиагоризонт', width: 9, fixedCenter: true },
  { id: 15, name: 'Высота', width: 6 },
  { id: 13, name: 'Скорость GPS', width: 5 },
  { id: 14, name: 'Спутники GPS', width: 5 },
  { id: 22, name: 'Стрелка домой', width: 2 },
  { id: 23, name: 'Дистанция домой', width: 6 },
  { id: 11, name: 'Ток', width: 6 },
  { id: 12, name: 'Потрачено мАч', width: 6 },
  { id: 7, name: 'Режим полёта', width: 5 },
  { id: 6, name: 'Время полёта', width: 6 },
  { id: 25, name: 'Вариометр', width: 3 },
  { id: 30, name: 'Сообщения', width: 28 },
  { id: 10, name: 'Канал VTX', width: 5 },
  { id: 109, name: 'CRSF RSSI dBm', width: 7 },
  { id: 110, name: 'CRSF LQ', width: 6 }
];

export interface OsdPlacement { id: number; zone: OsdZone; enabled: boolean }

export const OSD_GRID = { cols: 30, rows: 16 };

/** What the reference board shows; everything else is off. */
export const OSD_DEFAULT_LAYOUT: OsdPlacement[] = [
  { id: 41, zone: 'tl', enabled: true },
  { id: 42, zone: 'tl', enabled: true },
  { id: 9, zone: 'tl', enabled: true },
  { id: 0, zone: 'tr', enabled: true },
  { id: 1, zone: 'bl', enabled: true },
  { id: 38, zone: 'bl', enabled: true },
  { id: 2, zone: 'center', enabled: true },
  { id: 24, zone: 'tr', enabled: true },
  { id: 34, zone: 'tr', enabled: false },
  { id: 3, zone: 'center', enabled: false },
  { id: 15, zone: 'br', enabled: true },
  { id: 13, zone: 'br', enabled: false },
  { id: 14, zone: 'br', enabled: false },
  { id: 22, zone: 'center', enabled: false },
  { id: 23, zone: 'br', enabled: false },
  { id: 11, zone: 'bl', enabled: false },
  { id: 12, zone: 'bl', enabled: false },
  { id: 7, zone: 'tr', enabled: false },
  { id: 6, zone: 'tr', enabled: false },
  { id: 25, zone: 'br', enabled: false },
  { id: 30, zone: 'bl', enabled: false },
  { id: 10, zone: 'tr', enabled: false },
  { id: 109, zone: 'tr', enabled: false },
  { id: 110, zone: 'tr', enabled: false }
];

export function osdDef(id: number): OsdElementDef {
  return OSD_ELEMENTS.find((e) => e.id === id) ?? { id, name: `элемент ${id}`, width: 6 };
}

/** Stacks enabled elements of each zone row by row (top zones downwards, bottom zones upwards, center around the middle). */
export function osdLayoutLines(placements: OsdPlacement[], layout = 0): string[] {
  const lines: string[] = [];
  const perZone = new Map<OsdZone, OsdPlacement[]>();
  for (const p of placements) {
    if (!p.enabled) {
      lines.push(`osd_layout ${layout} ${p.id} 0 0 H`);
      continue;
    }
    perZone.set(p.zone, [...(perZone.get(p.zone) ?? []), p]);
  }
  const { cols, rows } = OSD_GRID;
  for (const [zone, items] of perZone) {
    items.forEach((p, i) => {
      const def = osdDef(p.id);
      const w = Math.min(def.width, cols - 2);
      let x: number;
      let y: number;
      switch (zone) {
        case 'tl': x = 1; y = 1 + i; break;
        case 'tr': x = cols - 1 - w; y = 1 + i; break;
        case 'bl': x = 1; y = rows - 2 - i; break;
        case 'br': x = cols - 1 - w; y = rows - 2 - i; break;
        default: x = Math.floor((cols - w) / 2); y = Math.floor(rows / 2) - 1 + i;
      }
      if (def.fixedCenter) { x = Math.floor((cols - w) / 2); y = Math.floor(rows / 2) - 1; }
      lines.push(`osd_layout ${layout} ${p.id} ${Math.max(0, x)} ${Math.min(rows - 1, Math.max(0, y))} V`);
    });
  }
  return lines;
}

/** Reads `osd_layout <layout> <id> <x> <y> <V|H>` lines back into zones (nearest corner / centre). */
export function osdPlacementsFromDiff(diff: string, layout = 0): OsdPlacement[] | null {
  const re = new RegExp(`^osd_layout\\s+${layout}\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([VH])`, 'gm');
  const out: OsdPlacement[] = [];
  const { cols, rows } = OSD_GRID;
  for (const m of diff.matchAll(re)) {
    const id = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const right = x > cols / 2 - 3;
    const bottom = y > rows / 2;
    const central = Math.abs(x - cols / 2) < 6 && Math.abs(y - rows / 2) < 4;
    out.push({ id, enabled: m[4] === 'V', zone: central ? 'center' : right ? (bottom ? 'br' : 'tr') : bottom ? 'bl' : 'tl' });
  }
  return out.length ? out : null;
}

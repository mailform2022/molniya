/**
 * Static inspection of a raw STM32 flash dump (dfu-util / STM32CubeProg `.bin`) taken from an FC before we touch it.
 * Answers: is it a firmware at all, which INAV target/version built it, and is the config sector present —
 * so a dump can be tied to the board snapshot and later compared with the post-crash dump.
 */

export interface FirmwareImageInfo {
  sizeBytes: number;
  /** Cortex-M vector table sanity: initial SP in SRAM, reset vector in flash with thumb bit. */
  vectorTableOk: boolean;
  initialSp: number | null;
  resetVector: number | null;
  /** `MCU flash layout` guess from the vector table; null when it is not a plain flash image. */
  layout: 'stm32f4_1m' | 'unknown' | null;
  /** Non-empty (not all 0xFF/0x00) 4 KiB pages, merged into [start,end) ranges. */
  regions: Array<{ start: number; end: number }>;
  /** Strings that identify the build. */
  fcVariant: string | null; // e.g. INAV, INAV-UTKA
  target: string | null; // e.g. SPEEDYBEEF405WING
  version: string | null; // e.g. 8.0.1
  buildDate: string | null;
  compiler: string | null;
  usbProductString: string | null;
  /** INAV F4 keeps `config` in the last 128 KiB sector (0x080E0000). */
  configSector: { offset: number; present: boolean; eepromVersion: number | null; sizeBytes: number | null } | null;
  warnings: string[];
}

const F4_CONFIG_OFFSET = 0xe0000;
const PAGE = 4096;

function isEmptyPage(b: Uint8Array, off: number): boolean {
  const first = b[off];
  if (first !== 0xff && first !== 0x00) return false;
  for (let i = off; i < Math.min(off + PAGE, b.length); i++) if (b[i] !== first) return false;
  return true;
}

function findStrings(b: Uint8Array, minLen = 6): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
    else {
      if (cur.length >= minLen) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= minLen) out.push(cur);
  return out;
}

export function analyzeFirmwareImage(buf: Uint8Array): FirmwareImageInfo {
  const warnings: string[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const initialSp = buf.length >= 8 ? dv.getUint32(0, true) : null;
  const resetVector = buf.length >= 8 ? dv.getUint32(4, true) : null;
  // SRAM (0x2000_0000) or CCM RAM (0x1000_0000, INAV F4 puts the stack there)
  const spOk = initialSp !== null && ((initialSp >= 0x20000000 && initialSp <= 0x20080000) || (initialSp >= 0x10000000 && initialSp <= 0x10010000));
  const rvOk = resetVector !== null && resetVector >= 0x08000000 && resetVector < 0x08200000 && (resetVector & 1) === 1;
  const vectorTableOk = spOk && rvOk;
  if (!vectorTableOk) warnings.push('Начало файла не похоже на таблицу векторов STM32: это не полный дамп flash с адреса 0x08000000 (или файл .hex/.dfu, а не .bin).');

  const regions: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  for (let off = 0; off < buf.length; off += PAGE) {
    const empty = isEmptyPage(buf, off);
    if (!empty && start === null) start = off;
    if (empty && start !== null) {
      regions.push({ start, end: off });
      start = null;
    }
  }
  if (start !== null) regions.push({ start, end: buf.length });

  const strs = findStrings(buf, 5);
  const target = strs.map((s) => /^"?([A-Z0-9_]{6,32})$/.exec(s)?.[1]).find((s): s is string => Boolean(s && /F[47]\d{2}|H7|AT32|WING|MINI|AIO/.test(s))) ?? null;
  const fcVariant = strs.find((s) => /^INAV(-[A-Z0-9]+)?$/.test(s)) ?? null;
  const version = strs.find((s) => /^\d+\.\d+\.\d+$/.test(s)) ?? null;
  const buildDate = strs.find((s) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d 20\d\d$/.test(s))?.replace(/\s+/g, ' ') ?? null;
  const compiler = strs.map((s) => /^(\d+\.\d+\.\d+ \d{8})$/.exec(s)?.[1]).find((s): s is string => Boolean(s)) ?? null;
  const usbProductString = strs.find((s) => /^[A-Za-z][A-Za-z0-9 ]{3,30}(Wing|WING|F4|F7|H7|AIO)[A-Za-z0-9 ]*$/.test(s) && !/^[A-Z0-9_]+$/.test(s)) ?? null;
  if (!fcVariant) warnings.push('Строка варианта INAV не найдена — прошивка не INAV или файл повреждён/зашифрован.');

  let layout: FirmwareImageInfo['layout'] = null;
  let configSector: FirmwareImageInfo['configSector'] = null;
  if (vectorTableOk) {
    layout = buf.length === 1024 * 1024 ? 'stm32f4_1m' : 'unknown';
    if (layout === 'stm32f4_1m') {
      const present = !isEmptyPage(buf, F4_CONFIG_OFFSET);
      let eepromVersion: number | null = null;
      let sizeBytes: number | null = null;
      if (present) {
        eepromVersion = buf[F4_CONFIG_OFFSET]!;
        sizeBytes = dv.getUint16(F4_CONFIG_OFFSET + 2, true);
      } else warnings.push('Сектор конфигурации (0x080E0000) пуст: настройки в дампе отсутствуют, сравнивать можно только код прошивки.');
      configSector = { offset: F4_CONFIG_OFFSET, present, eepromVersion, sizeBytes };
    } else warnings.push(`Размер ${buf.length} байт не равен 1 МиБ — не полный дамп F405; положение сектора конфигурации неизвестно.`);
  }

  return { sizeBytes: buf.length, vectorTableOk, initialSp, resetVector, layout, regions, fcVariant, target, version, buildDate, compiler, usbProductString, configSector, warnings };
}

/** Does the dump belong to the board we identified over MSP? Mismatch = wrong file or wrong board. */
export function imageMatchesBoard(info: FirmwareImageInfo, board: { target: string; version: string; variant: string }): string[] {
  const problems: string[] = [];
  if (info.target && info.target !== board.target) problems.push(`target в дампе ${info.target}, а борт по MSP — ${board.target}`);
  if (info.version && info.version !== board.version) problems.push(`версия в дампе ${info.version}, а борт по MSP — ${board.version}`);
  if (info.fcVariant && board.variant && !info.fcVariant.startsWith(board.variant)) problems.push(`вариант в дампе ${info.fcVariant}, а борт по MSP — ${board.variant}`);
  return problems;
}

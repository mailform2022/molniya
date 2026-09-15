/**
 * FC snapshot: everything we can read from a board over MSP/CLI *before* changing anything.
 * Used for: trust classification, diagnostic build inputs, and post-crash comparison.
 */
import type { BlackboxConfig, DataflashSummary, MspClient, SdcardSummary } from './client.js';

export interface ParsedDiff {
  /** `set name = value` → value */
  settings: Record<string, string>;
  /** other config lines grouped by first word: feature, serial, mixer, servo, aux, osd_layout, … */
  groups: Record<string, string[]>;
  /** `# INAV/TARGET 7.1.2 …` header line, if present */
  versionLine: string | null;
  lineCount: number;
}

export function parseDiff(text: string): ParsedDiff {
  const settings: Record<string, string> = {};
  const groups: Record<string, string[]> = {};
  let versionLine: string | null = null;
  let lineCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lineCount++;
    if (line.startsWith('#')) {
      if (/^#\s*(INAV|BTFL|BF)\//i.test(line)) versionLine = line.slice(1).trim();
      continue;
    }
    const set = /^set\s+([a-z0-9_]+)\s*=\s*(.+)$/i.exec(line);
    if (set) {
      settings[set[1]!.toLowerCase()] = set[2]!.trim();
      continue;
    }
    const head = line.split(/\s+/)[0]!.toLowerCase();
    if (head === 'batch' || head === 'defaults' || head === 'save') continue;
    (groups[head] ??= []).push(line);
  }
  return { settings, groups, versionLine, lineCount };
}

/** Settings whose change between snapshot and crash state most often explains a crash. */
export const CRITICAL_SETTING_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /^(failsafe_|rx_min_usec|rx_max_usec)/, why: 'логика failsafe' },
  { re: /^(nav_fw_|nav_rth_|nav_wp_|nav_manual_|nav_launch|nav_fw_launch)/, why: 'навигация/автопилот самолёта' },
  { re: /^(fw_p_|fw_i_|fw_d_|fw_ff_|fw_level|fw_iterm|fw_reference_airspeed|fw_min_throttle|fw_autotune)/, why: 'PID/FF контур крыла' },
  { re: /^(max_throttle|min_throttle|throttle_idle|min_check|max_check|motor_pwm|motor_poles)/, why: 'моторы/газ' },
  { re: /^(servo_|flaperon|fw_tpa)/, why: 'сервоприводы' },
  { re: /^(gyro_|acc_|align_|imu_|mag_|baro_)/, why: 'датчики/ориентация' },
  { re: /^(platform_type|mixer_|has_flaps|model_preview_type)/, why: 'тип платформы/микшер' },
  { re: /^(small_angle|nav_extra_arming_safety|disarm_kill_switch)/, why: 'арминг' }
];

export interface DiffChange {
  key: string;
  before: string | null;
  after: string | null;
  critical: string | null; // reason, if critical
}

/** Compare two `diff all` dumps (settings and grouped lines). Order-insensitive within a group. */
export function compareDiff(before: ParsedDiff, after: ParsedDiff): { settings: DiffChange[]; groups: DiffChange[]; criticalCount: number } {
  const settings: DiffChange[] = [];
  const keys = new Set([...Object.keys(before.settings), ...Object.keys(after.settings)]);
  for (const key of [...keys].sort()) {
    const b = before.settings[key] ?? null;
    const a = after.settings[key] ?? null;
    if (b === a) continue;
    const crit = CRITICAL_SETTING_PATTERNS.find((p) => p.re.test(key));
    settings.push({ key, before: b, after: a, critical: crit?.why ?? null });
  }
  const groups: DiffChange[] = [];
  const gkeys = new Set([...Object.keys(before.groups), ...Object.keys(after.groups)]);
  const CRIT_GROUPS: Record<string, string> = { mixer: 'микшер', servo: 'сервоприводы', smix: 'servo mixer', aux: 'режимы/арминг', serial: 'порты (RX/GPS/VTX)', feature: 'features' };
  for (const g of [...gkeys].sort()) {
    const b = new Set(before.groups[g] ?? []);
    const a = new Set(after.groups[g] ?? []);
    for (const l of b) if (!a.has(l)) groups.push({ key: g, before: l, after: null, critical: CRIT_GROUPS[g] ?? null });
    for (const l of a) if (!b.has(l)) groups.push({ key: g, before: null, after: l, critical: CRIT_GROUPS[g] ?? null });
  }
  return { settings, groups, criticalCount: settings.filter((c) => c.critical).length + groups.filter((c) => c.critical).length };
}

export type LogPath = 'flash' | 'sdcard' | 'serial_host' | 'none';

export interface BlackboxCapability {
  flash: DataflashSummary | null;
  sdcard: SdcardSummary | null;
  config: BlackboxConfig | null;
  /** Where diagnostic logs can actually go on this board. */
  recommended: LogPath;
  reasons: string[];
}

/** Decide, from what the FC itself reports, where a diagnostic log can be written. */
export function blackboxCapability(flash: DataflashSummary | null, sdcard: SdcardSummary | null, config: BlackboxConfig | null): BlackboxCapability {
  const reasons: string[] = [];
  let recommended: LogPath = 'none';
  if (flash?.supported) {
    recommended = 'flash';
    reasons.push(`Встроенная flash ${Math.round(flash.totalSize / 1048576)} МБ (занято ${Math.round(flash.usedSize / 1024)} КБ)`);
  } else reasons.push('Встроенной flash для чёрного ящика нет (MSP_DATAFLASH_SUMMARY: not supported)');
  if (sdcard?.supported) {
    if (sdcard.state === 4) {
      if (recommended === 'none') recommended = 'sdcard';
      reasons.push(`SD-карта готова, ${Math.round(sdcard.totalSizeKb / 1024)} МБ`);
    } else reasons.push('Слот SD есть, но карта не обнаружена/не готова — вставьте карту FAT32, иначе лог на SD невозможен');
  }
  if (recommended === 'none') {
    recommended = 'serial_host';
    reasons.push('Единственный путь логирования — по serial/USB на внешнее устройство (ПК/телефон) через MSP; в полёте без хост-устройства логов не будет');
  }
  if (config && !config.supported) reasons.push('Прошивка собрана без blackbox');
  return { flash, sdcard, config, recommended, reasons };
}

export interface FcSnapshot {
  takenAt: string;
  variant: string;
  version: string;
  target: string;
  boardId: string;
  uid: string;
  transport: { vid?: number; pid?: number; label: string };
  vtxConfig: { deviceType: number; band: number; channel: number; power: number; pitMode: number; freqMhz: number } | null;
  vtxMap: Array<{ band: number; channel: number; freqMhz: number; rcChannel: number; rcLevel: number }> | null;
  capability: BlackboxCapability;
  /** Raw `diff all` text — the authoritative copy of the configuration. */
  diffAll: string | null;
  diffError: string | null;
  statusText: string | null;
}

/**
 * Read-only pass over the FC. Order matters: MSP first (no reboot), CLI last (INAV reboots on exit).
 * Nothing is written to the board.
 */
export async function takeFcSnapshot(client: MspClient, onStep?: (text: string) => void): Promise<FcSnapshot> {
  const step = (t: string) => onStep?.(t);
  step('MSP_FC_VARIANT / MSP_FC_VERSION / MSP_BOARD_INFO');
  const variant = await client.fcVariant();
  const version = await client.fcVersion();
  const board = await client.boardInfo();
  let uid = '';
  try {
    uid = await client.getUid();
  } catch {
    uid = await client.uid();
  }
  const tryMsp = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      step(name);
      return await fn();
    } catch (e) {
      const msg = (e as Error).message;
      step(/rejected|unsupported/i.test(msg) ? `${name}: прошивка не знает эту команду (обычная INAV без VTX map) — пропускаем` : `${name}: ${msg}`);
      return null;
    }
  };
  const vtxConfig = await tryMsp('MSP_VTX_CONFIG', () => client.vtxConfig());
  const vtxMap = await tryMsp('MSP2 0x2F10 VTX_MAP_READ', () => client.vtxMapRead());
  const flash = await tryMsp('MSP_DATAFLASH_SUMMARY', () => client.dataflashSummary());
  const sdcard = await tryMsp('MSP_SDCARD_SUMMARY', () => client.sdcardSummary());
  const bbCfg = await tryMsp('MSP2_BLACKBOX_CONFIG', () => client.blackboxConfig());
  const capability = blackboxCapability(flash, sdcard, bbCfg);

  let diffAll: string | null = null;
  let diffError: string | null = null;
  let statusText: string | null = null;
  try {
    step('CLI: status, diff all (после выхода из CLI INAV перезагрузит борт — это нормально)');
    const s = await client.cliSession();
    try {
      statusText = await s.run('status', 3000);
      diffAll = await s.run('diff all', 8000);
    } finally {
      await s.end('exit');
    }
  } catch (e) {
    diffError = (e as Error).message;
    step(`CLI недоступен: ${diffError}`);
  }

  return {
    takenAt: new Date().toISOString(),
    variant,
    version,
    target: board.targetName,
    boardId: board.identifier,
    uid,
    transport: client.transport.info(),
    vtxConfig,
    vtxMap,
    capability,
    diffAll,
    diffError,
    statusText
  };
}

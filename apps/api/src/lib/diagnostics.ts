/**
 * Server-side logic for unverified boards:
 *  - trust classification of a connected FC against `verified_targets`;
 *  - deterministic diagnostic CLI script (logging on, user diff preserved);
 *  - post-crash analysis: pre/post `diff all` comparison + blackbox/host log provenance.
 *
 * Nothing here claims a root cause: findings are ranked deviations that a human reviews.
 */
import { type BlackboxFileSummary, compareDiff, parseBlackboxFile, parseDiff } from '@vtx/msp';

export type Trust = 'verified' | 'experimental' | 'unverified' | 'banned';

export interface VerifiedTargetRow {
  fcTarget: string;
  inavVersion: string;
  status: string;
}

/** `inavVersion` in verified_targets is an exact version or a prefix (`7.1` matches `7.1.2`). */
export function classifyTrust(fcTarget: string, fcVersion: string, rows: VerifiedTargetRow[]): Trust {
  const t = fcTarget.toUpperCase();
  const matches = rows.filter((r) => r.fcTarget.toUpperCase() === t && (fcVersion === r.inavVersion || fcVersion.startsWith(r.inavVersion + '.')));
  if (matches.length === 0) return 'unverified';
  if (matches.some((m) => m.status === 'banned')) return 'banned';
  if (matches.some((m) => m.status === 'verified')) return 'verified';
  return 'experimental';
}

export type LogPath = 'flash' | 'sdcard' | 'serial_host';

export interface DiagnosticOptions {
  logPath: LogPath;
  /** blackbox_rate_denom: 1 = every loop, 2 = half, ... */
  rateDenom: number;
  /** INAV `debug_mode` value, e.g. NONE | FLOW | ALWAYS | GYRO | ... */
  debugMode: string;
  /** UART number for serial_host logging (only for logPath=serial_host) */
  serialPort?: number;
  /** user `diff` lines to keep (already validated by the diff module) */
  userDiff?: string;
}

const BLACKBOX_DEVICE: Record<LogPath, string> = { flash: 'SPIFLASH', sdcard: 'SDCARD', serial_host: 'SERIAL' };

/**
 * Builds the CLI script applied after flashing the base firmware.
 * Order: defaults are NOT reset here (the user diff already assumes the fresh firmware), user diff first,
 * then logging settings override anything the user diff set for blackbox, then `save`.
 */
export function buildDiagnosticScript(opts: DiagnosticOptions, snapshotVersionLine: string | null): string {
  const lines: string[] = [];
  lines.push('# VTX Services diagnostic configuration');
  if (snapshotVersionLine) lines.push(`# pre-change snapshot: ${snapshotVersionLine}`);
  lines.push(`# logging path: ${opts.logPath}${opts.logPath === 'serial_host' ? ' (external host required; not onboard blackbox)' : ''}`);
  lines.push('batch start');
  if (opts.userDiff) {
    for (const raw of opts.userDiff.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      if (/^(save|exit|defaults|batch)\b/i.test(l)) continue;
      if (/^set\s+(blackbox_|debug_mode)/i.test(l)) continue; // logging is owned by the diagnostic layer
      lines.push(l);
    }
  }
  lines.push('feature BLACKBOX');
  lines.push(`set blackbox_device = ${BLACKBOX_DEVICE[opts.logPath]}`);
  lines.push('set blackbox_rate_num = 1');
  lines.push(`set blackbox_rate_denom = ${Math.max(1, Math.min(255, Math.trunc(opts.rateDenom)))}`);
  lines.push(`set debug_mode = ${opts.debugMode.toUpperCase()}`);
  if (opts.logPath === 'serial_host' && opts.serialPort !== undefined) {
    // serial function 128 = BLACKBOX in INAV serialPortFunction_e
    lines.push(`serial ${opts.serialPort} 128 115200 115200 0 115200`);
  }
  lines.push('batch end');
  lines.push('save');
  return lines.join('\n') + '\n';
}

export interface CrashFile {
  kind: string;
  name: string;
  bytes: Uint8Array;
}

export interface CrashAnalysis {
  diff: ReturnType<typeof compareDiff> | null;
  diffNote: string;
  logs: Array<{ name: string; kind: string; summary: BlackboxFileSummary | null; note: string }>;
  findings: Array<{ severity: 'critical' | 'warning' | 'info'; text: string }>;
}

/**
 * Compares pre-change and post-crash `diff all`, summarises uploaded logs and derives ranked findings.
 * Findings are deviations, not causes.
 */
export function analyzeCrash(diffBefore: string | null, diffAfter: string | null, files: CrashFile[]): CrashAnalysis {
  const findings: CrashAnalysis['findings'] = [];
  let diff: CrashAnalysis['diff'] = null;
  let diffNote: string;
  if (diffBefore && diffAfter) {
    const a = parseDiff(diffBefore);
    const b = parseDiff(diffAfter);
    diff = compareDiff(a, b);
    diffNote = `Сравнение diff all до/после: изменено настроек ${diff.settings.length}, групп ${diff.groups.length}, критичных ${diff.criticalCount}.`;
    if (a.versionLine && b.versionLine && a.versionLine !== b.versionLine) findings.push({ severity: 'warning', text: `Прошивка изменилась: «${a.versionLine}» → «${b.versionLine}».` });
    for (const c of diff.settings.filter((s) => s.critical)) findings.push({ severity: 'critical', text: `Критичный параметр ${c.key}: ${c.before ?? '—'} → ${c.after ?? '—'}.` });
    for (const c of diff.groups) findings.push({ severity: 'warning', text: `Изменена группа команд «${c.key}».` });
  } else {
    diffNote = diffBefore ? 'Нет diff all после падения: борт не читается или не был подключён.' : 'Нет исходного снимка diff all — сравнение невозможно, есть только логи.';
    findings.push({ severity: 'info', text: diffNote });
  }

  const logs: CrashAnalysis['logs'] = [];
  for (const f of files) {
    if (f.kind !== 'blackbox' && f.kind !== 'host_log') {
      logs.push({ name: f.name, kind: f.kind, summary: null, note: 'Файл сохранён как вложение, не анализируется автоматически.' });
      continue;
    }
    const summary = parseBlackboxFile(f.bytes);
    let note: string;
    if (summary.logs.length === 0) {
      note = f.kind === 'blackbox' ? 'В файле нет заголовков blackbox — запись на борту не велась или носитель не читался.' : 'В host-логе нет blackbox-кадров.';
      findings.push({ severity: 'critical', text: `${f.name}: ${note}` });
    } else {
      const interrupted = summary.logs.filter((l) => !l.cleanEnd);
      note = `Логов: ${summary.logs.length}, без маркера End of log: ${interrupted.length}.`;
      if (interrupted.length > 0) findings.push({ severity: 'warning', text: `${f.name}: ${interrupted.length} лог(ов) оборваны — вероятно, потеря питания/падение во время записи.` });
      const last = summary.logs.at(-1)!;
      if (last.frameHint['I'] === undefined && last.frameHint['P'] === undefined) findings.push({ severity: 'warning', text: `${f.name}: в последнем логе нет I/P кадров — записаны только заголовки.` });
    }
    for (const w of summary.warnings) findings.push({ severity: 'info', text: `${f.name}: ${w}` });
    logs.push({ name: f.name, kind: f.kind, summary, note });
  }
  if (files.length === 0) findings.push({ severity: 'info', text: 'Логи не приложены — анализ ограничен сравнением diff all.' });

  const order = { critical: 0, warning: 1, info: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity]);
  return { diff, diffNote, logs, findings };
}

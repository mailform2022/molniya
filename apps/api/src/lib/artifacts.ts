/**
 * Server-side generation of the two wizard artifacts. Pure functions of stored inputs, so the same
 * build set always yields byte-identical files (hashes are stored and can be re-verified).
 *
 *   FC:  CLI script (user diff + logging script + VTX map as comments) and a JSON bundle with provenance
 *   TX:  EdgeTX model YAML fragment (`vtxAuto:`) for the VtxAuto v3.1 firmware, same band/channel pairs
 */
import { createHash } from 'node:crypto';
import type { VtxPair } from '../db/schema.js';

export interface ArtifactInput {
  target: string;
  uid: string;
  trust: string;
  generatedAt: string;
  snapshot: { id: string; takenAt: string } | null;
  fcFirmware: { id: string; fileName: string; sha256: string; verification: string } | null;
  txFirmware: { id: string; fileName: string; sha256: string; verification: string } | null;
  userDiff: string;
  diagnostic: { id: string; logPath: string; cliScript: string } | null;
  vtx: { modelName: string | null; freqSource: string; pairs: VtxPair[] };
  transmitter: { code: string; profileId: string | null };
}

export interface Artifacts {
  fcScript: string;
  fcBundle: string;
  txYaml: string;
  hashes: { fcScript: string; fcBundle: string; txYaml: string };
}

/** Lines that would reboot the FC or wipe it — never part of an artifact, they are issued by the flasher. */
const TERMINAL = /^(save|exit|defaults|dfu|reboot)\b/i;

export const bandLetter = (band: number): string => String.fromCharCode(64 + band);

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** µs → EdgeTX channel percent (-100..100), as VtxAuto stores `value`. */
export function usToPercent(us: number): number {
  return Math.max(-100, Math.min(100, Math.round((us - 1500) / 5.12)));
}

export function cleanDiffLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !TERMINAL.test(l.trim()));
}

export function fcCliScript(i: ArtifactInput): string {
  const lines = [
    `# VTX Services — ${i.target} UID ${i.uid} — ${i.generatedAt}`,
    i.snapshot ? `# snapshot ${i.snapshot.id} (${i.snapshot.takenAt}), trust: ${i.trust}` : `# без снимка, trust: ${i.trust}`,
    i.fcFirmware ? `# прошивка: ${i.fcFirmware.fileName} sha256 ${i.fcFirmware.sha256} (${i.fcFirmware.verification})` : '# прошивка борта не меняется',
    '# 1) пользовательский diff',
    ...cleanDiffLines(i.userDiff)
  ];
  if (i.diagnostic) {
    lines.push(`# 2) диагностическое логирование (${i.diagnostic.logPath}, build ${i.diagnostic.id})`);
    lines.push(...cleanDiffLines(i.diagnostic.cliScript).filter((l) => !l.startsWith('#')));
  }
  lines.push(`# 3) карта VTX (${i.vtx.freqSource}${i.vtx.modelName ? `, ${i.vtx.modelName}` : ''}) пишется по MSP2 0x2F11, не через CLI: band/ch МГц RC мкс`);
  for (const p of i.vtx.pairs) lines.push(`#   ${bandLetter(p.band)}${p.channel} ${p.freqMhz} ch${p.rcChannel} ${p.rcLevel}`);
  lines.push('save');
  return lines.join('\n') + '\n';
}

export function fcBundleJson(i: ArtifactInput): string {
  return (
    JSON.stringify(
      {
        kind: 'vtx-services.fc-bundle',
        version: 1,
        generatedAt: i.generatedAt,
        target: i.target,
        uid: i.uid,
        trust: i.trust,
        snapshotId: i.snapshot?.id ?? null,
        firmware: i.fcFirmware,
        userDiff: cleanDiffLines(i.userDiff),
        diagnosticBuild: i.diagnostic ? { id: i.diagnostic.id, logPath: i.diagnostic.logPath } : null,
        vtx: i.vtx,
        transmitter: { ...i.transmitter, firmware: i.txFirmware }
      },
      null,
      2
    ) + '\n'
  );
}

/** EdgeTX `vtxAuto:` fragment (VtxAuto v3.1): bands 0-based, RC channel 0-based, value in percent. */
export function txYaml(pairs: VtxPair[], name: string): string {
  const ch = (pairs[0]?.rcChannel ?? 9) - 1;
  const lines = [
    'vtxAuto:',
    '  enabled: 1',
    '  activeProfile: 0',
    '  profileCount: 1',
    '  profiles:',
    '    0:',
    `      name: "${name.replace(/"/g, '').slice(0, 11)}"`,
    `      channel: ${ch}`,
    `      pairCount: ${pairs.length}`,
    '      mode: 0',
    '      timeType: 0',
    '      pairs:'
  ];
  pairs.forEach((p, idx) => lines.push(`        ${idx}:`, `          band: ${p.band - 1}`, `          channel: ${p.channel}`, `          value: ${usToPercent(p.rcLevel)}`));
  return lines.join('\n') + '\n';
}

export function buildArtifacts(i: ArtifactInput): Artifacts {
  const fcScript = fcCliScript(i);
  const fcBundle = fcBundleJson(i);
  const yaml = txYaml(i.vtx.pairs, i.vtx.modelName ?? 'VTX');
  return { fcScript, fcBundle, txYaml: yaml, hashes: { fcScript: sha256Hex(fcScript), fcBundle: sha256Hex(fcBundle), txYaml: sha256Hex(yaml) } };
}

/** Pairs must be unique per band/channel and per RC level, frequencies within a sane VTX range. */
export function validatePairs(pairs: VtxPair[]): string | null {
  if (!pairs.length) return 'нет пар band/канал';
  const bc = new Set<string>();
  const lv = new Set<number>();
  const rc = new Set(pairs.map((p) => p.rcChannel));
  if (rc.size > 1) return 'все пары должны использовать один RC-канал пульта';
  for (const p of pairs) {
    const k = `${p.band}:${p.channel}`;
    if (bc.has(k)) return `дубликат ${bandLetter(p.band)}${p.channel}`;
    bc.add(k);
    if (lv.has(p.rcLevel)) return `одинаковый уровень канала ${p.rcLevel} мкс у двух пар`;
    lv.add(p.rcLevel);
    if (p.freqMhz < 1000 || p.freqMhz > 6500) return `частота ${p.freqMhz} МГц вне диапазона VTX`;
  }
  const sorted = pairs.map((p) => p.rcLevel).sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) if (sorted[k]! - sorted[k - 1]! < 40) return `уровни ${sorted[k - 1]} и ${sorted[k]} мкс слишком близко (<40 мкс): пульт не различит`;
  return null;
}

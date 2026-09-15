/** INAV CLI diff parser: detects unknown commands and conflicting `set` values. */

const KNOWN = new Set([
  'batch', 'blackbox',
  'set', 'feature', 'beeper', 'map', 'serial', 'aux', 'adjrange', 'rxrange', 'servo', 'smix', 'mmix', 'osd_layout', 'led', 'color', 'mode_color',
  'logic', 'gvar', 'pid', 'wp', 'safehome', 'fwapproach', 'geozone', 'temp_sensor', 'vtxtable', 'timer_output_mode', 'resource', 'profile',
  'battery_profile', 'mixer_profile', 'control_profile', 'save', 'defaults', 'diff', 'dump', 'version', 'exit', 'ezTune', 'vtx_info'
]);

export interface DiffAnalysis {
  commands: number;
  unknown: string[];
  conflicts: string[];
  settings: Record<string, string>;
  features: string[];
}

export function analyzeDiff(text: string): DiffAnalysis {
  const settings: Record<string, string> = {};
  const unknown: string[] = [];
  const conflicts: string[] = [];
  const features: string[] = [];
  let commands = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    commands++;
    const [cmd, ...rest] = line.split(/\s+/);
    if (!cmd || !KNOWN.has(cmd)) {
      unknown.push(line);
      continue;
    }
    if (cmd === 'set') {
      const m = /^set\s+([a-z0-9_]+)\s*=\s*(.+)$/i.exec(line);
      if (!m) {
        unknown.push(line);
        continue;
      }
      const [, key, value] = m as unknown as [string, string, string];
      if (key in settings && settings[key] !== value) conflicts.push(`${key}: ${settings[key]} → ${value}`);
      settings[key] = value;
    } else if (cmd === 'feature') {
      const f = rest.join(' ');
      const bare = f.replace(/^-/, '');
      const opposite = f.startsWith('-') ? bare : `-${bare}`;
      if (features.includes(opposite)) conflicts.push(`feature ${opposite} vs ${f}`);
      features.push(f);
    }
  }
  return { commands, unknown, conflicts, settings, features };
}

/** Line-level diff between parent template and user's version. */
export function lineDiff(base: string, mine: string): Array<{ op: '=' | '+' | '-'; line: string }> {
  const a = base.split(/\r?\n/);
  const b = mine.split(/\r?\n/);
  const setA = new Set(a);
  const setB = new Set(b);
  const out: Array<{ op: '=' | '+' | '-'; line: string }> = [];
  for (const l of a) out.push({ op: setB.has(l) ? '=' : '-', line: l });
  for (const l of b) if (!setA.has(l)) out.push({ op: '+', line: l });
  return out;
}

/** Generate `vtxtable` CLI lines for a frequency grid. */
export function vtxTableDiff(bands: number[][], bandNames?: string[]): string {
  const channels = Math.max(...bands.map((b) => b.length));
  const lines = [`vtxtable bands ${bands.length}`, `vtxtable channels ${channels}`];
  bands.forEach((freqs, i) => {
    const name = bandNames?.[i] ?? `BAND${i + 1}`;
    const letter = String.fromCharCode(65 + i);
    lines.push(`vtxtable band ${i + 1} ${name} ${letter} CUSTOM ${freqs.join(' ')}`);
  });
  return lines.join('\n');
}

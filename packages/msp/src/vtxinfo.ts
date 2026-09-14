/** Parser for the `vtx_info` CLI command output (custom INAV fork). Example:
 *
 *   name: SX33-3G3
 *   protocol: smartaudio
 *   bands: 5
 *   channels: 8
 *   freq_table: 3330,3360,3390,...
 *   raw_status: AA 55 01 ...
 */
export interface VtxInfo {
  name: string;
  protocol: string;
  bands: number;
  channels: number;
  freqTable: number[];
  rawStatus: number[];
}

export function parseVtxInfo(text: string): VtxInfo {
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([a-z_]+)\s*[:=]\s*(.*)$/i.exec(line);
    if (m) kv[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  const nums = (s?: string) => (s ? s.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n)) : []);
  return {
    name: kv['name'] ?? 'unknown',
    protocol: kv['protocol'] ?? 'unknown',
    bands: Number(kv['bands'] ?? 0),
    channels: Number(kv['channels'] ?? 0),
    freqTable: nums(kv['freq_table']),
    rawStatus: (kv['raw_status'] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => parseInt(h, 16))
      .filter((n) => !Number.isNaN(n))
  };
}

/** Validate a frequency grid: integers, no duplicates, no empty, within band range. */
export function validateFreqTable(freqs: number[], rangeMhz: [number, number], toleranceMhz = 1): string[] {
  const errors: string[] = [];
  if (!freqs.length) errors.push('Сетка пуста');
  const seen = new Set<number>();
  freqs.forEach((f, i) => {
    if (!Number.isInteger(f)) errors.push(`#${i + 1}: не целое (${f})`);
    if (f < rangeMhz[0] - toleranceMhz || f > rangeMhz[1] + toleranceMhz) errors.push(`#${i + 1}: ${f} МГц вне диапазона ${rangeMhz[0]}–${rangeMhz[1]}`);
    if (seen.has(f)) errors.push(`#${i + 1}: дубликат ${f}`);
    seen.add(f);
  });
  return errors;
}

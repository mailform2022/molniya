/**
 * Frequency grid import. Accepts what users actually have on hand:
 *  - INAV/Betaflight CLI `vtxtable` dump  (`vtxtable band 1 A A FACTORY 5865 5845 ...`)
 *  - CSV/TSV/whitespace: one band per row, optional band name in the first column
 *  - JSON: number[][] or { bands: [{ name, freqs: number[] }] }
 * Output is a rectangular MHz table; validation of duplicates/ranges happens in the submission route.
 */
export type FreqFileResult = { ok: true; format: 'vtxtable' | 'csv' | 'json'; bandNames: string[]; freqTable: number[][]; warnings: string[] } | { ok: false; error: string };

const MHZ = /^\d{4}$/;

export function parseFrequencyFile(text: string, fileName = ''): FreqFileResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { ok: false, error: 'Пустой файл' };
  const warnings: string[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[') || fileName.toLowerCase().endsWith('.json')) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: 'JSON не разбирается' };
    }
    const rows: number[][] = [];
    const bandNames: string[] = [];
    const src = Array.isArray(json) ? json : typeof json === 'object' && json !== null && Array.isArray((json as { bands?: unknown }).bands) ? (json as { bands: unknown[] }).bands : null;
    if (!src) return { ok: false, error: 'Ожидался массив бэндов или { bands: [...] }' };
    src.forEach((b, i) => {
      const freqs = Array.isArray(b) ? b : typeof b === 'object' && b !== null && Array.isArray((b as { freqs?: unknown }).freqs) ? (b as { freqs: unknown[] }).freqs : null;
      if (!freqs) return;
      const nums = freqs.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (nums.length) {
        rows.push(nums);
        bandNames.push(typeof b === 'object' && b !== null && typeof (b as { name?: unknown }).name === 'string' ? (b as { name: string }).name : String.fromCharCode(65 + i));
      }
    });
    return finish('json', bandNames, rows, warnings);
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const vtxLines = lines.filter((l) => /^vtxtable\s+band\s+\d+/i.test(l));
  if (vtxLines.length) {
    const rows: number[][] = [];
    const bandNames: string[] = [];
    for (const l of vtxLines) {
      // vtxtable band <n> <NAME> <LETTER> [FACTORY|CUSTOM] <f1> <f2> ...
      const parts = l.split(/\s+/);
      const nums = parts.filter((p) => MHZ.test(p)).map(Number);
      const name = parts[3] ?? String.fromCharCode(65 + rows.length);
      if (nums.length) {
        rows.push(nums);
        bandNames.push(name);
      }
    }
    if (lines.length !== vtxLines.length && !lines.every((l) => /^vtxtable/i.test(l))) warnings.push('Строки, не начинающиеся с vtxtable, пропущены');
    return finish('vtxtable', bandNames, rows, warnings);
  }

  const rows: number[][] = [];
  const bandNames: string[] = [];
  for (const l of lines) {
    const cells = l.split(/[;,\t]+|\s{1,}/).map((c) => c.trim()).filter(Boolean);
    const nums = cells.filter((c) => MHZ.test(c)).map(Number);
    if (nums.length === 0) {
      if (rows.length === 0) continue; // header line
      warnings.push(`Строка без частот пропущена: «${l.slice(0, 40)}»`);
      continue;
    }
    const label = cells.find((c) => !MHZ.test(c));
    rows.push(nums);
    bandNames.push(label ?? String.fromCharCode(65 + rows.length - 1));
  }
  return finish('csv', bandNames, rows, warnings);
}

function finish(format: 'vtxtable' | 'csv' | 'json', bandNames: string[], rows: number[][], warnings: string[]): FreqFileResult {
  if (rows.length === 0) return { ok: false, error: 'Не найдено ни одной строки с частотами (ожидаются 4-значные МГц)' };
  if (rows.length > 8) return { ok: false, error: `Слишком много бэндов: ${rows.length} (максимум 8)` };
  const width = Math.max(...rows.map((r) => r.length));
  if (width > 16) return { ok: false, error: `Слишком много каналов в бэнде: ${width} (максимум 16)` };
  if (rows.some((r) => r.length !== width)) warnings.push('Бэнды разной длины — короткие строки нужно дополнить вручную');
  return { ok: true, format, bandNames, freqTable: rows, warnings };
}

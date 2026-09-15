/**
 * Blackbox (.bbl / .TXT) container parser — INAV/Betaflight format.
 * We parse headers and log boundaries exactly; frame payloads are not decoded here
 * (that is what INAV Blackbox Explorer does). Enough to answer: which firmware wrote the log,
 * how many flights, how long, and whether each log ended cleanly or was cut (power loss / crash).
 */

export interface BlackboxLogSummary {
  index: number;
  offset: number;
  sizeBytes: number;
  headers: Record<string, string>;
  firmware: string | null; // "Firmware revision" header
  board: string | null; // "Board information"
  craftName: string | null;
  /** looptime-derived data rate in Hz, when I interval / looptime are present */
  logRateHz: number | null;
  /** `E` frame type 255 with "End of log" marker found */
  cleanEnd: boolean;
  /** Approximate count of frame markers by type (I/P/S/E/G/H) — heuristic, first byte after header. */
  frameHint: Record<string, number>;
}

export interface BlackboxFileSummary {
  sizeBytes: number;
  logs: BlackboxLogSummary[];
  warnings: string[];
}

const MAGIC = 'H Product:Blackbox flight data recorder by Nicholas Sherlock';

function indexOfSeq(buf: Uint8Array, seq: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= buf.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

export function parseBlackboxFile(bytes: Uint8Array): BlackboxFileSummary {
  const enc = new TextEncoder();
  const magic = enc.encode(MAGIC);
  const endMarker = enc.encode('End of log');
  const warnings: string[] = [];
  const starts: number[] = [];
  let p = 0;
  while ((p = indexOfSeq(bytes, magic, p)) >= 0) {
    starts.push(p);
    p += magic.length;
  }
  if (!starts.length) {
    warnings.push('Заголовок Blackbox не найден — это не .bbl/.TXT лог INAV/Betaflight (или файл повреждён)');
    return { sizeBytes: bytes.length, logs: [], warnings };
  }
  const logs: BlackboxLogSummary[] = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : bytes.length;
    const chunk = bytes.subarray(start, end);
    const headers: Record<string, string> = {};
    let pos = 0;
    // header lines: "H key:value\n" until the first non-'H' line start
    while (pos < chunk.length && chunk[pos] === 0x48 /* H */ && chunk[pos + 1] === 0x20) {
      let nl = pos;
      while (nl < chunk.length && chunk[nl] !== 0x0a) nl++;
      const line = new TextDecoder().decode(chunk.subarray(pos + 2, nl));
      const c = line.indexOf(':');
      if (c > 0) headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
      pos = nl + 1;
    }
    const dataStart = pos;
    const data = chunk.subarray(dataStart);
    const frameHint: Record<string, number> = {};
    for (const t of ['I', 'P', 'S', 'E', 'G', 'H']) frameHint[t] = 0;
    // heuristic: count bytes equal to frame letters immediately after a 0x00-free position is not possible
    // without decoding; instead count occurrences of each letter — relative shares are still informative.
    for (const b of data) {
      const ch = String.fromCharCode(b);
      if (ch in frameHint) frameHint[ch]!++;
    }
    const cleanEnd = indexOfSeq(data, endMarker) >= 0;
    const looptime = Number(headers['looptime'] ?? 0);
    const iInterval = Number(headers['I interval'] ?? 0);
    const pDen = /(\d+)\/(\d+)/.exec(headers['P interval'] ?? '');
    let logRateHz: number | null = null;
    if (looptime > 0) {
      const base = 1_000_000 / looptime;
      logRateHz = pDen ? Math.round((base * Number(pDen[1])) / Number(pDen[2])) : iInterval > 0 ? Math.round(base) : Math.round(base);
    }
    return {
      index: i,
      offset: start,
      sizeBytes: chunk.length,
      headers,
      firmware: headers['Firmware revision'] ?? null,
      board: headers['Board information'] ?? null,
      craftName: headers['Craft name'] ?? null,
      logRateHz,
      cleanEnd,
      frameHint
    };
  });
  for (const l of logs) {
    if (!l.cleanEnd) warnings.push(`Лог #${l.index + 1}: нет маркера "End of log" — запись оборвана (потеря питания/удар/сброс)`);
    if (l.sizeBytes < 4096) warnings.push(`Лог #${l.index + 1}: очень короткий (${l.sizeBytes} байт) — вероятно, arming без полёта или сбой записи`);
  }
  return { sizeBytes: bytes.length, logs, warnings };
}

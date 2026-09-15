/**
 * «Реле взвода»: an RC channel range arms the board (USER3 mode) and the same channel is mirrored to a servo output
 * that acts as a relay — PWM (Молния, S6) or logic level (Утка, S9). Generates INAV CLI lines with a plain explanation
 * of what each one does.
 *
 * INAV assigns output pins to servos in order of *used* servo indices after the motor outputs: with 2 motors and
 * rules for servos 1..5, servo 4 lands on S6. Reaching a higher pin requires filler rules for the indices in between.
 */
export type RelayKind = 'pwm' | 'logic';

export interface ArmRelayConfig {
  board: 'molniya' | 'utka' | 'custom';
  /** RC channel (1-based) carrying the arm command, e.g. 8 */
  rcChannel: number;
  rangeMin: number;
  rangeMax: number;
  /** output pin S<n>, 1-based */
  outputPin: number;
  motors: number;
  kind: RelayKind;
  armedUs: number;
  disarmedUs: number;
  /** servo indices already used by the board's own mixer (from the diff) */
  usedServos: number[];
  /** optional second relay input from the other board (reciprocal arming) */
  peerChannel: number | null;
}

export const ARM_RELAY_PRESETS: Record<'molniya' | 'utka', Partial<ArmRelayConfig> & { name: string; note: string }> = {
  molniya: {
    name: 'Молния — S6, PWM-реле',
    note: 'Штатная схема с летающей Молнии: USER3 на CH8 (1700–2100), тот же CH8 через smix идёт на servo 4 → пин S6 как PWM 2000 мкс во взведённом состоянии, ~1200 в покое.',
    rcChannel: 8, rangeMin: 1700, rangeMax: 2100, outputPin: 6, motors: 2, kind: 'pwm', armedUs: 2000, disarmedUs: 1200, usedServos: [1, 2, 3, 4, 5]
  },
  utka: {
    name: 'Утка — S9, логический уровень',
    note: 'Другая распиновка: на S9 нужен высокий уровень при USER3 CH8 (1700–2100). Пин S9 при 2 моторах — это 7-й используемый servo; индексы между штатными сервами добиваются пустыми правилами (rate 0).',
    rcChannel: 8, rangeMin: 1700, rangeMax: 2100, outputPin: 9, motors: 2, kind: 'logic', armedUs: 2000, disarmedUs: 1000, usedServos: [1, 2, 3, 4, 5]
  }
};

export const ARM_RELAY_DEFAULT: ArmRelayConfig = { board: 'molniya', ...ARM_RELAY_PRESETS.molniya, peerChannel: null } as ArmRelayConfig;

const BOX_USER3 = 48;
const INPUT_MAX = 29; // constant source, used with rate 0 as a filler

/** INAV smix input id for RC channel n (1-based). */
export function rcInput(ch: number): number | null {
  if (ch >= 1 && ch <= 4) return 3 + ch; // roll/pitch/yaw/throttle → 4..7
  if (ch >= 5 && ch <= 8) return 3 + ch; // CH5..CH8 → 8..11
  if (ch >= 9 && ch <= 16) return 6 + ch; // CH9..CH16 → 15..22
  return null;
}

/** Which servo index ends up on pin S<pin> given motors and used servos (ascending). */
export function servoForPin(pin: number, motors: number, used: number[]): { servo: number; fillers: number[] } | null {
  const position = pin - motors; // 1-based among used servos
  if (position < 1) return null;
  const sorted = [...new Set(used)].sort((a, b) => a - b);
  if (position <= sorted.length) return { servo: sorted[position - 1]!, fillers: [] };
  const fillers: number[] = [];
  let next = (sorted[sorted.length - 1] ?? 0) + 1;
  for (let i = sorted.length + 1; i < position; i++) fillers.push(next++);
  if (next > 15) return null;
  return { servo: next, fillers };
}

export interface ArmRelayResult { lines: string[]; explain: string[]; errors: string[] }

export function armRelayLines(c: ArmRelayConfig, existingSmixCount: number, existingAuxSlots: number[]): ArmRelayResult {
  const errors: string[] = [];
  const explain: string[] = [];
  const lines: string[] = [];
  const input = rcInput(c.rcChannel);
  if (!input || c.rcChannel < 5) errors.push('Канал взвода должен быть CH5…CH16 (первые четыре — стики).');
  if (c.rangeMin >= c.rangeMax || c.rangeMin < 900 || c.rangeMax > 2100) errors.push('Диапазон канала: 900…2100, от < до.');
  const target = servoForPin(c.outputPin, c.motors, c.usedServos);
  if (!target) errors.push(`Пин S${c.outputPin} недостижим при ${c.motors} моторах — выходы под моторами или слишком далеко.`);
  if (errors.length || !input || !target) return { lines, explain, errors };

  let aux = 0;
  while (existingAuxSlots.includes(aux)) aux++;
  lines.push(`aux ${aux} ${BOX_USER3} ${c.rcChannel - 5} ${c.rangeMin} ${c.rangeMax}`);
  explain.push(`aux ${aux}: режим USER3 включается, когда CH${c.rcChannel} в ${c.rangeMin}–${c.rangeMax} мкс.`);

  let rule = existingSmixCount;
  for (const f of target.fillers) {
    lines.push(`smix ${rule++} ${f} ${INPUT_MAX} 0 0 -1`);
    explain.push(`smix для servo ${f}: пустое правило (rate 0), только чтобы занять выход и сдвинуть нумерацию к S${c.outputPin}.`);
  }
  const mid = c.kind === 'logic' ? 1000 : c.disarmedUs;
  lines.push(`servo ${target.servo} 1000 2000 ${mid} 100`);
  lines.push(`smix ${rule++} ${target.servo} ${input} 100 0 -1`);
  explain.push(`servo ${target.servo} → пин S${c.outputPin}: повторяет CH${c.rcChannel}. Взведено → ~${c.armedUs} мкс${c.kind === 'logic' ? ' (высокий уровень)' : ' (PWM)'}, покой → ~${mid} мкс.`);
  if (c.peerChannel && c.peerChannel !== c.rcChannel) {
    const peer = rcInput(c.peerChannel);
    if (peer) {
      lines.push(`smix ${rule++} ${target.servo} ${peer} 100 0 -1`);
      explain.push(`второе правило на тот же выход: сигнал взвода с другого борта по CH${c.peerChannel} тоже поднимает реле (правила суммируются).`);
    }
  }
  explain.push('Проверка: после save в CLI `status` (ARMING flags), затем CH8 → 2000 и осциллограф/мультиметр на пине — уровень должен подняться.');
  return { lines, explain, errors };
}

/** Pulls used servo indices, smix rule count and aux slots out of a `diff all` so new lines do not collide. */
export function relayContext(diff: string | undefined): { usedServos: number[]; smixCount: number; auxSlots: number[]; motors: number } {
  if (!diff) return { usedServos: [1, 2, 3, 4, 5], smixCount: 5, auxSlots: [], motors: 2 };
  const used = new Set<number>();
  let smixCount = 0;
  for (const m of diff.matchAll(/^smix\s+(\d+)\s+(\d+)\s/gm)) { smixCount = Math.max(smixCount, Number(m[1]) + 1); used.add(Number(m[2])); }
  const auxSlots = [...diff.matchAll(/^aux\s+(\d+)\s/gm)].map((m) => Number(m[1]));
  const motors = [...diff.matchAll(/^mmix\s+\d+\s/gm)].length || 2;
  return { usedServos: [...used].sort((a, b) => a - b), smixCount, auxSlots, motors };
}

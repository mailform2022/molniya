import { describe, expect, it } from 'vitest';
import { ARM_RELAY_DEFAULT, ARM_RELAY_PRESETS, armRelayLines, relayContext, servoForPin, type ArmRelayConfig } from './armrelay';
import { OSD_DEFAULT_LAYOUT, osdLayoutLines, osdPlacementsFromDiff } from './osd';

// Real `diff all` from the flying Молния (INAV 7.1.2 / 889d6f08): USER3 on CH8 → servo 4 → pin S6.
const MOLNIYA_DIFF = `
aux 8 48 3 1700 2100
mmix 0  1.000  0.000  0.000 -0.500
mmix 1  1.000  0.000  0.000  0.500
smix 0 1 1 100 0 -1
smix 1 2 0 100 0 -1
smix 2 3 0 100 0 -1
smix 3 4 11 100 0 -1
smix 4 5 16 100 0 -1
`;

describe('arm relay generator', () => {
  it('reproduces the stock Молния S6 relay (aux USER3 CH8, servo 4 from input 11)', () => {
    const ctx = relayContext(MOLNIYA_DIFF);
    expect(ctx).toEqual({ usedServos: [1, 2, 3, 4, 5], smixCount: 5, auxSlots: [8], motors: 2 });
    expect(servoForPin(6, 2, ctx.usedServos)).toEqual({ servo: 4, fillers: [] });

    const r = armRelayLines(ARM_RELAY_DEFAULT, ctx.smixCount, ctx.auxSlots);
    expect(r.errors).toEqual([]);
    expect(r.lines).toContain('aux 0 48 3 1700 2100');
    expect(r.lines).toContain('smix 5 4 11 100 0 -1');
    expect(r.lines).toContain('servo 4 1000 2000 1200 100');
  });

  it('Утка S9: logic level, fillers between servo 5 and the pin, peer arming from Молния', () => {
    const c: ArmRelayConfig = { ...ARM_RELAY_DEFAULT, board: 'utka', ...ARM_RELAY_PRESETS.utka, peerChannel: 9 };
    const ctx = relayContext(MOLNIYA_DIFF);
    expect(servoForPin(9, 2, ctx.usedServos)).toEqual({ servo: 7, fillers: [6] });
    const r = armRelayLines(c, ctx.smixCount, ctx.auxSlots);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      'aux 0 48 3 1700 2100',
      'smix 5 6 29 0 0 -1',
      'servo 7 1000 2000 1000 100',
      'smix 6 7 11 100 0 -1',
      'smix 7 7 15 100 0 -1'
    ]);
    expect(r.explain.join('\n')).toMatch(/высокий уровень/);
  });

  it('rejects stick channels, bad ranges and unreachable pins', () => {
    expect(armRelayLines({ ...ARM_RELAY_DEFAULT, rcChannel: 2 }, 0, []).errors.length).toBe(1);
    expect(armRelayLines({ ...ARM_RELAY_DEFAULT, rangeMin: 2100, rangeMax: 1700 }, 0, []).errors.length).toBe(1);
    expect(armRelayLines({ ...ARM_RELAY_DEFAULT, outputPin: 1 }, 0, []).errors.length).toBe(1);
  });
});

describe('osd zones', () => {
  it('places elements in five zones and hides disabled ones', () => {
    const lines = osdLayoutLines([
      { id: 41, zone: 'tl', enabled: true },
      { id: 9, zone: 'tl', enabled: true },
      { id: 0, zone: 'tr', enabled: true },
      { id: 1, zone: 'bl', enabled: true },
      { id: 24, zone: 'br', enabled: true },
      { id: 2, zone: 'center', enabled: true },
      { id: 42, zone: 'tr', enabled: false }
    ]);
    expect(lines).toContain('osd_layout 0 41 1 1 V');
    expect(lines).toContain('osd_layout 0 9 1 2 V');
    expect(lines).toContain('osd_layout 0 0 24 1 V');
    expect(lines).toContain('osd_layout 0 1 1 14 V');
    expect(lines).toContain('osd_layout 0 24 24 14 V');
    expect(lines).toContain('osd_layout 0 2 13 7 V');
    expect(lines).toContain('osd_layout 0 42 0 0 H');
  });

  it('round-trips zones through diff lines', () => {
    const lines = osdLayoutLines(OSD_DEFAULT_LAYOUT).join('\n');
    const back = osdPlacementsFromDiff(lines);
    expect(back).not.toBeNull();
    for (const p of OSD_DEFAULT_LAYOUT) {
      const b = back!.find((x) => x.id === p.id)!;
      expect(b.enabled).toBe(p.enabled);
      if (p.enabled) expect(b.zone).toBe(p.zone);
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifacts, cleanDiffLines, txYaml, usToPercent, validatePairs, type ArtifactInput } from './artifacts.js';

const pairs = [
  { band: 1, channel: 1, freqMhz: 3300, rcChannel: 9, rcLevel: 1000 },
  { band: 1, channel: 2, freqMhz: 3320, rcChannel: 9, rcLevel: 1250 },
  { band: 2, channel: 1, freqMhz: 3360, rcChannel: 9, rcLevel: 1500 }
];

const input: ArtifactInput = {
  target: 'CADDXF405_WING',
  uid: '0123456789abcdef',
  trust: 'verified',
  generatedAt: '2026-01-01T00:00:00.000Z',
  snapshot: { id: 'snap-1', takenAt: '2025-12-31T23:00:00.000Z' },
  fcFirmware: { id: 'fw-1', fileName: 'inav_7.1.2_CADDXF405_WING.hex', sha256: 'ab'.repeat(32), verification: 'flight_tested' },
  txFirmware: null,
  userDiff: 'set max_throttle = 2000\nservo 2 1000 2000 1500 100\nsave\n',
  diagnostic: { id: 'diag-1', logPath: 'flash', cliScript: '# logging\nfeature BLACKBOX\nset blackbox_device = SPIFLASH\nsave' },
  vtx: { modelName: 'SX33', freqSource: 'catalog', pairs },
  transmitter: { code: 'tx12mk2', profileId: null }
};

describe('artifacts', () => {
  it('strips terminal commands from user diff', () => {
    assert.deepEqual(cleanDiffLines('set a = 1\nsave\nexit\ndefaults noreboot\n\nreboot'), ['set a = 1']);
  });

  it('maps µs to EdgeTX percent', () => {
    assert.equal(usToPercent(1500), 0);
    assert.equal(usToPercent(1000), -98);
    assert.equal(usToPercent(2100), 100);
  });

  it('is deterministic and ends the FC script with a single save', () => {
    const a = buildArtifacts(input);
    const b = buildArtifacts(input);
    assert.deepEqual(a, b);
    const saves = a.fcScript.split('\n').filter((l) => l === 'save');
    assert.equal(saves.length, 1);
    assert.equal(a.fcScript.endsWith('save\n'), true);
    assert.ok(a.fcScript.includes('set max_throttle = 2000'));
    assert.ok(a.fcScript.includes('set blackbox_device = SPIFLASH'));
    assert.ok(a.fcScript.includes('#   A1 3300 ch9 1000'));
    assert.match(a.hashes.fcScript, /^[0-9a-f]{64}$/);
  });

  it('bundle carries provenance', () => {
    const j = JSON.parse(buildArtifacts(input).fcBundle) as { snapshotId: string; firmware: { sha256: string }; userDiff: string[] };
    assert.equal(j.snapshotId, 'snap-1');
    assert.equal(j.firmware.sha256, 'ab'.repeat(32));
    assert.ok(!j.userDiff.includes('save'));
  });

  it('YAML uses 0-based band and channel index', () => {
    const y = txYaml(pairs, 'SX33 "3.3"');
    assert.ok(y.includes('channel: 8\n'));
    assert.ok(y.includes('pairCount: 3'));
    assert.ok(y.includes('band: 0\n          channel: 1\n          value: -98'));
    assert.ok(y.includes('name: "SX33 3.3"'));
  });

  it('validates pairs', () => {
    assert.equal(validatePairs(pairs), null);
    assert.match(validatePairs([]), /нет пар/);
    assert.match(validatePairs([...pairs, { band: 1, channel: 1, freqMhz: 3300, rcChannel: 9, rcLevel: 1900 }]), /дубликат A1/);
    assert.match(validatePairs([pairs[0]!, { ...pairs[1]!, rcLevel: 1000 }]), /одинаковый уровень/);
    assert.match(validatePairs([pairs[0]!, { ...pairs[1]!, rcLevel: 1020 }]), /слишком близко/);
    assert.match(validatePairs([pairs[0]!, { ...pairs[1]!, rcChannel: 10 }]), /один RC-канал/);
    assert.match(validatePairs([{ ...pairs[0]!, freqMhz: 900 }]), /вне диапазона/);
  });
});

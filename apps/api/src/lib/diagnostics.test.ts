import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCrash, buildDiagnosticScript, classifyTrust } from './diagnostics.js';
import { parseFrequencyFile } from './freqfile.js';

const verified = [
  { fcTarget: 'CADDXF405_WING', inavVersion: '7.1', status: 'verified' },
  { fcTarget: 'SPEEDYBEEF405WING', inavVersion: '7.1.2', status: 'experimental' },
  { fcTarget: 'MATEKF405', inavVersion: '8', status: 'banned' }
];

test('trust: prefix match, experimental, banned, unknown', () => {
  assert.equal(classifyTrust('caddxf405_wing', '7.1.2', verified), 'verified');
  assert.equal(classifyTrust('CADDXF405_WING', '7.2.0', verified), 'unverified');
  assert.equal(classifyTrust('SPEEDYBEEF405WING', '7.1.2', verified), 'experimental');
  assert.equal(classifyTrust('SPEEDYBEEF405WING', '8.0.0', verified), 'unverified');
  assert.equal(classifyTrust('MATEKF405', '8.0.1', verified), 'banned');
});

test('diagnostic script keeps user diff, owns logging settings, ends with save', () => {
  const s = buildDiagnosticScript(
    { logPath: 'serial_host', rateDenom: 4, debugMode: 'gyro', serialPort: 2, userDiff: 'set max_throttle = 1900\nset blackbox_device = SPIFLASH\nsave\nfeature GPS' },
    '# INAV/SPEEDYBEEF405WING 7.1.2'
  );
  const lines = s.trim().split('\n');
  assert.ok(lines.includes('set max_throttle = 1900'));
  assert.ok(lines.includes('feature GPS'));
  assert.ok(!lines.includes('set blackbox_device = SPIFLASH'));
  assert.ok(lines.includes('set blackbox_device = SERIAL'));
  assert.ok(lines.includes('set blackbox_rate_denom = 4'));
  assert.ok(lines.includes('set debug_mode = GYRO'));
  assert.ok(lines.includes('serial 2 128 115200 115200 0 115200'));
  assert.equal(lines.filter((l) => l === 'save').length, 1);
  assert.equal(lines.at(-1), 'save');
  assert.match(s, /not onboard blackbox/);
});

test('crash analysis ranks critical diff changes and empty logs', () => {
  const before = '# INAV/SPEEDYBEEF405WING 7.1.2\nset failsafe_procedure = RTH\nset max_throttle = 1850\nservo 1 1000 2000 1500 100\n';
  const after = '# INAV/SPEEDYBEEF405WING 7.1.2\nset failsafe_procedure = DROP\nset max_throttle = 1850\nservo 1 1000 2000 1500 -100\n';
  const a = analyzeCrash(before, after, [{ kind: 'blackbox', name: 'LOG00001.TXT', bytes: new Uint8Array([0, 0, 0]) }]);
  assert.ok(a.diff);
  assert.equal(a.diff.criticalCount >= 1, true);
  assert.equal(a.findings[0]!.severity, 'critical');
  assert.ok(a.findings.some((f) => /failsafe_procedure/.test(f.text)));
  assert.ok(a.findings.some((f) => /нет заголовков blackbox/.test(f.text)));
  assert.ok(a.findings.some((f) => /servo/.test(f.text)));

  const none = analyzeCrash(null, after, []);
  assert.equal(none.diff, null);
  assert.ok(none.findings.every((f) => f.severity === 'info'));
});

test('frequency file: vtxtable dump, csv with band labels, json', () => {
  const vt = parseFrequencyFile('vtxtable bands 2\nvtxtable channels 3\nvtxtable band 1 BOSCAM_A A FACTORY 5865 5845 5825\nvtxtable band 2 BOSCAM_B B FACTORY 5733 5752 5771\n');
  assert.ok(vt.ok);
  assert.equal(vt.format, 'vtxtable');
  assert.deepEqual(vt.freqTable, [[5865, 5845, 5825], [5733, 5752, 5771]]);
  assert.deepEqual(vt.bandNames, ['BOSCAM_A', 'BOSCAM_B']);

  const csv = parseFrequencyFile('band;ch1;ch2\nA;3330;3360\nB;3390;3420\n', 'grid.csv');
  assert.ok(csv.ok);
  assert.equal(csv.format, 'csv');
  assert.deepEqual(csv.freqTable, [[3330, 3360], [3390, 3420]]);
  assert.deepEqual(csv.bandNames, ['A', 'B']);

  const js = parseFrequencyFile(JSON.stringify({ bands: [{ name: 'X', freqs: [3300, 3330] }] }));
  assert.ok(js.ok && js.freqTable[0]![1] === 3330);

  const bad = parseFrequencyFile('hello world');
  assert.ok(!bad.ok);
});

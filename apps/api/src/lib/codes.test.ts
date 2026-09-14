import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, parseCode, toEncoderForm } from './codes.js';
import { analyzeDiff, vtxTableDiff } from './diff.js';
import { deviceAuthToken, hashPassword, verifyPassword, encryptSecret, decryptSecret } from './crypto.js';

test('MLN code roundtrip + tamper detection', () => {
  const c = generateCode('ACT', 'BASE', 30, 3);
  assert.match(c.code, /^MLN-ACT-BASE-30D-3X[A-Z2-9]{4}-[A-Z2-9]{6}$/);
  const p = parseCode(c.code.toLowerCase());
  assert.ok(p);
  assert.equal(p.durationDays, 30);
  assert.equal(p.devices, 3);
  assert.equal(parseCode(c.code.replace('30D', '90D')), null);
  assert.match(toEncoderForm(c), /^\d{13}$/);
});

test('diff analyzer', () => {
  const a = analyzeDiff('set vtx_band = 1\nset vtx_band = 2\nfeature GPS\nfeature -GPS\nfoo bar\n# comment\nsave');
  assert.equal(a.commands, 6);
  assert.deepEqual(a.unknown, ['foo bar']);
  assert.equal(a.conflicts.length, 2);
  assert.match(vtxTableDiff([[3330, 3360], [3390, 3420]]), /vtxtable band 2 BAND2 B CUSTOM 3390 3420/);
});

test('crypto helpers', () => {
  const h = hashPassword('secret123');
  assert.ok(verifyPassword('secret123', h));
  assert.ok(!verifyPassword('secret124', h));
  assert.equal(decryptSecret(encryptSecret('JBSWY3DP')), 'JBSWY3DP');
  assert.equal(deviceAuthToken('ABC', 'BASE', 1).length, 32);
});

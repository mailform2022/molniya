import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFirmwareImage, imageMatchesBoard } from './image.js';

/** Same shape as the real SpeedyBee F405 Wing dump: vectors, INAV strings, config at 0xE0000. */
function fakeF4Dump(opts: { config?: boolean; variant?: string } = {}): Uint8Array {
  const b = new Uint8Array(1024 * 1024).fill(0xff);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x10010000, true);
  dv.setUint32(4, 0x080007c9, true);
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i);
    b[off + s.length] = 0;
  };
  put(0x8e000, opts.variant ?? 'INAV-UTKA');
  put(0x8e100, 'SPEEDYBEEF405WING');
  put(0x8e200, '8.0.1');
  put(0x8e300, 'Jul  5 2026');
  put(0x8e400, '13.2.1 20231009');
  put(0x8e500, 'SpeedyBee F405 Wing');
  if (opts.config !== false) {
    b[0xe0000] = 0x7e;
    b[0xe0001] = 0x07;
    dv.setUint16(0xe0002, 0x0a00, true);
  }
  return b;
}

test('image: identifies INAV build strings, layout and config sector', () => {
  const i = analyzeFirmwareImage(fakeF4Dump());
  assert.equal(i.vectorTableOk, true);
  assert.equal(i.layout, 'stm32f4_1m');
  assert.equal(i.fcVariant, 'INAV-UTKA');
  assert.equal(i.target, 'SPEEDYBEEF405WING');
  assert.equal(i.version, '8.0.1');
  assert.equal(i.buildDate, 'Jul 5 2026');
  assert.equal(i.usbProductString, 'SpeedyBee F405 Wing');
  assert.equal(i.configSector?.present, true);
  assert.equal(i.configSector?.eepromVersion, 0x7e);
  assert.deepEqual(i.warnings, []);
  assert.deepEqual(imageMatchesBoard(i, { target: 'SPEEDYBEEF405WING', version: '8.0.1', variant: 'INAV' }), []);
});

test('image: empty config sector and board mismatch are reported', () => {
  const i = analyzeFirmwareImage(fakeF4Dump({ config: false }));
  assert.equal(i.configSector?.present, false);
  assert.ok(i.warnings.some((w) => /Сектор конфигурации/.test(w)));
  const problems = imageMatchesBoard(i, { target: 'MOLNIYAF405WING', version: '7.1.2', variant: 'INAV' });
  assert.equal(problems.length, 2);
});

test('image: hex/garbage is rejected as non-flash-dump', () => {
  const text = new TextEncoder().encode(':020000040800F2\n:10000000...\n'.repeat(200));
  const i = analyzeFirmwareImage(text);
  assert.equal(i.vectorTableOk, false);
  assert.equal(i.layout, null);
  assert.ok(i.warnings.length >= 1);
});

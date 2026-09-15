import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc8DvbS2Buf, encodeV2, MspParser } from './codec.js';
import { MspClient } from './client.js';
import { EmulatedFc } from './emulator.js';
import { parseVtxInfo, validateFreqTable } from './vtxinfo.js';

test('crc8 dvb-s2 known vector', () => {
  // MSP2 header flags=0 code=0x2000 len=0 → CRC of [00 00 20 00 00]
  assert.equal(crc8DvbS2Buf(new Uint8Array([0x01, 0x02, 0x03])), 0x3f);
  const f = encodeV2(0x2000);
  assert.deepEqual(Array.from(f.subarray(0, 3)), [0x24, 0x58, 0x3c]);
  assert.equal(f.length, 9);
});

test('parser round-trips v2 frame in fragments', () => {
  const got: number[] = [];
  const p = new MspParser((m) => got.push(m.code, m.payload.length));
  const f = encodeV2(0x2f10, new Uint8Array([1, 2, 3]));
  f[2] = 0x3e;
  p.feed(f.subarray(0, 4));
  p.feed(f.subarray(4));
  assert.deepEqual(got, [0x2f10, 3]);
});

test('client talks to emulated FC incl. custom 0x2F1x/0x2F2x', async () => {
  const fc = new EmulatedFc();
  const c = new MspClient(fc.transport, { timeoutMs: 200, retries: 1 });
  await c.open();
  assert.equal(await c.fcVariant(), 'INAV');
  assert.equal(await c.fcVersion(), '7.1.2');
  assert.equal((await c.boardInfo()).targetName, 'CADDXF405_WING');
  assert.equal((await c.vtxMapRead()).length, 3);
  await c.vtxMapWrite([{ band: 2, channel: 4, freqMhz: 3450, rcChannel: 9, rcLevel: 1800 }]);
  assert.deepEqual(await c.vtxMapRead(), [{ band: 2, channel: 4, freqMhz: 3450, rcChannel: 9, rcLevel: 1800 }]);
  await c.vtxMapLive(9, 1234);
  assert.equal(fc.state.rc[8], 1234);
  assert.equal((await c.getUid()).length, 24);
  assert.equal((await c.getAuthStatus()).authorized, false);
  await c.setAuthToken(new Uint8Array(32));
  const st = await c.getAuthStatus();
  assert.equal(st.authorized, true);
  assert.equal(st.plan, 'BASE');
  await assert.rejects(c.request(0x1234), /rejected/);
  await c.close();
});

test('vtx_info parser + validation', () => {
  const i = parseVtxInfo('name: SX33\nprotocol: smartaudio\nbands: 1\nchannels: 3\nfreq_table: 3330,3360,3360\nraw_status: AA 55 01');
  assert.equal(i.name, 'SX33');
  assert.deepEqual(i.rawStatus, [0xaa, 0x55, 1]);
  const errs = validateFreqTable(i.freqTable, [3300, 3700]);
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /дубликат/);
});

test('snapshot: CLI session, diff all, blackbox capability on emulated boards', async () => {
  const { takeFcSnapshot, parseDiff, compareDiff } = await import('./snapshot.js');
  const { defaultEmulatedFc } = await import('./emulator.js');

  const molniya = new EmulatedFc(defaultEmulatedFc('molniya'));
  const c1 = new MspClient(molniya.transport, { timeoutMs: 200, retries: 1 });
  await c1.open();
  const s1 = await takeFcSnapshot(c1);
  assert.equal(s1.target, 'CADDXF405_WING');
  assert.equal(s1.capability.recommended, 'flash');
  assert.ok(s1.diffAll && /set max_throttle = 1850/.test(s1.diffAll));
  assert.ok(s1.statusText && /Dataflash/.test(s1.statusText));

  const utka = new EmulatedFc(defaultEmulatedFc('utka'));
  const c2 = new MspClient(utka.transport, { timeoutMs: 200, retries: 1 });
  await c2.open();
  const s2 = await takeFcSnapshot(c2);
  assert.equal(s2.target, 'SPEEDYBEEF405WING');
  assert.equal(s2.capability.recommended, 'serial_host');
  assert.equal(s2.vtxMap, null); // stock INAV: 0x2F10 rejected

  // change a critical setting and compare
  const sess = await c2.cliSession();
  await sess.run('set nav_fw_launch_thr = 1900');
  const after = await sess.run('diff all', 3000);
  await sess.end('exit');
  const cmp = compareDiff(parseDiff(s2.diffAll!), parseDiff(after));
  assert.equal(cmp.settings.length, 1);
  assert.equal(cmp.settings[0]!.key, 'nav_fw_launch_thr');
  assert.ok(cmp.settings[0]!.critical);
  assert.equal(cmp.criticalCount, 1);
});

test('blackbox container parser: headers, multiple logs, clean end detection', async () => {
  const { parseBlackboxFile } = await import('./blackbox.js');
  const hdr = (fw: string) =>
    `H Product:Blackbox flight data recorder by Nicholas Sherlock\nH Data version:2\nH Firmware revision:${fw}\nH Board information:SBF4 SPEEDYBEEF405WING\nH Craft name:Utka\nH looptime:1000\nH P interval:1/2\n`;
  const body = new Uint8Array(5000).fill(0x50);
  const enc = new TextEncoder();
  const log1 = [...enc.encode(hdr('INAV 7.1.2 (abc) SPEEDYBEEF405WING')), ...body, ...enc.encode('E\xffEnd of log\0')];
  const log2 = [...enc.encode(hdr('INAV 7.1.2 (abc) SPEEDYBEEF405WING')), ...body];
  const res = parseBlackboxFile(new Uint8Array([...log1, ...log2]));
  assert.equal(res.logs.length, 2);
  assert.equal(res.logs[0]!.cleanEnd, true);
  assert.equal(res.logs[1]!.cleanEnd, false);
  assert.equal(res.logs[0]!.logRateHz, 500);
  assert.equal(res.logs[0]!.board, 'SBF4 SPEEDYBEEF405WING');
  assert.ok(res.warnings.some((w) => /#2/.test(w)));
});

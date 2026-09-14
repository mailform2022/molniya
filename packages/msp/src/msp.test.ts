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

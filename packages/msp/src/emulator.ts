import { encodeV1, encodeV2, MspMessage, MspParser, PayloadReader, PayloadWriter } from './codec.js';
import { AuthStatus, MSP, MSP2, MSP2_VTX, VtxPair } from './codes.js';
import { LoopbackTransport } from './transport.js';

export interface EmulatedFcState {
  variant: string;
  version: [number, number, number];
  boardId: string;
  targetName: string;
  uid: string; // 24 hex chars
  vtx: { deviceType: number; band: number; channel: number; power: number; pitMode: number; freqMhz: number };
  pairs: VtxPair[];
  auth: AuthStatus;
  rc: number[]; // 16 channels
  live?: { rcChannel: number; rcLevel: number };
}

export function defaultEmulatedFc(): EmulatedFcState {
  return {
    variant: 'INAV',
    version: [7, 1, 2],
    boardId: 'CDF4',
    targetName: 'CADDXF405_WING',
    uid: '0123456789abcdef00112233',
    vtx: { deviceType: 3, band: 1, channel: 1, power: 1, pitMode: 0, freqMhz: 3330 },
    pairs: [
      { band: 1, channel: 1, freqMhz: 3330, rcChannel: 8, rcLevel: 1000 },
      { band: 1, channel: 2, freqMhz: 3360, rcChannel: 8, rcLevel: 1500 },
      { band: 1, channel: 3, freqMhz: 3390, rcChannel: 8, rcLevel: 2000 }
    ],
    auth: { authorized: false, plan: '', expiresAt: 0, deviceLimit: 3, devicesUsed: 0 },
    rc: Array.from({ length: 16 }, () => 1500)
  };
}

/** Software FC that answers MSP; used by BoardEmulator and unit tests. */
export class EmulatedFc {
  readonly transport: LoopbackTransport;
  private parser: MspParser;
  private replies: Uint8Array[] = [];

  constructor(public state: EmulatedFcState = defaultEmulatedFc()) {
    this.parser = new MspParser((m) => this.replies.push(this.handle(m)), true);
    this.transport = new LoopbackTransport((frame) => {
      this.replies = [];
      this.parser.feed(frame);
      if (!this.replies.length) return null;
      const total = this.replies.reduce((n, r) => n + r.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const r of this.replies) {
        out.set(r, o);
        o += r.length;
      }
      return out;
    });
  }

  private reply(m: MspMessage, payload: Uint8Array): Uint8Array {
    if (m.version === 1) {
      const f = encodeV1(m.code, payload);
      f[2] = 0x3e;
      f[f.length - 1] = f.subarray(3, f.length - 1).reduce((c, b) => c ^ b, 0);
      return f;
    }
    const f = encodeV2(m.code, payload, 0);
    f[2] = 0x3e;
    return f;
  }

  private error(m: MspMessage): Uint8Array {
    const f = this.reply(m, new Uint8Array(0));
    f[2] = 0x21;
    return f;
  }

  private handle(m: MspMessage): Uint8Array {
    const s = this.state;
    const w = new PayloadWriter();
    switch (m.code) {
      case MSP.FC_VARIANT:
        return this.reply(m, w.ascii(s.variant).build());
      case MSP.FC_VERSION:
        return this.reply(m, w.u8(s.version[0]).u8(s.version[1]).u8(s.version[2]).build());
      case MSP.BOARD_INFO:
        return this.reply(m, w.ascii(s.boardId).u16(0).u8(2).u8(0).u8(s.targetName.length).ascii(s.targetName).build());
      case MSP.UID: {
        for (let i = 0; i < 3; i++) w.u32(parseInt(s.uid.slice(i * 8, i * 8 + 8), 16));
        return this.reply(m, w.build());
      }
      case MSP.VTX_CONFIG:
        return this.reply(m, w.u8(s.vtx.deviceType).u8(s.vtx.band).u8(s.vtx.channel).u8(s.vtx.power).u8(s.vtx.pitMode).u16(s.vtx.freqMhz).build());
      case MSP.RC:
        for (const v of s.rc) w.u16(v);
        return this.reply(m, w.build());
      case MSP.EEPROM_WRITE:
        return this.reply(m, w.build());
      case MSP2.INAV_MISC:
        return this.reply(m, w.u16(1500).u16(1000).u16(1000).u16(2000).u16(1000).u16(1000).build());
      case MSP2_VTX.VTX_MAP_READ:
        w.u8(s.pairs.length);
        for (const p of s.pairs) w.u8(p.band).u8(p.channel).u16(p.freqMhz).u8(p.rcChannel).u16(p.rcLevel);
        return this.reply(m, w.build());
      case MSP2_VTX.VTX_MAP_WRITE: {
        const r = new PayloadReader(m.payload);
        const n = r.u8();
        const pairs: VtxPair[] = [];
        for (let i = 0; i < n; i++) pairs.push({ band: r.u8(), channel: r.u8(), freqMhz: r.u16(), rcChannel: r.u8(), rcLevel: r.u16() });
        s.pairs = pairs;
        return this.reply(m, w.build());
      }
      case MSP2_VTX.VTX_MAP_SET: {
        const r = new PayloadReader(m.payload);
        const idx = r.u8();
        const pair: VtxPair = { band: r.u8(), channel: r.u8(), freqMhz: r.u16(), rcChannel: r.u8(), rcLevel: r.u16() };
        if (idx > s.pairs.length) return this.error(m);
        s.pairs[idx] = pair;
        return this.reply(m, w.build());
      }
      case MSP2_VTX.VTX_MAP_LIVE: {
        const r = new PayloadReader(m.payload);
        s.live = { rcChannel: r.u8(), rcLevel: r.u16() };
        s.rc[s.live.rcChannel - 1] = s.live.rcLevel;
        return this.reply(m, w.build());
      }
      case MSP2_VTX.GET_UID:
        return this.reply(m, w.bytes(s.uid.match(/../g)!.map((h) => parseInt(h, 16))).build());
      case MSP2_VTX.SET_AUTH_TOKEN:
        s.auth = { ...s.auth, authorized: m.payload.length > 0, plan: 'BASE', expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400 };
        return this.reply(m, w.build());
      case MSP2_VTX.GET_AUTH_STATUS:
        return this.reply(m, w.u8(s.auth.authorized ? 1 : 0).u8(s.auth.plan.length).ascii(s.auth.plan).u32(s.auth.expiresAt).u8(s.auth.deviceLimit).u8(s.auth.devicesUsed).build());
      default:
        return this.error(m);
    }
  }
}

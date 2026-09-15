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
  /** Onboard blackbox storage as reported by MSP_DATAFLASH_SUMMARY / MSP_SDCARD_SUMMARY. */
  flash: { supported: boolean; totalSize: number; usedSize: number };
  sdcard: { supported: boolean; state: number; totalSizeKb: number };
  blackbox: { device: number; rateNum: number; rateDenom: number };
  /** CLI `set name = value` overrides that show up in `diff all`. */
  settings: Record<string, string>;
  /** Extra non-`set` lines of `diff all` (features, serial, mixer, servo, aux…). */
  diffLines: string[];
  /** `vtx_info` support (only the project INAV fork has it). */
  vtxInfo: { name: string; protocol: string; bands: number; channels: number; freqTable: number[]; rawStatus: number[] } | null;
  /** Project fork MSP2 0x2F10–0x2F22 present (stock INAV rejects them). */
  customMsp: boolean;
}

export type EmulatorPreset = 'molniya' | 'utka';

/** Molniya (CADDXF405_WING, project INAV fork, onboard flash) or «Утка» (SPEEDYBEEF405WING, stock INAV 7.1.2, no flash, no vtx_info). */
export function defaultEmulatedFc(preset: EmulatorPreset = 'molniya'): EmulatedFcState {
  const molniya = preset === 'molniya';
  return {
    variant: 'INAV',
    version: [7, 1, 2],
    boardId: molniya ? 'CDF4' : 'SBF4',
    targetName: molniya ? 'CADDXF405_WING' : 'SPEEDYBEEF405WING',
    uid: molniya ? '0123456789abcdef00112233' : 'aa55aa55deadbeef00c0ffee',
    vtx: molniya ? { deviceType: 3, band: 1, channel: 1, power: 1, pitMode: 0, freqMhz: 3330 } : { deviceType: 0, band: 0, channel: 0, power: 0, pitMode: 0, freqMhz: 0 },
    pairs: molniya
      ? [
          { band: 1, channel: 1, freqMhz: 3330, rcChannel: 8, rcLevel: 1000 },
          { band: 1, channel: 2, freqMhz: 3360, rcChannel: 8, rcLevel: 1500 },
          { band: 1, channel: 3, freqMhz: 3390, rcChannel: 8, rcLevel: 2000 }
        ]
      : [],
    auth: { authorized: false, plan: '', expiresAt: 0, deviceLimit: 1, devicesUsed: 0 },
    rc: Array.from({ length: 16 }, () => 1500),
    flash: molniya ? { supported: true, totalSize: 16 * 1024 * 1024, usedSize: 0 } : { supported: false, totalSize: 0, usedSize: 0 },
    sdcard: molniya ? { supported: false, state: 0, totalSizeKb: 0 } : { supported: true, state: 0, totalSizeKb: 0 },
    blackbox: molniya ? { device: 1, rateNum: 1, rateDenom: 1 } : { device: 0, rateNum: 1, rateDenom: 1 },
    settings: molniya
      ? { platform_type: 'AIRPLANE', throttle_idle: '5.000', max_throttle: '1850', blackbox_device: 'SPIFLASH', vtx_band: '1', vtx_channel: '1' }
      : { platform_type: 'AIRPLANE', throttle_idle: '15.000', max_throttle: '2000', blackbox_device: 'SDCARD', failsafe_procedure: 'RTH', nav_fw_launch_thr: '1700' },
    diffLines: molniya
      ? ['feature VBAT', 'feature BLACKBOX', 'feature TELEMETRY', 'serial 1 2 115200 115200 0 115200', 'serial 2 4096 115200 115200 0 115200', 'mixer motor 0 1.000 0 0 0 0', 'servo 2 1000 2000 1500 100', 'aux 0 0 0 1700 2100']
      : ['feature VBAT', 'feature TELEMETRY', 'serial 1 2 115200 115200 0 115200', 'mixer motor 0 1.000 0 0 0 0', 'servo 2 1000 2000 1500 100', 'aux 0 0 0 1700 2100'],
    customMsp: molniya,
    vtxInfo: molniya
      ? { name: 'SX33-3G3', protocol: 'smartaudio', bands: 1, channels: 8, freqTable: [3330, 3360, 3390, 3420, 3450, 3480, 3510, 3540], rawStatus: [0xaa, 0x55, 0x09, 0x06, 0x01, 0x00, 0x01, 0x0d, 0x02, 0x24, 0x33] }
      : null
  };
}

/** Software FC that answers MSP; used by BoardEmulator and unit tests. */
export class EmulatedFc {
  readonly transport: LoopbackTransport;
  private parser: MspParser;
  private replies: Uint8Array[] = [];

  private cliMode = false;
  private cliBuf = '';

  constructor(public state: EmulatedFcState = defaultEmulatedFc()) {
    this.parser = new MspParser((m) => this.replies.push(this.handle(m)), true);
    this.transport = new LoopbackTransport((frame) => {
      if (this.cliMode || (frame.length === 1 && frame[0] === 0x23)) return this.handleCli(frame);
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

  // ---- CLI (text) emulation: enough of INAV CLI for the snapshot/diff/vtx flows ----

  /** `diff all` exactly as INAV prints it: header, then only values that differ from defaults. */
  diffAll(): string {
    const s = this.state;
    const lines = [
      `# diff all`,
      ``,
      `# version`,
      `# ${s.variant}/${s.targetName} ${s.version.join('.')} ${new Date().toISOString().slice(0, 10)} (emulator)`,
      `# GCC-10.3.1`,
      ``,
      `# start the command batch`,
      `batch start`,
      ``,
      `# reset configuration to default settings`,
      `defaults noreboot`,
      ``,
      `# resources`,
      ``,
      `# mixer`,
      ...s.diffLines.filter((l) => l.startsWith('mixer')),
      ``,
      `# servo`,
      ...s.diffLines.filter((l) => l.startsWith('servo')),
      ``,
      `# feature`,
      ...s.diffLines.filter((l) => l.startsWith('feature')),
      ``,
      `# serial`,
      ...s.diffLines.filter((l) => l.startsWith('serial')),
      ``,
      `# aux`,
      ...s.diffLines.filter((l) => l.startsWith('aux')),
      ``,
      `# master`,
      ...Object.entries(s.settings).map(([k, v]) => `set ${k} = ${v}`),
      ``,
      `# end the command batch`,
      `batch end`,
      ``
    ];
    return lines.join('\r\n');
  }

  private handleCli(frame: Uint8Array): Uint8Array | null {
    const enc = new TextEncoder();
    if (!this.cliMode) {
      this.cliMode = true;
      return enc.encode("\r\nEntering CLI Mode, type 'exit' to return, or 'help'\r\n\r\n# ");
    }
    this.cliBuf += new TextDecoder().decode(frame);
    const nl = this.cliBuf.indexOf('\n');
    if (nl < 0) return null;
    const line = this.cliBuf.slice(0, nl).trim();
    this.cliBuf = this.cliBuf.slice(nl + 1);
    const out = this.cliCommand(line);
    if (out === null) {
      this.cliMode = false;
      return enc.encode(`${line}\r\n\r\nRebooting\r\n`);
    }
    return enc.encode(`${line}\r\n${out}${out && !out.endsWith('\n') ? '\r\n' : ''}# `);
  }

  /** Returns CLI output, or null when the command reboots the FC (exit/save). */
  private cliCommand(line: string): string | null {
    const s = this.state;
    const [cmd, ...rest] = line.split(/\s+/);
    switch ((cmd ?? '').toLowerCase()) {
      case '':
        return '';
      case 'exit':
      case 'save':
        return null;
      case 'diff':
        return this.diffAll();
      case 'status':
        return [
          `System Uptime: 42 seconds`,
          `Current Time: ${new Date().toISOString()}`,
          `Voltage: 0.00V (0S battery - NOT PRESENT)`,
          `CPU Clock=168MHz, GYRO=ICM42605, ACC=ICM42605, BARO=SPL06`,
          `Stack size: 6144, Stack address: 0x10010000, Heap available: 1536`,
          `SD card: ${s.sdcard.supported ? (s.sdcard.state === 4 ? 'Ready' : 'Not present') : 'not supported'}`,
          `Dataflash: ${s.flash.supported ? `${Math.round(s.flash.totalSize / 1024)}kB, used ${Math.round(s.flash.usedSize / 1024)}kB` : 'not supported'}`,
          `Arming disabled flags: NAV CLI`
        ].join('\r\n');
      case 'vtx_info':
        if (!s.vtxInfo) return `Unknown command, try 'help'`;
        return [
          `name: ${s.vtxInfo.name}`,
          `protocol: ${s.vtxInfo.protocol}`,
          `bands: ${s.vtxInfo.bands}`,
          `channels: ${s.vtxInfo.channels}`,
          `freq_table: ${s.vtxInfo.freqTable.join(',')}`,
          `raw_status: ${s.vtxInfo.rawStatus.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`
        ].join('\r\n');
      case 'set': {
        const m = /^set\s+([a-z0-9_]+)\s*=\s*(.+)$/i.exec(line);
        if (!m) return 'Invalid name';
        s.settings[m[1]!.toLowerCase()] = m[2]!.trim();
        return `${m[1]} = ${m[2]!.trim()}`;
      }
      case 'get': {
        const k = (rest[0] ?? '').toLowerCase();
        return k in s.settings ? `${k} = ${s.settings[k]}` : `Invalid name`;
      }
      case 'feature':
      case 'serial':
      case 'mixer':
      case 'servo':
      case 'aux':
        if (rest.length) s.diffLines = [...s.diffLines.filter((l) => l !== line), line];
        return '';
      case 'batch':
      case 'defaults':
        return '';
      default:
        return `Unknown command, try 'help'`;
    }
  }

  private handle(m: MspMessage): Uint8Array {
    const s = this.state;
    const w = new PayloadWriter();
    if (!s.customMsp && m.code >= 0x2f00 && m.code <= 0x2fff) return this.error(m);
    switch (m.code) {
      case MSP.DATAFLASH_SUMMARY:
        return this.reply(m, w.u8((s.flash.supported ? 2 : 0) | (s.flash.supported ? 1 : 0)).u32(s.flash.supported ? s.flash.totalSize / 4096 : 0).u32(s.flash.totalSize).u32(s.flash.usedSize).build());
      case MSP.DATAFLASH_READ: {
        const r = new PayloadReader(m.payload);
        const addr = r.u32();
        return this.reply(m, w.u32(addr).build());
      }
      case MSP.SDCARD_SUMMARY:
        return this.reply(m, w.u8(s.sdcard.supported ? 1 : 0).u8(s.sdcard.state).u8(0).u32(0).u32(s.sdcard.totalSizeKb).build());
      case MSP2.BLACKBOX_CONFIG:
        return this.reply(m, w.u8(1).u8(s.blackbox.device).u16(s.blackbox.rateNum).u16(s.blackbox.rateDenom).u32(0).build());
      case MSP2.SET_BLACKBOX_CONFIG: {
        const r = new PayloadReader(m.payload);
        s.blackbox = { device: r.u8(), rateNum: r.u16(), rateDenom: r.u16() };
        return this.reply(m, w.build());
      }
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

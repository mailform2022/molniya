import { encode, MspMessage, MspParser, PayloadReader, PayloadWriter } from './codec.js';
import { AuthStatus, MSP, MSP2, MSP2_VTX, VTX_MAP_MAX_PAIRS, VtxPair } from './codes.js';
import type { Transport } from './transport.js';

export interface MspLogEntry {
  t: number;
  dir: 'tx' | 'rx' | 'info' | 'err';
  code?: number;
  bytes?: number;
  text: string;
}

export interface MspClientOptions {
  timeoutMs?: number; // spec: retry on 100 ms timeout
  retries?: number;
  log?: (e: MspLogEntry) => void;
}

interface Pending {
  resolve: (m: MspMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MspClient {
  private parser: MspParser;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly log: (e: MspLogEntry) => void;
  private offData?: () => void;

  constructor(
    public readonly transport: Transport,
    opts: MspClientOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? 100;
    this.retries = opts.retries ?? 5;
    this.log = opts.log ?? (() => undefined);
    this.parser = new MspParser((m) => this.onMessage(m));
  }

  async open(): Promise<void> {
    this.offData = this.transport.onData((c) => this.parser.feed(c));
    if (!this.transport.connected) await this.transport.connect();
    this.log({ t: Date.now(), dir: 'info', text: `connected: ${this.transport.info().label}` });
  }

  async close(): Promise<void> {
    this.offData?.();
    await this.transport.disconnect();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('closed'));
    }
    this.pending.clear();
  }

  private onMessage(m: MspMessage): void {
    this.log({ t: Date.now(), dir: 'rx', code: m.code, bytes: m.payload.length, text: m.error ? 'FC error' : 'ok' });
    const p = this.pending.get(m.code);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.code);
    if (m.error) p.reject(new Error(`FC rejected command 0x${m.code.toString(16)}`));
    else p.resolve(m);
  }

  /** Send a command and wait for its reply. Serialised: one in-flight request at a time. */
  request(code: number, payload?: Uint8Array, timeoutMs = this.timeoutMs): Promise<MspMessage> {
    const run = async (): Promise<MspMessage> => {
      let lastErr: Error = new Error('no attempts');
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          return await this.once(code, payload, timeoutMs);
        } catch (e) {
          lastErr = e as Error;
          if (!/timeout/.test(lastErr.message)) throw lastErr;
          this.log({ t: Date.now(), dir: 'err', code, text: `timeout, retry ${attempt + 1}/${this.retries}` });
        }
      }
      throw lastErr;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private once(code: number, payload: Uint8Array | undefined, timeoutMs: number): Promise<MspMessage> {
    return new Promise<MspMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(code);
        reject(new Error(`timeout waiting for 0x${code.toString(16)}`));
      }, timeoutMs);
      this.pending.set(code, { resolve, reject, timer });
      const frame = encode(code, payload);
      this.log({ t: Date.now(), dir: 'tx', code, bytes: payload?.length ?? 0, text: 'send' });
      this.transport.write(frame).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(code);
        reject(e as Error);
      });
    });
  }

  // ---- high level commands ----

  async fcVariant(): Promise<string> {
    const m = await this.request(MSP.FC_VARIANT);
    return new PayloadReader(m.payload).ascii(4);
  }

  async fcVersion(): Promise<string> {
    const r = new PayloadReader((await this.request(MSP.FC_VERSION)).payload);
    return `${r.u8()}.${r.u8()}.${r.u8()}`;
  }

  async boardInfo(): Promise<{ identifier: string; hwRevision: number; targetName: string }> {
    const r = new PayloadReader((await this.request(MSP.BOARD_INFO)).payload);
    const identifier = r.ascii(4);
    const hwRevision = r.u16();
    // INAV: osdSupport u8, commCapabilities u8, targetName len u8 + name
    let targetName = '';
    if (r.remaining >= 3) {
      r.u8();
      r.u8();
      const n = r.u8();
      if (r.remaining >= n) targetName = r.ascii(n);
    }
    return { identifier, hwRevision, targetName };
  }

  async uid(): Promise<string> {
    const r = new PayloadReader((await this.request(MSP.UID)).payload);
    return [r.u32(), r.u32(), r.u32()].map((v) => v.toString(16).padStart(8, '0')).join('');
  }

  async vtxConfig(): Promise<{ deviceType: number; band: number; channel: number; power: number; pitMode: number; freqMhz: number }> {
    const r = new PayloadReader((await this.request(MSP.VTX_CONFIG)).payload);
    const deviceType = r.u8();
    const band = r.u8();
    const channel = r.u8();
    const power = r.u8();
    const pitMode = r.u8();
    const freqMhz = r.remaining >= 2 ? r.u16() : 0;
    return { deviceType, band, channel, power, pitMode, freqMhz };
  }

  async inavMisc(): Promise<Uint8Array> {
    return (await this.request(MSP2.INAV_MISC)).payload;
  }

  async eepromWrite(): Promise<void> {
    await this.request(MSP.EEPROM_WRITE, undefined, 1500);
  }

  async reboot(): Promise<void> {
    await this.transport.write(encode(MSP.REBOOT));
  }

  // ---- custom VTX Services commands ----

  async vtxMapRead(): Promise<VtxPair[]> {
    const r = new PayloadReader((await this.request(MSP2_VTX.VTX_MAP_READ)).payload);
    const n = r.u8();
    const pairs: VtxPair[] = [];
    for (let i = 0; i < n && r.remaining >= 7; i++) {
      pairs.push({ band: r.u8(), channel: r.u8(), freqMhz: r.u16(), rcChannel: r.u8(), rcLevel: r.u16() });
    }
    return pairs;
  }

  async vtxMapWrite(pairs: VtxPair[]): Promise<void> {
    if (pairs.length > VTX_MAP_MAX_PAIRS) throw new Error(`max ${VTX_MAP_MAX_PAIRS} pairs`);
    const w = new PayloadWriter().u8(pairs.length);
    for (const p of pairs) w.u8(p.band).u8(p.channel).u16(p.freqMhz).u8(p.rcChannel).u16(p.rcLevel);
    await this.request(MSP2_VTX.VTX_MAP_WRITE, w.build(), 500);
  }

  async vtxMapSet(index: number, pair: VtxPair): Promise<void> {
    const w = new PayloadWriter().u8(index).u8(pair.band).u8(pair.channel).u16(pair.freqMhz).u8(pair.rcChannel).u16(pair.rcLevel);
    await this.request(MSP2_VTX.VTX_MAP_SET, w.build());
  }

  /** Live preview while the user drags a slider: not persisted on the FC. */
  async vtxMapLive(rcChannel: number, rcLevel: number): Promise<void> {
    await this.request(MSP2_VTX.VTX_MAP_LIVE, new PayloadWriter().u8(rcChannel).u16(rcLevel).build());
  }

  async getUid(): Promise<string> {
    const m = await this.request(MSP2_VTX.GET_UID);
    return Array.from(m.payload, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async setAuthToken(token: Uint8Array): Promise<void> {
    await this.request(MSP2_VTX.SET_AUTH_TOKEN, token, 500);
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const r = new PayloadReader((await this.request(MSP2_VTX.GET_AUTH_STATUS)).payload);
    const authorized = r.u8() === 1;
    const planLen = r.u8();
    const plan = r.ascii(planLen);
    const expiresAt = r.u32();
    const deviceLimit = r.u8();
    const devicesUsed = r.u8();
    return { authorized, plan, expiresAt, deviceLimit, devicesUsed };
  }

  // ---- CLI over the same serial link ----

  /** Enter CLI ('#'), run a command, collect until prompt, then `exit`. */
  async cli(command: string, timeoutMs = 2000): Promise<string> {
    const dec = new TextDecoder();
    let buf = '';
    const off = this.transport.onData((c) => {
      buf += dec.decode(c, { stream: true });
    });
    try {
      await this.transport.write(new TextEncoder().encode('#'));
      await new Promise((r) => setTimeout(r, 200));
      buf = '';
      await this.transport.write(new TextEncoder().encode(command + '\n'));
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
        if (/\n# ?$/.test(buf)) break;
      }
      return buf.replace(/\n# ?$/, '').replace(new RegExp('^' + command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n'), '');
    } finally {
      off();
      await this.transport.write(new TextEncoder().encode('exit\n')).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

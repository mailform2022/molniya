import { encode, encodeV2, MspMessage, MspParser, PayloadReader, PayloadWriter } from './codec.js';
import { AuthStatus, MSP, MSP2, MSP2_VTX, VTX_MAP_MAX_PAIRS, VtxPair } from './codes.js';
import type { Transport } from './transport.js';

export interface MspLogEntry {
  t: number;
  dir: 'tx' | 'rx' | 'info' | 'err';
  code?: number;
  bytes?: number;
  text: string;
}

export interface DataflashSummary { ready: boolean; supported: boolean; sectors: number; totalSize: number; usedSize: number }
export interface SdcardSummary { supported: boolean; state: number; lastError: number; freeSizeKb: number; totalSizeKb: number }
export interface BlackboxConfig { supported: boolean; device: number; rateNum: number; rateDenom: number; includeFlags: number }

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
    this.timeoutMs = opts.timeoutMs ?? 400;
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
  request(code: number, payload?: Uint8Array, timeoutMs = this.timeoutMs, forceV2 = false): Promise<MspMessage> {
    const run = async (): Promise<MspMessage> => {
      let lastErr: Error = new Error('no attempts');
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          return await this.once(code, payload, timeoutMs, forceV2);
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

  private once(code: number, payload: Uint8Array | undefined, timeoutMs: number, forceV2: boolean): Promise<MspMessage> {
    return new Promise<MspMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(code);
        reject(new Error(`timeout waiting for 0x${code.toString(16)}`));
      }, timeoutMs);
      this.pending.set(code, { resolve, reject, timer });
      const frame = forceV2 ? encodeV2(code, payload) : encode(code, payload);
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

  // ---- blackbox storage (standard INAV MSP) ----

  /** MSP_DATAFLASH_SUMMARY: onboard SPI flash used by blackbox. */
  async dataflashSummary(): Promise<DataflashSummary> {
    const r = new PayloadReader((await this.request(MSP.DATAFLASH_SUMMARY)).payload);
    const flags = r.u8();
    return { ready: (flags & 1) !== 0, supported: (flags & 2) !== 0, sectors: r.u32(), totalSize: r.u32(), usedSize: r.u32() };
  }

  /** MSP_SDCARD_SUMMARY: SD card slot state. state: 0 not present, 1 fatal, 2 card init, 3 fs init, 4 ready. */
  async sdcardSummary(): Promise<SdcardSummary> {
    const r = new PayloadReader((await this.request(MSP.SDCARD_SUMMARY)).payload);
    const flags = r.u8();
    return { supported: (flags & 1) !== 0, state: r.u8(), lastError: r.u8(), freeSizeKb: r.u32(), totalSizeKb: r.u32() };
  }

  /** MSP2_BLACKBOX_CONFIG: device 0 none, 1 flash, 2 sdcard, 3 serial. */
  async blackboxConfig(): Promise<BlackboxConfig> {
    const r = new PayloadReader((await this.request(MSP2.BLACKBOX_CONFIG)).payload);
    return { supported: r.u8() === 1, device: r.u8(), rateNum: r.u16(), rateDenom: r.u16(), includeFlags: r.remaining >= 4 ? r.u32() : 0 };
  }

  async setBlackboxConfig(cfg: { device: number; rateNum: number; rateDenom: number; includeFlags?: number }): Promise<void> {
    const w = new PayloadWriter().u8(cfg.device).u16(cfg.rateNum).u16(cfg.rateDenom);
    if (cfg.includeFlags !== undefined) w.u32(cfg.includeFlags);
    await this.request(MSP2.SET_BLACKBOX_CONFIG, w.build(), 500);
  }

  /** MSP_DATAFLASH_READ one chunk; the FC echoes the address and returns up to `size` bytes. */
  async dataflashRead(address: number, size = 4096): Promise<Uint8Array> {
    // v2 framing: v1 payloads are capped at 255 bytes, which would make a flash dump painfully slow.
    const m = await this.request(MSP.DATAFLASH_READ, new PayloadWriter().u32(address).u16(size).build(), 3000, true);
    const r = new PayloadReader(m.payload);
    const addr = r.u32();
    if (addr !== address) throw new Error(`dataflash read: address mismatch ${addr} != ${address}`);
    return r.bytes(r.remaining);
  }

  /** Download the used part of onboard flash (blackbox logs). Returns raw .bbl bytes. */
  async downloadDataflash(onProgress?: (done: number, total: number) => void, chunk = 4096): Promise<Uint8Array> {
    const s = await this.dataflashSummary();
    if (!s.supported) throw new Error('На этом FC нет встроенной flash для чёрного ящика');
    const total = s.usedSize;
    const out = new Uint8Array(total);
    let off = 0;
    while (off < total) {
      const part = await this.dataflashRead(off, Math.min(chunk, total - off));
      if (!part.length) break;
      out.set(part, off);
      off += part.length;
      onProgress?.(off, total);
    }
    return out.subarray(0, off);
  }

  async dataflashErase(): Promise<void> {
    await this.request(MSP.DATAFLASH_ERASE, undefined, 5000);
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

  /**
   * Open a CLI session ('#'). INAV reboots the FC on `exit` and on `save`, so callers batch
   * commands in one session and leave once. While a session is open MSP requests are not sent.
   */
  async cliSession(): Promise<CliSession> {
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let buf = '';
    const off = this.transport.onData((c) => {
      buf += dec.decode(c, { stream: true });
    });
    const waitPrompt = async (timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 30));
        if (/(^|\n)# ?$/.test(buf)) return true;
      }
      return false;
    };
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let closed = false;
    const session: CliSession = {
      run: async (command, timeoutMs = 2000) => {
        if (closed) throw new Error('CLI session closed');
        buf = '';
        this.log({ t: Date.now(), dir: 'tx', text: `cli> ${command}` });
        await this.transport.write(enc.encode(command + '\n'));
        const ok = await waitPrompt(timeoutMs);
        if (!ok) throw new Error(`CLI timeout: ${command}`);
        const out = buf.replace(/(^|\n)# ?$/, '').replace(new RegExp('^' + escape(command) + '\\r?\\n'), '');
        this.log({ t: Date.now(), dir: 'rx', bytes: out.length, text: `cli< ${command}` });
        return out;
      },
      end: async (mode = 'exit') => {
        if (closed) return;
        closed = true;
        off();
        await this.transport.write(enc.encode(mode + '\n')).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 300));
      }
    };
    await this.transport.write(enc.encode('#'));
    if (!(await waitPrompt(1500))) {
      off();
      throw new Error('CLI: нет приглашения "#" (прошивка не отвечает на CLI)');
    }
    return session;
  }

  /** One-shot CLI command; ends with `exit` (FC reboots). Prefer `cliSession` for several commands. */
  async cli(command: string, timeoutMs = 2000): Promise<string> {
    const s = await this.cliSession();
    try {
      return await s.run(command, timeoutMs);
    } finally {
      await s.end('exit');
    }
  }
}

export interface CliSession {
  run(command: string, timeoutMs?: number): Promise<string>;
  /** `exit` — reboot without saving; `save` — write settings and reboot. */
  end(mode?: 'exit' | 'save'): Promise<void>;
}
